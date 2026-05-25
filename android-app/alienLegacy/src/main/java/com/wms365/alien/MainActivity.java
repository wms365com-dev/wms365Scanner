package com.wms365.alien;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Vibrator;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import com.alien.barcode.BarcodeCallback;
import com.alien.barcode.BarcodeReader;
import com.alien.common.KeyCode;
import com.barcode.BarcodeUtility;
import com.barcode.BarcodeUtility.ModuleType;

public class MainActivity extends Activity {
    private static final String TAG = "WMS365Alien";
    private static final String APPROVED_HOST = "app.wms365.co";
    private static final String SCAN_RESULT_ACTION = "com.wms365.alien.SCAN_RESULT";
    private static final String SCAN_RESULT_EXTRA = "barcode";
    private static final String RSCJA_KEY_DOWN_ACTION = "com.rscja.android.KEY_DOWN";
    private static final String PREFS_NAME = "wms365_alien_private";
    private static final String PREF_EMAIL = "saved_email";
    private static final String PREF_PASSWORD = "saved_password";

    private FrameLayout root;
    private WebView webView;
    private View loadingOverlay;
    private LinearLayout errorOverlay;
    private TextView errorText;
    private BarcodeReader barcodeReader;
    private String pendingScanTargetId = "";
    private boolean barcodeScanActive = false;
    private boolean scannerReceiversRegistered = false;
    private final Handler handler = new Handler();
    private long lastScannerKeyAt = 0L;
    private final BroadcastReceiver scannerResultReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String value = intent == null ? "" : intent.getStringExtra(SCAN_RESULT_EXTRA);
            if ((value == null || value.length() == 0) && intent != null && intent.getExtras() != null) {
                for (String key : intent.getExtras().keySet()) {
                    Object extra = intent.getExtras().get(key);
                    if (extra instanceof String && ((String) extra).trim().length() > 0) {
                        value = (String) extra;
                        break;
                    }
                }
            }
            Log.d(TAG, "Scanner broadcast received. hasValue=" + (value != null && value.trim().length() > 0));
            handleNativeBarcode(value);
        }
    };
    private final BroadcastReceiver rscjaKeyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            long now = System.currentTimeMillis();
            if (now - lastScannerKeyAt < 500L) return;
            lastScannerKeyAt = now;
            Log.d(TAG, "RSCJA scanner key broadcast received.");
            startNativeBarcodeScan("");
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        buildLayout();
        configureWebView();
        loadStartUrl(getIntent());
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerScannerReceivers();
        configureBarcodeUtility();
    }

    @Override
    protected void onPause() {
        stopNativeBarcodeScan();
        unregisterScannerReceivers();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        stopNativeBarcodeScan();
        unregisterScannerReceivers();
        super.onDestroy();
    }

    private void registerScannerReceivers() {
        if (scannerReceiversRegistered) return;
        registerReceiver(scannerResultReceiver, new IntentFilter(SCAN_RESULT_ACTION));
        registerReceiver(rscjaKeyReceiver, new IntentFilter(RSCJA_KEY_DOWN_ACTION));
        scannerReceiversRegistered = true;
    }

    private void unregisterScannerReceivers() {
        if (!scannerReceiversRegistered) return;
        try {
            unregisterReceiver(scannerResultReceiver);
        } catch (Throwable ignored) {
        }
        try {
            unregisterReceiver(rscjaKeyReceiver);
        } catch (Throwable ignored) {
        }
        scannerReceiversRegistered = false;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        loadStartUrl(intent);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (isAlienScanKey(event.getKeyCode())) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                Log.d(TAG, "Physical Alien scan key pressed: " + event.getKeyCode());
                startNativeBarcodeScan("");
            }
            return true;
        }
        if (event.getAction() == KeyEvent.ACTION_UP && event.getKeyCode() == KeyEvent.KEYCODE_F5) {
            startNativeBarcodeScan("");
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private boolean isAlienScanKey(int keyCode) {
        return keyCode == KeyCode.ALR_H450.SCAN
            || keyCode == KeyCode.ALR_H450.SIDE_LEFT
            || keyCode == KeyCode.ALR_H450.SIDE_RIGHT
            || keyCode == KeyCode.ALR_H460.SCAN
            || keyCode == KeyCode.ALR_H460.SIDE_LEFT_FUNC
            || keyCode == KeyCode.ALR_H460.HANDLE_TRIGGER
            || keyCode == 119;
    }

    private void buildLayout() {
        root = new FrameLayout(this);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        loadingOverlay = buildOverlay("WMS365 Scanner", "Loading Alien handheld mode...");
        root.addView(loadingOverlay);

        errorOverlay = buildOverlay("Connection Issue", "WMS365 could not load.");
        errorText = (TextView) errorOverlay.getChildAt(1);
        Button retry = new Button(this);
        retry.setText("Retry");
        retry.setOnClickListener(v -> {
            showError(false, "");
            showLoading(true);
            webView.reload();
        });
        errorOverlay.addView(retry);
        errorOverlay.setVisibility(View.GONE);
        root.addView(errorOverlay);
        setContentView(root);
    }

    private LinearLayout buildOverlay(String title, String message) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(36, 36, 36, 36);
        layout.setBackgroundColor(Color.rgb(244, 247, 249));
        layout.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextSize(24);
        titleView.setTextColor(Color.rgb(16, 32, 51));
        titleView.setGravity(Gravity.CENTER);
        layout.addView(titleView);

        TextView messageView = new TextView(this);
        messageView.setText(message);
        messageView.setTextSize(14);
        messageView.setTextColor(Color.rgb(100, 116, 139));
        messageView.setGravity(Gravity.CENTER);
        messageView.setPadding(0, 12, 0, 20);
        layout.addView(messageView);

        layout.addView(new ProgressBar(this));

        TextView versionView = new TextView(this);
        versionView.setText("Alien Legacy " + BuildConfig.VERSION_NAME);
        versionView.setTextSize(12);
        versionView.setTextColor(Color.rgb(100, 116, 139));
        versionView.setGravity(Gravity.CENTER);
        versionView.setPadding(0, 20, 0, 0);
        layout.addView(versionView);
        return layout;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setBuiltInZoomControls(false);
        settings.setSupportZoom(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " WMS365Alien/0.1 ALR-H450");

        webView.addJavascriptInterface(new AlienBridge(), "WMS365Android");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if (isApprovedUri(uri)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectAlienMode();
                injectAlienLegacyPageShims();
                showLoading(false);
                showError(false, "");
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showLoading(false);
                showError(true, isOnline() ? "WMS365 could not load. Check Wi-Fi and retry." : "Offline. Reconnect Wi-Fi and retry.");
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                String url = error == null ? "" : error.getUrl();
                Uri uri = url == null ? null : Uri.parse(url);
                if (isApprovedUri(uri)) {
                    handler.proceed();
                    return;
                }
                handler.cancel();
                showLoading(false);
                showError(true, "WMS365 secure connection failed.");
            }
        });
    }

    private boolean isApprovedUri(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        String host = uri.getHost();
        return "https".equalsIgnoreCase(scheme) && APPROVED_HOST.equalsIgnoreCase(host);
    }

    private void loadStartUrl(Intent intent) {
        showLoading(true);
        showError(false, "");
        String url = resolveStartUrl(intent);
        webView.loadUrl(url);
    }

    private String resolveStartUrl(Intent intent) {
        Uri deepLink = intent == null ? null : intent.getData();
        if (deepLink != null && isApprovedUri(deepLink)) {
            Uri.Builder builder = deepLink.buildUpon();
            if (deepLink.getQueryParameter("mode") == null) builder.appendQueryParameter("mode", "mobile");
            if (deepLink.getQueryParameter("device") == null) builder.appendQueryParameter("device", "alien");
            return builder.build().toString();
        }
        return BuildConfig.WMS365_BASE_URL + BuildConfig.WMS365_START_PATH;
    }

    private void injectAlienMode() {
        String script =
            "(function(){" +
            "document.body.classList.add('device-mobile','device-android','device-webview','device-profile-hardware-scanner','device-alien-legacy');" +
            "document.body.dataset.deviceProfile='alien-alr-h450';" +
            "var s=document.getElementById('wms365-alien-legacy-style');" +
            "if(!s){s=document.createElement('style');s.id='wms365-alien-legacy-style';document.head.appendChild(s);}" +
            "s.textContent=[" +
            "'body.device-alien-legacy button[data-scan-target]{font-weight:800!important}'," +
            "'body.device-alien-legacy input,body.device-alien-legacy select,body.device-alien-legacy textarea{font-size:18px!important}'," +
            "'body.device-alien-legacy .shell{width:100%!important;max-width:none!important;display:block!important;padding:0!important}'," +
            "'body.device-alien-legacy{margin:0!important;padding:0!important;width:100%!important;height:100%!important;overflow:hidden!important;background:#f4f7f9!important;color:#20303a!important}'," +
            "'body.device-alien-legacy .app{position:fixed!important;left:0!important;top:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;max-width:none!important;min-height:0!important;transform:none!important;overflow:hidden!important;background:#f4f7f9!important;border:0!important;border-radius:0!important;box-shadow:none!important}'," +
            "'body.device-alien-legacy .mobile-only{display:block!important}'," +
            "'body.device-alien-legacy .desktop-only,body.device-alien-legacy .desktop-complex,body.device-alien-legacy .hero,body.device-alien-legacy .tabbar,body.device-alien-legacy .desktop-nav,body.device-alien-legacy .desktop-factbox,body.device-alien-legacy .feedback-launcher{display:none!important}'," +
            "'body.device-alien-legacy .panel{display:none!important;position:absolute!important;left:0!important;top:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;overflow:auto!important;background:#f4f7f9!important;padding:0!important;margin:0!important}'," +
            "'body.device-alien-legacy .panel.active{display:block!important}'," +
            "'body.device-alien-legacy .mobile-screen-body,body.device-alien-legacy .mobile-home-card,body.device-alien-legacy .menu-stack,body.device-alien-legacy .mobile-menu-group,body.device-alien-legacy .form-grid,body.device-alien-legacy .action-grid,body.device-alien-legacy .search-grid,body.device-alien-legacy .section-grid,body.device-alien-legacy .inventory-grid,body.device-alien-legacy .backup-grid,body.device-alien-legacy .labels-tool-grid{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important}'," +
            "'body.device-alien-legacy .mobile-screen-body{padding:8px!important}'," +
            "'body.device-alien-legacy .card,body.device-alien-legacy .helper,body.device-alien-legacy .summary,body.device-alien-legacy .table-wrap,body.device-alien-legacy .quick-row{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;margin:0 0 8px 0!important;padding:10px!important;border:1px solid #d5dde4!important;border-radius:10px!important;background:#ffffff!important;box-shadow:none!important}'," +
            "'body.device-alien-legacy .mobile-appbar{display:block!important;padding:8px!important;margin:0 0 8px 0!important;border:1px solid #d5dde4!important;border-radius:10px!important;background:#ffffff!important}'," +
            "'body.device-alien-legacy .mobile-appbar-logo{width:28px!important;height:28px!important;vertical-align:middle!important;margin-right:8px!important}'," +
            "'body.device-alien-legacy .mobile-appbar-copy{display:inline-block!important;vertical-align:middle!important}'," +
            "'body.device-alien-legacy .mobile-appbar-badge{float:right!important;font-size:12px!important;margin-top:4px!important}'," +
            "'body.device-alien-legacy h1,body.device-alien-legacy h2,body.device-alien-legacy h3{margin:6px 0!important;color:#20303a!important;letter-spacing:0!important}'," +
            "'body.device-alien-legacy .lead,body.device-alien-legacy .meta,body.device-alien-legacy .menu-card-meta,body.device-alien-legacy .mobile-build-label{display:none!important}'," +
            "'body.device-alien-legacy .mobile-menu-group-title{margin:10px 0 4px!important;color:#657582!important;font-size:12px!important;font-weight:bold!important;text-transform:uppercase!important}'," +
            "'body.device-alien-legacy .btn,body.device-alien-legacy button{display:block!important;width:100%!important;min-height:48px!important;margin:0 0 8px 0!important;padding:10px!important;border-radius:10px!important;border:1px solid #48687d!important;background:#5c7b92!important;color:#ffffff!important;font-size:18px!important;font-weight:bold!important;text-align:left!important;box-sizing:border-box!important}'," +
            "'body.device-alien-legacy .btn.ghost,body.device-alien-legacy button.ghost{background:#ffffff!important;color:#20303a!important;border-color:#d5dde4!important}'," +
            "'body.device-alien-legacy .field,body.device-alien-legacy label{display:block!important;margin:0 0 8px 0!important;color:#20303a!important;font-weight:bold!important}'," +
            "'body.device-alien-legacy input,body.device-alien-legacy select,body.device-alien-legacy textarea{display:block!important;width:100%!important;max-width:100%!important;min-height:46px!important;margin:4px 0 8px 0!important;padding:8px!important;border:2px solid #d5dde4!important;border-radius:9px!important;background:#ffffff!important;color:#20303a!important;box-sizing:border-box!important}'," +
            "'body.device-alien-legacy .mobile-drill-menu,body.device-alien-legacy .mobile-drill-card,body.device-alien-legacy .mobile-subview{display:none!important}'," +
            "'body.device-alien-legacy .mobile-drill-menu.active,body.device-alien-legacy .mobile-drill-card.active,body.device-alien-legacy .mobile-subview.active{display:block!important}'," +
            "'body.device-alien-legacy .mobile-company-locked.hidden,body.device-alien-legacy #mobileCompanySelectWrap.hidden,body.device-alien-legacy #mobileLockCompanyBtn.hidden,body.device-alien-legacy .mobile-pending-panel.hidden{display:none!important}'," +
            "'html{height:auto!important;min-height:100%!important;overflow:auto!important}'," +
            "'body.device-alien-legacy:not(.alien-login-mode){height:auto!important;min-height:100%!important;overflow:auto!important;-webkit-overflow-scrolling:touch!important}'," +
            "'body.device-alien-legacy:not(.alien-login-mode) .app{position:static!important;left:auto!important;top:auto!important;right:auto!important;bottom:auto!important;height:auto!important;min-height:100%!important;overflow:visible!important}'," +
            "'body.device-alien-legacy:not(.alien-login-mode) .panel.active{position:static!important;height:auto!important;min-height:100%!important;overflow:visible!important}'," +
            "'body.device-alien-legacy .mobile-home-card,body.device-alien-legacy .mobile-screen-body{height:auto!important;min-height:0!important;overflow:visible!important}'," +
            "'body.device-alien-legacy .mobile-company-locked{display:block!important}'," +
            "'body.device-alien-legacy .mobile-company-locked .btn{display:block!important;width:100%!important;margin:8px 0 0 0!important;text-align:center!important}'," +
            "'body.device-alien-legacy .mobile-company-locked strong{display:block!important;font-size:18px!important;line-height:1.2!important;word-break:break-word!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-screen-body{padding:5px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-appbar{padding:5px!important;margin:0 0 3px 0!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-appbar-logo{width:22px!important;height:22px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-appbar-copy h1{font-size:20px!important;margin:0!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-home-card{padding:5px!important;margin:0!important}'," +
            "'body.device-alien-legacy #mobileHomePanel h1,body.device-alien-legacy #mobileHomePanel h2{display:none!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-company-locked{padding:5px!important;margin:0 0 3px 0!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-company-locked span{display:none!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-company-locked strong{font-size:14px!important;line-height:1.1!important}'," +
            "'body.device-alien-legacy #mobileHomePanel #mobileSwitchCompanyBtn{min-height:28px!important;margin:3px 0 0 0!important;padding:3px 8px!important;font-size:13px!important;text-align:center!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-menu-group-title{display:none!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .menu-card-btn{min-height:35px!important;margin:0 0 3px 0!important;padding:5px 9px!important;font-size:15px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .menu-card-title{display:block!important;line-height:1.15!important}'," +
            "'body.device-alien-legacy #mobileHomePanel button[data-mobile-subview-target=\"adjust\"],body.device-alien-legacy #mobileHomePanel button[data-mobile-nav=\"labels\"],body.device-alien-legacy #mobileHomePanel button[data-mobile-nav=\"scan\"]{display:none!important}'," +
            "'body.device-alien-legacy .footer,body.device-alien-legacy .footer-build,body.device-alien-legacy #appBuildFooter{display:none!important}'," +
            "'body.device-alien-legacy .mobile-panel-head{display:block!important;padding:5px 6px 0!important;margin:0!important}'," +
            "'body.device-alien-legacy .mobile-appbar{min-height:42px!important;padding:6px 8px!important;margin:0 0 6px 0!important;border-radius:8px!important}'," +
            "'body.device-alien-legacy .mobile-appbar-title,body.device-alien-legacy .mobile-appbar-copy strong{font-size:21px!important;line-height:1.1!important}'," +
            "'body.device-alien-legacy .mobile-appbar-kicker,body.device-alien-legacy .mobile-appbar-badge{display:none!important}'," +
            "'body.device-alien-legacy .mobile-screen-body{padding:6px!important}'," +
            "'body.device-alien-legacy .card{border-radius:8px!important;margin:0 0 7px 0!important;padding:10px 12px!important}'," +
            "'body.device-alien-legacy h1,body.device-alien-legacy h2{font-size:28px!important;line-height:1.1!important;margin:4px 0 10px!important}'," +
            "'body.device-alien-legacy h3{font-size:22px!important;line-height:1.1!important}'," +
            "'body.device-alien-legacy .btn,body.device-alien-legacy button{min-height:64px!important;padding:13px 16px!important;margin:0 0 9px 0!important;border-radius:8px!important;font-size:24px!important;line-height:1.15!important;text-align:left!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .menu-card-btn{min-height:64px!important;margin:0 0 6px 0!important;padding:13px 15px!important;font-size:24px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-screen-body{padding:6px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-appbar{min-height:34px!important;padding:5px 8px!important;margin:0 0 4px 0!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-appbar-logo{width:26px!important;height:26px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-appbar-copy h1{font-size:22px!important;line-height:1.05!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-home-card{padding:6px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-company-locked{padding:6px 10px!important;margin:0 0 6px 0!important;border-radius:8px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-company-locked strong{font-size:18px!important;line-height:1.15!important}'," +
            "'body.device-alien-legacy #mobileHomePanel #mobileSwitchCompanyBtn,body.device-alien-legacy #mobileHomePanel .mobile-company-locked .btn{min-height:38px!important;padding:7px 10px!important;margin:5px 0 0 0!important;font-size:17px!important;text-align:center!important}'," +
            "'body.device-alien-legacy .mobile-company-locked .btn,body.device-alien-legacy #menuBtn,body.device-alien-legacy #companyMenuBtn,body.device-alien-legacy #workMenuBtn,body.device-alien-legacy [data-mobile-home],body.device-alien-legacy [data-mobile-section-back]{min-height:44px!important;padding:8px 12px!important;font-size:19px!important;text-align:center!important}'," +
            "'body.device-alien-legacy .locked,body.device-alien-legacy #mobileCompanyLocked{padding:8px!important;margin:0 0 6px 0!important;border-radius:8px!important}'," +
            "'body.device-alien-legacy .locked strong,body.device-alien-legacy #mobileCompanyLockedLabel,body.device-alien-legacy #lockedCompanyLabel{font-size:20px!important;line-height:1.15!important;word-break:break-word!important}'," +
            "'body.device-alien-legacy label span,body.device-alien-legacy .field span{display:block!important;font-size:18px!important;letter-spacing:1px!important;text-transform:uppercase!important;color:#657582!important;margin:0 0 4px 0!important}'," +
            "'body.device-alien-legacy input,body.device-alien-legacy select,body.device-alien-legacy textarea{min-height:64px!important;padding:12px 14px!important;font-size:24px!important;border-radius:8px!important}'," +
            "'body.device-alien-legacy textarea{min-height:150px!important}'," +
            "'body.device-alien-legacy .action-scan-row{display:block!important}'," +
            "'body.device-alien-legacy #transferInventoryCard form>label:first-child,body.device-alien-legacy #putAwayInventoryCard form>label:first-child,body.device-alien-legacy #adjustInventoryCard form>label:first-child,body.device-alien-legacy #moveInventoryCard form>label:first-child,body.device-alien-legacy #searchFormCard form>label:first-child{display:none!important}'," +
            "'body.device-alien-legacy button[data-scan-target],body.device-alien-legacy button[data-action-scan-target],body.device-alien-legacy #mobileQuickInboundDocScanBtn{min-height:66px!important;background:#5c7b92!important;color:#fff!important;border-color:#48687d!important;font-size:25px!important}'," +
            "'body.device-alien-legacy #saveBtn,body.device-alien-legacy #mobileQuickInboundCreateBtn,body.device-alien-legacy button[type=\"submit\"]{min-height:70px!important;background:#255f46!important;border-color:#1d4f39!important;color:#fff!important;text-align:center!important}'," +
            "'body.device-alien-legacy #anotherSkuBtn,body.device-alien-legacy #nextLocationBtn{min-height:70px!important;text-align:center!important}'," +
            "'body.device-alien-legacy .status,body.device-alien-legacy .msg{display:block!important;min-height:44px!important;padding:10px 12px!important;margin:7px 0!important;border-radius:8px!important;font-size:20px!important;font-weight:bold!important}'," +
            "'body.device-alien-legacy .status.good,body.device-alien-legacy .msg.ok{background:#dcfce7!important;color:#14532d!important;border:2px solid #22c55e!important}'," +
            "'body.device-alien-legacy .status.bad,body.device-alien-legacy .msg.err{background:#fee2e2!important;color:#7f1d1d!important;border:2px solid #ef4444!important}'," +
            "'body.device-alien-legacy input[hidden],body.device-alien-legacy select[hidden],body.device-alien-legacy textarea[hidden]{display:none!important}'," +
            "'body.device-alien-legacy button.active,body.device-alien-legacy .menu-card-btn.active,body.device-alien-legacy input:focus,body.device-alien-legacy textarea:focus{box-shadow:inset 0 0 0 3px #f59e0b!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-appbar{min-height:30px!important;padding:4px 8px!important;margin:0 0 3px 0!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-appbar-logo{width:22px!important;height:22px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-appbar-copy h1{font-size:21px!important;line-height:1!important}'," +
            "'body.device-alien-legacy #mobileHomePanel h2{display:none!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-company-locked{padding:4px 8px!important;margin:0 0 5px 0!important;border-radius:8px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .mobile-company-locked strong{font-size:16px!important;line-height:1.08!important}'," +
            "'body.device-alien-legacy #mobileHomePanel #mobileSwitchCompanyBtn{height:32px!important;min-height:32px!important;max-height:32px!important;padding:0 8px!important;margin:4px 0 0 0!important;font-size:16px!important;text-align:center!important;line-height:32px!important}'," +
            "'body.device-alien-legacy #mobileHomePanel .menu-card-btn{display:flex!important;align-items:center!important;height:52px!important;min-height:52px!important;max-height:52px!important;margin:0 0 5px 0!important;padding:0 14px!important;font-size:21px!important;line-height:1.05!important}'," +
            "'body.device-alien-legacy #menuBtn,body.device-alien-legacy #companyMenuBtn,body.device-alien-legacy #workMenuBtn,body.device-alien-legacy #switchCompanyBtn,body.device-alien-legacy [data-mobile-home],body.device-alien-legacy [data-mobile-section-back]{min-height:42px!important;padding:7px 12px!important;font-size:18px!important;text-align:center!important}'," +
            "'body.device-alien-legacy .locked-actions button,body.device-alien-legacy .locked-actions .btn{min-height:42px!important;padding:7px 12px!important;font-size:18px!important;margin:0 0 6px 0!important;text-align:center!important}'," +
            "'body.device-alien-legacy.alien-login-mode{display:block!important;padding:8px!important;place-items:initial!important;overflow:auto!important}'," +
            "'body.device-alien-legacy.alien-login-mode .intro{display:none!important}'," +
            "'body.device-alien-legacy.alien-login-mode .card{display:block!important;width:100%!important;min-width:0!important;padding:14px!important;border-radius:12px!important}'," +
            "'body.device-alien-legacy.alien-login-mode .recovery-box,body.device-alien-legacy.alien-login-mode .card-links{display:none!important}'," +
            "'body.device-alien-legacy.alien-login-mode .card-head p{display:none!important}'," +
            "'body.device-alien-legacy.alien-login-mode button{min-height:48px!important}'" +
            "].join('\\n');" +
            "if(document.getElementById('loginForm')){document.body.classList.add('alien-login-mode');document.getElementById('loginForm').scrollIntoView(true);installAlienLegacyLoginShim();}" +
            "function installAlienLegacyLoginShim(){var f=document.getElementById('loginForm');if(!f||f.__alienShim)return;f.__alienShim=true;try{var savedEmail=window.WMS365Android&&window.WMS365Android.getSavedEmail?window.WMS365Android.getSavedEmail():'';var savedPassword=window.WMS365Android&&window.WMS365Android.getSavedPassword?window.WMS365Android.getSavedPassword():'';if(savedEmail&&f.email&&!f.email.value)f.email.value=savedEmail;if(savedPassword&&f.password&&!f.password.value)f.password.value=savedPassword;}catch(prefEx){}f.onsubmit=function(e){if(e&&e.preventDefault)e.preventDefault();var m=document.getElementById('message');var b=f.querySelector('button[type=submit]');var email=(f.email&&f.email.value||'').replace(/^\\s+|\\s+$/g,'');var password=f.password&&f.password.value||'';if(!email||!password){if(m){m.className='msg err';m.innerHTML='Email and password are required.';}return false;}if(m){m.className='msg';m.innerHTML='Signing in...';}if(b){b.disabled=true;b.innerHTML='Signing in...';}var xhr=new XMLHttpRequest();xhr.open('POST','/api/app/login',true);xhr.setRequestHeader('Content-Type','application/json');xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;var ok=xhr.status>=200&&xhr.status<300;if(!ok){var err='Login failed.';try{var data=JSON.parse(xhr.responseText||'{}');if(data&&data.error)err=data.error;}catch(ex){}if(m){m.className='msg err';m.innerHTML=err;}if(b){b.disabled=false;b.innerHTML='Sign in';}return;}try{if(window.WMS365Android&&window.WMS365Android.saveLogin)window.WMS365Android.saveLogin(email,password);}catch(saveEx){}if(m){m.className='msg ok';m.innerHTML='Login accepted. Opening warehouse app...';}var next='/mobile?mode=mobile&device=alien';try{var q=window.location.search||'';var match=q.match(/[?&]next=([^&]+)/);if(match&&match[1])next=decodeURIComponent(match[1]);}catch(ex2){}if(next.indexOf('?')===-1)next+='?mode=mobile&device=alien';else if(next.indexOf('device=')===-1)next+='&device=alien';window.location.href=next;};xhr.send(JSON.stringify({email:email,password:password}));return false;};}" +
            "installAlienLegacyMobileShim();" +
            "document.querySelectorAll('[data-scan-target]').forEach(function(b){b.textContent='Trigger';b.title='Tap, then press the Alien scanner trigger.';});" +
            "function hideAlienAccountLabels(){['transferAccount','putAwayAccount','adjustAccount','moveAccount','searchAccount','convertAccount','fullBinMoveAccount'].forEach(function(id){try{var input=document.getElementById(id);var p=input&&input.parentNode;if(p&&p.tagName&&p.tagName.toLowerCase()==='label')p.style.display='none';}catch(e){}});document.querySelectorAll('input[hidden]').forEach(function(input){try{var p=input.parentNode;if(p&&p.tagName&&p.tagName.toLowerCase()==='label')p.style.display='none';}catch(e){}});}" +
            "hideAlienAccountLabels();" +
            "document.querySelectorAll('input[id]').forEach(function(input){var text=(input.id+' '+(input.placeholder||'')).toLowerCase();if(/scan|sku|upc|location|bin|lot|order|reference/.test(text)){input.removeAttribute('readonly');input.setAttribute('autocomplete','off');input.setAttribute('autocorrect','off');input.setAttribute('spellcheck','false');}});" +
            "window.__wms365AlienLegacy=true;" +
            "function installAlienLegacyMobileShim(){if(window.__wms365AlienMobileShim)return;window.__wms365AlienMobileShim=true;var contextKey='wms365-mobile-company-context';function byId(id){return document.getElementById(id);}function qs(sel){return document.querySelector(sel);}function qsa(sel){return Array.prototype.slice.call(document.querySelectorAll(sel));}function urlCompany(){try{var m=(window.location.search||'').match(/[?&](accountName|account_name)=([^&]+)/);return m&&m[2]?decodeURIComponent(m[2].replace(/\\+/g,' ')):'';}catch(ex){return '';}}function getCompany(){try{var c=localStorage.getItem(contextKey)||urlCompany()||'';if(c)localStorage.setItem(contextKey,c);return c;}catch(ex){return urlCompany()||'';}}function setCompany(v){try{if(v)localStorage.setItem(contextKey,v);else localStorage.removeItem(contextKey);}catch(ex){}}function showPanel(name){qsa('.panel').forEach(function(p){p.classList.remove('active');});var panel=qs('[data-panel=\"'+name+'\"]')||byId('mobileHomePanel');if(panel){panel.classList.add('active');panel.scrollTop=0;}return panel;}function jumpTo(el){if(!el)return;setTimeout(function(){try{el.scrollIntoView(true);window.scrollBy(0,-6);}catch(e){}},80);}function setSubview(group,target){qsa('[data-mobile-subview-group=\"'+group+'\"]').forEach(function(el){el.classList.remove('active');});qsa('[data-mobile-subview-card-group=\"'+group+'\"],[data-mobile-subview-menu-group=\"'+group+'\"]').forEach(function(el){el.classList.add('active');});qsa('[data-mobile-subview=\"'+target+'\"]').forEach(function(el){if(el.getAttribute('data-mobile-subview-group')===group)el.classList.add('active');});qsa('[data-mobile-subview-btn-group=\"'+group+'\"]').forEach(function(btn){if(btn.getAttribute('data-mobile-subview-target')===target)btn.classList.add('active');else btn.classList.remove('active');});var active=qs('[data-mobile-subview-group=\"'+group+'\"][data-mobile-subview=\"'+target+'\"]');if(group==='actions'&&active){var menu=qs('[data-mobile-subview-menu-group=\"actions\"]');if(menu&&menu.parentNode&&active.parentNode!==menu.parentNode)menu.parentNode.insertBefore(active,menu);}jumpTo(active);}function updateCompanyUi(){var company=getCompany();var select=byId('mobileActiveCompany');if(select&&company)select.value=company;var locked=byId('mobileCompanyLocked');var wrap=byId('mobileCompanySelectWrap');var lock=byId('mobileLockCompanyBtn');var label=byId('mobileCompanyLockedLabel');if(locked){if(company)locked.classList.remove('hidden');else locked.classList.add('hidden');}if(wrap){if(company)wrap.classList.add('hidden');else wrap.classList.remove('hidden');}if(lock){if(company)lock.classList.add('hidden');else lock.classList.remove('hidden');}if(label)label.innerHTML=company||'Choose company';qsa('[data-mobile-nav],[data-mobile-link],#mobilePendingBtn').forEach(function(btn){if(company){btn.disabled=false;btn.removeAttribute('disabled');}else{btn.disabled=true;btn.setAttribute('disabled','disabled');}});qsa('input[id$=\"Account\"]').forEach(function(input){input.value=company;});}function loadCompanies(){var select=byId('mobileActiveCompany');if(!select||select.__alienLoaded)return;select.__alienLoaded=true;var xhr=new XMLHttpRequest();xhr.open('GET','/api/app/me',true);xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;try{var data=JSON.parse(xhr.responseText||'{}');var user=data.user||{};var list=(user.assignedCompanies||[]).concat(user.inheritedCompanies||[]);var seen={};for(var i=0;i<list.length;i++){var name=String(list[i]||'').replace(/^\\s+|\\s+$/g,'');if(!name||seen[name])continue;seen[name]=true;var opt=document.createElement('option');opt.value=name;opt.text=name;select.appendChild(opt);}var saved=getCompany();if(saved)select.value=saved;updateCompanyUi();}catch(ex){updateCompanyUi();}};xhr.send();}function handleButton(btn){if(!btn)return false;if(btn.id==='mobileLockCompanyBtn'){var select=byId('mobileActiveCompany');setCompany(select?select.value:'');updateCompanyUi();return true;}if(btn.id==='mobileSwitchCompanyBtn'){setCompany('');updateCompanyUi();return true;}if(btn.id==='mobilePendingBtn'){var pp=byId('mobilePendingPanel');if(pp)pp.classList.remove('hidden');return true;}if(btn.id==='mobilePendingCloseBtn'){var pc=byId('mobilePendingPanel');if(pc)pc.classList.add('hidden');return true;}if(btn.getAttribute('data-mobile-home')!==null||btn.getAttribute('data-mobile-section-back')!==null){showPanel('mobile-home');return true;}var section=btn.getAttribute('data-mobile-nav');if(section){showPanel(section);var group=btn.getAttribute('data-mobile-subview-group');var target=btn.getAttribute('data-mobile-subview-target');if(group&&target)setSubview(group,target);return true;}var sub=btn.getAttribute('data-mobile-subview-target');if(sub){setSubview(btn.getAttribute('data-mobile-subview-btn-group')||btn.getAttribute('data-mobile-subview-group')||'actions',sub);return true;}var href=btn.getAttribute('data-mobile-link');if(href){var company=getCompany();var sep=href.indexOf('?')===-1?'?':'&';window.location.href=href+sep+'mode=mobile&device=alien'+(company?'&accountName='+encodeURIComponent(company):'');return true;}var scan=btn.getAttribute('data-action-scan-target')||btn.getAttribute('data-scan-target');if(scan){var input=byId(scan);if(input){input.removeAttribute('readonly');input.focus();if(input.select)input.select();}try{if(window.WMS365Android&&window.WMS365Android.scanBarcode){window.WMS365Android.scanBarcode(scan);return true;}}catch(ex){}return true;}return false;}var touchStartX=0,touchStartY=0,touchMoved=false,suppressNextClick=false;function rememberTouch(ev){var t=ev.touches&&ev.touches[0];if(t){touchStartX=t.clientX;touchStartY=t.clientY;touchMoved=false;}}function markTouchMove(ev){var t=ev.touches&&ev.touches[0];if(t&&(Math.abs(t.clientX-touchStartX)>12||Math.abs(t.clientY-touchStartY)>12))touchMoved=true;}function nearestButton(node){while(node&&node!==document){if(node.tagName&&node.tagName.toLowerCase()==='button')return node;node=node.parentNode;}return null;}function delegated(ev){if(ev&&ev.type==='touchend'&&touchMoved){touchMoved=false;suppressNextClick=true;setTimeout(function(){suppressNextClick=false;},350);return true;}if(ev&&ev.type==='click'&&suppressNextClick){suppressNextClick=false;return true;}var btn=nearestButton(ev.target);if(handleButton(btn)){if(ev.preventDefault)ev.preventDefault();if(ev.stopPropagation)ev.stopPropagation();return false;}return true;}showPanel('mobile-home');loadCompanies();updateCompanyUi();if(!document.__alienDelegate){document.__alienDelegate=true;document.addEventListener('touchstart',rememberTouch,true);document.addEventListener('touchmove',markTouchMove,true);document.addEventListener('click',delegated,true);document.addEventListener('touchend',delegated,true);}}" +
            "})();";
        evaluate(script);
    }

    private void focusLikelyScanField() {
        evaluate("(function(){var e=document.activeElement;if(e&&/input|textarea/i.test(e.tagName||'')){e.focus();return true;}var ids=['confirmLocation','confirmSku','locationInput','skuInput','orderSearch','scanLocation','scanUpc','scanSku','transferFrom','transferTo','transferSku','putAwayFrom','putAwayTo','putAwaySku'];for(var i=0;i<ids.length;i++){var el=document.getElementById(ids[i]);if(el&&el.offsetParent!==null&&!el.disabled){el.removeAttribute('readonly');el.focus();if(el.select)el.select();return true;}}return false;})();");
    }

    private void startNativeBarcodeScan(String targetId) {
        pendingScanTargetId = targetId == null ? "" : targetId;
        focusScanTarget(pendingScanTargetId);
        hideSoftKeyboard();
        stopNativeBarcodeScan();
        try {
            if (barcodeReader == null) barcodeReader = new BarcodeReader(this);
            barcodeReader.setAllSymbologies(true);
            barcodeScanActive = true;
            barcodeReader.start(new BarcodeCallback() {
                @Override
                public void onBarcodeRead(String barcode) {
                    Log.d(TAG, "Direct SDK barcode callback received.");
                    handleNativeBarcode(barcode);
                }
            });
            triggerBarcodeUtilityScan();
            handler.postDelayed(() -> {
                if (barcodeScanActive) {
                    stopNativeBarcodeScan();
                    Toast.makeText(MainActivity.this, "Scan timed out.", Toast.LENGTH_SHORT).show();
                }
            }, 12000);
            Log.d(TAG, "Native scanner started for target=" + pendingScanTargetId);
            Toast.makeText(this, "Scanning...", Toast.LENGTH_SHORT).show();
        } catch (Throwable scannerError) {
            Log.e(TAG, "Native scanner failed.", scannerError);
            barcodeScanActive = false;
            Toast.makeText(this, "Scanner unavailable. Use trigger/key in.", Toast.LENGTH_LONG).show();
        }
    }

    private void stopNativeBarcodeScan() {
        barcodeScanActive = false;
        try {
            if (barcodeReader != null) barcodeReader.stop();
        } catch (Throwable ignored) {
        }
        try {
            BarcodeUtility.getInstance().stopScan(getApplicationContext(), ModuleType.AUTOMATIC_ADAPTATION);
        } catch (Throwable ignored) {
        }
    }

    private void configureBarcodeUtility() {
        try {
            BarcodeUtility utility = BarcodeUtility.getInstance();
            Context context = getApplicationContext();
            utility.open(context, ModuleType.AUTOMATIC_ADAPTATION);
            utility.setScanOutTime(context, 8000);
            utility.enablePlaySuccessSound(context, true);
            utility.enablePlayFailureSound(context, true);
            utility.enableVibrate(context, true);
            utility.enableEnter(context, true);
            utility.enableTAB(context, false);
            utility.setScanResultBroadcast(context, SCAN_RESULT_ACTION, SCAN_RESULT_EXTRA);
            utility.setOutputMode(context, 0);
            Log.d(TAG, "Barcode utility configured for keyboard-wedge scan results.");
        } catch (Throwable error) {
            Log.e(TAG, "Barcode utility configuration failed.", error);
        }
    }

    private void triggerBarcodeUtilityScan() {
        try {
            configureBarcodeUtility();
            BarcodeUtility.getInstance().startScan(getApplicationContext(), ModuleType.AUTOMATIC_ADAPTATION);
            Log.d(TAG, "Barcode utility startScan sent.");
        } catch (Throwable error) {
            Log.e(TAG, "Barcode utility startScan failed.", error);
        }
    }

    private void hideSoftKeyboard() {
        try {
            InputMethodManager inputMethodManager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            View view = getCurrentFocus();
            if (inputMethodManager != null && view != null) {
                inputMethodManager.hideSoftInputFromWindow(view.getWindowToken(), 0);
            }
        } catch (Throwable ignored) {
        }
    }

    private void focusScanTarget(String targetId) {
        final String id = targetId == null ? "" : targetId;
        evaluate("(function(){var el=document.getElementById(" + jsString(id) + ");if(!el){var e=document.activeElement;if(e&&/input|textarea/i.test(e.tagName||''))el=e;}if(el){el.removeAttribute('readonly');el.focus();if(el.select)el.select();}return true;})();");
        handler.postDelayed(this::hideSoftKeyboard, 350);
    }

    private void handleNativeBarcode(String barcode) {
        final String value = barcode == null ? "" : barcode.trim();
        if (!value.isEmpty()) {
            try {
                Vibrator vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (vibrator != null) vibrator.vibrate(60);
            } catch (Throwable ignored) {
            }
        }
        evaluate(
            "(function(){var target=" + jsString(pendingScanTargetId) + ";" +
            "var value=" + jsString(value) + ";" +
            "function clean(v){return String(v||'').replace(/[\\u0000-\\u001f\\u007f]/g,'').replace(/^\\s+|\\s+$/g,'').toUpperCase();}" +
            "function visibleId(id){var n=document.getElementById(id);return !!(n&&!n.disabled&&!n.closest('.hidden')&&n.offsetParent!==null);}" +
            "function resolveTarget(requested){requested=String(requested||'').replace(/^\\s+|\\s+$/g,'');var active=(document.activeElement&&document.activeElement.id)||'';var fields=['orderSearch','confirmLocation','confirmSku','confirmLot','confirmExpiration','locationInput','skuInput','lotInput','expirationInput','mobileQuickInboundReference','mobileQuickInboundSku'];if(fields.indexOf(requested)>=0&&visibleId(requested))return requested;if(fields.indexOf(active)>=0&&visibleId(active))return active;var pick=document.getElementById('pickCard');var activePick=pick&&!pick.classList.contains('hidden');if(activePick){if(visibleId('confirmLocation')&&!clean((document.getElementById('confirmLocation')||{}).value))return 'confirmLocation';if(visibleId('confirmSku')&&!clean((document.getElementById('confirmSku')||{}).value))return 'confirmSku';if(visibleId('confirmLot')&&!clean((document.getElementById('confirmLot')||{}).value))return 'confirmLot';if(visibleId('confirmExpiration')&&!clean((document.getElementById('confirmExpiration')||{}).value))return 'confirmExpiration';return visibleId('confirmSku')?'confirmSku':'confirmLocation';}if(visibleId('locationInput')&&!clean((document.getElementById('locationInput')||{}).value))return 'locationInput';if(visibleId('skuInput')&&!clean((document.getElementById('skuInput')||{}).value))return 'skuInput';if(visibleId('orderSearch'))return 'orderSearch';return requested;}" +
            "target=resolveTarget(target);" +
            "if(window.wms365ReceiveAndroidScan&&(location.pathname||'').indexOf('/mobile-')===0){window.wms365ReceiveAndroidScan(target,value);return;}" +
            "var el=target?document.getElementById(target):null;" +
            "if(!el){var e=document.activeElement;if(e&&/input|textarea/i.test(e.tagName||''))el=e;}" +
            "if(el){el.removeAttribute('readonly');el.focus();el.value=value;" +
            "['input','change'].forEach(function(name){var ev=document.createEvent('HTMLEvents');ev.initEvent(name,true,false);el.dispatchEvent(ev);});" +
            "try{var kev;if(typeof KeyboardEvent==='function'){kev=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true});}else{kev=document.createEvent('HTMLEvents');kev.initEvent('keydown',true,true);kev.keyCode=13;kev.which=13;}el.dispatchEvent(kev);}catch(enterEx){}" +
            "var id=el.id||'';function visible(next){return next&&next.offsetParent!==null&&!next.disabled;}function firstVisible(ids){for(var i=0;i<ids.length;i++){var n=document.getElementById(ids[i]);if(visible(n))return n;}return null;}function go(next){if(visible(next)){setTimeout(function(){next.focus();if(next.scrollIntoView)next.scrollIntoView(true);},60);}}" +
            "if(id==='confirmLocation')go(document.getElementById('confirmSku'));" +
            "else if(id==='confirmSku')go(firstVisible(['confirmLot','confirmExpiration','confirmQty','confirmPickBtn']));" +
            "else if(id==='confirmLot')go(firstVisible(['confirmExpiration','confirmQty','confirmPickBtn']));" +
            "else if(id==='confirmExpiration')go(document.getElementById('confirmQty'));" +
            "else if(id==='confirmQty'){var btn=document.getElementById('confirmPickBtn');if(btn)setTimeout(function(){btn.click();},80);}" +
            "}" +
            "if(window.WMS365Android&&window.WMS365Android.vibrate)window.WMS365Android.vibrate(60);" +
            "})();"
        );
        stopNativeBarcodeScan();
    }

    private void injectAlienLegacyPageShims() {
        String script =
            "(function(){" +
            "var s=document.getElementById('wms365-alien-final-style');if(!s){s=document.createElement('style');s.id='wms365-alien-final-style';document.head.appendChild(s);}" +
            "s.textContent='body.device-alien-legacy .hidden,body.device-alien-legacy .desktop-only,body.device-alien-legacy .desktop-complex,body.device-alien-legacy .hero,body.device-alien-legacy .tabbar,body.device-alien-legacy .desktop-nav,body.device-alien-legacy .desktop-factbox{display:none!important}body.device-alien-legacy .mobile-drill-menu:not(.active),body.device-alien-legacy .mobile-drill-card:not(.active),body.device-alien-legacy .mobile-subview:not(.active){display:none!important}body.device-alien-legacy .mobile-subview.active,body.device-alien-legacy .mobile-drill-card.active{display:block!important}body.device-alien-legacy .locked{display:block!important}body.device-alien-legacy .locked.hidden{display:none!important}body.device-alien-legacy .locked-actions{display:block!important;margin-top:8px!important}body.device-alien-legacy .locked-actions button,body.device-alien-legacy .locked-actions .btn{display:block!important;width:100%!important;margin:0 0 8px 0!important;text-align:center!important}body.device-alien-legacy .scan-row{display:block!important}body.device-alien-legacy #orderPickerWrap .order-toolbar{margin-top:4px!important}body.device-alien-legacy #orderPickerWrap .order-toolbar h2{font-size:24px!important;line-height:1!important}body.device-alien-legacy #orderPickerWrap #refreshBtn{min-height:48px!important;font-size:22px!important;padding:8px 14px!important}body.device-alien-legacy #orderPickerWrap .order-search{display:grid!important;grid-template-columns:1fr!important;gap:6px!important;margin-top:6px!important}body.device-alien-legacy #orderPickerWrap #orderSearch{min-height:54px!important;font-size:22px!important;margin:0!important}body.device-alien-legacy #orderPickerWrap .order-search button{min-height:54px!important;margin:0!important}body.device-alien-legacy #orderPickerWrap #orderCounts{margin-top:6px!important;font-size:18px!important}body.device-alien-legacy #orderPickerWrap #pendingOrderList{margin-top:6px!important}body.device-alien-legacy #orderPickerWrap .order-row,body.device-alien-legacy #orderPickerWrap a.order-row,body.device-alien-legacy #orderPickerWrap button[data-alien-order]{display:block!important;text-decoration:none!important;width:100%!important;min-height:82px!important;margin:0 0 7px 0!important;padding:10px 12px!important;font-size:19px!important;text-align:left!important;background:#fff!important;color:#20303a!important;border:2px solid #b7c9d5!important;border-radius:8px!important}body.device-alien-legacy #orderPickerWrap .order-row strong,body.device-alien-legacy #orderPickerWrap button[data-alien-order] strong{display:block!important;font-size:23px!important;line-height:1.05!important}body.device-alien-legacy #orderPickerWrap .order-row span,body.device-alien-legacy #orderPickerWrap .order-row small{display:block!important;font-size:15px!important;line-height:1.15!important}body.device-alien-legacy #lockedCompanyWrap{padding:6px 8px!important;margin:0 0 6px 0!important}body.device-alien-legacy #lockedCompanyWrap strong{font-size:22px!important}body.device-alien-legacy #lockedCompanyWrap span{font-size:12px!important}body.device-alien-legacy #lockedCompanyWrap .locked-actions button{min-height:42px!important;font-size:18px!important;margin:0 0 5px 0!important;padding:6px 10px!important}';" +
            "function id(x){return document.getElementById(x);}function qs(x){return document.querySelector(x);}function qsa(x){return Array.prototype.slice.call(document.querySelectorAll(x));}function norm(v){return String(v||'').replace(/^\\s+|\\s+$/g,'');}function esc(v){return String(v||'').replace(/[&<>\\\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\\\"':'&quot;',\"'\":'&#39;'}[c];});}" +
            "function urlCompany(){try{var m=(location.search||'').match(/[?&](accountName|account_name)=([^&]+)/);return m&&m[2]?decodeURIComponent(m[2].replace(/\\+/g,' ')):'';}catch(e){return '';}}" +
            "function getCompany(){try{var c=localStorage.getItem('wms365-mobile-company-context')||localStorage.getItem('wms365_inventory_count_company')||urlCompany()||'';if(c){localStorage.setItem('wms365-mobile-company-context',c);localStorage.setItem('wms365_inventory_count_company',c);}return c;}catch(e){return urlCompany()||'';}}" +
            "function setCompany(v){v=norm(v);try{if(v){localStorage.setItem('wms365-mobile-company-context',v);localStorage.setItem('wms365_inventory_count_company',v);}else{localStorage.removeItem('wms365-mobile-company-context');localStorage.removeItem('wms365_inventory_count_company');}}catch(e){}return v;}" +
            "function xhr(method,url,body,cb){var r=new XMLHttpRequest();r.open(method,url,true);r.setRequestHeader('Content-Type','application/json');r.onreadystatechange=function(){if(r.readyState!==4)return;var data={};try{data=JSON.parse(r.responseText||'{}');}catch(e){}cb(r.status>=200&&r.status<300,data,r.status);};r.send(body?JSON.stringify(body):null);}" +
            "function goMenu(){var c=getCompany();location.href='/mobile?mode=mobile&device=alien'+(c?'&accountName='+encodeURIComponent(c):'');}" +
            "function bindButton(el,fn){if(!el||el.__alienBound)return;el.__alienBound=true;el.onclick=function(e){if(e&&e.preventDefault)e.preventDefault();fn();return false;};el.ontouchend=function(e){if(e&&e.preventDefault)e.preventDefault();fn();return false;};}" +
            "function bindScans(){qsa('[data-scan-target],[data-action-scan-target]').forEach(function(b){bindButton(b,function(){var target=b.getAttribute('data-scan-target')||b.getAttribute('data-action-scan-target');var input=id(target);if(input){input.removeAttribute('readonly');input.focus();if(input.select)input.select();}try{if(window.WMS365Android&&window.WMS365Android.scanBarcode){window.WMS365Android.scanBarcode(target);return;}}catch(ex){}});b.innerHTML='Scan';});}" +
            "function loadCompanyOptions(select,done){if(!select){if(done)done([]);return;}xhr('GET','/api/app/me',null,function(ok,data){var user=data.user||{};var list=(user.assignedCompanies||[]).concat(user.inheritedCompanies||[]);var seen={},names=[];for(var i=0;i<list.length;i++){var n=norm(list[i]);if(n&&!seen[n]){seen[n]=true;names.push(n);}}names.sort();var html='<option value=\"\">Choose company</option>';for(var j=0;j<names.length;j++)html+='<option value=\"'+esc(names[j])+'\">'+esc(names[j])+'</option>';select.innerHTML=html;var saved=getCompany();if(saved)select.value=saved;if(done)done(names);});}" +
            "function customizeAlienMenu(){var stack=qs('#mobileHomePanel .menu-stack');if(!stack||stack.__alienCustom)return;stack.__alienCustom=true;stack.innerHTML='<div class=\"mobile-menu-group alien-worker-menu\"><p class=\"mobile-menu-group-title\">Alien Scanner Tasks</p><button class=\"btn menu-card-btn\" type=\"button\" data-mobile-link=\"/mobile-pick\"><span class=\"menu-card-title\">Pending Work</span></button><button class=\"btn menu-card-btn\" type=\"button\" data-mobile-link=\"/mobile-pick\"><span class=\"menu-card-title\">Picking</span></button><button class=\"btn menu-card-btn\" type=\"button\" data-mobile-nav=\"inbounds\"><span class=\"menu-card-title\">Receiving</span></button><button class=\"btn menu-card-btn\" type=\"button\" data-mobile-nav=\"actions\" data-mobile-subview-group=\"actions\" data-mobile-subview-target=\"putaway\"><span class=\"menu-card-title\">Putaway</span></button><button class=\"btn menu-card-btn\" type=\"button\" data-mobile-link=\"/mobile-count\"><span class=\"menu-card-title\">Inventory Count</span></button><button class=\"btn menu-card-btn\" type=\"button\" data-mobile-nav=\"search\"><span class=\"menu-card-title\">Lookup SKU / BIN</span></button><button class=\"btn menu-card-btn\" type=\"button\" data-mobile-nav=\"actions\" data-mobile-subview-group=\"actions\" data-mobile-subview-target=\"transfer\"><span class=\"menu-card-title\">Move Item</span></button></div>';}" +
            "function installCount(){if(!id('companyStep')||!id('countStep')||window.__alienCountShim)return;window.__alienCountShim=true;document.body.classList.add('device-alien-legacy');var account=id('accountSelect'),companyStep=id('companyStep'),countStep=id('countStep'),locked=id('lockedCompanyLabel'),msg=id('message'),companyMsg=id('companyMessage');function render(){var c=getCompany();if(locked)locked.innerHTML=c||'-';if(companyStep)companyStep.className=c?'card stack hidden':'card stack';if(countStep)countStep.className=c?'card stack':'card stack hidden';if(account&&c)account.value=c;if(c&&id('locationInput')&&(!document.activeElement||document.activeElement===document.body))setTimeout(function(){id('locationInput').focus();},250);}function nextField(){var active=document.activeElement&&document.activeElement.id;if(active==='locationInput'&&id('skuInput'))id('skuInput').focus();else if(active==='skuInput'&&id('casesInput'))id('casesInput').focus();else if(active==='lotInput'&&id('expirationInput'))id('expirationInput').focus();else if(active==='expirationInput'&&id('casesInput'))id('casesInput').focus();else if(active==='casesInput'&&id('saveBtn'))id('saveBtn').focus();}loadCompanyOptions(account,render);bindButton(id('lockCompanyBtn'),function(){var c=setCompany(account?account.value:'');if(!c&&companyMsg){companyMsg.className='status bad';companyMsg.innerHTML='Choose a company first.';}render();});bindButton(id('switchCompanyBtn'),function(){setCompany('');render();});bindButton(id('menuBtn'),goMenu);bindButton(id('companyMenuBtn'),goMenu);bindButton(id('clearBtn'),function(){if(id('skuInput'))id('skuInput').value='';if(id('casesInput'))id('casesInput').value='';if(msg)msg.innerHTML='Ready for next SKU.';if(id('skuInput'))id('skuInput').focus();});bindButton(id('anotherSkuBtn'),function(){if(id('skuInput'))id('skuInput').value='';if(id('casesInput'))id('casesInput').value='';if(id('skuInput'))id('skuInput').focus();});bindButton(id('nextLocationBtn'),function(){if(id('locationInput'))id('locationInput').value='';if(id('skuInput'))id('skuInput').value='';if(id('casesInput'))id('casesInput').value='';if(id('locationInput'))id('locationInput').focus();});bindButton(id('saveBtn'),function(){var body={accountName:getCompany(),location:norm(id('locationInput')&&id('locationInput').value),sku:norm(id('skuInput')&&id('skuInput').value),countedCases:parseInt(id('casesInput')&&id('casesInput').value,10)||0,lotNumber:norm(id('lotInput')&&id('lotInput').value),expirationDate:norm(id('expirationInput')&&id('expirationInput').value),source:'android_app'};if(!body.accountName||!body.location||!body.sku||body.countedCases<0){if(msg){msg.className='status bad';msg.innerHTML='Company, location, SKU, and quantity are required.';}return;}if(msg){msg.className='status';msg.innerHTML='Saving count...';}xhr('POST','/api/inventory-counts',body,function(ok,data){if(msg){msg.className=ok?'status good':'status bad';msg.innerHTML=ok?'Count saved.':(data.error||'Count save failed.');}var p=id('afterSavePrompt');if(p&&ok)p.className='prompt';});});if(!document.__alienCountEnter){document.__alienCountEnter=true;document.addEventListener('keydown',function(e){var key=e.keyCode||e.which;if(key===13){if(e.preventDefault)e.preventDefault();nextField();return false;}},true);}bindScans();render();}" +
            "function installPick(){if(!id('companyPickerWrap')||!id('orderPickerWrap')||window.__alienPickShim)return;window.__alienPickShim=true;document.body.classList.add('device-alien-legacy');var select=id('companySelect'),locked=id('lockedCompanyWrap'),label=id('lockedCompanyLabel'),picker=id('companyPickerWrap'),orders=id('orderPickerWrap'),list=id('pendingOrderList'),counts=id('orderCounts');function render(){var c=getCompany();if(label)label.innerHTML=c||'-';if(locked)locked.className=c?'locked':'locked hidden';if(picker)picker.className=c?'hidden':'';if(orders)orders.className=c?'':'hidden';if(select&&c)select.value=c;}function requestedOrderId(){try{return String(new URLSearchParams(location.search||'').get('orderId')||'').replace(/^\\s+|\\s+$/g,'');}catch(e){var m=(location.search||'').match(/[?&]orderId=([^&]+)/);return m?decodeURIComponent(m[1]):'';}}function orderHref(order){return '/mobile-pick?mode=mobile&device=alien&orderId='+encodeURIComponent(order.id)+(getCompany()?'&accountName='+encodeURIComponent(getCompany()):'');}function buildAlienPicks(order){var out=[];var lines=order.lines||[];for(var i=0;i<lines.length;i++){var line=lines[i];var picks=line.pickLocations&&line.pickLocations.length?line.pickLocations:[{location:'',quantity:line.quantity,trackingLevel:line.trackingLevel,lotNumber:'',expirationDate:''}];for(var j=0;j<picks.length;j++){var p=picks[j];out.push({orderId:order.id,lineId:line.id||line.sku,sku:line.sku,upc:line.upc||p.upc||'',description:line.description||'',location:p.location||'',manualLocationRequired:!p.location,quantity:parseInt(p.quantity||line.quantity||0,10)||0,available:parseInt(p.quantity||line.availableQuantity||0,10)||0,lot:p.lotNumber||'',expiry:p.expirationDate||'',tracking:p.trackingLevel||line.trackingLevel||'UNIT',key:'alien-'+order.id+'-'+(line.id||line.sku)+'-'+j+'-'+Date.now()});}}return out;}function showAlienPick(order){window.__alienActiveOrder=order;window.__alienPicks=buildAlienPicks(order);window.__alienPickIndex=0;function show(){var p=(window.__alienPicks||[])[window.__alienPickIndex];document.body.classList.add('picking-active');if(orders)orders.className='hidden';if(locked)locked.className='locked hidden';var summary=id('orderSummaryCard');if(summary)summary.className='card hidden';var done=id('doneCard'),pick=id('pickCard');if(done)done.className='card hidden';if(!p){if(pick)pick.className='card hidden';if(done){done.className='card';var meta=id('doneOrderMeta');if(meta)meta.innerHTML=(order.orderCode||'Order')+' ready to mark picked.';}return;}if(pick)pick.className='card';if(id('workOrderCode'))id('workOrderCode').innerHTML=order.orderCode||'Order';if(id('workOrderMeta'))id('workOrderMeta').innerHTML=(getCompany()||order.accountName||'')+' | '+(window.__alienPickIndex+1)+'/'+window.__alienPicks.length;if(id('pickLocation'))id('pickLocation').innerHTML=p.location||'SCAN SOURCE LOCATION';if(id('pickSku'))id('pickSku').innerHTML=p.sku||'';if(id('pickDescription'))id('pickDescription').innerHTML=p.description||'';if(id('pickTraceability'))id('pickTraceability').innerHTML=p.manualLocationRequired?'No directed bin. Scan actual pick location.':((p.lot?'Lot '+esc(p.lot):'')+(p.expiry?' Exp '+esc(p.expiry):''));if(id('pickQty'))id('pickQty').innerHTML=p.quantity+' '+String(p.tracking||'unit').toLowerCase();if(id('pickAvailable'))id('pickAvailable').innerHTML=p.available;if(id('confirmLocation'))id('confirmLocation').value='';if(id('confirmSku'))id('confirmSku').value='';if(id('confirmLot'))id('confirmLot').value='';if(id('confirmExpiration'))id('confirmExpiration').value=p.expiry||'';var lotWrap=id('confirmLotWrap');if(lotWrap)lotWrap.className=p.lot?'':'hidden';var expEl=id('confirmExpiration'),expWrap=expEl&&expEl.parentNode;if(expWrap)expWrap.className=p.expiry?'':'hidden';if(id('confirmQty'))id('confirmQty').value=p.quantity||'';if(id('pickMessage')){id('pickMessage').className='status';id('pickMessage').innerHTML=p.manualLocationRequired?'No directed bin. Scan actual source location, then SKU.':'Go to the directed location. Scan location, then SKU.';}setTimeout(function(){if(id('confirmLocation'))id('confirmLocation').focus();},150);}show();bindButton(id('workListBtn'),function(){document.body.classList.remove('picking-active');if(locked)locked.className='locked';if(orders)orders.className='';if(id('pickCard'))id('pickCard').className='card hidden';});bindButton(id('confirmPickBtn'),function(){var p=(window.__alienPicks||[])[window.__alienPickIndex];if(!p)return;var loc=norm(id('confirmLocation')&&id('confirmLocation').value),sku=norm(id('confirmSku')&&id('confirmSku').value),qty=parseInt(id('confirmQty')&&id('confirmQty').value,10)||0,msg=id('pickMessage');if(p.location&&loc!==norm(p.location)){if(msg){msg.className='status bad';msg.innerHTML='Wrong location. Scan '+esc(p.location)+'.';}return;}if(sku!==norm(p.sku)&&(!p.upc||sku!==norm(p.upc))){if(msg){msg.className='status bad';msg.innerHTML='Wrong SKU / UPC. Scan '+esc(p.sku)+(p.upc?' or '+esc(p.upc):'')+'.';}return;}if(qty<1||qty>p.quantity){if(msg){msg.className='status bad';msg.innerHTML='Check quantity.';}return;}if(msg){msg.className='status';msg.innerHTML='Saving pick...';}xhr('POST','/api/mobile/pick-confirmations',{orderId:p.orderId,lineId:p.lineId,location:loc,sku:sku,lot:norm(id('confirmLot')&&id('confirmLot').value),expiry:norm(id('confirmExpiration')&&id('confirmExpiration').value),quantity:qty,deviceId:'ALIEN-LEGACY',source:'android_app',idempotencyKey:p.key},function(ok,data){if(!ok){if(msg){msg.className='status bad';msg.innerHTML=data.error||'Pick save failed.';}return;}if(msg){msg.className='status good';msg.innerHTML='Pick saved.';}window.__alienPickIndex++;setTimeout(show,450);});});}function startAlienOrder(order){if(!order)return;try{if(typeof startOrder==='function'){startOrder(order);return;}}catch(startEx){}if(typeof window.startOrder==='function'){window.startOrder(order);return;}showAlienPick(order);}function closestOrderNode(node){while(node&&node!==document){if(node.getAttribute&&(node.getAttribute('data-alien-order')||node.getAttribute('data-order-id')))return node;node=node.parentNode;}return null;}function bindOrderList(){if(!list||list.__alienOrderBound)return;list.__alienOrderBound=true;list.onclick=function(e){var b=closestOrderNode(e&&e.target);if(!b)return;var oid=b.getAttribute('data-alien-order')||b.getAttribute('data-order-id');var rows=window.__alienPickOrders||[];for(var i=0;i<rows.length;i++){if(String(rows[i].id)===String(oid)){if(e&&e.preventDefault)e.preventDefault();startAlienOrder(rows[i]);break;}}};list.ontouchend=function(e){var b=closestOrderNode(e&&e.target);if(!b)return true;if(e&&e.preventDefault)e.preventDefault();list.onclick(e);return false;};}function loadOrders(){var c=getCompany();if(!c||!list)return;list.innerHTML='<p class=\"muted\">Loading orders...</p>';xhr('GET','/api/mobile/pick-orders?account_name='+encodeURIComponent(c)+'&accountName='+encodeURIComponent(c),null,function(ok,data){var rows=data.orders||[];window.__alienPickOrders=rows;if(counts)counts.innerHTML=rows.length+' open order'+(rows.length===1?'':'s');if(!ok){list.innerHTML='<p class=\"muted\">Orders could not load.</p>';return;}if(!rows.length){list.innerHTML='<p class=\"muted\">No released picking orders for this company.</p>';return;}var html='';for(var i=0;i<rows.length;i++){var o=rows[i];var ref=o.shippingReference||o.poNumber||o.shipToName||'No reference';var lines=o.lines&&o.lines.length?o.lines.length:0;html+='<a href=\"'+esc(orderHref(o))+'\" class=\"order-row\" data-alien-order=\"'+esc(o.id)+'\" data-order-id=\"'+esc(o.id)+'\"><span class=\"order-action\">'+esc(String(o.status||'OPEN').toUpperCase()==='RELEASED'?'Pick':String(o.status||'OPEN'))+'</span><strong>'+esc(o.orderCode||o.id)+'</strong><span>'+esc(ref)+'</span><small>'+lines+' line'+(lines===1?'':'s')+'</small></a>'; }list.innerHTML=html;bindOrderList();var wanted=requestedOrderId();if(wanted){for(var j=0;j<rows.length;j++){if(String(rows[j].id)===String(wanted)){setTimeout(function(order){return function(){startAlienOrder(order);};}(rows[j]),150);break;}}}});}loadCompanyOptions(select,function(){render();if(getCompany())loadOrders();});bindButton(id('lockCompanyBtn'),function(){setCompany(select?select.value:'');render();loadOrders();});bindButton(id('switchCompanyBtn'),function(){setCompany('');render();});bindButton(id('menuBtn'),goMenu);bindButton(id('companyMenuBtn'),goMenu);bindButton(id('workMenuBtn'),goMenu);bindButton(id('refreshBtn'),loadOrders);bindOrderList();bindScans();render();}" +
            "function scrollToEl(el){if(!el)return;setTimeout(function(){try{el.scrollIntoView(true);window.scrollBy(0,-6);}catch(e){}},80);}" +
            "function setSub(group,target){qsa('[data-mobile-subview-group=\"'+group+'\"]').forEach(function(el){el.classList.remove('active');});qsa('[data-mobile-subview-card-group=\"'+group+'\"],[data-mobile-subview-menu-group=\"'+group+'\"]').forEach(function(el){el.classList.add('active');});qsa('[data-mobile-subview=\"'+target+'\"]').forEach(function(el){if(el.getAttribute('data-mobile-subview-group')===group)el.classList.add('active');});qsa('[data-mobile-subview-btn-group=\"'+group+'\"]').forEach(function(btn){btn.classList.toggle('active',btn.getAttribute('data-mobile-subview-target')===target);});var active=qs('[data-mobile-subview-group=\"'+group+'\"][data-mobile-subview=\"'+target+'\"]');if(group==='actions'&&active){var menu=qs('[data-mobile-subview-menu-group=\"actions\"]');if(menu&&menu.parentNode&&active.parentNode!==menu.parentNode){menu.parentNode.insertBefore(active,menu);}}scrollToEl(active);}" +
            "function hideAccountLabels(){var company=getCompany();['transferAccount','putAwayAccount','adjustAccount','moveAccount','searchAccount','convertAccount','fullBinMoveAccount'].forEach(function(n){try{var input=id(n),p=input&&input.parentNode;if(input&&company)input.value=company;if(p&&p.tagName&&p.tagName.toLowerCase()==='label')p.style.display='none';}catch(e){}});[['transferFrom','Scan FROM'],['putAwayFrom','Scan FROM'],['transferTo','Scan TO'],['putAwayTo','Scan TO BIN'],['transferSku','Scan SKU / UPC'],['putAwaySku','Scan SKU / UPC'],['adjustLocation','Scan LOCATION'],['adjustSku','Scan SKU / UPC'],['moveFrom','Scan FROM BIN'],['moveTo','Scan TO BIN']].forEach(function(pair){var el=id(pair[0]);if(el)el.setAttribute('placeholder',pair[1]);});}" +
            "function installSubJump(){hideAccountLabels();qsa('[data-mobile-subview-btn-group]').forEach(function(btn){if(btn.__alienSubJump)return;btn.__alienSubJump=true;bindButton(btn,function(){var group=btn.getAttribute('data-mobile-subview-btn-group')||btn.getAttribute('data-mobile-subview-group')||'actions';var target=btn.getAttribute('data-mobile-subview-target')||'';if(group&&target)setSub(group,target);hideAccountLabels();});});}" +
            "function installInbound(){var form=id('mobileQuickInboundForm'),quick=id('mobileQuickInboundToggleBtn'),stage=id('mobileReceiveWithoutPoBtn'),refresh=id('mobileInboundRefreshBtn'),list=id('mobileInboundArrivalList'),meta=id('mobileInboundArrivalMeta'),msg=id('mobileInboundArrivalMessage'),create=id('mobileQuickInboundCreateBtn');if(!quick||quick.__alienInbound)return;quick.__alienInbound=true;function setMsg(text,good){if(msg){msg.className=good?'status good':'status';msg.innerHTML=text||'';}}function isOpen(s){s=norm(s).toUpperCase();return s==='SUBMITTED'||s==='ARRIVED';}function closestAttr(node,attr){while(node&&node!==document){if(node.getAttribute&&node.getAttribute(attr)!==null)return node;node=node.parentNode;}return null;}function lineHtml(line){var q=parseInt(line.quantity||line.expectedQuantity||line.receivedQuantity||1,10)||1;var sku=line.sku||'';return '<div class=\"quick-meta\" data-alien-inbound-line=\"'+esc(line.id||line.lineId||sku)+'\" data-alien-sku=\"'+esc(sku)+'\"><strong>'+esc(sku||'SKU')+'</strong><label class=\"field\"><span>Received Qty</span><input data-alien-receive-qty type=\"number\" min=\"1\" value=\"'+q+'\"></label><label class=\"field\"><span>Stage Location</span><input data-alien-receive-location type=\"text\" value=\"RECEIVING-STAGE\"></label></div>';}" +
            "function renderInbounds(rows){if(!list)return;var open=[];for(var i=0;i<(rows||[]).length;i++){if(isOpen(rows[i].status))open.push(rows[i]);}if(meta)meta.innerHTML=(getCompany()?esc(getCompany())+' | ':'')+open.length+' open PO'+(open.length===1?'':'s');if(!open.length){list.innerHTML='<p class=\"empty\">No open purchase orders are waiting.</p>';return;}var html='';for(var j=0;j<open.length;j++){var inb=open[j],status=norm(inb.status).toUpperCase(),lines=inb.lines||[];html+='<article class=\"order-card\" data-alien-inbound-card=\"'+esc(inb.id)+'\"><div class=\"order-card-head\"><div><strong>'+esc(inb.inboundCode||('INB-'+inb.id))+'</strong><div class=\"quick-meta\">Ref '+esc(inb.referenceNumber||'None')+'</div></div><span class=\"pill\">'+esc(status)+'</span></div><div class=\"order-card-grid\"><div>Carrier: '+esc(inb.carrierName||'Not provided')+'</div><div>'+lines.length+' line'+(lines.length===1?'':'s')+'</div></div>';if(status==='SUBMITTED'){html+='<button class=\"btn\" type=\"button\" data-alien-inbound-arrive=\"'+esc(inb.id)+'\">Check In Freight</button>';}if(status==='ARRIVED'){html+='<div class=\"quick-meta\"><label class=\"field\"><span>BOL / Reference</span><input data-alien-bol type=\"text\" placeholder=\"Scan or enter BOL\"></label><label class=\"field\"><span>Pallets</span><input data-alien-pallets type=\"number\" min=\"0\" placeholder=\"0\"></label><label class=\"field\"><span>Cases</span><input data-alien-cases type=\"number\" min=\"0\" placeholder=\"0\"></label>'+lines.map(lineHtml).join('')+'<button class=\"btn\" type=\"button\" data-alien-inbound-receive=\"'+esc(inb.id)+'\">Finish Receiving to Staging</button></div>';}html+='</article>';}list.innerHTML=html;installInboundStagingFlow();qsa('[data-alien-inbound-arrive]').forEach(function(btn){bindButton(btn,function(){arriveInbound(btn.getAttribute('data-alien-inbound-arrive'));});});qsa('[data-alien-inbound-receive]').forEach(function(btn){bindButton(btn,function(){receiveInbound(btn.getAttribute('data-alien-inbound-receive'),closestAttr(btn,'data-alien-inbound-card'));});});}" +
            "function loadInbounds(){var c=getCompany();if(!c){if(meta)meta.innerHTML='Choose company before receiving.';return;}if(meta)meta.innerHTML='Loading purchase orders...';if(list)list.innerHTML='<p class=\"empty\">Loading purchase orders...</p>';xhr('GET','/api/admin/portal-inbounds?accountName='+encodeURIComponent(c),null,function(ok,data){if(!ok){if(list)list.innerHTML='<p class=\"empty\">Purchase orders could not load.</p>';if(meta)meta.innerHTML='Load failed.';return;}renderInbounds(data.inbounds||[]);});}" +
            "function arriveInbound(inboundId){setMsg('Checking in freight...',false);xhr('POST','/api/admin/portal-inbounds/'+encodeURIComponent(inboundId)+'/status',{status:'ARRIVED',arrivalNote:'Alien scanner check-in completed at the dock.'},function(ok,data){if(!ok){if(msg){msg.className='status bad';msg.innerHTML=data.error||'Check-in failed.';}return;}setMsg('Freight checked in.',true);loadInbounds();});}" +
            "function receiveInbound(inboundId,card){var rows=qsa('[data-alien-inbound-line]').filter(function(el){return card&&card.contains(el);});var receiving=[];for(var i=0;i<rows.length;i++){var row=rows[i],qty=parseInt((row.querySelector('[data-alien-receive-qty]')||{}).value,10)||0,loc=norm((row.querySelector('[data-alien-receive-location]')||{}).value);if(!qty||!loc){if(msg){msg.className='status bad';msg.innerHTML='Enter quantity and staging location for every line.';}return;}receiving.push({id:row.getAttribute('data-alien-inbound-line')||'',sku:row.getAttribute('data-alien-sku')||'',receivedQuantity:qty,receivedLocation:loc});}setMsg('Receiving to staging...',false);xhr('POST','/api/admin/portal-inbounds/'+encodeURIComponent(inboundId)+'/status',{status:'RECEIVED',receivingLines:receiving,bolNumber:norm((card.querySelector('[data-alien-bol]')||{}).value),palletCount:parseInt((card.querySelector('[data-alien-pallets]')||{}).value,10)||0,caseCount:parseInt((card.querySelector('[data-alien-cases]')||{}).value,10)||0,note:'Alien scanner receiving completed to RECEIVING-STAGE.'},function(ok,data){if(!ok){if(msg){msg.className='status bad';msg.innerHTML=data.error||'Receiving failed.';}return;}setMsg('Received to staging. Putaway is next.',true);loadInbounds();});}" +
            "if(list&&!list.__alienInboundList){list.__alienInboundList=true;list.onclick=function(e){var a=closestAttr(e&&e.target,'data-alien-inbound-arrive'),r=closestAttr(e&&e.target,'data-alien-inbound-receive');if(a){if(e&&e.preventDefault)e.preventDefault();arriveInbound(a.getAttribute('data-alien-inbound-arrive'));return false;}if(r){if(e&&e.preventDefault)e.preventDefault();receiveInbound(r.getAttribute('data-alien-inbound-receive'),closestAttr(r,'data-alien-inbound-card'));return false;}return true;};list.ontouchend=function(e){var a=closestAttr(e&&e.target,'data-alien-inbound-arrive'),r=closestAttr(e&&e.target,'data-alien-inbound-receive');if(a||r){if(e&&e.preventDefault)e.preventDefault();list.onclick(e);return false;}return true;};}" +
            "bindButton(quick,function(){if(!form)return;form.classList.toggle('hidden');if(!form.classList.contains('hidden')){var ref=id('mobileQuickInboundReference');if(ref)ref.focus();scrollToEl(form);}});bindButton(stage,function(){if(form)form.classList.remove('hidden');var ref=id('mobileQuickInboundReference');if(ref)ref.focus();setMsg('Stage freight without a PO: enter the BOL/reference and counts.',false);scrollToEl(form);});bindButton(refresh,loadInbounds);bindButton(create,function(){var c=getCompany(),ref=norm(id('mobileQuickInboundReference')&&id('mobileQuickInboundReference').value),sku=norm(id('mobileQuickInboundSku')&&id('mobileQuickInboundSku').value)||'UNKNOWN',qty=parseInt(id('mobileQuickInboundQty')&&id('mobileQuickInboundQty').value,10)||parseInt(id('mobileQuickInboundCases')&&id('mobileQuickInboundCases').value,10)||1;if(!c||!ref){if(msg){msg.className='status bad';msg.innerHTML='Company and reference are required.';}return;}setMsg('Creating quick inbound...',false);xhr('POST','/api/admin/portal-inbounds',{accountName:c,referenceNumber:ref,carrierName:norm(id('mobileQuickInboundCarrier')&&id('mobileQuickInboundCarrier').value),expectedDate:new Date().toISOString().slice(0,10),contactName:'Dock receiving',notes:'Alien scanner quick inbound.',lines:[{sku:sku,quantity:qty}]},function(ok,data){if(!ok){if(msg){msg.className='status bad';msg.innerHTML=data.error||'Quick inbound failed.';}return;}setMsg('Quick inbound created.',true);if(form)form.classList.add('hidden');loadInbounds();});});setTimeout(loadInbounds,350);}" +
            "function installInboundStagingFlow(){var stageLoc='RECEIVING-STAGE';function up(v){return String(v||'').replace(/^\\s+|\\s+$/g,'').toUpperCase();}qsa('[data-mobile-inbound-location],[data-inbound-receive-location]').forEach(function(input){if(!input||input.disabled)return;var current=up(input.value);if(!current||current==='RECEIVING'||current==='BULK')input.value=stageLoc;input.setAttribute('placeholder','Scan staging location');input.setAttribute('autocomplete','off');});qsa('[data-mobile-inbound-receive]').forEach(function(btn){if(btn)btn.innerHTML='Finish Receiving to Staging';});var from=id('putAwayFrom');if(from){if(!up(from.value))from.value=stageLoc;from.setAttribute('placeholder','Scan FROM staging');}var to=id('putAwayTo');if(to)to.setAttribute('placeholder','Scan TO pickable bin');qsa('.pill').forEach(function(p){if(up(p.innerHTML)==='RECEIVED_PENDING_PUTAWAY')p.innerHTML='RECEIVED - PUTAWAY NEEDED';});}" +
            "customizeAlienMenu();installCount();installPick();installInbound();installInboundStagingFlow();setTimeout(installInboundStagingFlow,800);setTimeout(installInboundStagingFlow,2200);installSubJump();bindScans();" +
            "})();";
        evaluate(script);
    }

    private void evaluate(String script) {
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    private void showLoading(boolean show) {
        loadingOverlay.setVisibility(show ? View.VISIBLE : View.GONE);
        if (show) loadingOverlay.bringToFront();
    }

    private void showError(boolean show, String message) {
        errorText.setText(message == null || message.length() == 0 ? "WMS365 could not load." : message);
        errorOverlay.setVisibility(show ? View.VISIBLE : View.GONE);
        if (show) errorOverlay.bringToFront();
    }

    private boolean isOnline() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        NetworkInfo info = manager.getActiveNetworkInfo();
        return info != null && info.isConnected();
    }

    private String jsString(String value) {
        if (value == null) return "''";
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "\\r") + "'";
    }

    public class AlienBridge {
        @JavascriptInterface public boolean isAndroidApp() { return true; }
        @JavascriptInterface public boolean hasHardwareScanner() { return true; }
        @JavascriptInterface public String getScannerProfile() { return "alien_native_barcode"; }
        @JavascriptInterface public String getPlatform() { return "android-alien-legacy"; }
        @JavascriptInterface public String getAppVersion() { return BuildConfig.VERSION_NAME; }
        @JavascriptInterface public String getDeviceManufacturer() { return "Alien"; }
        @JavascriptInterface public String getDeviceBrand() { return "Alien"; }
        @JavascriptInterface public String getDeviceModel() { return "ALR-H450"; }
        @JavascriptInterface public boolean isOnline() { return MainActivity.this.isOnline(); }

        @JavascriptInterface
        public String getSavedEmail() {
            return getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(PREF_EMAIL, "");
        }

        @JavascriptInterface
        public String getSavedPassword() {
            return getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(PREF_PASSWORD, "");
        }

        @JavascriptInterface
        public void saveLogin(String email, String password) {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(PREF_EMAIL, email == null ? "" : email)
                .putString(PREF_PASSWORD, password == null ? "" : password)
                .apply();
        }

        @JavascriptInterface
        public void clearSavedLogin() {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .remove(PREF_EMAIL)
                .remove(PREF_PASSWORD)
                .apply();
        }

        @JavascriptInterface
        public void scanBarcode(String targetId) {
            runOnUiThread(() -> startNativeBarcodeScan(targetId));
        }

        @JavascriptInterface
        public void vibrate(int durationMs) {
            try {
                Vibrator vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (vibrator != null) vibrator.vibrate(Math.max(20, Math.min(durationMs, 250)));
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface public void beep(String type) { }
        @JavascriptInterface public void setKeepScreenAwake(boolean enabled) {
            if (enabled) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        @JavascriptInterface public void showToast(String message) {
            Toast.makeText(MainActivity.this, message == null ? "" : message, Toast.LENGTH_SHORT).show();
        }
    }
}
