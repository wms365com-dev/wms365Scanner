package com.wms365.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.MediaStore
import android.provider.Settings
import android.view.Gravity
import android.view.KeyEvent
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
import android.widget.Toast
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
    private val hardwareScanBuffer = StringBuilder()
    private val hardwareScanHandler = Handler(Looper.getMainLooper())
    private val hardwareScanFlushRunnable = Runnable { flushHardwareScanBuffer() }

    private val baseUri: Uri = Uri.parse(BuildConfig.WMS365_BASE_URL)
    private val allowedHosts: Set<String> = setOfNotNull(
        baseUri.host?.lowercase(),
        "app.wms365.co",
        "wms365.co"
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        setKeepScreenAwake(true)
        configureFullscreen()
        buildLayout()
        configureWebView()
        webView.loadUrl(resolveStartUrl(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        webView.loadUrl(resolveStartUrl(intent))
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            hardwareScanHandler.postDelayed({
                webView.evaluateJavascript(
                    "(window.__wms365AndroidWarmData ? window.__wms365AndroidWarmData('android-resume') : (window.WMS365Mobile && window.WMS365Mobile.preloadWarehouseData && window.WMS365Mobile.preloadWarehouseData({reason:'android-resume'}).catch(function(){})));",
                    null
                )
            }, 1000)
        }
    }

    private fun configureFullscreen() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.decorView.post {
                window.insetsController?.hide(WindowInsets.Type.statusBars())
                window.insetsController?.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
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
                injectAndroidWebViewFixes()
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

    private fun injectAndroidWebViewFixes() {
        val script = """
            (function () {
              var id = 'wms365-android-webview-fixes';
              var style = document.getElementById(id);
              if (!style) {
                style = document.createElement('style');
                style.id = id;
                document.head.appendChild(style);
              }
              style.textContent = [
                'html, body.device-mobile { height: 100vh !important; min-height: 100vh !important; overflow: hidden !important; }',
                'body.device-mobile .app { height: calc(100vh - var(--mobile-safe-top, 0px) - var(--mobile-safe-bottom, 0px)) !important; min-height: calc(100vh - var(--mobile-safe-top, 0px) - var(--mobile-safe-bottom, 0px)) !important; max-height: calc(100vh - var(--mobile-safe-top, 0px) - var(--mobile-safe-bottom, 0px)) !important; overflow: hidden !important; }',
                'body.device-mobile .panel { min-height: 0 !important; }',
                'body.device-mobile .panel.active { height: 100% !important; overflow-y: auto !important; -webkit-overflow-scrolling: touch !important; }',
                'body.device-webview header { padding-top: 6px !important; padding-bottom: 6px !important; }',
                'body.device-webview .head-card { padding: 9px 11px !important; gap: 4px !important; }',
                'body.device-webview .brand img { width: 32px !important; height: 32px !important; flex-basis: 32px !important; }',
                'body.device-webview .title { font-size: 19px !important; line-height: 1.08 !important; }',
                'body.device-webview .sub { display: none !important; }',
                'body.device-webview .top > .meta { display: none !important; }',
                'body.device-webview .footer { display: none !important; }',
                'body.device-webview .order-row { padding: 9px 10px !important; }',
                'body.device-webview .quick-actions { display: none !important; }',
                'body.device-webview .order-search { display: grid !important; grid-template-columns: minmax(0,1fr) 82px !important; gap: 8px !important; margin-top: 10px !important; }',
                'body.device-webview .order-search input { min-height: 44px !important; }',
                'body.device-webview .order-counts { display: flex !important; gap: 6px !important; flex-wrap: wrap !important; margin-top: 8px !important; }',
                'body.device-webview .order-action { font-size: 11px !important; font-weight: 800 !important; text-transform: uppercase !important; letter-spacing: .08em !important; color: #3f5f76 !important; }',
                'body.device-webview.picking-active .app { grid-template-rows: 1fr !important; }',
                'body.device-webview.picking-active header, body.device-webview.picking-active main > .card:first-child, body.device-webview.picking-active #orderSummaryCard, body.device-webview.picking-active #lockedCompanyWrap { display: none !important; }',
                'body.device-webview.picking-active main { padding: 6px !important; gap: 6px !important; }',
                'body.device-webview.picking-active #pickCard { padding: 9px !important; }',
                'body.device-webview.picking-active .pick-step { gap: 7px !important; }',
                'body.device-webview.picking-active .kicker, body.device-webview.picking-active #pickTraceability { display: none !important; }',
                'body.device-webview.picking-active .loc { font-size: 30px !important; line-height: 1 !important; }',
                'body.device-webview.picking-active .big { font-size: 20px !important; line-height: 1.05 !important; }',
                'body.device-webview.picking-active #pickDescription { font-size: 13px !important; line-height: 1.25 !important; }',
                'body.device-webview.picking-active input, body.device-webview.picking-active select { padding: 10px 11px !important; }',
                'body.device-webview.picking-active button { padding: 10px 12px !important; }',
                'body.device-webview.count-active .app { grid-template-rows: 1fr !important; padding: 6px !important; }',
                'body.device-webview.count-active .top { display: none !important; }',
                'body.device-webview.count-active .stack { gap: 7px !important; }',
                'body.device-webview.count-active .card { padding: 9px !important; }',
                'body.device-webview.count-active .locked { padding: 8px 9px !important; }',
                'body.device-webview #orderPickerWrap > label { display: none !important; }',
                'body.device-webview #loadOrderBtn { display: none !important; }',
                'body.device-webview #refreshBtn { width: 100% !important; }',
                'body.device-webview .mobile-screen-body { gap: 0.42rem !important; padding: 0.42rem 0.48rem calc(0.7rem + env(safe-area-inset-bottom)) !important; }',
                'body.device-webview .mobile-appbar { display: flex !important; align-items: center !important; gap: 0.55rem !important; padding: 0.52rem 0.65rem !important; }',
                'body.device-webview .mobile-appbar-logo, body.device-webview .appbar img, body.device-webview .brand img { width: 32px !important; height: 32px !important; flex: 0 0 32px !important; object-fit: contain !important; }',
                'body.device-webview .mobile-appbar-copy, body.device-webview .appbar-copy, body.device-webview .brand-copy { display: grid !important; min-width: 0 !important; flex: 1 1 auto !important; gap: 2px !important; }',
                'body.device-webview .mobile-appbar-kicker, body.device-webview .brand-copy span, body.device-webview .appbar .kicker { display: none !important; }',
                'body.device-webview .mobile-appbar-title, body.device-webview .title, body.device-webview .title-text { font-size: 19px !important; line-height: 1.08 !important; font-weight: 800 !important; }',
                'body.device-webview .mobile-appbar-badge, body.device-webview .module-badge, body.device-webview .badge { flex: 0 0 auto !important; font-size: 12px !important; padding: 5px 9px !important; border: 1px solid #d5dde4 !important; border-radius: 999px !important; background: #fff !important; color: #3f5f76 !important; }',
                'body.device-webview .appbar { display: flex !important; align-items: center !important; gap: 10px !important; padding: 9px 11px !important; border: 1px solid #d5dde4 !important; border-radius: 12px !important; background: #fff !important; }',
                'body.device-webview .mobile-home-card { gap: 0.36rem !important; }',
                'body.device-webview .mobile-home-card h1 { margin: 0 0 0.08rem !important; font-size: 1.24rem !important; letter-spacing: 0 !important; }',
                'body.device-webview .menu-stack { gap: 0.48rem !important; }',
                'body.device-webview .mobile-menu-group { gap: 0.42rem !important; }',
                'body.device-webview .mobile-menu-group-title { margin: 0.15rem 0 0 !important; }',
                'body.device-webview .menu-card-btn { min-height: 48px !important; padding: 0.62rem 0.78rem !important; }',
                'body.device-webview .menu-card-title { font-size: 0.95rem !important; }',
                'body.device-webview .mobile-company-card, body.device-webview .mobile-pending-panel { gap: 0.42rem !important; padding: 0.58rem 0.68rem !important; }',
                'body.device-webview .feedback-launcher { right: calc(0.5rem + env(safe-area-inset-right)) !important; bottom: calc(0.5rem + env(safe-area-inset-bottom)) !important; width: 42px !important; height: 42px !important; min-height: 42px !important; border-radius: 14px !important; opacity: 0.92 !important; }',
                'body.device-webview .feedback-launcher::before { font-size: 1.1rem !important; }',
                'body.device-webview .top { padding-top: 8px !important; padding-bottom: 8px !important; }',
                'body.device-webview .top h1 { margin-top: 2px !important; font-size: 22px !important; }',
                'body.device-webview .badge { padding: 5px 9px !important; }',
                'body.device-webview .login-brand { display: flex !important; align-items: center !important; gap: 10px !important; padding: 9px 11px !important; border: 1px solid #d5dde4 !important; border-radius: 12px !important; background: #fff !important; }',
                'body.device-webview .login-brand img { width: 32px !important; height: 32px !important; flex: 0 0 32px !important; object-fit: contain !important; }',
                'body.device-webview .login-brand-copy { display: grid !important; gap: 2px !important; min-width: 0 !important; flex: 1 1 auto !important; }',
                'body.device-webview .login-brand-copy span { display: none !important; }',
                'body.device-webview .login-brand-copy strong { font-size: 19px !important; font-weight: 800 !important; line-height: 1.08 !important; color: #20303a !important; }',
                'body.device-webview .login-brand-badge { border: 1px solid #d5dde4 !important; border-radius: 999px !important; padding: 5px 9px !important; background: #fff !important; color: #3f5f76 !important; font-size: 12px !important; font-weight: 800 !important; flex: 0 0 auto !important; }'
              ].join('\n');
              document.body.classList.add('device-android', 'device-webview');
              function ensureLogoAppbar() {
                document.querySelectorAll('.mobile-appbar').forEach(function (appbar) {
                  if (!appbar.querySelector('.mobile-appbar-logo')) {
                  var logo = document.createElement('img');
                  logo.className = 'mobile-appbar-logo';
                  logo.src = '/marketing-logo.svg';
                  logo.alt = 'WMS365 logo';
                  logo.width = 32;
                  logo.height = 32;
                  appbar.insertBefore(logo, appbar.firstChild);
                  }
                  var title = appbar.querySelector('.mobile-appbar-title');
                  if (title && (location.pathname || '') === '/mobile') title.textContent = 'WMS365 Scanner';
                  var badge = appbar.querySelector('.mobile-appbar-badge');
                  if (badge && (location.pathname || '') === '/mobile') badge.textContent = 'Menu';
                });
              }
              ensureLogoAppbar();
              new MutationObserver(ensureLogoAppbar).observe(document.body, { childList: true, subtree: true });
              function ensureLoginBranding() {
                var form = document.getElementById('loginForm');
                if (!form || form.querySelector('.login-brand')) return;
                var brand = document.createElement('div');
                brand.className = 'login-brand';
                brand.innerHTML = '<img src="/marketing-logo.svg" alt="WMS365 logo" width="32" height="32"><div class="login-brand-copy"><span>WMS365</span><strong>WMS365 Scanner</strong></div><span class="login-brand-badge">Login</span>';
                form.insertBefore(brand, form.firstChild);
              }
              ensureLoginBranding();
              var mobileSwitch = document.getElementById('mobileSwitchCompanyBtn');
              if (mobileSwitch) mobileSwitch.textContent = 'Switch';
              function hasAndroidHardwareScanner() {
                return typeof WMS365Android !== 'undefined' && WMS365Android.hasHardwareScanner && WMS365Android.hasHardwareScanner();
              }
              function setHardwareScannerButtons() {
                if (!hasAndroidHardwareScanner()) return;
                document.querySelectorAll('[data-scan-target]').forEach(function (button) {
                  button.textContent = 'Trigger';
                  button.title = 'Press this, then use the physical scanner trigger.';
                });
              }
              function armHardwareScannerInputs(ids) {
                if (!hasAndroidHardwareScanner()) return;
                ids.forEach(function (id) {
                  var input = document.getElementById(id);
                  if (!input) return;
                  if (/location/i.test(id)) input.placeholder = 'Scan location';
                  else if (/sku/i.test(id)) input.placeholder = 'Scan SKU';
                  else if (/lot/i.test(id)) input.placeholder = 'Scan lot';
                  if (input.__wms365HardwareScannerInput) return;
                  input.__wms365HardwareScannerInput = true;
                  input.setAttribute('inputmode', 'none');
                  input.setAttribute('readonly', 'readonly');
                  input.title = 'Tap, then press the scanner trigger.';
                  var lastStarted = 0;
                  var startHardwareScan = function (event) {
                    if (event) event.preventDefault();
                    var now = Date.now();
                    if (now - lastStarted < 700) return;
                    lastStarted = now;
                    input.blur();
                    WMS365Android.scanBarcode(id);
                  };
                  input.addEventListener('click', startHardwareScan);
                  input.addEventListener('focus', startHardwareScan);
                });
              }
              function textContainsAny(text, values) {
                var haystack = String(text || '').toLowerCase();
                return Array.isArray(values) && values.some(function (value) { return haystack.indexOf(String(value || '').toLowerCase()) >= 0; });
              }
              function matchAndroidDeviceProfile(profile) {
                var match = profile && profile.match || {};
                var manufacturer = typeof WMS365Android !== 'undefined' && WMS365Android.getDeviceManufacturer ? WMS365Android.getDeviceManufacturer() : '';
                var brandValue = typeof WMS365Android !== 'undefined' && WMS365Android.getDeviceBrand ? WMS365Android.getDeviceBrand() : '';
                var model = typeof WMS365Android !== 'undefined' && WMS365Android.getDeviceModel ? WMS365Android.getDeviceModel() : '';
                var platform = navigator.userAgent || 'android';
                return textContainsAny(manufacturer, match.manufacturerContains)
                  || textContainsAny(brandValue, match.brandContains)
                  || textContainsAny(model, match.modelContains)
                  || textContainsAny(platform, match.platformContains);
              }
              function applyAndroidDeviceProfile(profile) {
                if (!profile) return;
                window.__wms365DeviceProfile = profile;
                document.body.dataset.deviceProfile = profile.id || '';
                document.body.classList.toggle('device-profile-hardware-scanner', profile.showSoftKeyboardForScanFields === false || /hardware/i.test(String(profile.scannerMode || '')));
                if (profile.androidOptimizations && profile.androidOptimizations.compactWorkerScreens) document.body.classList.add('device-optimized-worker');
                if (profile.showSoftKeyboardForScanFields === false) {
                  setHardwareScannerButtons();
                  armHardwareScannerInputs(['confirmLocation', 'confirmSku', 'confirmLot', 'locationInput', 'skuInput', 'lotInput', 'orderSearch']);
                }
              }
              function loadAndroidDeviceProfile() {
                fetch('/device-profiles.json', { cache: 'no-store' })
                  .then(function (response) { return response.ok ? response.json() : null; })
                  .then(function (data) {
                    var profiles = data && Array.isArray(data.profiles) ? data.profiles : [];
                    applyAndroidDeviceProfile(profiles.find(matchAndroidDeviceProfile) || profiles.find(function (profile) { return profile.id === 'generic-android-phone'; }));
                  })
                  .catch(function () {});
              }
              loadAndroidDeviceProfile();
              var path = location.pathname || '';
              if (path.indexOf('/mobile-pick') === 0) {
                var pickTitle = document.querySelector('.brand-copy .title');
                if (pickTitle) pickTitle.textContent = 'WMS365 Scanner';
                var pickKicker = document.querySelector('.brand-copy span');
                if (pickKicker) pickKicker.textContent = 'WMS365';
                var brand = document.querySelector('.brand');
                if (brand && !brand.querySelector('.module-badge')) {
                  var pickBadge = document.createElement('span');
                  pickBadge.className = 'module-badge';
                  pickBadge.textContent = 'Picking';
                  pickBadge.style.cssText = 'border:1px solid #d5dde4;border-radius:999px;padding:5px 9px;background:#fff;color:#3f5f76;font-size:12px;font-weight:800;';
                  brand.appendChild(pickBadge);
                }
                function enhancePickQueue() {
                  var list = document.getElementById('pendingOrderList');
                  if (!list) return;
                  normalizePickInputs();
                  var toolbar = document.querySelector('.order-toolbar');
                  if (!document.getElementById('orderSearch')) {
                    var searchWrap = document.createElement('div');
                    searchWrap.className = 'order-search';
                    searchWrap.innerHTML = '<input id="orderSearch" type="text" placeholder="Scan/order/customer" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search"><button class="secondary" type="button" data-scan-target="orderSearch">Trigger</button>';
                    if (toolbar && toolbar.parentNode) toolbar.parentNode.insertBefore(searchWrap, toolbar.nextSibling);
                    else list.parentNode.insertBefore(searchWrap, list);
                    searchWrap.querySelector('button').onclick = function () {
                      if (window.WMS365Mobile && window.WMS365Mobile.scanBarcode) window.WMS365Mobile.scanBarcode('orderSearch');
                    };
                    searchWrap.querySelector('input').addEventListener('input', filterPickRows);
                    searchWrap.querySelector('input').addEventListener('keydown', function (event) {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      openExactPickRow();
                    });
                  }
                  if (!document.getElementById('orderCounts')) {
                    var counts = document.createElement('div');
                    counts.id = 'orderCounts';
                    counts.className = 'order-counts';
                    list.parentNode.insertBefore(counts, list);
                  }
                  sortPickRows();
                  filterPickRows();
                  focusActivePickWork();
                }
                function normalizePickInputs() {
                  [
                    ['confirmLocation', 'Scan location'],
                    ['confirmSku', 'Scan SKU'],
                    ['confirmLot', 'Scan lot'],
                    ['confirmQty', 'Qty']
                  ].forEach(function (entry) {
                    var input = document.getElementById(entry[0]);
                    if (input) input.placeholder = entry[1];
                  });
                  setHardwareScannerButtons();
                  armHardwareScannerInputs(['confirmLocation', 'confirmSku', 'confirmLot']);
                }
                function compactProgressText(progress) {
                  var match = String(progress || '').match(/(\d+)\s+of\s+(\d+)/i);
                  return match ? match[1] + '/' + match[2] : String(progress || '').trim();
                }
                function focusActivePickWork() {
                  var pickCard = document.getElementById('pickCard');
                  var orderPicker = document.getElementById('orderPickerWrap');
                  var active = pickCard && !pickCard.classList.contains('hidden');
                  document.body.classList.toggle('picking-active', !!active);
                  if (orderPicker) orderPicker.classList.toggle('hidden', !!active);
                  if (active && pickCard && !document.getElementById('wms365Workbar')) {
                    var step = pickCard.querySelector('.pick-step') || pickCard;
                    var bar = document.createElement('div');
                    bar.id = 'wms365Workbar';
                    bar.className = 'workbar';
                    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid #d5dde4;border-radius:12px;background:#f7f9fa;padding:8px 9px;';
                    var order = (document.getElementById('orderCode') || {}).textContent || 'Order';
                    var companyLabel = (document.getElementById('lockedCompanyLabel') || {}).textContent || '';
                    var progress = compactProgressText((document.getElementById('progressText') || {}).textContent || '');
                    bar.innerHTML = '<div><strong style="display:block;font-size:15px;">' + order + '</strong><span style="display:block;font-size:12px;color:#657582;font-weight:700;">' + [companyLabel, progress].filter(Boolean).join(' | ') + '</span></div><div style="display:flex;gap:6px;flex:0 0 auto;"><button class="secondary" type="button" id="wms365WorkMenuBtn" style="min-height:36px;padding:8px 10px;">Menu</button><button class="secondary" type="button" id="wms365WorkListBtn" style="min-height:36px;padding:8px 10px;">List</button></div>';
                    step.insertBefore(bar, step.firstChild);
                    var menu = document.getElementById('wms365WorkMenuBtn');
                    var listBtn = document.getElementById('wms365WorkListBtn');
                    if (menu) menu.onclick = function () {
                      var company = ((document.getElementById('lockedCompanyLabel') || {}).textContent || '').trim();
                      location.href = '/mobile' + (company ? '?mode=mobile&accountName=' + encodeURIComponent(company) : '?mode=mobile');
                    };
                    if (listBtn) listBtn.onclick = function () {
                      if (typeof state !== 'undefined') {
                        state.selectedOrder = null;
                        state.picks = [];
                        state.index = 0;
                      }
                      document.body.classList.remove('picking-active');
                      if (typeof renderPick === 'function') renderPick();
                      if (typeof renderCompanyLock === 'function') renderCompanyLock();
                      if (orderPicker) orderPicker.classList.remove('hidden');
                    };
                  }
                  if (active && !window.__wms365PickScrolled) {
                    window.__wms365PickScrolled = true;
                    pickCard.scrollIntoView({ block: 'start' });
                  }
                }
                function pickRowStatus(row) {
                  return ((row.querySelector('.pill') || {}).textContent || row.textContent || '').toUpperCase();
                }
                function pickPriority(row) {
                  var status = pickRowStatus(row);
                  if (status.indexOf('RELEASED') >= 0) return 0;
                  if (status.indexOf('PICKED') >= 0) return 1;
                  if (status.indexOf('STAGED') >= 0) return 2;
                  return 9;
                }
                function sortPickRows() {
                  var list = document.getElementById('pendingOrderList');
                  if (!list) return;
                  var rows = Array.prototype.slice.call(list.querySelectorAll('.order-row'));
                  rows.sort(function (a, b) {
                    return pickPriority(a) - pickPriority(b) || (a.textContent || '').localeCompare(b.textContent || '');
                  }).forEach(function (row) {
                    var action = row.querySelector('.order-action');
                    var priority = pickPriority(row);
                    var label = priority === 0 ? 'Pick' : priority === 1 ? 'Stage' : priority === 2 ? 'Ship' : 'Open';
                    if (!action) {
                      action = document.createElement('span');
                      action.className = 'order-action';
                      row.insertBefore(action, row.firstChild);
                    }
                    action.textContent = label;
                    row.setAttribute('data-action', label.toLowerCase());
                    list.appendChild(row);
                  });
                  var counts = document.getElementById('orderCounts');
                  if (counts) {
                    var pick = rows.filter(function (row) { return pickPriority(row) === 0; }).length;
                    var stage = rows.filter(function (row) { return pickPriority(row) === 1; }).length;
                    var ship = rows.filter(function (row) { return pickPriority(row) === 2; }).length;
                    counts.innerHTML = [
                      pick ? '<span class="pill">Pick ' + pick + '</span>' : '',
                      stage ? '<span class="pill">Stage ' + stage + '</span>' : '',
                      ship ? '<span class="pill">Ship ' + ship + '</span>' : ''
                    ].filter(Boolean).join('');
                  }
                }
                function filterPickRows() {
                  var list = document.getElementById('pendingOrderList');
                  var search = document.getElementById('orderSearch');
                  if (!list || !search) return;
                  var query = (search.value || '').trim().toUpperCase();
                  Array.prototype.slice.call(list.querySelectorAll('.order-row')).forEach(function (row) {
                    row.style.display = !query || (row.textContent || '').toUpperCase().indexOf(query) >= 0 ? '' : 'none';
                  });
                }
                function openExactPickRow() {
                  var search = document.getElementById('orderSearch');
                  var list = document.getElementById('pendingOrderList');
                  if (!search || !list) return;
                  var query = (search.value || '').trim().toUpperCase();
                  if (!query) return;
                  var rows = Array.prototype.slice.call(list.querySelectorAll('.order-row'));
                  var match = rows.find(function (row) {
                    var first = (row.querySelector('strong') || {}).textContent || '';
                    return first.trim().toUpperCase() === query;
                  });
                  if (match) match.click();
                }
                var originalReceiveScan = window.wms365ReceiveAndroidScan;
                window.wms365ReceiveAndroidScan = function (targetId, value) {
                  if (targetId === 'orderSearch') {
                    var input = document.getElementById('orderSearch');
                    if (input) {
                      input.value = String(value || '').trim();
                      filterPickRows();
                      openExactPickRow();
                      return;
                    }
                  }
                  if (typeof originalReceiveScan === 'function') originalReceiveScan(targetId, value);
                };
                window.setTimeout(enhancePickQueue, 700);
                window.setTimeout(enhancePickQueue, 2200);
                window.setTimeout(enhancePickQueue, 5200);
                window.setInterval(function () {
                  if ((location.pathname || '').indexOf('/mobile-pick') === 0) {
                    normalizePickInputs();
                    focusActivePickWork();
                  }
                }, 1500);
              }
              function optimizePickQueueForWorker() {
                if ((location.pathname || '').indexOf('/mobile-pick') !== 0) return;
                var list = document.getElementById('pendingOrderList');
                if (!list) return;
                if (!list.querySelector('.order-row') && window.WMS365Mobile && window.WMS365Mobile.getCachedData && !window.__wms365PickCacheHydrating) {
                  window.__wms365PickCacheHydrating = true;
                  var activeCompany = '';
                  try { activeCompany = window.WMS365Mobile.getCompanyContext && window.WMS365Mobile.getCompanyContext(); } catch (error) {}
                  activeCompany = activeCompany || ((document.getElementById('lockedCompanyLabel') || {}).textContent || '');
                  activeCompany = String(activeCompany || '').trim().replace(/\s+/g, ' ').toUpperCase();
                  window.WMS365Mobile.getCachedData('mobile-pick-orders:' + activeCompany, { maxAgeMs: 15 * 60 * 1000 }).then(function (record) {
                    var payload = record && record.payload;
                    if (!payload || !Array.isArray(payload.orders) || !payload.orders.length) return;
                    if (typeof applyOrdersPayload === 'function') {
                      applyOrdersPayload(payload);
                    } else if (typeof state !== 'undefined') {
                      state.orders = payload.orders;
                      if (typeof renderPendingOrders === 'function') renderPendingOrders();
                    }
                  }).catch(function () {}).finally(function () {
                    window.__wms365PickCacheHydrating = false;
                    window.setTimeout(optimizePickQueueForWorker, 100);
                  });
                }
                var toolbar = document.querySelector('.order-toolbar');
                var search = document.getElementById('orderSearch');
                if (!search) {
                  var wrap = document.createElement('div');
                  wrap.className = 'order-search';
                  wrap.innerHTML = '<input id="orderSearch" type="text" placeholder="Scan/order/customer" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search"><button class="secondary" type="button" data-scan-target="orderSearch">Trigger</button>';
                  if (toolbar && toolbar.parentNode) toolbar.parentNode.insertBefore(wrap, toolbar.nextSibling);
                  else list.parentNode.insertBefore(wrap, list);
                  search = document.getElementById('orderSearch');
                  var trigger = wrap.querySelector('button');
                  if (trigger) trigger.onclick = function () {
                    if (window.WMS365Mobile && window.WMS365Mobile.scanBarcode) window.WMS365Mobile.scanBarcode('orderSearch');
                  };
                }
                var counts = document.getElementById('orderCounts');
                if (!counts) {
                  counts = document.createElement('div');
                  counts.id = 'orderCounts';
                  counts.className = 'order-counts';
                  list.parentNode.insertBefore(counts, list);
                }
                function rowStatus(row) {
                  var pill = row.querySelector('.pill');
                  return String((pill && pill.textContent) || row.textContent || '').toUpperCase();
                }
                function priority(row) {
                  var status = rowStatus(row);
                  if (status.indexOf('RELEASED') >= 0) return 0;
                  if (status.indexOf('PICKED') >= 0) return 1;
                  if (status.indexOf('STAGED') >= 0) return 2;
                  return 9;
                }
                function actionLabel(row) {
                  var p = priority(row);
                  return p === 0 ? 'PICK' : p === 1 ? 'STAGE' : p === 2 ? 'SHIP' : 'OPEN';
                }
                var rows = Array.prototype.slice.call(list.querySelectorAll('.order-row'));
                rows.sort(function (a, b) {
                  return priority(a) - priority(b) || String(a.textContent || '').localeCompare(String(b.textContent || ''));
                }).forEach(function (row) {
                  var action = row.querySelector('.order-action');
                  if (!action) {
                    action = document.createElement('span');
                    action.className = 'order-action';
                    row.insertBefore(action, row.firstChild);
                  }
                  var label = actionLabel(row);
                  action.textContent = label;
                  row.setAttribute('data-action', label.toLowerCase());
                  list.appendChild(row);
                });
                var pick = rows.filter(function (row) { return priority(row) === 0; }).length;
                var stage = rows.filter(function (row) { return priority(row) === 1; }).length;
                var ship = rows.filter(function (row) { return priority(row) === 2; }).length;
                counts.innerHTML = [
                  pick ? '<span class="pill">Pick ' + pick + '</span>' : '',
                  stage ? '<span class="pill">Stage ' + stage + '</span>' : '',
                  ship ? '<span class="pill">Ship ' + ship + '</span>' : ''
                ].filter(Boolean).join('');
                if (search && !search.__wms365WorkerBound) {
                  search.__wms365WorkerBound = true;
                  search.addEventListener('input', function () {
                    var query = String(search.value || '').trim().toUpperCase();
                    rows.forEach(function (row) {
                      row.style.display = !query || String(row.textContent || '').toUpperCase().indexOf(query) >= 0 ? '' : 'none';
                    });
                  });
                  search.addEventListener('keydown', function (event) {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    var query = String(search.value || '').trim().toUpperCase();
                    var match = rows.find(function (row) {
                      var strong = row.querySelector('strong');
                      return strong && String(strong.textContent || '').trim().toUpperCase() === query;
                    });
                    if (match) match.click();
                  });
                }
                setHardwareScannerButtons();
                armHardwareScannerInputs(['confirmLocation', 'confirmSku', 'confirmLot']);
                var pickCard = document.getElementById('pickCard');
                var orderPicker = document.getElementById('orderPickerWrap');
                var activePick = pickCard && !pickCard.classList.contains('hidden');
                document.body.classList.toggle('picking-active', !!activePick);
                if (orderPicker && activePick) orderPicker.classList.add('hidden');
              }
              window.__wms365WorkerOptimize = optimizePickQueueForWorker;
              window.setTimeout(optimizePickQueueForWorker, 900);
              window.setTimeout(optimizePickQueueForWorker, 2500);
              window.setTimeout(optimizePickQueueForWorker, 6000);
              window.setInterval(optimizePickQueueForWorker, 1800);
              if (path.indexOf('/mobile-count') === 0) {
                var top = document.querySelector('.top');
                if (top && !top.querySelector('.appbar')) {
                  var appbar = document.createElement('div');
                  appbar.className = 'appbar';
                  appbar.innerHTML = '<img src="/marketing-logo.svg" alt="WMS365 logo" width="32" height="32"><div class="appbar-copy"><div class="kicker">WMS365</div><div class="title-text">WMS365 Scanner</div></div><span class="badge">Count</span>';
                  top.insertBefore(appbar, top.firstChild);
                  var oldTitle = top.querySelector('.title');
                  if (oldTitle) oldTitle.style.display = 'none';
                }
              }
              if (path.indexOf('/mobile-pick') === 0 || path.indexOf('/mobile-count') === 0) {
                var switchButton = document.getElementById('switchCompanyBtn');
                if (switchButton) switchButton.textContent = 'Switch';
                var lock = document.getElementById('lockedCompanyWrap') || document.querySelector('.locked');
                if (lock && !document.getElementById('wms365AndroidMenuBtn')) {
                  var menuButton = document.createElement('button');
                  menuButton.id = 'wms365AndroidMenuBtn';
                  menuButton.type = 'button';
                  menuButton.className = switchButton ? switchButton.className : 'btn ghost';
                  menuButton.textContent = 'Menu';
                  menuButton.onclick = function () {
                    var company = '';
                    var label = document.getElementById('lockedCompanyLabel');
                    if (label) company = (label.textContent || '').trim();
                    var query = company && company !== '-' ? '?mode=mobile&accountName=' + encodeURIComponent(company) : '?mode=mobile';
                    location.href = '/mobile' + query;
                  };
                  if (switchButton && switchButton.parentNode) switchButton.parentNode.insertBefore(menuButton, switchButton);
                  else lock.appendChild(menuButton);
                }
                var orderCode = document.getElementById('orderCode');
                var summary = document.getElementById('orderSummaryCard');
                if (summary && orderCode && /No order loaded/i.test(orderCode.textContent || '')) summary.style.display = 'none';
              }
              function clearStaleCountLoading() {
                if ((location.pathname || '').indexOf('/mobile-count') !== 0) return;
                var locationInput = document.getElementById('locationInput');
                var skuInput = document.getElementById('skuInput');
                var casesInput = document.getElementById('casesInput');
                if (locationInput) locationInput.placeholder = 'Scan or key location';
                if (skuInput) skuInput.placeholder = 'Scan or key SKU';
                if (casesInput) casesInput.placeholder = 'Counted cases';
                var message = document.getElementById('message');
                var locked = document.getElementById('lockedCompanyLabel');
                setHardwareScannerButtons();
                armHardwareScannerInputs(['locationInput', 'skuInput', 'lotInput']);
                var itemSummary = document.getElementById('itemSummary');
                if (itemSummary && skuInput) itemSummary.classList.toggle('hidden', !String(skuInput.value || '').trim());
                document.body.classList.toggle('count-active', !!(locked && (locked.textContent || '').trim()));
                if (message && locked && (locked.textContent || '').trim() && /Loading company data/i.test(message.textContent || '')) {
                  message.className = 'status good';
                  message.textContent = 'Ready to count.';
                }
              }
              clearStaleCountLoading();
              window.setTimeout(clearStaleCountLoading, 1200);
              window.setTimeout(clearStaleCountLoading, 3500);
              if (path.indexOf('/mobile-count') === 0 || path.indexOf('/mobile-pick') === 0) {
                setHardwareScannerButtons();
                armHardwareScannerInputs(['confirmLocation', 'confirmSku', 'confirmLot', 'locationInput', 'skuInput', 'lotInput']);
              }
              function androidWarmWarehouseData(reason) {
                if (!window.WMS365Mobile) return;
                if (typeof window.WMS365Mobile.preloadWarehouseData === 'function') {
                  window.WMS365Mobile.preloadWarehouseData({ reason: reason || 'android-page' }).catch(function () {});
                }
                if (window.__wms365AndroidWarmRunning) return;
                window.__wms365AndroidWarmRunning = true;
                var normalize = function (value) { return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase(); };
                var company = '';
                try { company = normalize(window.WMS365Mobile.getCompanyContext && window.WMS365Mobile.getCompanyContext()); } catch (error) {}
                var fetchJson = function (url) {
                  return fetch(url, { cache: 'no-store', headers: { 'Content-Type': 'application/json' } })
                    .then(function (response) { return response.text().then(function (text) {
                      var data = {};
                      try { data = text ? JSON.parse(text) : {}; } catch (error) { data = {}; }
                      if (!response.ok) throw new Error(data.error || ('Request failed (' + response.status + ')'));
                      return data;
                    }); });
                };
                var cacheData = function (key, payload) {
                  if (!window.WMS365Mobile || typeof window.WMS365Mobile.cacheData !== 'function') return Promise.resolve(null);
                  return window.WMS365Mobile.cacheData(key, payload).catch(function () { return null; });
                };
                var matchesCompany = function (record, name) {
                  if (!name) return true;
                  return [
                    record && record.accountName,
                    record && record.account_name,
                    record && record.owner,
                    record && record.ownerName,
                    record && record.company,
                    record && record.companyName,
                    record && record.customer,
                    record && record.customerName
                  ].map(normalize).filter(Boolean).indexOf(name) >= 0;
                };
                var fastSlice = function (compact, name) {
                  var masters = compact.masters || {};
                  var ownerRecords = masters.ownerRecords || [];
                  var locations = (masters.locations || []).filter(function (location) {
                    return matchesCompany(location, name) || !normalize(location.accountName || location.owner || location.companyName);
                  });
                  return {
                    accountName: name,
                    cachedAt: new Date().toISOString(),
                    inventory: (compact.inventory || []).filter(function (line) { return matchesCompany(line, name); }),
                    inventoryCounts: (compact.inventoryCounts || []).filter(function (count) { return matchesCompany(count, name); }),
                    warehouseTasks: (compact.warehouseTasks || []).filter(function (task) { return matchesCompany(task, name); }),
                    pallets: (compact.pallets || []).filter(function (pallet) { return matchesCompany(pallet, name); }),
                    items: (masters.items || []).filter(function (item) { return matchesCompany(item, name); }),
                    locations: locations,
                    ownerRecord: ownerRecords.find(function (owner) { return matchesCompany(owner, name); }) || null,
                    fulfillmentLocations: (masters.companyFulfillmentLocations || []).filter(function (location) { return matchesCompany(location, name); }),
                    partners: masters.partners || [],
                    session: compact.session || {},
                    meta: compact.meta || {}
                  };
                };
                fetchJson('/api/state').then(function (payload) {
                  var compact = {
                    inventory: payload.inventory || [],
                    inventoryCounts: payload.inventoryCounts || [],
                    warehouseTasks: payload.warehouseTasks || [],
                    pallets: payload.pallets || [],
                    activity: payload.activity || [],
                    masters: payload.masters || {},
                    billing: payload.billing || {},
                    session: payload.session || {},
                    meta: payload.meta || {}
                  };
                  var companies = []
                    .concat((compact.masters && compact.masters.owners) || [])
                    .concat((compact.inventory || []).map(function (line) { return line.accountName; }))
                    .concat((compact.inventoryCounts || []).map(function (count) { return count.accountName; }))
                    .concat((compact.warehouseTasks || []).map(function (task) { return task.accountName; }))
                    .map(normalize).filter(Boolean);
                  companies = Array.from(new Set(companies));
                  var warmCompanies = company ? [company] : companies.slice(0, 3);
                  var fetchPickOrders = function (name) {
                    var query = name ? '?account_name=' + encodeURIComponent(name) + '&accountName=' + encodeURIComponent(name) : '';
                    return fetchJson('/api/mobile/pick-orders' + query).catch(function (error) {
                      if (!/404|Cannot GET/i.test(String(error && error.message || ''))) throw error;
                      var fallback = name ? '?accountName=' + encodeURIComponent(name) + '&account_name=' + encodeURIComponent(name) : '';
                      return fetchJson('/api/admin/portal-orders' + fallback);
                    });
                  };
                  var slices = companies.map(function (name) {
                    var slice = fastSlice(compact, name);
                    return cacheData('warehouse-fast:' + name, slice).then(function () {
                      return {
                        accountName: name,
                        inventory: slice.inventory.length,
                        counts: slice.inventoryCounts.length,
                        tasks: slice.warehouseTasks.length,
                        items: slice.items.length,
                        locations: slice.locations.length,
                        pallets: slice.pallets.length
                      };
                    });
                  });
                  return cacheData('warehouse-state-v1', compact).then(function () {
                    return Promise.all(slices).then(function (sliceSummary) {
                      return cacheData('warehouse-company-index-v1', { companies: companies, slices: sliceSummary, cachedAt: new Date().toISOString() });
                    });
                  }).then(function () {
                    return Promise.all(warmCompanies.map(function (name) {
                      return fetchPickOrders(name).then(function (ordersPayload) {
                        return cacheData('mobile-pick-orders:' + (name || 'all'), Object.assign({}, ordersPayload, { accountName: name, cachedAt: new Date().toISOString() }));
                      }).catch(function () {});
                    })).then(function () {
                      return cacheData('warehouse-preload-v1', { ok: true, reason: reason || 'android-page', company: company, companies: companies, companySlicesCached: companies.length, completedAt: new Date().toISOString() });
                    });
                  });
                }).catch(function (error) {
                  cacheData('warehouse-preload-v1', { ok: false, reason: reason || 'android-page', company: company, error: error.message || 'Preload failed', completedAt: new Date().toISOString() });
                }).finally(function () {
                  window.__wms365AndroidWarmRunning = false;
                });
              }
              window.__wms365AndroidWarmData = androidWarmWarehouseData;
              androidWarmWarehouseData('android-page');
            })();
        """.trimIndent()
        webView.evaluateJavascript(script, null)
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
                deliverScanToWeb(pendingScanTargetId, value)
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

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && pendingScanTargetId.isNotBlank() && hasHardwareScannerDevice()) {
            if (event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_TAB) {
                flushHardwareScanBuffer()
                return true
            }
            val character = event.unicodeChar
            if (character >= 32) {
                hardwareScanBuffer.append(character.toChar())
                hardwareScanHandler.removeCallbacks(hardwareScanFlushRunnable)
                hardwareScanHandler.postDelayed(hardwareScanFlushRunnable, 140)
                return true
            }
        }
        return super.dispatchKeyEvent(event)
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

    private fun hasHardwareScannerDevice(): Boolean {
        val fingerprint = listOf(
            Build.MANUFACTURER,
            Build.BRAND,
            Build.MODEL,
            Build.DEVICE,
            Build.PRODUCT
        ).joinToString(" ").lowercase()
        val scannerMarkers = listOf(
            "rs60",
            "chainway",
            "zebra",
            "honeywell",
            "datalogic",
            "newland",
            "urovo",
            "unitech",
            "seuic",
            "cipherlab",
            "point mobile",
            "mobilebase",
            "sunmi",
            "scanpal"
        )
        return scannerMarkers.any { fingerprint.contains(it) }
    }

    private fun scannerProfile(): String {
        return if (hasHardwareScannerDevice()) "hardware_wedge" else "camera"
    }

    private fun flushHardwareScanBuffer() {
        val value = hardwareScanBuffer.toString().trim()
        hardwareScanBuffer.setLength(0)
        if (value.isBlank() || pendingScanTargetId.isBlank()) return
        deliverScanToWeb(pendingScanTargetId, value)
        pendingScanTargetId = ""
    }

    private fun deliverScanToWeb(targetId: String, value: String) {
        val safeTarget = targetId.replace("\\", "\\\\").replace("'", "\\'")
        val safeValue = value.replace("\\", "\\\\").replace("'", "\\'")
        webView.evaluateJavascript("window.wms365ReceiveAndroidScan && window.wms365ReceiveAndroidScan('$safeTarget','$safeValue');", null)
        vibrate(45)
        beep("success")
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun scanBarcode(targetId: String) {
            runOnUiThread {
                pendingScanTargetId = targetId
                hardwareScanBuffer.setLength(0)
                if (hasHardwareScannerDevice()) {
                    webView.requestFocus()
                    Toast.makeText(this@MainActivity, "Press the hardware scan trigger.", Toast.LENGTH_SHORT).show()
                    return@runOnUiThread
                }
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    Toast.makeText(this@MainActivity, "Allow camera, then tap Scan again.", Toast.LENGTH_SHORT).show()
                    ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.CAMERA), cameraPermissionRequest)
                    return@runOnUiThread
                }
                IntentIntegrator(this@MainActivity)
                    .setCaptureActivity(PortraitCaptureActivity::class.java)
                    .setDesiredBarcodeFormats(IntentIntegrator.ALL_CODE_TYPES)
                    .setPrompt("Hold phone upright and scan barcode")
                    .setBeepEnabled(false)
                    .setOrientationLocked(true)
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
        fun getDeviceManufacturer(): String = Build.MANUFACTURER ?: ""

        @JavascriptInterface
        fun getDeviceBrand(): String = Build.BRAND ?: ""

        @JavascriptInterface
        fun hasHardwareScanner(): Boolean = this@MainActivity.hasHardwareScannerDevice()

        @JavascriptInterface
        fun getScannerProfile(): String = this@MainActivity.scannerProfile()

        @JavascriptInterface
        fun getDeviceModel(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

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
