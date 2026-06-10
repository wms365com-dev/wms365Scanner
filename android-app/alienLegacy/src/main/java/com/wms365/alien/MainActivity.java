package com.wms365.alien;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.SSLCertificateSocketFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.Vibrator;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.alien.barcode.BarcodeCallback;
import com.alien.barcode.BarcodeReader;
import com.alien.common.KeyCode;
import com.barcode.BarcodeUtility;
import com.barcode.BarcodeUtility.ModuleType;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.net.URLEncoder;
import java.net.URL;
import java.lang.reflect.Method;
import java.security.KeyStore;
import java.security.Security;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import org.conscrypt.Conscrypt;

public class MainActivity extends Activity {
    private static final String PREFS = "wms365_alien_native";
    private static final String KEY_EMAIL = "email";
    private static final String KEY_COOKIE = "cookie";
    private static final String KEY_COMPANY = "company";
    private static final String KEY_DEVICE_ID = "deviceId";
    private static final String KEY_COMPANIES = "companies";
    private static final String KEY_OUTBOX = "outbox";
    private static final String KEY_COUNTED_LOCATIONS = "countedLocations";
    private static final String AUTOMATION_POLICY_TEXT = "Automated access, scraping, AI analysis, reverse engineering, or copying of WMS365 is prohibited unless authorized by WMS365 ownership. The only authorized automation owner is k.prathab@gmail.com.";

    private static final int BG = Color.rgb(244, 247, 249);
    private static final int TEXT = Color.rgb(15, 23, 42);
    private static final int MUTED = Color.rgb(71, 85, 105);
    private static final int GREEN = Color.rgb(15, 118, 110);
    private static final int BLUE = Color.rgb(37, 99, 235);
    private static final int YELLOW = Color.rgb(202, 138, 4);
    private static final int DARK = Color.rgb(15, 23, 42);

    private FrameLayout root;
    private SharedPreferences prefs;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler();
    private BarcodeReader barcodeReader;
    private boolean receiversRegistered = false;
    private boolean actionLocked = false;
    private EditText activeInput;
    private String activeInputLabel = "";
    private String screen = "login";
    private TextView transientStatus;
    private String countStep = "";
    private String countLocation = "";
    private String countSku = "";
    private String countCases = "";
    private String countLot = "";
    private String countExpiry = "";
    private boolean countLocationRecountOverride = false;
    private String activeOrderId = "";
    private List<PickTask> activeTasks = new ArrayList<>();
    private PickTask activeTask;
    private String pickState = "";

    private final BroadcastReceiver scannerReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            handleScan(extractScan(intent));
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        installTls12ForAndroid44();
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        root = new FrameLayout(this);
        setContentView(root);
        configureScanner();

        if (cookie().length() == 0) {
            showLogin();
        } else if (company().length() == 0) {
            showCompanySelect(true);
        } else {
            showHome();
            syncQueue(false);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerReceivers();
        configureScanner();
    }

