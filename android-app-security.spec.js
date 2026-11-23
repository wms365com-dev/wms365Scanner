"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const root = "android-app/app/src/main/";
const activity = fs.readFileSync(`${root}java/com/wms365/app/MainActivity.kt`, "utf8");
const policy = fs.readFileSync(`${root}java/com/wms365/app/AppUrlPolicy.kt`, "utf8");
const manifest = fs.readFileSync(`${root}AndroidManifest.xml`, "utf8");
const build = fs.readFileSync("android-app/app/build.gradle", "utf8");
const cloudTests = fs.readFileSync("android-app/app/src/androidTest/java/com/wms365/app/CloudSmokeTest.kt", "utf8");

test("Android variants use one configured HTTPS origin and audience-scoped deep links", () => {
    assert.match(activity, /AppUrlPolicy\(BuildConfig\.WMS365_BASE_URL, BuildConfig\.WMS365_APP_MODE\)/);
    assert.match(activity, /urlPolicy\.allowsDeepLink\(deepLink\.toString\(\)\)/);
    assert.match(policy, /appMode != "customer_portal" \|\| isCustomerPortalPath/);
    assert.match(policy, /path\?\.startsWith\("\/api\/portal\/"\)/);
    assert.match(build, /applicationId "com\.wms365\.warehouse"/);
    assert.match(build, /applicationId "com\.wms365\.customerportal"/);
    assert.match(build, /WMS365_START_PATH.*\/portal\.html/);
    assert.match(policy, /uri\.rawUserInfo == null/);
    assert.match(policy, /uri\.port == -1 \|\| uri\.port == 443/);
    assert.doesNotMatch(activity, /allowedHosts/);
    assert.match(manifest, /android:usesCleartextTraffic="false"/);
    assert.match(manifest, /android:allowBackup="false"/);
});

test("Android camera grants are origin scoped and never grant all requested resources", () => {
    assert.match(activity, /!isApprovedUri\(request\.origin\)/);
    assert.match(activity, /request\.grant\(arrayOf\(PermissionRequest\.RESOURCE_VIDEO_CAPTURE\)\)/);
    assert.match(activity, /urlPolicy\.allows\(webView\.url\.orEmpty\(\)\)/);
    assert.doesNotMatch(activity, /request\.grant\(request\.resources\)/);
    assert.match(activity, /onPermissionRequestCanceled/);
});

test("Android HTTP and certificate failures show recoverable errors without insecure fallback", () => {
    assert.match(activity, /onReceivedHttpError[\s\S]*?if \(!request\.isForMainFrame\) return/);
    for (const status of ["401", "403", "429", "500..599"]) assert.ok(activity.includes(status));
    assert.match(activity, /override fun onReceivedSslError[\s\S]*?handler\.cancel\(\)/);
    assert.doesNotMatch(activity, /handler\.proceed\(\)/);
    assert.match(activity, /errorOverlay\.getChildAt\(2\)\.visibility = View\.GONE/);
    assert.match(activity, /if \(pageLoadFailed \|\| url == null \|\| !urlPolicy\.allows\(url\)\) return/);
});

test("Android scan and document callbacks serialize arguments rather than hand escaping", () => {
    for (const value of ["targetId", "value", "callbackId", "source"]) {
        assert.ok(activity.includes(`JSONObject.quote(${value})`));
    }
    assert.match(activity, /wms365ReceiveAndroidScan\(\$safeTarget,\$safeValue\)/);
    assert.match(activity, /wms365ReceiveAndroidDocumentScan\(\$safeCallback,/);
    assert.doesNotMatch(activity, /wms365ReceiveAndroidScan\('\$safeTarget'/);
});

test("Android renderer recovery and activity cleanup do not erase queued warehouse data", () => {
    const recovery = activity.slice(activity.indexOf("override fun onRenderProcessGone"), activity.indexOf("webView.webChromeClient ="));
    assert.match(recovery, /root\.removeView\(view\)/);
    assert.match(recovery, /view\.destroy\(\)/);
    assert.match(recovery, /configureWebView\(\)/);
    assert.match(recovery, /Check the order status before repeating any action/);
    assert.doesNotMatch(recovery, /deleteAllData|removeAllCookies|clearWebData/);
    assert.match(activity, /override fun onDestroy[\s\S]*?removeCallbacksAndMessages\(null\)[\s\S]*?removeJavascriptInterface\("WMS365Android"\)/);
    for (const callback of ["onPageStarted", "onPageFinished", "onReceivedError", "onReceivedHttpError", "onReceivedSslError", "onRenderProcessGone"]) {
        assert.match(activity, new RegExp(`override fun ${callback}[^\\{]*\\{[\\s\\S]*?if \\(view !== webView\\) return`));
    }
    assert.match(cloudTests, /retiredClient\.onReceivedError/);
    assert.match(cloudTests, /Recovery instructions must persist after drawing/);
});

test("both Android variants require and resume Play-managed native updates", () => {
    assert.match(activity, /UpdateAvailability\.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS/);
    assert.match(activity, /isUpdateTypeAllowed\(AppUpdateType\.IMMEDIATE\)/);
    assert.match(activity, /startPlayUpdate\(info, AppUpdateType\.IMMEDIATE\)/);
    assert.match(activity, /requestCode == appUpdateRequest[\s\S]*?checkForAppUpdate\(false\)/);
    assert.match(activity, /AppUpdateType\.FLEXIBLE/);
    assert.match(activity, /webView\.visibility = if \(updateGatePassed\) View\.VISIBLE else View\.INVISIBLE/);
    assert.match(activity, /addOnFailureListener[\s\S]*?showRequiredUpdateError/);
    assert.match(activity, /private fun showRequiredUpdateError[\s\S]*?setCancelable\(false\)/);
    assert.match(activity, /private fun showCompleteUpdatePrompt[\s\S]*?setCancelable\(false\)/);
    assert.doesNotMatch(activity, /setNegativeButton\("Later"/);
});

test("Firebase smoke tests refuse the production origin and application identity", () => {
    assert.match(build, /applicationIdSuffix "\.testlab"/);
    assert.match(build, /WMS365_BASE_URL.*https:\/\/wms365-test\.invalid/);
    assert.match(build, /testInstrumentationRunner "androidx\.test\.runner\.AndroidJUnitRunner"/);
    assert.match(cloudTests, /check\(BuildConfig\.WMS365_BASE_URL == "https:\/\/wms365-test\.invalid"\)/);
    assert.match(cloudTests, /check\(instrumentation\.targetContext\.packageName == "com\.wms365\.app\.testlab"\)/);
    assert.ok(cloudTests.indexOf("check(BuildConfig.WMS365_BASE_URL") < cloudTests.indexOf("startActivitySync"));
    assert.equal((cloudTests.match(/@Test\s+fun test/g) || []).length, 6);
    assert.match(cloudTests, /captureScreen\("offline-recovery"\)/);
    assert.match(cloudTests, /captureScreen\("http-error-recovery"\)/);
    assert.match(cloudTests, /captureScreen\("renderer-recovery"\)/);
    assert.doesNotMatch(cloudTests, /app\.wms365\.co|password|access_token|api_key/i);
});
