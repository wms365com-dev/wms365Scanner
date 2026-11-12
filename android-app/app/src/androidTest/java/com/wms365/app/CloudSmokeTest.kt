package com.wms365.app

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import android.view.View
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@Suppress("DEPRECATION")
@RunWith(AndroidJUnit4::class)
class CloudSmokeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var activity: MainActivity

    @Before
    fun setUp() {
        check(BuildConfig.WMS365_BASE_URL == "https://wms365-test.invalid") {
            "Cloud tests require the isolated cloudTest build. Never run against a live backend."
        }
        check(instrumentation.targetContext.packageName == "com.wms365.app.testlab") {
            "Cloud tests require the separate testlab application identity."
        }
        val intent = Intent(instrumentation.targetContext, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity = instrumentation.startActivitySync(intent) as MainActivity
        instrumentation.waitForIdleSync()
    }

    @After
    fun tearDown() {
        if (::activity.isInitialized) instrumentation.runOnMainSync { activity.finish() }
    }

    private fun allViews(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { allViews(view.getChildAt(it)) } else emptyList()

    private fun root(): View = activity.findViewById(android.R.id.content)
    private fun web(): WebView = allViews(root()).filterIsInstance<WebView>().single()

    private fun hasVisibleText(value: String): Boolean {
        var found = false
        instrumentation.runOnMainSync {
            found = allViews(root()).filterIsInstance<TextView>().any { it.isShown && it.text.toString().contains(value) }
        }
        return found
    }

    private fun waitUntil(message: String, test: () -> Boolean) {
        val end = System.currentTimeMillis() + 35_000
        while (System.currentTimeMillis() < end) {
            if (test()) return
            Thread.sleep(200)
        }
        fail(message)
    }

    private fun captureScreen(name: String) {
        instrumentation.waitForIdleSync()
        // UI idleness alone does not guarantee that the updated text reached the display.
        val rendered = CountDownLatch(1)
        instrumentation.runOnMainSync {
            root().postOnAnimation { root().postOnAnimation { rendered.countDown() } }
        }
        check(rendered.await(5, TimeUnit.SECONDS)) { "Screen did not finish drawing" }
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(1_000, 5_000)
        Thread.sleep(1_000)
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "wms365-test-artifacts")
        check(directory.exists() || directory.mkdirs()) { "Unable to create synthetic screenshot directory" }
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot()) { "Device screenshot unavailable" }
        try {
            File(directory, "$name.png").outputStream().use { output ->
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) { "Screenshot capture failed" }
            }
        } finally { bitmap.recycle() }
    }

    private fun request(mainFrame: Boolean = true): WebResourceRequest = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse("${BuildConfig.WMS365_BASE_URL}/mobile")
        override fun isForMainFrame(): Boolean = mainFrame
        override fun isRedirect(): Boolean = false
        override fun hasGesture(): Boolean = false
        override fun getMethod(): String = "GET"
        override fun getRequestHeaders(): MutableMap<String, String> = mutableMapOf()
    }

    private fun httpError(status: Int, mainFrame: Boolean = true) {
        instrumentation.runOnMainSync {
            val view = web()
            view.stopLoading()
            view.webViewClient.onReceivedHttpError(view, request(mainFrame),
                WebResourceResponse("text/html", "UTF-8", status, "Test response", emptyMap(), ByteArrayInputStream(byteArrayOf())))
            view.webViewClient.onPageFinished(view, "${BuildConfig.WMS365_BASE_URL}/mobile")
        }
    }

    @Test
    fun testOfflineStartupProvidesRecovery() {
        waitUntil("Connection failure must offer recovery") { hasVisibleText("Connection Issue") }
        assertTrue(hasVisibleText("Retry"))
        assertTrue(hasVisibleText("Open workspace"))
        assertFalse(hasVisibleText("Loading mobile workspace"))
        captureScreen("offline-recovery")
    }

    @Test
    fun testHttpErrorsRemainVisibleAfterPageFinished() {
        waitUntil("Initial page did not settle") { hasVisibleText("Connection Issue") }
        for ((status, message) in listOf(401 to "session has ended", 403 to "Access restricted", 429 to "Too many requests", 503 to "temporarily unavailable")) {
            httpError(status)
            assertTrue("HTTP $status", hasVisibleText(message))
        }
        httpError(404, false)
        assertTrue("Asset failure must not replace the page error", hasVisibleText("temporarily unavailable"))
        captureScreen("http-error-recovery")
        assertTrue(hasVisibleText("temporarily unavailable"))
    }

    @Test
    fun testCameraRejectsUntrustedOriginsAndMicrophone() {
        for ((origin, resource) in listOf("https://untrusted.invalid" to PermissionRequest.RESOURCE_VIDEO_CAPTURE,
            BuildConfig.WMS365_BASE_URL to PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
            var denied = false
            var granted = false
            val permission = object : PermissionRequest() {
                override fun getOrigin(): Uri = Uri.parse(origin)
                override fun getResources(): Array<String> = arrayOf(resource)
                override fun grant(resources: Array<out String>) { granted = true }
                override fun deny() { denied = true }
            }
            instrumentation.runOnMainSync { web().webChromeClient!!.onPermissionRequest(permission) }
            assertTrue("Untrusted or unsupported request must be denied", denied)
            assertFalse(granted)
        }
    }

    @Test
    fun testDeepLinksDoNotChangeTrustedOrigin() {
        val method = MainActivity::class.java.getDeclaredMethod("resolveStartUrl", Intent::class.java).apply { isAccessible = true }
        val unrelated = Intent().setData(Uri.parse("https://untrusted.invalid/mobile?orderId=999"))
        val desktop = Intent().setData(Uri.parse("${BuildConfig.WMS365_BASE_URL}/desktop"))
        for (intent in listOf(unrelated, desktop)) {
            assertEquals("${BuildConfig.WMS365_BASE_URL}/mobile?mode=mobile", method.invoke(activity, intent))
        }
    }

    @Test
    fun testBarcodeCharactersReachWebViewUnchanged() {
        val loaded = CountDownLatch(1)
        instrumentation.runOnMainSync {
            web().loadDataWithBaseURL("${BuildConfig.WMS365_BASE_URL}/mobile", """
                <html><body class="app">Isolated Android test.
                <script>window.wms365ReceiveAndroidScan=function(target,value){window.testScan=[target,value];};</script>
                </body></html>
            """.trimIndent(), "text/html", "UTF-8", null)
        }
        waitUntil("Synthetic page did not finish loading") {
            var ready = false
            val checked = CountDownLatch(1)
            instrumentation.runOnMainSync {
                web().evaluateJavascript("typeof window.wms365ReceiveAndroidScan === 'function'") { result -> ready = result == "true"; checked.countDown() }
            }
            checked.await(3, TimeUnit.SECONDS) && ready
        }
        val target = "scan'field\\name"
        val value = "O'Brien\\case\nGS1\u001d123"
        val method = MainActivity::class.java.getDeclaredMethod("deliverScanToWeb", String::class.java, String::class.java).apply { isAccessible = true }
        var result = ""
        instrumentation.runOnMainSync {
            method.invoke(activity, target, value)
            web().evaluateJavascript("JSON.stringify(window.testScan)") { data -> result = data; loaded.countDown() }
        }
        assertTrue("Scan callback did not complete", loaded.await(5, TimeUnit.SECONDS))
        val decoded = JSONArray(JSONTokener(result).nextValue() as String)
        assertEquals(target, decoded.getString(0))
        assertEquals(value, decoded.getString(1))
    }

    @Test
    fun testRendererRecoveryKeepsWorkspaceControls() {
        waitUntil("Initial page did not settle") { hasVisibleText("Connection Issue") }
        var replaced = false
        instrumentation.runOnMainSync {
            val old = web()
            val retiredClient = old.webViewClient
            val recovered = retiredClient.onRenderProcessGone(old, object : RenderProcessGoneDetail() {
                override fun didCrash(): Boolean = true
                override fun rendererPriorityAtExit(): Int = 0
            })
            replaced = recovered && web() !== old
            // Retired screens can still deliver queued callbacks after renderer replacement.
            retiredClient.onReceivedError(old, -2, "Late synthetic error", "${BuildConfig.WMS365_BASE_URL}/mobile")
            retiredClient.onPageStarted(old, "${BuildConfig.WMS365_BASE_URL}/mobile", null)
            retiredClient.onPageFinished(old, "${BuildConfig.WMS365_BASE_URL}/mobile")
            retiredClient.onReceivedHttpError(old, request(),
                WebResourceResponse("text/html", "UTF-8", 503, "Late synthetic response", emptyMap(), ByteArrayInputStream(byteArrayOf())))
        }
        assertTrue(replaced)
        assertTrue(hasVisibleText("screen stopped unexpectedly"))
        assertTrue(hasVisibleText("Open workspace"))
        assertTrue(hasVisibleText("Check the order status"))
        captureScreen("renderer-recovery")
        assertTrue("Recovery instructions must persist after drawing", hasVisibleText("Check the order status"))
    }
}
