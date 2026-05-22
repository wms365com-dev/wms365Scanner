package com.wms365.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.MediaStore
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.zxing.integration.android.IntentIntegrator
import java.io.File
import java.io.IOException

class MainActivity : Activity() {
    private val cameraPermissionRequest = 7
    private val fileChooserRequest = 8

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var loadingOverlay: LinearLayout
    private lateinit var errorOverlay: LinearLayout
    private lateinit var errorText: TextView

    private var pendingPermissionRequest: PermissionRequest? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraPhotoUri: Uri? = null
    private var pendingScanTargetId: String = ""

    private val baseUri: Uri = Uri.parse(BuildConfig.WMS365_BASE_URL)
    private val allowedHosts: Set<String> = setOfNotNull(
        baseUri.host?.lowercase(),
        "app.wms365.co",
        "wms365.co"
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        configureFullscreen()
        requestCameraPermissionIfNeeded()
        buildLayout()
        configureWebView()
        webView.loadUrl(resolveStartUrl(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        webView.loadUrl(resolveStartUrl(intent))
    }

    private fun configureFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.hide(WindowInsets.Type.statusBars())
            window.insetsController?.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
    }

    private fun buildLayout() {
        root = FrameLayout(this)
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        loadingOverlay = buildOverlay("WMS365 Scanner", "Loading mobile workspace...")
        root.addView(loadingOverlay)

        errorOverlay = buildOverlay("Connection Issue", "WMS365 could not load.")
        errorText = errorOverlay.getChildAt(1) as TextView
        val retryButton = Button(this).apply {
            text = "Retry"
            setOnClickListener {
                showError(false)
                showLoading(true)
                webView.reload()
            }
        }
        errorOverlay.addView(retryButton)
        errorOverlay.visibility = View.GONE
        root.addView(errorOverlay)

        setContentView(root)
    }

    private fun buildOverlay(title: String, message: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.rgb(244, 247, 249))
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            addView(TextView(this@MainActivity).apply {
                text = title
                textSize = 24f
                setTextColor(Color.rgb(16, 32, 51))
                gravity = Gravity.CENTER
            })
            addView(TextView(this@MainActivity).apply {
                text = message
                textSize = 14f
                setTextColor(Color.rgb(100, 116, 139))
                gravity = Gravity.CENTER
                setPadding(0, 12, 0, 20)
            })
            addView(ProgressBar(this@MainActivity))
            addView(TextView(this@MainActivity).apply {
                text = "App ${BuildConfig.VERSION_NAME}"
                textSize = 12f
                setTextColor(Color.rgb(100, 116, 139))
                gravity = Gravity.CENTER
                setPadding(0, 20, 0, 0)
            })
        }
    }

    private fun configureWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.addJavascriptInterface(AndroidBridge(), "WMS365Android")

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = true
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            userAgentString = "$userAgentString WMS365Android/${BuildConfig.VERSION_NAME}"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url ?: return true
                if (!isApprovedUri(uri)) return true
                return false
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                showLoading(true)
                showError(false)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                showLoading(false)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    showLoading(false)
                    showError(true, if (isOnline()) "WMS365 could not load. Check the connection and retry." else "Offline. Reconnect and retry, or continue with cached web data if the page was already loaded.")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(request.resources)
                } else {
                    pendingPermissionRequest = request
                    ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.CAMERA), cameraPermissionRequest)
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback
                openImageChooser(fileChooserParams)
                return true
            }
        }
    }

    private fun resolveStartUrl(intent: Intent?): String {
        val deepLink = intent?.data
        if (deepLink != null && isApprovedUri(deepLink)) {
            val builder = deepLink.buildUpon()
            if (deepLink.getQueryParameter("mode").isNullOrBlank()) builder.appendQueryParameter("mode", "mobile")
            return builder.build().toString()
        }
        return BuildConfig.WMS365_BASE_URL + BuildConfig.WMS365_START_PATH
    }

    private fun isApprovedUri(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return false
        val host = uri.host?.lowercase() ?: return false
        return scheme == "https" && host in allowedHosts
    }

    private fun showLoading(show: Boolean) {
        loadingOverlay.visibility = if (show) View.VISIBLE else View.GONE
    }

    private fun showError(show: Boolean, message: String = "WMS365 could not load.") {
        errorText.text = message
        errorOverlay.visibility = if (show) View.VISIBLE else View.GONE
    }

    private fun requestCameraPermissionIfNeeded() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), cameraPermissionRequest)
        }
    }

    private fun openImageChooser(params: WebChromeClient.FileChooserParams) {
        val contentIntent = params.createIntent()
        var cameraIntent: Intent? = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        try {
            val photoFile = File.createTempFile("wms365-mobile-", ".jpg", cacheDir)
            cameraPhotoUri = FileProvider.getUriForFile(this, "$packageName.fileprovider", photoFile)
            cameraIntent?.putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri)
            cameraIntent?.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: IOException) {
            cameraIntent = null
            cameraPhotoUri = null
        }

        val chooser = Intent(Intent.ACTION_CHOOSER).apply {
            putExtra(Intent.EXTRA_INTENT, contentIntent)
            putExtra(Intent.EXTRA_TITLE, "Take or choose photo")
            if (cameraIntent != null) putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(cameraIntent))
        }

        try {
            startActivityForResult(chooser, fileChooserRequest)
        } catch (_: ActivityNotFoundException) {
            filePathCallback?.onReceiveValue(null)
            filePathCallback = null
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val request = pendingPermissionRequest
        if (requestCode == cameraPermissionRequest && request != null) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                request.grant(request.resources)
            } else {
                request.deny()
            }
            pendingPermissionRequest = null
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val scanResult = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (scanResult != null) {
            val value = scanResult.contents ?: ""
            if (value.isNotBlank()) {
                val safeTarget = pendingScanTargetId.replace("\\", "\\\\").replace("'", "\\'")
                val safeValue = value.replace("\\", "\\\\").replace("'", "\\'")
                webView.evaluateJavascript("window.wms365ReceiveAndroidScan && window.wms365ReceiveAndroidScan('$safeTarget','$safeValue');", null)
                vibrate(45)
                beep("success")
            } else {
                beep("error")
            }
            pendingScanTargetId = ""
            return
        }

        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != fileChooserRequest || filePathCallback == null) return

        var results: Array<Uri>? = null
        if (resultCode == RESULT_OK) {
            results = if (data == null || data.data == null) {
                cameraPhotoUri?.let { arrayOf(it) }
            } else {
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            }
        }
        filePathCallback?.onReceiveValue(results)
        filePathCallback = null
        cameraPhotoUri = null
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    private fun isOnline(): Boolean {
        val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun vibrate(durationMs: Long) {
        val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(durationMs.coerceIn(10, 300), VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(durationMs.coerceIn(10, 300))
        }
    }

    private fun beep(type: String) {
        val tone = if (type == "error") ToneGenerator.TONE_PROP_NACK else ToneGenerator.TONE_PROP_ACK
        ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80).startTone(tone, 120)
    }

    private fun setKeepScreenAwake(enabled: Boolean) {
        if (enabled) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun scanBarcode(targetId: String) {
            runOnUiThread {
                pendingScanTargetId = targetId
                IntentIntegrator(this@MainActivity)
                    .setDesiredBarcodeFormats(IntentIntegrator.ALL_CODE_TYPES)
                    .setPrompt("Scan WMS365 barcode")
                    .setBeepEnabled(false)
                    .setOrientationLocked(false)
                    .initiateScan()
            }
        }

        @JavascriptInterface
        fun vibrate(durationMs: Long) {
            runOnUiThread { this@MainActivity.vibrate(durationMs) }
        }

        @JavascriptInterface
        fun beep(type: String) {
            runOnUiThread { this@MainActivity.beep(type) }
        }

        @JavascriptInterface
        fun getDeviceId(): String {
            return Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: ""
        }

        @JavascriptInterface
        fun getAppVersion(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun getPlatform(): String = "android"

        @JavascriptInterface
        fun isOnline(): Boolean = this@MainActivity.isOnline()

        @JavascriptInterface
        fun setKeepScreenAwake(enabled: Boolean) {
            runOnUiThread { this@MainActivity.setKeepScreenAwake(enabled) }
        }

        @JavascriptInterface
        fun clearWebData() {
            runOnUiThread {
                CookieManager.getInstance().removeAllCookies(null)
                WebStorage.getInstance().deleteAllData()
                webView.clearCache(true)
                webView.clearHistory()
            }
        }
    }
}