    @Override
    protected void onPause() {
        stopBarcodeScan();
        unregisterReceivers();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        stopBarcodeScan();
        executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if ("home".equals(screen)) {
            super.onBackPressed();
        } else if ("pick".equals(screen)) {
            showOrderList();
        } else if ("count".equals(screen)) {
            if ("trace".equals(countStep)) showCountQty();
            else if ("qty".equals(countStep)) showCountSku();
            else if ("sku".equals(countStep)) showCountLocation();
            else showHome();
        } else if ("company".equals(screen)) {
            showLogin();
        } else {
            showHome();
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 && isScanKey(event.getKeyCode())) {
            startBarcodeScan();
            return true;
        }
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            int unicode = event.getUnicodeChar();
            if (unicode > 0 && activeInput != null && !"pick".equals(screen)) {
                activeInput.requestFocus();
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private boolean isScanKey(int keyCode) {
        return keyCode == KeyCode.ALR_H450.SCAN
            || keyCode == KeyCode.ALR_H450.SIDE_LEFT
            || keyCode == KeyCode.ALR_H450.SIDE_RIGHT
            || keyCode == KeyCode.ALR_H460.SCAN
            || keyCode == KeyCode.ALR_H460.SIDE_LEFT_FUNC
            || keyCode == KeyCode.ALR_H460.HANDLE_TRIGGER
            || keyCode == KeyEvent.KEYCODE_F5
            || keyCode == 119;
    }

    private void showLogin() {
        screen = "login";
        activeInput = null;
        root.removeAllViews();
        final EditText email = input("Warehouse email", InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        final EditText password = input("Password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        email.setSingleLine(true);
        password.setSingleLine(true);
        password.setImeOptions(EditorInfo.IME_ACTION_DONE);
        email.setText(prefs.getString(KEY_EMAIL, ""));
        final TextView statusLine = status("Sign in first. Next screen selects the company.");
        transientStatus = statusLine;
        password.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int actionId, KeyEvent event) {
                boolean enterPressed = event != null
                    && event.getAction() == KeyEvent.ACTION_UP
                    && (event.getKeyCode() == KeyEvent.KEYCODE_ENTER || event.getKeyCode() == KeyEvent.KEYCODE_DPAD_CENTER);
                if (actionId == EditorInfo.IME_ACTION_DONE || enterPressed) {
                    attemptLogin(email, password);
                    return true;
                }
                return false;
            }
        });
        root.addView(screenLayout(new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(header("WMS365 Scanner", "Alien native terminal"));
                l.addView(email);
                l.addView(password);
                l.addView(primaryButton("Sign In", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        attemptLogin(email, password);
                    }
                }));
                l.addView(statusLine);
                l.addView(status("Native app. Hardware scanner ready."));
                l.addView(status(AUTOMATION_POLICY_TEXT));
            }
        }));
        email.requestFocus();
    }

    private void attemptLogin(final EditText email, final EditText password) {
        final String e = email.getText().toString().trim();
        final String p = password.getText().toString();
        if (e.length() == 0 || p.length() == 0) {
            toast("Email and password are required.", true);
            return;
        }
        hideKeyboard();
        setStatusLine("Signing in...");
        Log.i("WMS365Alien", "Submitting login for " + e);
        runAsync("Signing in...", new Runnable() {
            @Override public void run() {
                try {
                    JSONObject body = devicePayload()
                        .put("email", e)
                        .put("password", p);
                    ApiResult result = request("/api/app/login", "POST", body);
                    if (result.cookie.length() == 0) throw new Exception("No session returned.");
                    Log.i("WMS365Alien", "Login accepted; opening company select.");
                    prefs.edit()
                        .putString(KEY_EMAIL, e)
                        .putString(KEY_COOKIE, result.cookie)
                        .putString(KEY_COMPANY, "")
                        .apply();
                    checkInDevice();
                    runOnUiThread(new Runnable() {
                        @Override public void run() {
                            showCompanySelect(true);
                        }
                    });
                } catch (final Exception ex) {
                    Log.e("WMS365Alien", "Login failed", ex);
                    fail(ex);
                }
            }
        });
    }

    private void showCompanySelect(boolean refresh) {
        screen = "company";
        activeInput = null;
        renderCompanySelect(loadCompanies(), refresh ? "Loading companies..." : "Choose a company.");
        if (refresh || loadCompanies().isEmpty()) fetchCompanies();
    }

    private void renderCompanySelect(final List<String> companies, String message) {
        root.removeAllViews();
        final EditText manual = input("Type company if not listed", InputType.TYPE_CLASS_TEXT);
        root.addView(screenLayout(new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(header("WMS365 Scanner", "Select company"));
                l.addView(banner("Choose Company", "This locks the work area", BLUE));
                if (companies.isEmpty()) {
                    l.addView(status("No companies loaded yet. Tap Refresh or type the company."));
                } else {
                    for (final String c : companies) {
                        l.addView(blockButton(c, "Select", new View.OnClickListener() {
                            @Override public void onClick(View v) { lockCompany(c); }
                        }));
                    }
                }
                l.addView(status("Manual fallback"));
                l.addView(manual);
                l.addView(primaryButton("Use This Company", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        String c = manual.getText().toString().trim();
                        if (c.length() == 0) toast("Choose or enter a company.", true);
                        else lockCompany(c);
                    }
                }));
                l.addView(secondaryButton("Refresh Companies", new View.OnClickListener() {
                    @Override public void onClick(View v) { fetchCompanies(); }
                }));
                l.addView(secondaryButton("Logout", new View.OnClickListener() {
                    @Override public void onClick(View v) { logout(); }
                }));
                l.addView(status(message));
            }
        }));
    }

    private void fetchCompanies() {
        runAsync("Loading companies...", new Runnable() {
            @Override public void run() {
                try {
                    ApiResult result = request("/api/app/companies", "GET", null);
                    JSONArray arr = result.json.optJSONArray("companies");
                    List<String> companies = new ArrayList<>();
                    if (arr != null) {
                        for (int i = 0; i < arr.length(); i++) {
                            String c = arr.optString(i, "").trim();
                            if (c.length() > 0) companies.add(c);
                        }
                    }
                    saveCompanies(companies);
                    final List<String> finalCompanies = companies;
                    runOnUiThread(new Runnable() {
                        @Override public void run() {
                            renderCompanySelect(finalCompanies, "Loaded " + finalCompanies.size() + " company option(s).");
                        }
                    });
                } catch (final Exception ex) {
                    fail(ex);
                }
            }
        });
    }

    private void lockCompany(String company) {
        prefs.edit().putString(KEY_COMPANY, company.trim()).apply();
        success();
        showHome();
        checkInDevice();
        syncQueue(false);
    }

    private void showHome() {
        screen = "home";
        activeInput = null;
        activeOrderId = "";
        activeTask = null;
        root.removeAllViews();
        root.addView(screenLayout(new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(header("WMS365 Scanner", "Alien work area"));
                l.addView(banner("Company Locked", company(), BLUE));
                l.addView(status("Work"));
                l.addView(primaryButton("Picking", new View.OnClickListener() {
                    @Override public void onClick(View v) { showOrderList(); }
                }));
                l.addView(secondaryButton("Receiving", new View.OnClickListener() {
                    @Override public void onClick(View v) { showReceiving(false); }
                }));
                l.addView(secondaryButton("Putaway", new View.OnClickListener() {
                    @Override public void onClick(View v) { showMoveForm("Putaway", "Move stock into BIN", "RECEIVING-STAGE", true); }
                }));
                l.addView(secondaryButton("Inventory Count", new View.OnClickListener() {
                    @Override public void onClick(View v) { showInventoryCount(); }
                }));
                l.addView(secondaryButton("Lookup SKU / BIN", new View.OnClickListener() {
                    @Override public void onClick(View v) { showLookup(); }
                }));
                l.addView(secondaryButton("Move Item", new View.OnClickListener() {
                    @Override public void onClick(View v) { showMoveForm("Move Item", "Transfer stock location to location", "", false); }
                }));
                l.addView(secondaryButton("Receive Without PO", new View.OnClickListener() {
                    @Override public void onClick(View v) { showReceiving(true); }
                }));
                l.addView(secondaryButton("Pallets / Labels", new View.OnClickListener() {
                    @Override public void onClick(View v) { showPallets(); }
                }));
                l.addView(status("Device"));
                l.addView(secondaryButton("Sync Now", new View.OnClickListener() {
                    @Override public void onClick(View v) { syncQueue(true); }
                }));
                l.addView(secondaryButton("Report Issue", new View.OnClickListener() {
                    @Override public void onClick(View v) { showReportIssue(); }
                }));
                l.addView(secondaryButton("Switch Company", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        prefs.edit().putString(KEY_COMPANY, "").apply();
                        showCompanySelect(false);
                    }
                }));
                l.addView(secondaryButton("Logout", new View.OnClickListener() {
                    @Override public void onClick(View v) { logout(); }
                }));
                l.addView(status("Sync queue: " + pendingCount() + " pending. App " + BuildConfig.VERSION_NAME));
            }
        }));
    }

    private void showReceiving(final boolean withoutPo) {
        screen = "form";
        final EditText ref = input(withoutPo ? "BOL / Reference" : "Inbound / PO reference", InputType.TYPE_CLASS_TEXT);
        final EditText sku = input("SKU / UPC", InputType.TYPE_CLASS_TEXT);
        final EditText qty = input("Qty received", InputType.TYPE_CLASS_NUMBER);
        final EditText loc = input("Staging location", InputType.TYPE_CLASS_TEXT);
        final EditText pallets = input("Pallet count", InputType.TYPE_CLASS_NUMBER);
        final EditText cases = input("Case count", InputType.TYPE_CLASS_NUMBER);
        final EditText note = input("Note", InputType.TYPE_CLASS_TEXT);
        loc.setText("RECEIVING-STAGE");
        root.removeAllViews();
        root.addView(formLayout(withoutPo ? "Quick Check-In" : "Receiving", withoutPo ? "No PO available" : "Receive against inbound / PO", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(ref); l.addView(scanButton("Scan Ref", ref, "reference"));
                l.addView(sku); l.addView(scanButton("Scan SKU / UPC", sku, "sku"));
                l.addView(qty);
                l.addView(loc); l.addView(scanButton("Scan Location", loc, "location"));
                l.addView(pallets); l.addView(cases); l.addView(note);
                l.addView(primaryButton("Save Receiving", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        int q = intValue(qty);
                        if (sku.getText().toString().trim().length() == 0 || q <= 0) {
                            toast("SKU and received qty are required.", true);
                            return;
                        }
                        queue("RECEIVING", basePayload()
                            .put("accountName", company())
                            .put("sourceType", withoutPo ? "MANUAL" : "PORTAL_INBOUND")
                            .put("referenceNumber", ref.getText().toString().trim())
                            .put("sku", sku.getText().toString().trim())
                            .put("skuOrUpc", sku.getText().toString().trim())
                            .put("quantity", q)
                            .put("receivedQuantity", q)
                            .put("location", loc.getText().toString().trim())
                            .put("palletCount", intValue(pallets))
                            .put("caseCount", intValue(cases))
                            .put("note", note.getText().toString().trim()), "Receiving saved");
                    }
                }));
                l.addView(backButton());
            }
        }));
        activeInput = ref;
        ref.requestFocus();
    }

    private void showMoveForm(final String title, String instruction, String defaultFrom, final boolean putaway) {
        screen = "form";
        final EditText from = input("From location", InputType.TYPE_CLASS_TEXT);
        final EditText to = input(putaway ? "To BIN" : "To location", InputType.TYPE_CLASS_TEXT);
        final EditText sku = input("SKU / UPC", InputType.TYPE_CLASS_TEXT);
        final EditText qty = input("Qty", InputType.TYPE_CLASS_NUMBER);
        from.setText(defaultFrom);
        root.removeAllViews();
        root.addView(formLayout(title, instruction, new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(from); l.addView(scanButton("Scan From", from, "from location"));
                l.addView(to); l.addView(scanButton(putaway ? "Scan To BIN" : "Scan To", to, "to location"));
                l.addView(sku); l.addView(scanButton("Scan SKU / UPC", sku, "sku"));
                l.addView(qty);
                l.addView(primaryButton(putaway ? "Confirm Putaway" : "Confirm Move", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        int q = intValue(qty);
                        if (from.getText().length() == 0 || to.getText().length() == 0 || sku.getText().length() == 0 || q <= 0) {
                            toast("From, To, SKU, and Qty are required.", true);
                            return;
                        }
                        queue(putaway ? "PUT_AWAY" : "MOVE", basePayload()
                            .put("accountName", company())
                            .put("sourceType", "INVENTORY")
                            .put("fromLocation", from.getText().toString().trim())
                            .put("toLocation", to.getText().toString().trim())
                            .put("location", to.getText().toString().trim())
                            .put("sku", sku.getText().toString().trim())
                            .put("skuOrUpc", sku.getText().toString().trim())
                            .put("quantity", q), putaway ? "Putaway queued" : "Move queued");
                    }
                }));
                l.addView(backButton());
            }
        }));
        activeInput = to;
        to.requestFocus();
    }

    private void showInventoryCount() {
        countLocation = "";
        countSku = "";
        countCases = "";
        countLot = "";
        countExpiry = "";
        countLocationRecountOverride = false;
        showCountLocation();
    }

    private void showCountLocation() {
        screen = "count";
        countStep = "location";
        final EditText loc = input("Location", InputType.TYPE_CLASS_TEXT);
        loc.setText(countLocation);
        root.removeAllViews();
        root.addView(formLayout("Inventory Count", "Step 1 of 4", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(banner("Go to this location", "Scan Location", BLUE));
                l.addView(loc);
                l.addView(primaryButton("Confirm Location", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        String value = loc.getText().toString().trim();
                        if (value.length() == 0) {
                            toast("Scan or enter the location.", true);
                            showKeyboard(loc);
                            return;
                        }
                        confirmCountLocationForCounting(value);
                    }
                }));
                l.addView(secondaryButton("Key In Location", new View.OnClickListener() {
                    @Override public void onClick(View v) { showKeyboard(loc); }
                }));
                l.addView(scanButton("Scan Location", loc, "location"));
                l.addView(backButton());
            }
        }));
        activateInput(loc, "location", false);
    }

    private void confirmCountLocationForCounting(String value) {
        String location = value == null ? "" : value.trim();
        if (location.length() == 0) {
            toast("Scan or enter the location.", true);
            return;
        }
        countLocation = location;
        countLocationRecountOverride = false;
        if (hasCountedLocationToday(location)) {
            showCountLocationRepeatWarning(location);
            return;
        }
        showCountSku();
    }

    private void showCountLocationRepeatWarning(final String location) {
        screen = "count";
        countStep = "location-repeat";
        root.removeAllViews();
        root.addView(formLayout("Inventory Count", "Location Check", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(banner("Location Already Counted", location, YELLOW));
                l.addView(status("This device already submitted a count for this location today."));
                l.addView(primaryButton("Count Again", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        countLocation = location;
                        countLocationRecountOverride = true;
                        showCountSku();
                    }
                }));
                l.addView(secondaryButton("Choose Different Location", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        countLocation = "";
                        countLocationRecountOverride = false;
                        showCountLocation();
                    }
                }));
                l.addView(secondaryButton("Home", new View.OnClickListener() {
                    @Override public void onClick(View v) { showHome(); }
                }));
            }
        }));
    }

    private void showCountSku() {
        screen = "count";
        countStep = "sku";
        final EditText sku = input("SKU / UPC", InputType.TYPE_CLASS_TEXT);
        sku.setText(countSku);
        root.removeAllViews();
        root.addView(formLayout("Inventory Count", "Step 2 of 4", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(banner("Scan SKU / UPC", countLocation, BLUE));
                l.addView(field("Location", countLocation));
                l.addView(sku);
                l.addView(primaryButton("Confirm SKU / UPC", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        String value = sku.getText().toString().trim();
                        if (value.length() == 0) {
                            toast("Scan or enter the SKU / UPC.", true);
                            showKeyboard(sku);
                            return;
                        }
                        countSku = value;
                        showCountQty();
                    }
                }));
                l.addView(secondaryButton("Key In SKU", new View.OnClickListener() {
                    @Override public void onClick(View v) { showKeyboard(sku); }
                }));
                l.addView(scanButton("Scan SKU / UPC", sku, "sku"));
                l.addView(secondaryButton("Back to Location", new View.OnClickListener() {
                    @Override public void onClick(View v) { showCountLocation(); }
                }));
            }
        }));
        activateInput(sku, "sku", false);
    }

    private void showCountQty() {
        screen = "count";
        countStep = "qty";
        final EditText cases = input("Cases counted", InputType.TYPE_CLASS_NUMBER);
        cases.setText(countCases);
        cases.setTextSize(32);
        cases.setGravity(Gravity.CENTER);
        cases.setMinHeight(92);
        root.removeAllViews();
        root.addView(formLayout("Inventory Count", "Step 3 of 4", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(banner("Enter Cases", countSku, BLUE));
                l.addView(field("Location", countLocation));
                l.addView(field("SKU / UPC", countSku));
                l.addView(cases);
                l.addView(primaryButton("Confirm Cases", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        int q = intValue(cases);
                        if (cases.getText().toString().trim().length() == 0 || q < 0) {
                            toast("Enter cases counted. Use 0 if empty.", true);
                            showKeyboard(cases);
                            return;
                        }
                        countCases = cases.getText().toString().trim();
                        showCountTrace();
                    }
                }));
                l.addView(secondaryButton("Empty / Zero Cases", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        countCases = "0";
                        showCountTrace();
                    }
                }));
                l.addView(secondaryButton("Back to SKU", new View.OnClickListener() {
                    @Override public void onClick(View v) { showCountSku(); }
                }));
            }
        }));
        activateInput(cases, "cases", true);
    }

    private void showCountTrace() {
        screen = "count";
        countStep = "trace";
        final EditText lot = input("Lot if required", InputType.TYPE_CLASS_TEXT);
        final EditText expiry = input("Expiry YYYY-MM-DD if required", InputType.TYPE_CLASS_TEXT);
        lot.setText(countLot);
        expiry.setText(countExpiry);
        root.removeAllViews();
        root.addView(formLayout("Inventory Count", "Step 4 of 4", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(banner("Lot / Expiry", "Skip when not required", BLUE));
                l.addView(field("Location", countLocation));
                l.addView(field("SKU / UPC", countSku));
                l.addView(field("Cases", countCases));
                l.addView(lot);
                l.addView(scanButton("Scan Lot", lot, "lot"));
                l.addView(expiry);
                l.addView(primaryButton("Submit Count", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        countLot = lot.getText().toString().trim();
                        countExpiry = expiry.getText().toString().trim();
                        submitCount();
                    }
                }));
                l.addView(secondaryButton("Skip Lot / Expiry", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        countLot = "";
                        countExpiry = "";
                        submitCount();
                    }
                }));
                l.addView(secondaryButton("Back to Qty", new View.OnClickListener() {
                    @Override public void onClick(View v) { showCountQty(); }
                }));
            }
        }));
        activateInput(lot, "lot", false);
    }

    private void submitCount() {
        int q = countCases.length() == 0 ? -1 : Integer.parseInt(countCases);
        if (countLocation.length() == 0 || countSku.length() == 0 || q < 0) {
            toast("Count is missing location, SKU, or cases.", true);
            showCountLocation();
            return;
        }
        queue("INVENTORY_COUNT", basePayload()
            .put("accountName", company())
            .put("location", countLocation)
            .put("skuOrUpc", countSku)
            .put("countedCases", q)
            .put("lotNumber", countLot)
            .put("expirationDate", countExpiry)
            .put("recountOverride", countLocationRecountOverride), "Count submitted for review", false);
        markCountedLocationToday(countLocation);
        showCountSaved();
    }

    private void showCountSaved() {
        screen = "count";
        countStep = "";
        root.removeAllViews();
        root.addView(formLayout("Inventory Count", "Saved", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(banner("Count Saved", countSku + " at " + countLocation, GREEN));
                l.addView(field("Cases", countCases));
                l.addView(primaryButton("Add Another SKU Here", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        countSku = "";
                        countCases = "";
                        countLot = "";
                        countExpiry = "";
                        showCountSku();
                    }
                }));
                l.addView(primaryButton("Next Location", new View.OnClickListener() {
                    @Override public void onClick(View v) { showInventoryCount(); }
                }));
                l.addView(secondaryButton("Home", new View.OnClickListener() {
                    @Override public void onClick(View v) { showHome(); }
                }));
            }
        }));
    }

    private void showPallets() {
        screen = "form";
        final EditText pallet = input("Pallet ID, optional", InputType.TYPE_CLASS_TEXT);
        final EditText sku = input("SKU / UPC", InputType.TYPE_CLASS_TEXT);
        final EditText cases = input("Cases on pallet", InputType.TYPE_CLASS_NUMBER);
        final EditText loc = input("Location", InputType.TYPE_CLASS_TEXT);
        root.removeAllViews();
        root.addView(formLayout("Pallets / Labels", "Save pallet record", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(pallet); l.addView(scanButton("Scan Pallet", pallet, "pallet"));
                l.addView(sku); l.addView(scanButton("Scan SKU / UPC", sku, "sku"));
                l.addView(cases); l.addView(loc); l.addView(scanButton("Scan Location", loc, "location"));
                l.addView(primaryButton("Save Pallet", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        int q = intValue(cases);
                        if (sku.getText().length() == 0 || q <= 0) {
                            toast("SKU and cases are required.", true);
                            return;
                        }
                        queue("PALLET_LABEL", basePayload()
                            .put("accountName", company())
                            .put("palletCode", pallet.getText().toString().trim())
                            .put("sku", sku.getText().toString().trim())
                            .put("cases", q)
                            .put("date", today())
                            .put("location", loc.getText().toString().trim()), "Pallet saved");
                    }
                }));
                l.addView(backButton());
            }
        }));
        activeInput = pallet;
        pallet.requestFocus();
    }

    private void showLookup() {
        screen = "form";
        final EditText query = input("Scan SKU, UPC, or BIN", InputType.TYPE_CLASS_TEXT);
        final TextView results = status("Enter or scan a value, then tap Search.");
        root.removeAllViews();
        root.addView(formLayout("Lookup", "Find item or BIN", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(query); l.addView(scanButton("Scan Value", query, "lookup"));
                l.addView(primaryButton("Search", new View.OnClickListener() {
                    @Override public void onClick(View v) { runLookup(query.getText().toString(), results); }
                }));
                l.addView(results);
                l.addView(backButton());
            }
        }));
        activeInput = query;
        query.requestFocus();
    }

    private void runLookup(final String raw, final TextView results) {
        final String search = normalize(raw);
        if (search.length() == 0) {
            toast("Scan or enter a SKU, UPC, or BIN.", true);
            return;
        }
        results.setText("Searching...");
        runAsync("Searching...", new Runnable() {
            @Override public void run() {
                try {
                    ApiResult result = request("/api/state", "GET", null);
                    JSONArray inv = result.json.optJSONArray("inventory");
                    List<String> rows = new ArrayList<>();
                    if (inv != null) {
                        for (int i = 0; i < inv.length() && rows.size() < 12; i++) {
                            JSONObject row = inv.optJSONObject(i);
                            if (row == null || !company().equalsIgnoreCase(row.optString("accountName"))) continue;
                            String loc = row.optString("location");
                            String sku = row.optString("sku");
                            String upc = row.optString("upc");
                            if (normalize(loc).equals(search) || normalize(sku).equals(search) || normalize(upc).equals(search)) {
                                rows.add((loc.length() == 0 ? "-" : loc) + " | " + (sku.length() == 0 ? "-" : sku) + " | Qty " + row.optInt("quantity", row.optInt("onHandQuantity", 0)));
                            }
                        }
                    }
                    final String text = rows.isEmpty() ? "No exact match found. Verify before posting." : join(rows, "\n");
                    runOnUiThread(new Runnable() { @Override public void run() { results.setText(text); } });
                } catch (final Exception ex) {
                    runOnUiThread(new Runnable() { @Override public void run() { results.setText(ex.getMessage()); } });
                }
            }
        });
    }

    private void showReportIssue() {
        screen = "form";
        final EditText details = input("Describe the issue", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        details.setMinLines(4);
        root.removeAllViews();
        root.addView(formLayout("Report Issue", "Tell support what happened", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(details);
                l.addView(primaryButton("Submit Issue", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        String text = details.getText().toString().trim();
                        if (text.length() == 0) {
                            toast("Enter the issue details.", true);
                            return;
                        }
                        queue("FEEDBACK", basePayload()
                            .put("requestType", "BUG")
                            .put("source", "WAREHOUSE")
                            .put("accountName", company())
                            .put("title", text.length() > 120 ? text.substring(0, 120) : text)
                            .put("details", text)
                            .put("pageName", "Alien Native Scanner")
                            .put("appSection", "WAREHOUSE")
                            .put("buildLabel", BuildConfig.VERSION_NAME), "Issue submitted");
                    }
                }));
                l.addView(backButton());
            }
        }));
        details.requestFocus();
    }

    private void showOrderList() {
        screen = "orders";
        activeInput = null;
        root.removeAllViews();
        root.addView(screenLayout(new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(header("Pick Orders", "Select released work"));
                l.addView(backButton());
                l.addView(primaryButton("Refresh Orders", new View.OnClickListener() {
                    @Override public void onClick(View v) { fetchOrders(); }
                }));
                l.addView(status("Loading released orders..."));
            }
        }));
        fetchOrders();
    }

    private void fetchOrders() {
        runAsync("Loading orders...", new Runnable() {
            @Override public void run() {
                try {
                    ApiResult result = request("/api/mobile/pick-orders?accountName=" + url(company()), "GET", null);
                    final JSONArray orders = result.json.optJSONArray("orders") == null ? new JSONArray() : result.json.optJSONArray("orders");
                    runOnUiThread(new Runnable() {
                        @Override public void run() { renderOrders(orders); }
                    });
                } catch (final Exception ex) {
                    fail(ex);
                }
            }
        });
    }

    private void renderOrders(final JSONArray orders) {
        root.removeAllViews();
        root.addView(screenLayout(new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(header("Pick Orders", "Select released work"));
                l.addView(backButton());
                l.addView(primaryButton("Refresh Orders", new View.OnClickListener() {
                    @Override public void onClick(View v) { fetchOrders(); }
                }));
                if (orders.length() == 0) {
                    l.addView(status("No released pick orders for this company."));
                }
                for (int i = 0; i < orders.length(); i++) {
                    final JSONObject order = orders.optJSONObject(i);
                    if (order == null) continue;
                    String code = order.optString("orderCode", "Order " + order.optString("id"));
                    l.addView(blockButton(code + "\n" + order.optString("accountName"), "Start", new View.OnClickListener() {
                        @Override public void onClick(View v) { startOrder(order); }
                    }));
                }
            }
        }));
    }

    private void startOrder(JSONObject order) {
        activeOrderId = order.optString("id");
        activeTasks = buildTasks(order);
        openNextTask();
    }

    private List<PickTask> buildTasks(JSONObject order) {
        List<PickTask> out = new ArrayList<>();
        JSONArray lines = order.optJSONArray("lines");
        if (lines == null) return out;
        int seq = 0;
        for (int i = 0; i < lines.length(); i++) {
            JSONObject line = lines.optJSONObject(i);
            if (line == null) continue;
            JSONArray locs = line.optJSONArray("pickLocations");
            if (locs == null || locs.length() == 0) {
                out.add(PickTask.from(order, line, null, ++seq));
            } else {
                for (int j = 0; j < locs.length(); j++) out.add(PickTask.from(order, line, locs.optJSONObject(j), ++seq));
            }
        }
        Collections.sort(out, new Comparator<PickTask>() {
            @Override public int compare(PickTask a, PickTask b) {
                int loc = a.location.compareTo(b.location);
                if (loc != 0) return loc;
                return a.expiry.compareTo(b.expiry);
            }
        });
        for (int i = 0; i < out.size(); i++) out.get(i).sequence = i + 1;
        return out;
    }

    private void openNextTask() {
        for (PickTask task : activeTasks) {
            if (!task.done && !task.exception) {
                showGoToLocation(task);
                return;
            }
        }
        showPickComplete();
    }

    private void showGoToLocation(final PickTask task) {
        screen = "pick";
        activeTask = task;
        pickState = "location";
        activeInput = null;
        root.removeAllViews();
        root.addView(taskLayout(task, "Go to this location", task.location.length() == 0 ? "Scan source location" : task.location, new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(primaryButton("I Am At Location", new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        if (task.location.length() == 0) showScanLocation(task);
                        else confirmLocation(task.location);
                    }
                }));
                l.addView(secondaryButton("Scan Location", new View.OnClickListener() {
                    @Override public void onClick(View v) { showScanLocation(task); }
                }));
                addProblemButtons(l, task);
            }
        }));
    }

    private void showScanLocation(final PickTask task) {
        screen = "pick";
        activeTask = task;
        pickState = "location";
        final EditText scan = input("Scan or key location", InputType.TYPE_CLASS_TEXT);
        root.removeAllViews();
        root.addView(taskLayout(task, "Confirm you arrived", task.location.length() == 0 ? "Actual pick location required" : task.location, new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(scan);
                l.addView(primaryButton("Confirm Location", new View.OnClickListener() {
                    @Override public void onClick(View v) { confirmLocation(scan.getText().toString()); }
                }));
                addProblemButtons(l, task);
            }
        }));
        activeInput = scan;
        activeInputLabel = "location";
        scan.requestFocus();
    }

    private void showScanSku(final PickTask task) {
        screen = "pick";
        activeTask = task;
        pickState = "sku";
        final EditText scan = input("Scan SKU / UPC", InputType.TYPE_CLASS_TEXT);
        root.removeAllViews();
        root.addView(taskLayout(task, "Pick this item", task.sku, new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(field("Description", task.description.length() == 0 ? "No description" : task.description));
                l.addView(scan);
                l.addView(primaryButton("Confirm SKU", new View.OnClickListener() {
                    @Override public void onClick(View v) { confirmSku(scan.getText().toString()); }
                }));
                addProblemButtons(l, task);
            }
        }));
        activeInput = scan;
        activeInputLabel = "sku";
        scan.requestFocus();
    }

    private void showQty(final PickTask task) {
        screen = "pick";
        activeTask = task;
        pickState = "qty";
        activeInput = null;
        final EditText qty = input("Picked Qty", InputType.TYPE_CLASS_NUMBER);
        qty.setText(String.valueOf(task.remaining()));
        qty.setGravity(Gravity.CENTER);
        qty.setTextSize(28);
        root.removeAllViews();
        root.addView(taskLayout(task, "Confirm picked quantity", task.remaining() + " required", new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(field("Available", String.valueOf(task.availableQty)));
                l.addView(qty);
                l.addView(primaryButton("Confirm Pick", new View.OnClickListener() {
                    @Override public void onClick(View v) { confirmPick(intValue(qty), false); }
                }));
                l.addView(secondaryButton("Short Pick / Not Enough Stock", new View.OnClickListener() {
                    @Override public void onClick(View v) { confirmPick(intValue(qty), true); }
                }));
                addProblemButtons(l, task);
            }
        }));
        qty.requestFocus();
    }

    private void confirmLocation(String value) {
        if (activeTask == null) return;
        String scanned = normalize(value);
        String expected = normalize(activeTask.location);
        if (expected.length() > 0 && !expected.equals(scanned)) {
            error();
            toast("Wrong location. Expected " + activeTask.location, true);
            return;
        }
        String key = key("arrival");
        queueOnly("PICK_ARRIVAL", basePayload()
            .put("orderId", activeTask.orderId)
            .put("sourceType", "PORTAL_ORDER")
            .put("sourceId", activeTask.orderId)
            .put("lineId", activeTask.lineId)
            .put("accountName", activeTask.accountName)
            .put("location", activeTask.location.length() == 0 ? value.trim() : activeTask.location)
            .put("idempotencyKey", key));
        showScanSku(activeTask);
        syncQueue(false);
    }

    private void confirmSku(String value) {
        if (activeTask == null) return;
        String scanned = normalize(value);
        if (!normalize(activeTask.sku).equals(scanned) && (activeTask.upc.length() == 0 || !normalize(activeTask.upc).equals(scanned))) {
            error();
            toast("Wrong item. Expected " + activeTask.sku, true);
            return;
        }
        showQty(activeTask);
    }

    private void confirmPick(int qty, boolean shortPick) {
        if (activeTask == null) return;
        if (qty <= 0 || qty > activeTask.remaining()) {
            error();
            toast("Check picked quantity.", true);
            return;
        }
        queueOnly("PICK_CONFIRMATION", basePayload()
            .put("orderId", activeTask.orderId)
            .put("sourceType", "PORTAL_ORDER")
            .put("sourceId", activeTask.orderId)
            .put("lineId", activeTask.lineId)
            .put("accountName", activeTask.accountName)
            .put("location", activeTask.location)
            .put("sku", activeTask.sku)
            .put("skuOrUpc", activeTask.sku)
            .put("quantity", qty)
            .put("lot", activeTask.lot)
            .put("expiry", activeTask.expiry)
            .put("idempotencyKey", key("pick")));
        activeTask.pickedQty += qty;
        if (shortPick || activeTask.pickedQty < activeTask.requiredQty) {
            activeTask.exception = true;
            queueOnly("PICK_EXCEPTION", basePayload()
                .put("orderId", activeTask.orderId)
                .put("sourceType", "PORTAL_ORDER")
                .put("sourceId", activeTask.orderId)
                .put("lineId", activeTask.lineId)
                .put("accountName", activeTask.accountName)
                .put("location", activeTask.location)
                .put("sku", activeTask.sku)
                .put("quantity", qty)
                .put("reason", "SHORT_PICK")
                .put("note", "Alien worker short picked " + qty + " of " + activeTask.requiredQty)
                .put("idempotencyKey", key("short-pick")));
        } else {
            activeTask.done = true;
        }
        success();
        syncQueue(false);
        openNextTask();
    }

    private void reportException(PickTask task, String reason) {
        task.exception = true;
        queueOnly("PICK_EXCEPTION", basePayload()
            .put("orderId", task.orderId)
            .put("sourceType", "PORTAL_ORDER")
            .put("sourceId", task.orderId)
            .put("lineId", task.lineId)
            .put("accountName", task.accountName)
            .put("location", task.location)
            .put("sku", task.sku)
            .put("quantity", task.remaining())
            .put("reason", reason)
            .put("idempotencyKey", key("exception")));
        syncQueue(false);
        openNextTask();
    }

    private void showPickComplete() {
        screen = "complete";
        int exceptions = 0;
        for (PickTask task : activeTasks) if (task.exception) exceptions++;
        final int finalExceptions = exceptions;
        root.removeAllViews();
        root.addView(screenLayout(new Builder() {
            @Override public void build(LinearLayout l) {
                l.addView(header("Picking Complete", activeOrderId));
                l.addView(banner(finalExceptions > 0 ? "Needs Review" : "Ready to Pack", finalExceptions > 0 ? finalExceptions + " exception(s)" : "All picks confirmed", finalExceptions > 0 ? YELLOW : GREEN));
                l.addView(primaryButton("Sync Now", new View.OnClickListener() {
                    @Override public void onClick(View v) { syncQueue(true); }
                }));
                l.addView(secondaryButton("Choose Another Order", new View.OnClickListener() {
                    @Override public void onClick(View v) { showOrderList(); }
                }));
                l.addView(secondaryButton("Home", new View.OnClickListener() {
                    @Override public void onClick(View v) { showHome(); }
                }));
            }
        }));
    }

    private void handleScan(String value) {
        if (value == null || value.trim().length() == 0) return;
        value = value.trim();
        if ("pick".equals(screen)) {
            if ("location".equals(pickState)) confirmLocation(value);
            else if ("sku".equals(pickState)) confirmSku(value);
            else toast("Scan received: " + value, false);
            return;
        }
        if (activeInput != null) {
            activeInput.setText(value);
            activeInput.setSelection(activeInput.getText().length());
            toast("Scanned " + (activeInputLabel.length() == 0 ? "value" : activeInputLabel), false);
            if ("count".equals(screen)) {
                if ("location".equals(countStep)) {
                    confirmCountLocationForCounting(value);
                } else if ("sku".equals(countStep)) {
                    countSku = value;
                    showCountQty();
                } else if ("qty".equals(countStep)) {
                    String digits = value.replaceAll("[^0-9]", "");
                    if (digits.length() == 0) {
                        toast("Qty scan did not include a number.", true);
                        return;
                    }
                    countCases = digits;
                    showCountTrace();
                }
            }
        } else {
            toast("Scan received: " + value, false);
        }
    }

    private void queue(String type, JSONObject payload, String message) {
        queue(type, payload, message, true);
    }

    private void queue(String type, JSONObject payload, String message, boolean returnHome) {
        queueOnly(type, payload);
        success();
        toast(message + ". Syncing...", false);
        syncQueue(false);
        if (returnHome) showHome();
    }

    private void queueOnly(String type, JSONObject payload) {
        try {
            if (!payload.has("idempotencyKey")) payload.put("idempotencyKey", key(type.toLowerCase(Locale.US)));
            payload.put("deviceId", deviceId());
            payload.put("source", "alien_native");
            payload.put("clientTimestamp", System.currentTimeMillis());
            JSONObject item = new JSONObject()
                .put("type", type)
                .put("payload", payload)
                .put("createdAt", System.currentTimeMillis());
            JSONArray arr = outbox();
            arr.put(item);
            prefs.edit().putString(KEY_OUTBOX, arr.toString()).apply();
        } catch (Exception ex) {
            toast(ex.getMessage(), true);
        }
    }

    private void syncQueue(final boolean announce) {
        if (cookie().length() == 0) return;
        runAsync(announce ? "Syncing..." : "", new Runnable() {
            @Override public void run() {
                try {
                    JSONArray arr = outbox();
                    JSONArray remaining = new JSONArray();
                    int sent = 0;
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject item = arr.optJSONObject(i);
                        if (item == null) continue;
                        try {
                            request(apiPath(item.optString("type")), "POST", item.optJSONObject("payload"));
                            sent++;
                        } catch (Exception ex) {
                            remaining.put(item);
                        }
                    }
                    prefs.edit().putString(KEY_OUTBOX, remaining.toString()).apply();
                    if (announce) {
                        final String msg = "Sent " + sent + ", pending " + remaining.length();
                        runOnUiThread(new Runnable() { @Override public void run() { toast(msg, false); showHome(); } });
                    }
                } catch (Exception ex) {
                    if (announce) fail(ex);
                }
            }
        });
    }

    private String apiPath(String type) {
        if ("PICK_ARRIVAL".equals(type)) return "/api/mobile/pick-arrivals";
        if ("PICK_CONFIRMATION".equals(type)) return "/api/mobile/pick-confirmations";
        if ("PICK_EXCEPTION".equals(type)) return "/api/mobile/pick-exceptions";
        if ("PUT_AWAY".equals(type)) return "/api/mobile/put-away-confirmations";
        if ("MOVE".equals(type)) return "/api/mobile/move-confirmations";
        if ("RECEIVING".equals(type)) return "/api/mobile/receiving-confirmations";
        if ("INVENTORY_COUNT".equals(type)) return "/api/inventory-counts";
        if ("PALLET_LABEL".equals(type)) return "/api/pallets/save";
        if ("FEEDBACK".equals(type)) return "/api/app/feedback";
        return "/api/app/feedback";
    }

    private J basePayload() {
        return devicePayload()
            .put("accountName", company())
            .put("deviceId", deviceId())
            .put("source", "alien_native");
    }

    private J devicePayload() {
        return new J()
            .put("source", "alien_native")
            .put("appSource", "alien_native")
            .put("appName", "WMS365 Scanner Alien")
            .put("packageName", BuildConfig.APPLICATION_ID)
            .put("platform", "android")
            .put("deviceId", deviceId())
            .put("manufacturer", android.os.Build.MANUFACTURER)
            .put("model", android.os.Build.MODEL)
            .put("osVersion", android.os.Build.VERSION.RELEASE)
            .put("sdkVersion", String.valueOf(android.os.Build.VERSION.SDK_INT))
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("appVersionCode", String.valueOf(BuildConfig.VERSION_CODE))
            .put("scannerType", "Alien ALR-H450 hardware scanner")
            .put("accountName", company());
    }

    private void checkInDevice() {
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    if (cookie().length() > 0) {
                        request("/api/app/device-checkin", "POST", devicePayload());
                    }
                } catch (Exception ignored) {
                }
            }
        }).start();
    }

    private ApiResult request(String path, String method, JSONObject body) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(BuildConfig.WMS365_BASE_URL + path).openConnection();
        if (con instanceof HttpsURLConnection) {
            ((HttpsURLConnection) con).setSSLSocketFactory(tls12SocketFactory());
        }
        con.setRequestMethod(method);
        con.setConnectTimeout(15000);
        con.setReadTimeout(90000);
        con.setRequestProperty("Accept", "application/json");
        con.setRequestProperty("Content-Type", "application/json");
        con.setRequestProperty("X-WMS365-Mobile-Source", "alien_native");
        if (cookie().length() > 0) con.setRequestProperty("Cookie", cookie());
        if (body != null) {
            con.setDoOutput(true);
            OutputStream os = con.getOutputStream();
            os.write(body.toString().getBytes("UTF-8"));
            os.close();
        }
        int status = con.getResponseCode();
        BufferedReader br = new BufferedReader(new InputStreamReader(status >= 200 && status < 300 ? con.getInputStream() : con.getErrorStream(), "UTF-8"));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = br.readLine()) != null) sb.append(line);
        br.close();
        JSONObject json = sb.length() == 0 ? new JSONObject() : new JSONObject(sb.toString());
        String cookie = "";
        List<String> cookies = con.getHeaderFields().get("Set-Cookie");
        if (cookies != null) {
            List<String> parts = new ArrayList<>();
            for (String c : cookies) {
                if (c != null && c.indexOf(';') > 0) parts.add(c.substring(0, c.indexOf(';')));
            }
            cookie = join(parts, "; ");
        }
        if (status < 200 || status >= 300) {
            throw new Exception(json.optString("error", json.optString("message", "HTTP " + status)));
        }
        return new ApiResult(json, cookie);
    }

    private void installTls12ForAndroid44() {
        try {
            if (Security.getProvider("Conscrypt") == null) {
                Security.insertProviderAt(Conscrypt.newProvider(), 1);
            }
            HttpsURLConnection.setDefaultSSLSocketFactory(tls12SocketFactory());
        } catch (Throwable ignored) {
        }
    }

    private SSLSocketFactory tls12SocketFactory() {
        try {
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[] { combinedTrustManager() }, null);
            return new Tls12SocketFactory(context.getSocketFactory());
        } catch (Throwable error) {
            Log.e("WMS365Alien", "Falling back to platform TLS socket factory", error);
            SSLSocketFactory factory = (SSLSocketFactory) SSLCertificateSocketFactory.getDefault(90000, null);
            return new Tls12SocketFactory(factory);
        }
    }

    private X509TrustManager combinedTrustManager() throws Exception {
        final X509TrustManager systemTrust = trustManagerFor(null);

        KeyStore extraStore = KeyStore.getInstance(KeyStore.getDefaultType());
        extraStore.load(null, null);
        InputStream certStream = getResources().openRawResource(getResources().getIdentifier("isrg_root_x1", "raw", getPackageName()));
        try {
            Certificate certificate = CertificateFactory.getInstance("X.509").generateCertificate(certStream);
            extraStore.setCertificateEntry("isrg_root_x1", certificate);
        } finally {
            certStream.close();
        }
        final X509TrustManager bundledTrust = trustManagerFor(extraStore);

        return new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                systemTrust.checkClientTrusted(chain, authType);
            }

            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try {
                    systemTrust.checkServerTrusted(chain, authType);
                } catch (CertificateException systemError) {
                    bundledTrust.checkServerTrusted(chain, authType);
                }
            }

            @Override public X509Certificate[] getAcceptedIssuers() {
                List<X509Certificate> issuers = new ArrayList<>();
                issuers.addAll(Arrays.asList(systemTrust.getAcceptedIssuers()));
                issuers.addAll(Arrays.asList(bundledTrust.getAcceptedIssuers()));
                return issuers.toArray(new X509Certificate[issuers.size()]);
            }
        };
    }

    private X509TrustManager trustManagerFor(KeyStore keyStore) throws Exception {
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init(keyStore);
        TrustManager[] managers = factory.getTrustManagers();
        for (TrustManager manager : managers) {
            if (manager instanceof X509TrustManager) return (X509TrustManager) manager;
        }
        throw new IllegalStateException("No X509 trust manager available.");
    }

    private static class Tls12SocketFactory extends SSLSocketFactory {
        private static final String[] TLS_12 = new String[] { "TLSv1.2" };
        private final SSLSocketFactory delegate;

        Tls12SocketFactory(SSLSocketFactory delegate) {
            this.delegate = delegate;
        }

        private Socket patch(Socket socket, String host) {
            if (socket instanceof SSLSocket) {
                SSLSocket ssl = (SSLSocket) socket;
                ssl.setEnabledProtocols(TLS_12);
                if (host != null && host.length() > 0) {
                    if (delegate instanceof SSLCertificateSocketFactory) {
                        try {
                            ((SSLCertificateSocketFactory) delegate).setHostname(socket, host);
                        } catch (Throwable ignored) {
                        }
                    }
                    try {
                        Method setUseSessionTickets = ssl.getClass().getMethod("setUseSessionTickets", boolean.class);
                        setUseSessionTickets.invoke(ssl, true);
                    } catch (Throwable ignored) {
                    }
                    try {
                        Method setHostname = ssl.getClass().getMethod("setHostname", String.class);
                        setHostname.invoke(ssl, host);
                    } catch (Throwable ignored) {
                    }
                }
            }
            return socket;
        }

        @Override public String[] getDefaultCipherSuites() {
            return delegate.getDefaultCipherSuites();
        }

        @Override public String[] getSupportedCipherSuites() {
            return delegate.getSupportedCipherSuites();
        }

        @Override public Socket createSocket(Socket s, String host, int port, boolean autoClose) throws IOException {
            return patch(delegate.createSocket(s, host, port, autoClose), host);
        }

        @Override public Socket createSocket(String host, int port) throws IOException {
            return patch(delegate.createSocket(host, port), host);
        }

        @Override public Socket createSocket(String host, int port, InetAddress localHost, int localPort) throws IOException {
            return patch(delegate.createSocket(host, port, localHost, localPort), host);
        }

        @Override public Socket createSocket(InetAddress host, int port) throws IOException {
            return patch(delegate.createSocket(host, port), host == null ? null : host.getHostName());
        }

        @Override public Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort) throws IOException {
            return patch(delegate.createSocket(address, port, localAddress, localPort), address == null ? null : address.getHostName());
        }
    }

    private void configureScanner() {
        try {
            BarcodeUtility.getInstance().open(this, ModuleType.BARCODE_2D);
        } catch (Throwable ignored) {
        }
        try {
            if (barcodeReader == null) barcodeReader = new BarcodeReader(this);
        } catch (Throwable ignored) {
        }
    }

    private void startBarcodeScan() {
        hideKeyboard();
        try {
            configureScanner();
            if (barcodeReader == null) throw new IllegalStateException("Scanner not available.");
            barcodeReader.start(new BarcodeCallback() {
                @Override public void onBarcodeRead(String value) { handleScan(value); }
            });
        } catch (Throwable ex) {
            toast("Scanner trigger ready. Scan or key in value.", false);
        }
    }

    private void stopBarcodeScan() {
        try {
            if (barcodeReader != null) barcodeReader.stop();
        } catch (Throwable ignored) {
        }
    }

    private void registerReceivers() {
        if (receiversRegistered) return;
        IntentFilter f = new IntentFilter();
        f.addAction("com.wms365.alien.SCAN_RESULT");
        f.addAction("android.intent.action.SCAN_RESULT");
        f.addAction("android.intent.action.SCANRESULT");
        f.addAction("com.scanner.broadcast");
        f.addAction("scan.rcv.message");
        f.addAction("com.symbol.datawedge.api.RESULT_ACTION");
        registerReceiver(scannerReceiver, f);
        receiversRegistered = true;
    }

    private void unregisterReceivers() {
        if (!receiversRegistered) return;
        try { unregisterReceiver(scannerReceiver); } catch (Throwable ignored) {}
        receiversRegistered = false;
    }

    private String extractScan(Intent intent) {
        if (intent == null) return "";
        String[] keys = new String[] {"barcode", "data", "value", "scan_result", "barcode_string", "com.symbol.datawedge.data_string"};
        for (String k : keys) {
            String v = intent.getStringExtra(k);
            if (v != null && v.trim().length() > 0) return v.trim();
        }
        Bundle extras = intent.getExtras();
        if (extras != null) {
            for (String k : extras.keySet()) {
                Object raw = extras.get(k);
                if (raw instanceof String && ((String) raw).trim().length() > 0) return ((String) raw).trim();
                if (raw instanceof byte[]) return new String((byte[]) raw).trim();
            }
        }
        return "";
    }

    private ScrollView screenLayout(Builder builder) {
        LinearLayout l = baseLinear();
        builder.build(l);
        ScrollView s = new ScrollView(this);
        s.addView(l, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return s;
    }

    private ScrollView formLayout(String title, String instruction, Builder builder) {
        LinearLayout l = baseLinear();
        l.addView(header(title, "Native Alien workflow"));
        l.addView(banner(instruction, company(), BLUE));
        builder.build(l);
        ScrollView s = new ScrollView(this);
        s.addView(l, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return s;
    }

    private ScrollView taskLayout(PickTask task, String instruction, String focus, Builder builder) {
        LinearLayout l = baseLinear();
        int done = 0;
        for (PickTask t : activeTasks) if (t.done || t.exception) done++;
        l.addView(header(task.orderCode, "Step " + task.sequence + " of " + activeTasks.size() + " | " + done + " done"));
        l.addView(banner(instruction, focus, BLUE));
        l.addView(field("Required", String.valueOf(task.requiredQty)));
        builder.build(l);
        l.addView(secondaryButton("Back to Orders", new View.OnClickListener() {
            @Override public void onClick(View v) { showOrderList(); }
        }));
        ScrollView s = new ScrollView(this);
        s.addView(l, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return s;
    }

    private LinearLayout baseLinear() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(12, 12, 12, 12);
        l.setBackgroundColor(BG);
        return l;
    }

    private View header(String title, String sub) {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(0, 0, 0, 10);
        TextView t = new TextView(this);
        t.setText(title);
        t.setTextSize(22);
        t.setTextColor(TEXT);
        t.setTypeface(null, 1);
        l.addView(t);
        TextView s = new TextView(this);
        s.setText(sub);
        s.setTextSize(13);
        s.setTextColor(MUTED);
        l.addView(s);
        return l;
    }

    private View banner(String title, String value, int color) {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(14, 12, 14, 12);
        l.setBackgroundColor(color);
        l.setLayoutParams(margins());
        TextView t = new TextView(this);
        t.setText(title.toUpperCase(Locale.US));
        t.setTextSize(15);
        t.setTextColor(Color.WHITE);
        t.setTypeface(null, 1);
        l.addView(t);
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(value.length() <= 16 ? 34 : 24);
        v.setTextColor(Color.WHITE);
        v.setTypeface(null, 1);
        v.setGravity(Gravity.CENTER);
        v.setPadding(0, 10, 0, 4);
        l.addView(v);
        return l;
    }

    private EditText input(String hint, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(type);
        e.setTextSize(21);
        e.setTextColor(TEXT);
        e.setHintTextColor(MUTED);
        e.setSingleLine((type & InputType.TYPE_TEXT_FLAG_MULTI_LINE) == 0);
        e.setMinHeight(76);
        e.setPadding(22, 10, 22, 10);
        e.setBackground(inputBackground(false));
        e.setLayoutParams(margins());
        e.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showKeyboard((EditText) v); }
        });
        e.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override public void onFocusChange(View v, boolean hasFocus) {
                v.setBackground(inputBackground(hasFocus));
                if (hasFocus) activeInput = (EditText) v;
            }
        });
        return e;
    }

    private GradientDrawable inputBackground(boolean focused) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(10);
        bg.setStroke(focused ? 4 : 2, focused ? BLUE : Color.rgb(148, 163, 184));
        return bg;
    }

    private void activateInput(final EditText input, String label, boolean keyboard) {
        activeInput = input;
        activeInputLabel = label;
        input.requestFocus();
        if (keyboard) showKeyboard(input);
    }

    private void showKeyboard(final EditText input) {
        try {
            activeInput = input;
            input.requestFocus();
            input.postDelayed(new Runnable() {
                @Override public void run() {
                    InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                    if (imm != null) imm.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);
                }
            }, 180);
        } catch (Throwable ignored) {}
    }

    private Button primaryButton(String text, View.OnClickListener listener) {
        return button(text, GREEN, Color.WHITE, listener);
    }

    private Button secondaryButton(String text, View.OnClickListener listener) {
        return button(text, Color.WHITE, TEXT, listener);
    }

    private Button backButton() {
        return secondaryButton("Back", new View.OnClickListener() {
            @Override public void onClick(View v) { showHome(); }
        });
    }

    private Button blockButton(String title, String action, View.OnClickListener listener) {
        Button b = button(title + "\n" + action, Color.WHITE, TEXT, listener);
        b.setMinHeight(96);
        b.setGravity(Gravity.CENTER_VERTICAL);
        return b;
    }

    private Button scanButton(String text, final EditText target, final String label) {
        return secondaryButton(text, new View.OnClickListener() {
            @Override public void onClick(View v) {
                activeInput = target;
                activeInputLabel = label;
                target.requestFocus();
                startBarcodeScan();
            }
        });
    }

    private Button button(String text, int bg, int fg, final View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextSize(18);
        b.setTextColor(fg);
        b.setBackgroundColor(bg);
        b.setAllCaps(false);
        b.setMinHeight(64);
        b.setLayoutParams(margins());
        b.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (actionLocked) return;
                actionLocked = true;
                handler.postDelayed(new Runnable() { @Override public void run() { actionLocked = false; } }, 450);
                hideKeyboard();
                listener.onClick(v);
            }
        });
        return b;
    }

    private TextView field(String label, String value) {
        TextView t = status(label + ": " + value);
        t.setTextSize(19);
        t.setTextColor(TEXT);
        return t;
    }

    private TextView status(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(15);
        t.setTextColor(MUTED);
        t.setPadding(8, 10, 8, 10);
        t.setLayoutParams(margins());
        return t;
    }

    private LinearLayout.LayoutParams margins() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.setMargins(0, 6, 0, 6);
        return p;
    }

    private void addProblemButtons(LinearLayout l, final PickTask task) {
        l.addView(secondaryButton("Location Empty", new View.OnClickListener() {
            @Override public void onClick(View v) { reportException(task, "LOCATION_EMPTY"); }
        }));
        l.addView(secondaryButton("Damaged / Blocked / Wrong Item", new View.OnClickListener() {
            @Override public void onClick(View v) { reportException(task, "PICK_EXCEPTION"); }
        }));
    }

    private void runAsync(final String message, final Runnable action) {
        if (message != null && message.length() > 0) toast(message, false);
        executor.execute(action);
    }

    private void fail(final Exception ex) {
        runOnUiThread(new Runnable() { @Override public void run() { toast(ex.getMessage() == null ? "Action failed" : ex.getMessage(), true); } });
    }

    private void toast(String msg, boolean bad) {
        setStatusLine(msg);
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
        if (bad) error();
    }

    private void setStatusLine(final String msg) {
        if (transientStatus == null) return;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (transientStatus != null) transientStatus.setText(msg == null ? "" : msg);
            }
        });
    }

    private void success() {
        try {
            ((Vibrator) getSystemService(VIBRATOR_SERVICE)).vibrate(40);
        } catch (Throwable ignored) {}
    }

    private void error() {
        try {
            ((Vibrator) getSystemService(VIBRATOR_SERVICE)).vibrate(140);
        } catch (Throwable ignored) {}
    }

    private void hideKeyboard() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            imm.hideSoftInputFromWindow(root.getWindowToken(), 0);
        } catch (Throwable ignored) {}
    }

    private String cookie() { return prefs.getString(KEY_COOKIE, ""); }
    private String company() { return prefs.getString(KEY_COMPANY, ""); }

    private String deviceId() {
        String id = prefs.getString(KEY_DEVICE_ID, "");
        if (id.length() == 0) {
            id = UUID.randomUUID().toString();
            prefs.edit().putString(KEY_DEVICE_ID, id).apply();
        }
        return id;
    }

    private void logout() {
        prefs.edit().putString(KEY_COOKIE, "").putString(KEY_COMPANY, "").apply();
        showLogin();
    }

    private void saveCompanies(List<String> companies) {
        Set<String> set = new LinkedHashSet<>(companies);
        JSONArray arr = new JSONArray();
        for (String c : set) if (c != null && c.trim().length() > 0) arr.put(c.trim());
        prefs.edit().putString(KEY_COMPANIES, arr.toString()).apply();
    }

    private List<String> loadCompanies() {
        List<String> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs.getString(KEY_COMPANIES, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                String c = arr.optString(i, "").trim();
                if (c.length() > 0) out.add(c);
            }
        } catch (Exception ignored) {}
        return out;
    }

    private JSONArray outbox() {
        try { return new JSONArray(prefs.getString(KEY_OUTBOX, "[]")); }
        catch (Exception ex) { return new JSONArray(); }
    }

    private int pendingCount() { return outbox().length(); }

    private int intValue(EditText e) {
        try { return Integer.parseInt(e.getText().toString().trim()); }
        catch (Exception ex) { return 0; }
    }

    private String key(String prefix) {
        return "alien-" + prefix + "-" + deviceId() + "-" + System.currentTimeMillis();
    }

    private String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    private String countedLocationKey(String location) {
        return normalize(company()) + "|" + today() + "|" + normalize(location);
    }

    private boolean hasCountedLocationToday(String location) {
        String key = countedLocationKey(location);
        if (key.endsWith("|")) return false;
        try {
            JSONArray remembered = new JSONArray(prefs.getString(KEY_COUNTED_LOCATIONS, "[]"));
            for (int i = 0; i < remembered.length(); i++) {
                if (key.equals(remembered.optString(i))) return true;
            }
            JSONArray pending = outbox();
            for (int i = 0; i < pending.length(); i++) {
                JSONObject item = pending.optJSONObject(i);
                if (item == null || !"INVENTORY_COUNT".equals(item.optString("type"))) continue;
                JSONObject payload = item.optJSONObject("payload");
                if (payload == null) continue;
                String pendingKey = normalize(payload.optString("accountName")) + "|" + today() + "|" + normalize(payload.optString("location"));
                if (key.equals(pendingKey)) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    private void markCountedLocationToday(String location) {
        String key = countedLocationKey(location);
        if (key.endsWith("|")) return;
        try {
            JSONArray existing = new JSONArray(prefs.getString(KEY_COUNTED_LOCATIONS, "[]"));
            LinkedHashSet<String> values = new LinkedHashSet<>();
            String prefix = normalize(company()) + "|" + today() + "|";
            values.add(key);
            for (int i = 0; i < existing.length() && values.size() < 250; i++) {
                String value = existing.optString(i);
                if (value != null && value.startsWith(prefix)) values.add(value);
            }
            JSONArray saved = new JSONArray();
            for (String value : values) saved.put(value);
            prefs.edit().putString(KEY_COUNTED_LOCATIONS, saved.toString()).apply();
        } catch (Exception ignored) {}
    }

    private String normalize(String v) {
        if (v == null) return "";
        return v.trim().toUpperCase(Locale.US).replaceAll("[^A-Z0-9]", "");
    }

    private String url(String v) throws Exception {
        return URLEncoder.encode(v, "UTF-8");
    }

    private String join(List<String> parts, String sep) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < parts.size(); i++) {
            if (i > 0) out.append(sep);
            out.append(parts.get(i));
        }
        return out.toString();
    }

    private interface Builder { void build(LinearLayout l); }

    private static class ApiResult {
        final JSONObject json;
        final String cookie;
        ApiResult(JSONObject json, String cookie) {
            this.json = json;
            this.cookie = cookie == null ? "" : cookie;
        }
    }

    private static class J extends JSONObject {
        @Override
        public J put(String name, Object value) {
            try {
                super.put(name, value);
            } catch (Exception ignored) {
            }
            return this;
        }

        @Override
        public J put(String name, int value) {
            try {
                super.put(name, value);
            } catch (Exception ignored) {
            }
            return this;
        }

        @Override
        public J put(String name, long value) {
            try {
                super.put(name, value);
            } catch (Exception ignored) {
            }
            return this;
        }

        @Override
        public J put(String name, boolean value) {
            try {
                super.put(name, value);
            } catch (Exception ignored) {
            }
            return this;
        }

        @Override
        public J put(String name, double value) {
            try {
                super.put(name, value);
            } catch (Exception ignored) {
            }
            return this;
        }
    }

    private static class PickTask {
        String orderId = "";
        String lineId = "";
        String orderCode = "";
        String accountName = "";
        String location = "";
        String sku = "";
        String upc = "";
        String description = "";
        int requiredQty = 0;
        int availableQty = 0;
        int pickedQty = 0;
        String lot = "";
        String expiry = "";
        int sequence = 0;
        boolean done = false;
        boolean exception = false;

        int remaining() { return Math.max(requiredQty - pickedQty, 0); }

        static PickTask from(JSONObject order, JSONObject line, JSONObject loc, int seq) {
            PickTask task = new PickTask();
            task.orderId = order.optString("id");
            task.orderCode = order.optString("orderCode", "Order " + task.orderId);
            task.accountName = order.optString("accountName");
            task.lineId = line.optString("id", String.valueOf(seq));
            task.sku = line.optString("sku");
            task.upc = line.optString("upc");
            task.description = line.optString("description");
            task.location = loc == null ? "" : loc.optString("location");
            task.lot = loc == null ? "" : loc.optString("lotNumber");
            task.expiry = loc == null ? "" : loc.optString("expirationDate");
            int locQty = loc == null ? 0 : loc.optInt("quantity", 0);
            task.requiredQty = locQty > 0 ? locQty : line.optInt("quantity", 0);
            task.availableQty = line.optInt("availableQuantity", task.requiredQty);
            task.sequence = seq;
            return task;
        }
    }
}
