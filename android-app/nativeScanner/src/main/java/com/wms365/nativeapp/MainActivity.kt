package com.wms365.nativeapp

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.zxing.integration.android.IntentIntegrator
import com.wms365.nativeapp.data.AppSession
import com.wms365.nativeapp.data.LocalStore
import com.wms365.nativeapp.data.OutboxType
import com.wms365.nativeapp.data.PickState
import com.wms365.nativeapp.data.PickTask
import com.wms365.nativeapp.network.WmsApiClient
import com.wms365.nativeapp.scanner.ScannerManager
import com.wms365.nativeapp.sync.SyncEngine
import com.wms365.nativeapp.sync.SyncJobService
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var store: LocalStore
    private lateinit var api: WmsApiClient
    private lateinit var sync: SyncEngine
    private lateinit var scanner: ScannerManager
    private val executor = Executors.newSingleThreadExecutor()

    private var activeOrderId = ""
    private var activeScanTarget = ScanTarget.NONE
    private var activeTask: PickTask? = null
    private var messageText: TextView? = null
    private var currentScreen = Screen.LOGIN
    private var scanReceiverRegistered = false
    private var actionLockedUntil = 0L
    private var activeTextInput: EditText? = null
    private var activeTextInputTarget = ""
    private var activeCountStep = CountStep.NONE
    private var countLocation = ""
    private var countSkuOrUpc = ""
    private var countCases = ""
    private var countLot = ""
    private var countExpiry = ""
    private val scanReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val value = extractScanFromIntent(intent)
            if (value.isNotBlank()) scanner.acceptCameraResult(value)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = FrameLayout(this)
        setContentView(root)

        store = LocalStore(this)
        api = WmsApiClient()
        scanner = ScannerManager(this) { handleScan(it) }
        sync = SyncEngine(this, store, api) { status ->
            toastStatus(status.label(), status.failedAfter > 0 || status.message.isNotBlank())
            when (currentScreen) {
                Screen.HOME -> showHome()
                Screen.ORDER_LIST -> showOrderList()
                else -> Unit
            }
        }
        SyncJobService.schedule(this)

        val session = store.getSession()
        when {
            session == null -> showLogin()
            session.company.isBlank() -> showCompanySelect()
            else -> {
                showHome()
                sync.syncNow(downloadOrders = true)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        registerScanReceivers()
    }

    override fun onPause() {
        unregisterScanReceivers()
        super.onPause()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        return scanner.dispatchKeyEvent(event) || super.dispatchKeyEvent(event)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        val result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (result != null) {
            if (!result.contents.isNullOrBlank()) scanner.acceptCameraResult(result.contents)
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    @Deprecated("Deprecated in Android platform API; kept for rugged devices on older Android builds.")
    override fun onBackPressed() {
        when (currentScreen) {
            Screen.FORM, Screen.ORDER_LIST, Screen.COMPLETE -> showHome()
            Screen.COMPANY_SELECT -> showLogin()
            Screen.COUNT -> when (activeCountStep) {
                CountStep.LOCATION, CountStep.NONE -> showHome()
                CountStep.SKU -> showCountLocation()
                CountStep.QTY -> showCountSku()
                CountStep.TRACE -> showCountQty()
            }
            Screen.PICKING -> showOrderList()
            Screen.SYNC_ISSUES -> showHome()
            Screen.LOGIN -> super.onBackPressed()
            Screen.HOME -> super.onBackPressed()
        }
    }

    private fun showLogin() {
        activeScanTarget = ScanTarget.NONE
        currentScreen = Screen.LOGIN
        root.removeAllViews()
        val email = input("Warehouse email", InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val password = input("Password", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val status = statusView("Sign in first. Next screen selects the company for this work session.")
        messageText = status

        root.addView(screen {
            addView(header("WMS365 Scanner", "Warehouse terminal"))
            addView(email)
            addView(password)
            addView(primaryButton("Sign In") {
                val deviceId = store.getSetting("deviceId").ifBlank {
                    UUID.randomUUID().toString().also { store.setSetting("deviceId", it) }
                }
                runAsync("Signing in...") {
                    val session = api.login(email.text.toString(), password.text.toString(), deviceId)
                    store.saveSession(session)
                    runOnUiThread {
                        showCompanySelect(forceRefresh = true)
                    }
                }
            })
            addView(status)
            addView(footer())
        })
        email.requestFocus()
    }

    private fun showCompanySelect(forceRefresh: Boolean = false) {
        clearNativeScan()
        currentScreen = Screen.COMPANY_SELECT
        val cachedCompanies = store.getCompanyList()
        renderCompanySelect(cachedCompanies, if (cachedCompanies.isEmpty()) "Loading companies..." else "Choose the company to work on.")
        if (forceRefresh || cachedCompanies.isEmpty()) fetchCompanyList()
    }

    private fun renderCompanySelect(companies: List<String>, statusMessage: String) {
        root.removeAllViews()
        val manualCompany = input("Type company if not listed", InputType.TYPE_CLASS_TEXT)
        val status = statusView(statusMessage)
        messageText = status
        root.addView(screen {
            addView(header("WMS365 Scanner", "Select company"))
            addView(banner("Choose Company", "This locks the work area", BLUE))
            if (companies.isEmpty()) {
                addView(statusView("No companies loaded yet. Use Refresh or enter the company manually."))
            } else {
                companies.forEach { company ->
                    addView(blockButton(company, "Select") { lockCompanyAndOpen(company) })
                }
            }
            addView(statusView("Manual fallback"))
            addView(manualCompany)
            addView(primaryButton("Use This Company") {
                val company = manualCompany.text.toString().trim()
                if (company.isBlank()) {
                    toastStatus("Choose or enter a company.", true)
                } else {
                    lockCompanyAndOpen(company)
                }
            })
            addView(secondaryButton("Refresh Companies") { fetchCompanyList() })
            addView(secondaryButton("Logout") {
                store.clearSession()
                showLogin()
            })
            addView(status)
        })
    }

    private fun fetchCompanyList() {
        val session = store.getSession()
        if (session == null) {
            showLogin()
            return
        }
        toastStatus("Loading companies...", false)
        executor.execute {
            try {
                val companies = api.fetchCompanies(session)
                store.saveCompanyList(companies)
                runOnUiThread {
                    renderCompanySelect(companies, if (companies.isEmpty()) "No companies returned for this login." else "Loaded ${companies.size} company option(s).")
                }
            } catch (error: Exception) {
                runOnUiThread {
                    renderCompanySelect(store.getCompanyList(), error.message ?: "Company list could not load.")
                }
            }
        }
    }

    private fun extractCompaniesFromState(state: JSONObject): List<String> {
        val names = linkedSetOf<String>()
        val ownerRecords = state.optJSONArray("ownerRecords") ?: org.json.JSONArray()
        for (i in 0 until ownerRecords.length()) {
            val row = ownerRecords.optJSONObject(i) ?: continue
            row.optString("name").trim().takeIf { it.isNotBlank() }?.let(names::add)
        }
        val ownerNames = state.optJSONArray("owners") ?: org.json.JSONArray()
        for (i in 0 until ownerNames.length()) {
            val raw = ownerNames.opt(i)
            val value = when (raw) {
                is String -> raw
                is JSONObject -> raw.optString("name")
                else -> ""
            }.trim()
            if (value.isNotBlank()) names.add(value)
        }
        val inventory = state.optJSONArray("inventory") ?: org.json.JSONArray()
        for (i in 0 until inventory.length()) {
            val value = inventory.optJSONObject(i)?.optString("accountName").orEmpty().trim()
            if (value.isNotBlank()) names.add(value)
        }
        return names.toList().sorted()
    }

    private fun lockCompanyAndOpen(company: String) {
        store.setLockedCompany(company)
        scanner.success()
        showHome()
        sync.syncNow(downloadOrders = true)
    }

    private fun showHome() {
        activeOrderId = ""
        activeTask = null
        activeScanTarget = ScanTarget.NONE
        currentScreen = Screen.HOME
        val session = store.getSession()
        val summary = store.outboxSummary()
        root.removeAllViews()
        root.addView(screen {
            addView(header("WMS365 Scanner", "Work area"))
            addView(banner("Company Locked", session?.company?.ifBlank { "All assigned companies" } ?: "Not signed in", BLUE))
            if (summary.second > 0) {
                addView(banner("Sync Issues", "${summary.second} failed transaction(s) need review", RED))
                addView(dangerButton("Review Sync Issues") { showSyncIssues() })
            } else if (summary.first > 0) {
                addView(banner("Sync Pending", "${summary.first} transaction(s) waiting to send", YELLOW))
            }
            addView(statusView("Outbound"))
            addView(primaryButton("Picking") { showOrderList() })
            addView(statusView("Inbound"))
            addView(secondaryButton("Receiving") { showReceiving() })
            addView(secondaryButton("Receive Without PO") { showReceiveWithoutPo() })
            addView(secondaryButton("Putaway") { showPutaway() })
            addView(statusView("Inventory"))
            addView(secondaryButton("Inventory Count") { showInventoryCount() })
            addView(secondaryButton("Move Item") { showMoveItem() })
            addView(secondaryButton("Lookup SKU / BIN") { showLookup() })
            addView(secondaryButton("Pallets / Labels") { showPalletsLabels() })
            addView(statusView("Device Tools"))
            addView(secondaryButton("Sync Now") { sync.syncNow(downloadOrders = true) })
            addView(secondaryButton("Report Issue") { showReportIssue() })
            addView(secondaryButton("Switch Company") {
                store.clearLockedCompany()
                showCompanySelect(forceRefresh = false)
            })
            addView(secondaryButton("Logout") {
                store.clearSession()
                showLogin()
            })
            addView(statusView("Sync queue: ${summary.first} pending, ${summary.second} failed. App ${BuildConfig.VERSION_NAME}"))
        })
    }

    private fun showSyncIssues() {
        currentScreen = Screen.SYNC_ISSUES
        val failed = store.pendingOutbox(100).filter { it.status == "FAILED" }
        val pending = store.pendingOutbox(100).filter { it.status == "PENDING" }
        root.removeAllViews()
        root.addView(screen {
            addView(header("Sync Issues", "Device queue"))
            when {
                failed.isNotEmpty() -> addView(banner("Failed Sync", "${failed.size} transaction(s) need supervisor review", RED))
                pending.isNotEmpty() -> addView(banner("Sync Pending", "${pending.size} transaction(s) waiting to send", YELLOW))
                else -> addView(banner("All Synced", "No pending or failed transactions", GREEN))
            }
            addView(primaryButton("Retry Sync Now") {
                sync.syncNow(downloadOrders = true)
                showSyncIssues()
            })
            if (failed.isNotEmpty()) {
                failed.take(20).forEach { item ->
                    addView(statusView(syncIssueText(item.type.name, item.payload, item.lastError)))
                }
            } else if (pending.isNotEmpty()) {
                pending.take(20).forEach { item ->
                    addView(statusView(syncIssueText(item.type.name, item.payload, "Pending sync")))
                }
            } else {
                addView(statusView("The device queue is clear."))
            }
            addView(secondaryButton("Home") { showHome() })
        })
    }

    private fun syncIssueText(type: String, payloadRaw: String, error: String): String {
        val payload = runCatching { JSONObject(payloadRaw) }.getOrNull() ?: JSONObject()
        val order = payload.optString("sourceId").ifBlank { payload.optString("orderId") }.ifBlank { payload.optString("referenceNumber") }
        val sku = payload.optString("sku").ifBlank { payload.optString("skuOrUpc") }
        val location = payload.optString("location").ifBlank { payload.optString("toLocation") }.ifBlank { payload.optString("fromLocation") }
        val parts = listOf(
            type,
            if (order.isNotBlank()) "Order/Ref $order" else "",
            if (sku.isNotBlank()) "SKU $sku" else "",
            if (location.isNotBlank()) "Loc $location" else ""
        ).filter { it.isNotBlank() }
        return "${parts.joinToString(" | ")}\n${error.ifBlank { "Unknown sync error" }.take(170)}"
    }

    private fun showReceiving() {
        showReceivingForm("Receiving", "Receive against inbound / PO", false)
    }

    private fun showReceiveWithoutPo() {
        showReceivingForm("Quick Check-In", "No PO available", true)
    }

    private fun showReceivingForm(title: String, instruction: String, withoutPo: Boolean) {
        clearNativeScan()
        currentScreen = Screen.FORM
        val ref = input(if (withoutPo) "BOL / Reference" else "Inbound / PO reference", InputType.TYPE_CLASS_TEXT)
        val sku = input("SKU / UPC", InputType.TYPE_CLASS_TEXT)
        val qty = input("Qty received", InputType.TYPE_CLASS_NUMBER)
        val location = input("Staging location", InputType.TYPE_CLASS_TEXT).apply { setText("RECEIVING-STAGE") }
        val pallets = input("Pallet count", InputType.TYPE_CLASS_NUMBER)
        val cases = input("Case count", InputType.TYPE_CLASS_NUMBER)
        val note = input("Note", InputType.TYPE_CLASS_TEXT)
        root.removeAllViews()
        root.addView(nativeFormScreen(title, instruction) {
            addView(ref)
            addView(scanToButton("Scan Ref", ref, "reference"))
            addView(sku)
            addView(scanToButton("Scan SKU / UPC", sku, "sku"))
            addView(qty)
            addView(location)
            addView(scanToButton("Scan Location", location, "location"))
            addView(pallets)
            addView(cases)
            addView(note)
            addView(primaryButton("Save Receiving") {
                val company = lockedCompanyOrStop() ?: return@primaryButton
                val receivedQty = qty.text.toString().toIntOrNull() ?: 0
                if (sku.text.isBlank() || receivedQty <= 0) {
                    toastStatus("SKU and received qty are required.", true)
                    return@primaryButton
                }
                queueNativeWork(
                    OutboxType.RECEIVING,
                    JSONObject()
                        .put("accountName", company)
                        .put("sourceType", if (withoutPo) "MANUAL" else "PORTAL_INBOUND")
                        .put("referenceNumber", ref.text.toString().trim())
                        .put("sku", sku.text.toString().trim())
                        .put("skuOrUpc", sku.text.toString().trim())
                        .put("quantity", receivedQty)
                        .put("receivedQuantity", receivedQty)
                        .put("location", location.text.toString().trim())
                        .put("palletCount", pallets.text.toString().toIntOrNull() ?: 0)
                        .put("caseCount", cases.text.toString().toIntOrNull() ?: 0)
                        .put("note", note.text.toString().trim()),
                    "Receiving saved"
                )
            })
            addView(secondaryButton("Back") { showHome() })
        })
        ref.requestFocus()
        activeTextInput = ref
    }

    private fun showPutaway() {
        clearNativeScan()
        currentScreen = Screen.FORM
        val from = input("From location", InputType.TYPE_CLASS_TEXT).apply { setText("RECEIVING-STAGE") }
        val to = input("To BIN", InputType.TYPE_CLASS_TEXT)
        val sku = input("SKU / UPC", InputType.TYPE_CLASS_TEXT)
        val qty = input("Qty", InputType.TYPE_CLASS_NUMBER)
        root.removeAllViews()
        root.addView(nativeFormScreen("Putaway", "Move stock into BIN") {
            addView(from)
            addView(scanToButton("Scan From", from, "from location"))
            addView(to)
            addView(scanToButton("Scan To BIN", to, "to location"))
            addView(sku)
            addView(scanToButton("Scan SKU / UPC", sku, "sku"))
            addView(qty)
            addView(primaryButton("Confirm Putaway") {
                val company = lockedCompanyOrStop() ?: return@primaryButton
                val movedQty = qty.text.toString().toIntOrNull() ?: 0
                if (from.text.isBlank() || to.text.isBlank() || sku.text.isBlank() || movedQty <= 0) {
                    toastStatus("From, To, SKU, and Qty are required.", true)
                    return@primaryButton
                }
                queueNativeWork(
                    OutboxType.PUT_AWAY,
                    JSONObject()
                        .put("accountName", company)
                        .put("sourceType", "INVENTORY")
                        .put("fromLocation", from.text.toString().trim())
                        .put("toLocation", to.text.toString().trim())
                        .put("location", to.text.toString().trim())
                        .put("sku", sku.text.toString().trim())
                        .put("skuOrUpc", sku.text.toString().trim())
                        .put("quantity", movedQty),
                    "Putaway queued"
                )
            })
            addView(secondaryButton("Back") { showHome() })
        })
        to.requestFocus()
        activeTextInput = to
    }

    private fun showMoveItem() {
        clearNativeScan()
        currentScreen = Screen.FORM
        val from = input("From location", InputType.TYPE_CLASS_TEXT)
        val to = input("To location", InputType.TYPE_CLASS_TEXT)
        val sku = input("SKU / UPC", InputType.TYPE_CLASS_TEXT)
        val qty = input("Qty", InputType.TYPE_CLASS_NUMBER)
        root.removeAllViews()
        root.addView(nativeFormScreen("Move Item", "Transfer stock location to location") {
            addView(from)
            addView(scanToButton("Scan From", from, "from location"))
            addView(to)
            addView(scanToButton("Scan To", to, "to location"))
            addView(sku)
            addView(scanToButton("Scan SKU / UPC", sku, "sku"))
            addView(qty)
            addView(primaryButton("Confirm Move") {
                val company = lockedCompanyOrStop() ?: return@primaryButton
                val movedQty = qty.text.toString().toIntOrNull() ?: 0
                if (from.text.isBlank() || to.text.isBlank() || sku.text.isBlank() || movedQty <= 0) {
                    toastStatus("From, To, SKU, and Qty are required.", true)
                    return@primaryButton
                }
                queueNativeWork(
                    OutboxType.MOVE,
                    JSONObject()
                        .put("accountName", company)
                        .put("sourceType", "INVENTORY")
                        .put("fromLocation", from.text.toString().trim())
                        .put("toLocation", to.text.toString().trim())
                        .put("location", to.text.toString().trim())
                        .put("sku", sku.text.toString().trim())
                        .put("skuOrUpc", sku.text.toString().trim())
                        .put("quantity", movedQty),
                    "Move queued"
                )
            })
            addView(secondaryButton("Back") { showHome() })
        })
        from.requestFocus()
        activeTextInput = from
    }

    private fun showInventoryCount() {
        clearNativeScan()
        countLocation = ""
        countSkuOrUpc = ""
        countCases = ""
        countLot = ""
        countExpiry = ""
        showCountLocation()
    }

    private fun showCountLocation() {
        currentScreen = Screen.COUNT
        activeCountStep = CountStep.LOCATION
        val location = countInput("Location", InputType.TYPE_CLASS_TEXT).apply { setText(countLocation) }
        root.removeAllViews()
        root.addView(countScreen("Step 1 of 4", "Scan Location", "Go to the bin and scan the location label.") {
            addView(location)
            addView(primaryButton("Confirm Location") {
                val value = location.text.toString().trim()
                if (value.isBlank()) {
                    toastStatus("Scan or enter the location.", true)
                    showKeyboard(location)
                    return@primaryButton
                }
                countLocation = value
                showCountSku()
            })
            addView(secondaryButton("Key In Location") { showKeyboard(location) })
            addView(cameraButton("Camera Scan") {
                activeTextInput = location
                activeTextInputTarget = "location"
                startCameraScan()
            })
            addView(secondaryButton("Back") { showHome() })
        })
        activateInput(location, "location", showKeyboard = false)
    }

    private fun showCountSku() {
        currentScreen = Screen.COUNT
        activeCountStep = CountStep.SKU
        val sku = countInput("SKU / UPC", InputType.TYPE_CLASS_TEXT).apply { setText(countSkuOrUpc) }
        root.removeAllViews()
        root.addView(countScreen("Step 2 of 4", "Scan SKU / UPC", countLocation) {
            addView(fieldLabel("Location", countLocation))
            addView(sku)
            addView(primaryButton("Confirm SKU / UPC") {
                val value = sku.text.toString().trim()
                if (value.isBlank()) {
                    toastStatus("Scan or enter the SKU / UPC.", true)
                    showKeyboard(sku)
                    return@primaryButton
                }
                countSkuOrUpc = value
                showCountQty()
            })
            addView(secondaryButton("Key In SKU") { showKeyboard(sku) })
            addView(cameraButton("Camera Scan") {
                activeTextInput = sku
                activeTextInputTarget = "sku"
                startCameraScan()
            })
            addView(secondaryButton("Back to Location") { showCountLocation() })
        })
        activateInput(sku, "sku", showKeyboard = false)
    }

    private fun showCountQty() {
        currentScreen = Screen.COUNT
        activeCountStep = CountStep.QTY
        val cases = countInput("Cases counted", InputType.TYPE_CLASS_NUMBER).apply {
            setText(countCases)
            textSize = 32f
            gravity = Gravity.CENTER
            minHeight = 92
        }
        root.removeAllViews()
        root.addView(countScreen("Step 3 of 4", "Enter Cases", countSkuOrUpc) {
            addView(fieldLabel("Location", countLocation))
            addView(fieldLabel("SKU / UPC", countSkuOrUpc))
            addView(cases)
            addView(primaryButton("Confirm Cases") {
                val value = cases.text.toString().trim()
                val counted = value.toIntOrNull()
                if (counted == null || counted < 0) {
                    toastStatus("Enter cases counted. Use 0 if empty.", true)
                    showKeyboard(cases)
                    return@primaryButton
                }
                countCases = value
                showCountTraceability()
            })
            addView(secondaryButton("Empty / Zero Cases") {
                countCases = "0"
                showCountTraceability()
            })
            addView(secondaryButton("Back to SKU") { showCountSku() })
        })
        activateInput(cases, "cases", showKeyboard = true)
    }

    private fun showCountTraceability() {
        currentScreen = Screen.COUNT
        activeCountStep = CountStep.TRACE
        val lot = countInput("Lot if required", InputType.TYPE_CLASS_TEXT).apply { setText(countLot) }
        val expiry = countInput("Expiry YYYY-MM-DD if required", InputType.TYPE_CLASS_TEXT).apply { setText(countExpiry) }
        root.removeAllViews()
        root.addView(countScreen("Step 4 of 4", "Lot / Expiry", "Skip when not required.") {
            addView(fieldLabel("Location", countLocation))
            addView(fieldLabel("SKU / UPC", countSkuOrUpc))
            addView(fieldLabel("Cases", countCases))
            addView(lot)
            addView(scanToButton("Scan Lot", lot, "lot"))
            addView(expiry)
            addView(primaryButton("Submit Count") {
                countLot = lot.text.toString().trim()
                countExpiry = expiry.text.toString().trim()
                submitGuidedInventoryCount()
            })
            addView(secondaryButton("Skip Lot / Expiry") {
                countLot = ""
                countExpiry = ""
                submitGuidedInventoryCount()
            })
            addView(secondaryButton("Back to Qty") { showCountQty() })
        })
        activateInput(lot, "lot", showKeyboard = false)
    }

    private fun submitGuidedInventoryCount() {
        val company = lockedCompanyOrStop() ?: return
        val counted = countCases.toIntOrNull()
        if (countLocation.isBlank() || countSkuOrUpc.isBlank() || counted == null || counted < 0) {
            toastStatus("Count is missing location, SKU, or cases.", true)
            showCountLocation()
            return
        }
        queueNativeWork(
            OutboxType.INVENTORY_COUNT,
            JSONObject()
                .put("accountName", company)
                .put("location", countLocation)
                .put("skuOrUpc", countSkuOrUpc)
                .put("countedCases", counted)
                .put("lotNumber", countLot)
                .put("expirationDate", countExpiry)
                .put("source", "android_app"),
            "Count submitted for review",
            returnHome = false
        )
        showCountSaved()
    }

    private fun showCountSaved() {
        currentScreen = Screen.COUNT
        activeCountStep = CountStep.NONE
        root.removeAllViews()
        root.addView(countScreen("Saved", "Count Saved", "$countSkuOrUpc at $countLocation") {
            addView(fieldLabel("Cases", countCases))
            addView(primaryButton("Add Another SKU Here") {
                countSkuOrUpc = ""
                countCases = ""
                countLot = ""
                countExpiry = ""
                showCountSku()
            })
            addView(primaryButton("Next Location") { showInventoryCount() })
            addView(secondaryButton("Home") { showHome() })
        })
    }

    private fun countScreen(step: String, action: String, detail: String, body: LinearLayout.() -> Unit): ScrollView {
        return screen {
            addView(header("Inventory Count", step))
            addView(banner(action, detail, BLUE))
            body()
        }
    }

    private fun showPalletsLabels() {
        clearNativeScan()
        currentScreen = Screen.FORM
        val pallet = input("Pallet ID, optional", InputType.TYPE_CLASS_TEXT)
        val sku = input("SKU / UPC", InputType.TYPE_CLASS_TEXT)
        val cases = input("Cases on pallet", InputType.TYPE_CLASS_NUMBER)
        val location = input("Location", InputType.TYPE_CLASS_TEXT)
        root.removeAllViews()
        root.addView(nativeFormScreen("Pallets / Labels", "Save pallet record") {
            addView(pallet)
            addView(scanToButton("Scan Pallet", pallet, "pallet"))
            addView(sku)
            addView(scanToButton("Scan SKU / UPC", sku, "sku"))
            addView(cases)
            addView(location)
            addView(scanToButton("Scan Location", location, "location"))
            addView(primaryButton("Save Pallet") {
                val company = lockedCompanyOrStop() ?: return@primaryButton
                val caseQty = cases.text.toString().toIntOrNull() ?: 0
                if (sku.text.isBlank() || caseQty <= 0) {
                    toastStatus("SKU and cases are required.", true)
                    return@primaryButton
                }
                queueNativeWork(
                    OutboxType.PALLET_LABEL,
                    JSONObject()
                        .put("accountName", company)
                        .put("palletCode", pallet.text.toString().trim())
                        .put("sku", sku.text.toString().trim())
                        .put("cases", caseQty)
                        .put("date", todayDate())
                        .put("location", location.text.toString().trim())
                        .put("source", "android_app"),
                    "Pallet saved"
                )
            })
            addView(secondaryButton("Back") { showHome() })
        })
        pallet.requestFocus()
        activeTextInput = pallet
    }

    private fun showLookup() {
        clearNativeScan()
        currentScreen = Screen.FORM
        val query = input("Scan SKU, UPC, or BIN", InputType.TYPE_CLASS_TEXT)
        val results = statusView("Enter or scan a value, then tap Search.")
        messageText = results
        root.removeAllViews()
        root.addView(nativeFormScreen("Lookup", "Find item or BIN") {
            addView(query)
            addView(scanToButton("Scan Value", query, "lookup"))
            addView(primaryButton("Search") { runLookup(query.text.toString(), results) })
            addView(results)
            addView(secondaryButton("Back") { showHome() })
        })
        query.requestFocus()
        activeTextInput = query
    }

    private fun runLookup(raw: String, results: TextView) {
        val search = normalizeScan(raw)
        if (search.isBlank()) {
            toastStatus("Scan or enter a SKU, UPC, or BIN.", true)
            return
        }
        val session = store.getSession() ?: return toastStatus("Sign in first.", true)
        val localMatches = store.localLookup(search, session.company)
        results.text = if (localMatches.isNotEmpty()) {
            "Device cache:\n${localMatches.joinToString("\n")}\n\nChecking live inventory..."
        } else {
            "Checking live inventory..."
        }
        executor.execute {
            try {
                val state = api.fetchState(session)
                val company = session.company
                val inventory = state.optJSONArray("inventory") ?: org.json.JSONArray()
                val matches = mutableListOf<String>()
                for (i in 0 until inventory.length()) {
                    val row = inventory.optJSONObject(i) ?: continue
                    if (company.isNotBlank() && !row.optString("accountName").equals(company, true)) continue
                    val location = row.optString("location")
                    val sku = row.optString("sku")
                    val upc = row.optString("upc")
                    if (listOf(location, sku, upc).any { normalizeScan(it) == search }) {
                        matches += "${location.ifBlank { "-" }} | ${sku.ifBlank { "-" }} | Qty ${row.optInt("quantity", row.optInt("onHandQuantity", 0))}"
                    }
                    if (matches.size >= 12) break
                }
                runOnUiThread {
                    results.text = when {
                        matches.isNotEmpty() -> "Live inventory:\n${matches.joinToString("\n")}"
                        localMatches.isNotEmpty() -> "Device cache:\n${localMatches.joinToString("\n")}\n\nLive inventory: no exact match found."
                        else -> "No exact match found. Worker may continue, but verify before posting."
                    }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    results.text = if (localMatches.isNotEmpty()) {
                        "Device cache:\n${localMatches.joinToString("\n")}\n\nLive lookup failed: ${error.message ?: "unknown error"}"
                    } else {
                        error.message ?: "Lookup failed"
                    }
                }
            }
        }
    }

    private fun showReportIssue() {
        clearNativeScan()
        currentScreen = Screen.FORM
        val details = EditText(this).apply {
            hint = "Describe the issue"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 4
            textSize = 18f
            setPadding(18, 12, 18, 12)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).withMargins()
        }
        root.removeAllViews()
        root.addView(nativeFormScreen("Report Issue", "Tell support what happened") {
            addView(details)
            addView(primaryButton("Submit Issue") {
                val text = details.text.toString().trim()
                if (text.isBlank()) {
                    toastStatus("Enter the issue details.", true)
                    return@primaryButton
                }
                queueNativeWork(
                    OutboxType.FEEDBACK,
                    JSONObject()
                        .put("requestType", "BUG")
                        .put("source", "WAREHOUSE")
                        .put("accountName", store.getSession()?.company.orEmpty())
                        .put("title", text.take(120))
                        .put("details", text)
                        .put("pageName", "Native Android Scanner")
                        .put("appSection", "WAREHOUSE")
                        .put("buildLabel", BuildConfig.VERSION_NAME),
                    "Issue submitted"
                )
            })
            addView(secondaryButton("Back") { showHome() })
        })
        details.requestFocus()
    }

    private fun clearNativeScan() {
        activeTask = null
        activeOrderId = ""
        activeScanTarget = ScanTarget.NONE
        activeTextInput = null
        activeTextInputTarget = ""
        activeCountStep = CountStep.NONE
    }

    private fun nativeFormScreen(title: String, instruction: String, body: LinearLayout.() -> Unit): ScrollView {
        return screen {
            addView(header(title, "Native Android workflow"))
            addView(banner(instruction, store.getSession()?.company?.ifBlank { "No company locked" } ?: "Not signed in", BLUE))
            body()
        }
    }

    private fun scanToButton(text: String, target: EditText, targetLabel: String): Button {
        return cameraButton(text) {
            activeTextInput = target
            activeTextInputTarget = targetLabel
            target.requestFocus()
            startCameraScan()
        }
    }

    private fun lockedCompanyOrStop(): String? {
        val company = store.getSession()?.company.orEmpty()
        if (company.isBlank()) {
            toastStatus("Select and lock a company at login first.", true)
            return null
        }
        return company
    }

    private fun queueNativeWork(type: OutboxType, payload: JSONObject, successMessage: String, returnHome: Boolean = true) {
        val session = store.getSession()
        val key = "android-${type.name.lowercase()}-${session?.deviceId}-${System.currentTimeMillis()}"
        val enriched = JSONObject(payload.toString())
            .put("deviceId", session?.deviceId.orEmpty())
            .put("warehouseId", session?.warehouseId.orEmpty())
            .put("source", "android_app")
            .put("idempotencyKey", key)
            .put("clientTimestamp", System.currentTimeMillis())
        store.enqueue(type, key, enriched)
        scanner.success()
        toastStatus("$successMessage. Syncing...", false)
        sync.syncNow(downloadOrders = false)
        if (returnHome) showHome()
    }

    private fun todayDate(): String {
        return java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
    }

    private fun showOrderList() {
        activeScanTarget = ScanTarget.NONE
        currentScreen = Screen.ORDER_LIST
        val session = store.getSession()
        val orders = store.getPickOrders(session?.company.orEmpty()).filter { it.status.equals("RELEASED", true) }
        root.removeAllViews()
        root.addView(screen {
            addView(header("Pick Orders", "Select released work"))
            addView(secondaryButton("Back") { showHome() })
            addView(primaryButton("Refresh Orders") { sync.syncNow(downloadOrders = true) })
            if (orders.isEmpty()) {
                addView(statusView("No released pick orders cached. Tap Refresh Orders while online."))
            } else {
                orders.forEach { order ->
                    addView(blockButton("${order.orderCode}\n${order.accountName}", "Start") {
                        activeOrderId = order.id
                        openNextTask()
                    })
                }
            }
        })
    }

    private fun openNextTask() {
        val tasks = store.getPickTasks(activeOrderId)
        val next = tasks.firstOrNull { it.state != PickState.COMPLETE && it.state != PickState.EXCEPTION }
        if (next == null) {
            showPickComplete(tasks)
            return
        }
        activeTask = next
        when (next.state) {
            PickState.GO_TO_LOCATION -> showGoToLocation(next, tasks)
            PickState.SCAN_LOCATION -> showScanLocation(next, tasks)
            PickState.SCAN_ITEM -> showEnterQty(next, tasks)
            PickState.ENTER_QTY -> showEnterQty(next, tasks)
            PickState.EXCEPTION, PickState.COMPLETE -> openNextTask()
        }
    }

    private fun showGoToLocation(task: PickTask, tasks: List<PickTask>) {
        activeScanTarget = ScanTarget.NONE
        currentScreen = Screen.PICKING
        root.removeAllViews()
        root.addView(taskScreen(task, tasks, "Go to this location", task.location.ifBlank { "Scan source location" }) {
            addView(primaryButton("I Am At Location") {
                store.updateTaskState(task.id, PickState.SCAN_LOCATION)
                openNextTask()
            })
            addView(cameraButton("Scan Location") {
                activeScanTarget = ScanTarget.LOCATION
                startCameraScan()
            })
            addProblemButtons(task)
        })
    }

    private fun showScanLocation(task: PickTask, tasks: List<PickTask>) {
        activeScanTarget = ScanTarget.LOCATION
        currentScreen = Screen.PICKING
        val scan = input("Scan or key location", InputType.TYPE_CLASS_TEXT)
        root.removeAllViews()
        root.addView(taskScreen(task, tasks, "Confirm you arrived", task.location.ifBlank { "Actual pick location required" }) {
            addView(scan)
            addView(primaryButton("Confirm Location") { confirmLocation(task, scan.text.toString()) })
            addView(cameraButton("Camera Scan") { startCameraScan() })
            addProblemButtons(task)
        })
        scan.requestFocus()
    }

    private fun showScanItem(task: PickTask, tasks: List<PickTask>) {
        activeScanTarget = ScanTarget.SKU
        currentScreen = Screen.PICKING
        val scan = input("Scan SKU / UPC", InputType.TYPE_CLASS_TEXT)
        root.removeAllViews()
        root.addView(taskScreen(task, tasks, "Pick this item", task.sku) {
            addView(fieldLabel("Description", task.description.ifBlank { "No description" }))
            if (task.lotNumber.isNotBlank()) addView(fieldLabel("Lot", task.lotNumber))
            if (task.expiry.isNotBlank()) addView(fieldLabel("Expiry", task.expiry))
            addView(scan)
            addView(primaryButton("Confirm SKU") { confirmSku(task, scan.text.toString()) })
            addView(cameraButton("Camera Scan") { startCameraScan() })
            addProblemButtons(task)
        })
        scan.requestFocus()
    }

    private fun showEnterQty(task: PickTask, tasks: List<PickTask>) {
        activeTask = task
        activeScanTarget = ScanTarget.SKU
        currentScreen = Screen.PICKING
        val scan = input("Scan each unit / case", InputType.TYPE_CLASS_TEXT)
        root.removeAllViews()
        root.addView(taskScreen(task, tasks, "Scan each unit", task.sku) {
            addView(fieldLabel("Picked", "${task.pickedQty} of ${task.requiredQty}"))
            addView(fieldLabel("Remaining", task.remainingQty.toString()))
            addView(fieldLabel("Available", task.availableQty.toString()))
            addView(fieldLabel("Description", task.description.ifBlank { "No description" }))
            if (task.lotNumber.isNotBlank()) addView(fieldLabel("Lot", task.lotNumber))
            if (task.expiry.isNotBlank()) addView(fieldLabel("Expiry", task.expiry))
            addView(scan)
            addView(primaryButton("Confirm This Scan") { confirmSku(task, scan.text.toString()) })
            addView(cameraButton("Camera Scan") { startCameraScan() })
            addView(secondaryButton("Short Pick / Not Enough Stock") { reportException(task, "SHORT_PICK") })
            addProblemButtons(task)
        })
        scan.requestFocus()
    }

    private fun showPickComplete(tasks: List<PickTask>) {
        activeScanTarget = ScanTarget.NONE
        currentScreen = Screen.COMPLETE
        root.removeAllViews()
        val exceptions = tasks.count { it.state == PickState.EXCEPTION }
        val syncSummary = store.outboxSummary()
        root.addView(screen {
            addView(header("Picking Complete", activeOrderId))
            addView(banner(if (exceptions > 0) "Needs Review" else "Ready to Pack", if (exceptions > 0) "$exceptions exception(s) reported" else "All picks confirmed", if (exceptions > 0) YELLOW else GREEN))
            if (syncSummary.first > 0 || syncSummary.second > 0) {
                addView(statusView("Sync queue: ${syncSummary.first} pending, ${syncSummary.second} failed. Tap Sync Now and tell a supervisor if failed remains."))
            }
            addView(primaryButton("Sync Now") { sync.syncNow(downloadOrders = true) })
            if (syncSummary.second > 0) {
                addView(dangerButton("Review Sync Issues") { showSyncIssues() })
                addView(secondaryButton("Resolve Sync First", disabled = true) {})
            } else {
                addView(secondaryButton("Choose Another Order") { showOrderList() })
            }
            addView(secondaryButton("Home") { showHome() })
        })
    }

    private fun confirmLocation(task: PickTask, value: String) {
        val normalized = normalizeScan(value)
        val expected = normalizeScan(task.location)
        if (expected.isNotBlank() && normalized != expected) {
            store.recordScan(value, "location", "wrong_location", task.orderId, task.id)
            scanner.error()
            toastStatus("Wrong location. Expected ${task.location}", true)
            return
        }
        val actualLocation = task.location.ifBlank { value.trim() }
        val key = newKey("arrival", task)
        store.enqueue(OutboxType.PICK_ARRIVAL, key, basePayload(task, key).put("location", actualLocation))
        store.recordScan(value, "location", "accepted", task.orderId, task.id)
        store.updateTaskState(task.id, PickState.ENTER_QTY)
        sync.syncNow(downloadOrders = false)
        openNextTask()
    }

    private fun confirmSku(task: PickTask, value: String) {
        val normalized = normalizeScan(value)
        val skuOk = normalized == normalizeScan(task.sku)
        val upcOk = task.upc.isNotBlank() && normalized == normalizeScan(task.upc)
        if (!skuOk && !upcOk) {
            store.recordScan(value, "sku", "wrong_sku", task.orderId, task.id)
            scanner.error()
            toastStatus("Wrong item. Expected ${task.sku}", true)
            return
        }
        confirmPickScan(task, value)
    }

    private fun confirmPickScan(task: PickTask, scannedValue: String) {
        val current = store.getPickTask(task.id) ?: task
        if (current.remainingQty <= 0) {
            scanner.error()
            toastStatus("This line is already fully picked.", true)
            return
        }

        val pickKey = newKey("pick", current)
        store.enqueue(
            OutboxType.PICK_CONFIRMATION,
            pickKey,
            basePayload(current, pickKey)
                .put("location", current.location)
                .put("sku", current.sku)
                .put("skuOrUpc", current.sku)
                .put("scannedValue", scannedValue.trim())
                .put("quantity", 1)
                .put("lot", current.lotNumber)
                .put("expiry", current.expiry)
        )

        val newPicked = current.pickedQty + 1
        val nextState = if (newPicked >= current.requiredQty) PickState.COMPLETE else PickState.ENTER_QTY
        store.recordScan(scannedValue, "sku", "picked_unit", current.orderId, current.id)
        store.updateTaskState(current.id, nextState, newPicked)

        scanner.success()
        toastStatus("Picked $newPicked of ${current.requiredQty}", false)
        sync.syncNow(downloadOrders = false)
        if (nextState == PickState.COMPLETE) {
            openNextTask()
        } else {
            store.getPickTask(current.id)?.let {
                activeTask = it
                showEnterQty(it, store.getPickTasks(current.orderId))
            } ?: openNextTask()
        }
    }

    private fun reportException(task: PickTask, reason: String) {
        val key = newKey("exception-${reason.lowercase()}", task)
        store.enqueue(
            OutboxType.PICK_EXCEPTION,
            key,
            basePayload(task, key)
                .put("reason", reason)
                .put("location", task.location)
                .put("sku", task.sku)
                .put("quantity", task.remainingQty)
        )
        store.updateTaskState(task.id, PickState.EXCEPTION)
        sync.syncNow(downloadOrders = false)
        openNextTask()
    }

    private fun handleScan(value: String) {
        val cleanValue = value.trim()
        if (activeTask == null && activeTextInput != null) {
            activeTextInput?.setText(cleanValue)
            activeTextInput?.setSelection(activeTextInput?.text?.length ?: 0)
            store.recordScan(cleanValue, activeTextInputTarget.ifBlank { "field" }, "captured")
            scanner.success()
            toastStatus("Scanned ${activeTextInputTarget.ifBlank { "value" }}", false)
            if (currentScreen == Screen.COUNT) {
                when (activeCountStep) {
                    CountStep.LOCATION -> {
                        countLocation = cleanValue
                        showCountSku()
                    }
                    CountStep.SKU -> {
                        countSkuOrUpc = cleanValue
                        showCountQty()
                    }
                    CountStep.QTY -> {
                        val digits = cleanValue.filter(Char::isDigit)
                        if (digits.isBlank()) {
                            scanner.error()
                            toastStatus("Qty scan did not include a number.", true)
                            return
                        }
                        countCases = digits
                        showCountTraceability()
                    }
                    CountStep.TRACE, CountStep.NONE -> Unit
                }
            }
            return
        }
        val task = activeTask ?: return
        when (activeScanTarget) {
            ScanTarget.LOCATION -> confirmLocation(task, cleanValue)
            ScanTarget.SKU -> confirmSku(task, cleanValue)
            ScanTarget.NONE -> toastStatus("Scan received: $cleanValue", false)
        }
    }

    private fun startCameraScan() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 44)
            return
        }
        IntentIntegrator(this).apply {
            setDesiredBarcodeFormats(IntentIntegrator.ALL_CODE_TYPES)
            setPrompt("Scan barcode")
            setBeepEnabled(false)
            setOrientationLocked(false)
            initiateScan()
        }
    }

    private fun basePayload(task: PickTask, key: String): JSONObject {
        val session = store.getSession()
        return JSONObject()
            .put("orderId", task.orderId)
            .put("sourceType", "PORTAL_ORDER")
            .put("sourceId", task.orderId)
            .put("lineId", task.lineId)
            .put("accountName", task.accountName)
            .put("deviceId", session?.deviceId.orEmpty())
            .put("warehouseId", session?.warehouseId.orEmpty())
            .put("source", "android_app")
            .put("idempotencyKey", key)
    }

    private fun newKey(prefix: String, task: PickTask): String = "android-$prefix-${store.getSession()?.deviceId}-${task.id}-${System.currentTimeMillis()}-${UUID.randomUUID()}"

    private fun taskScreen(task: PickTask, tasks: List<PickTask>, instruction: String, focus: String, body: LinearLayout.() -> Unit): ScrollView {
        val done = tasks.count { it.state == PickState.COMPLETE || it.state == PickState.EXCEPTION }
        return screen {
            addView(header(task.orderCode, "Step ${task.sequence} of ${tasks.size} | $done done"))
            addView(banner(instruction, focus, BLUE))
            addView(fieldLabel("Required", task.requiredQty.toString()))
            body()
            addView(secondaryButton("Back to Orders") { showOrderList() })
        }
    }

    private fun LinearLayout.addProblemButtons(task: PickTask) {
        addView(secondaryButton("Location Empty") { reportException(task, "LOCATION_EMPTY") })
        addView(secondaryButton("Damaged / Blocked / Wrong Item") { reportException(task, "PICK_EXCEPTION") })
    }

    private fun screen(body: LinearLayout.() -> Unit): ScrollView {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(18, 18, 18, 18)
            setBackgroundColor(BG)
            body()
        }
        return ScrollView(this).apply {
            addView(container, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
    }

    private fun header(title: String, subtitle: String): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(0, 0, 0, 14)
        addView(TextView(this@MainActivity).apply {
            text = title
            textSize = 24f
            setTextColor(TEXT)
            setTypeface(null, android.graphics.Typeface.BOLD)
        })
        addView(TextView(this@MainActivity).apply {
            text = subtitle
            textSize = 13f
            setTextColor(MUTED)
        })
    }

    private fun banner(title: String, value: String, color: Int): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(18, 16, 18, 16)
        setBackgroundColor(color)
        addView(TextView(this@MainActivity).apply {
            text = title.uppercase()
            textSize = 16f
            setTextColor(Color.WHITE)
            setTypeface(null, android.graphics.Typeface.BOLD)
        })
        addView(TextView(this@MainActivity).apply {
            text = value
            textSize = if (value.length <= 16) 38f else 27f
            setTextColor(Color.WHITE)
            setTypeface(null, android.graphics.Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(0, 12, 0, 4)
        })
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).withMargins()
    }

    private fun input(hint: String, inputTypeValue: Int): EditText = EditText(this).apply {
        this.hint = hint
        inputType = inputTypeValue
        textSize = 21f
        setTextColor(TEXT)
        setHintTextColor(MUTED)
        setSingleLine(true)
        setPadding(22, 10, 22, 10)
        minHeight = 76
        background = inputBackground(focused = false)
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
            showSoftInputOnFocus = true
        }
        setOnClickListener { showKeyboard(this) }
        setOnFocusChangeListener { view, hasFocus ->
            background = inputBackground(focused = hasFocus)
            if (hasFocus && view is EditText) {
                activeTextInput = view
            }
        }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).withMargins()
    }

    private fun countInput(hint: String, inputTypeValue: Int): EditText = input(hint, inputTypeValue).apply {
        textSize = 22f
        minHeight = 78
        setPadding(20, 12, 20, 12)
    }

    private fun inputBackground(focused: Boolean): GradientDrawable = GradientDrawable().apply {
        setColor(Color.WHITE)
        cornerRadius = 10f
        setStroke(if (focused) 4 else 2, if (focused) BLUE else Color.rgb(148, 163, 184))
    }

    private fun activateInput(input: EditText, target: String, showKeyboard: Boolean) {
        activeTextInput = input
        activeTextInputTarget = target
        input.requestFocus()
        if (showKeyboard) showKeyboard(input)
    }

    private fun showKeyboard(input: EditText) {
        input.requestFocus()
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
        input.postDelayed({
            val manager = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            manager.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
        }, 120)
    }

    private fun primaryButton(text: String, onClick: () -> Unit): Button = button(text, GREEN, Color.WHITE, false, onClick)
    private fun cameraButton(text: String, onClick: () -> Unit): Button = button(text, DARK, Color.WHITE, false, onClick)
    private fun secondaryButton(text: String, disabled: Boolean = false, onClick: () -> Unit): Button = button(text, Color.WHITE, TEXT, disabled, onClick)
    private fun dangerButton(text: String, onClick: () -> Unit): Button = button(text, RED, Color.WHITE, false, onClick)
    private fun warningButton(text: String, onClick: () -> Unit): Button = button(text, YELLOW, Color.WHITE, false, onClick)

    private fun blockButton(title: String, action: String, onClick: () -> Unit): Button = button("$title\n$action", Color.WHITE, TEXT, false, onClick).apply {
        gravity = Gravity.CENTER_VERTICAL
        minHeight = 112
    }

    private fun button(textValue: String, bg: Int, fg: Int, disabled: Boolean, onClick: () -> Unit): Button = Button(this).apply {
        text = textValue
        textSize = 18f
        setTextColor(fg)
        setBackgroundColor(if (disabled) Color.rgb(203, 213, 225) else bg)
        minHeight = 68
        isEnabled = !disabled
        setAllCaps(false)
        setOnClickListener {
            val now = System.currentTimeMillis()
            if (!disabled && now >= actionLockedUntil) {
                actionLockedUntil = now + 450
                onClick()
            }
        }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).withMargins()
    }

    private fun fieldLabel(label: String, value: String): View = TextView(this).apply {
        text = "$label: $value"
        textSize = 20f
        setTextColor(TEXT)
        setPadding(10, 8, 10, 8)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).withMargins()
    }

    private fun statusView(textValue: String): TextView = TextView(this).apply {
        text = textValue
        textSize = 15f
        setTextColor(MUTED)
        setPadding(8, 14, 8, 14)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).withMargins()
    }

    private fun footer(): TextView = statusView("Works offline. Pick confirmations sync automatically.")

    private fun runAsync(loading: String, action: () -> Unit) {
        toastStatus(loading, false)
        executor.execute {
            try {
                action()
            } catch (error: Exception) {
                runOnUiThread {
                    toastStatus(error.message ?: "Action failed", true)
                }
            }
        }
    }

    private fun toastStatus(message: String, bad: Boolean) {
        messageText?.text = message
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show()
        if (bad) scanner.error()
    }

    private fun normalizeScan(value: String): String = value.trim().uppercase().replace(Regex("[^A-Z0-9]"), "")

    private fun registerScanReceivers() {
        if (scanReceiverRegistered) return
        val filter = IntentFilter().apply {
            addAction("com.symbol.datawedge.api.RESULT_ACTION")
            addAction("com.sonim.intent.action.SCAN_RESULT")
            addAction("com.sonim.intent.action.BARCODE_DATA")
            addAction("com.chainway.scan.result")
            addAction("android.intent.ACTION_DECODE_DATA")
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(scanReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(scanReceiver, filter)
        }
        scanReceiverRegistered = true
    }

    private fun unregisterScanReceivers() {
        if (!scanReceiverRegistered) return
        runCatching { unregisterReceiver(scanReceiver) }
        scanReceiverRegistered = false
    }

    private fun extractScanFromIntent(intent: Intent?): String {
        if (intent == null) return ""
        val keys = listOf(
            "com.symbol.datawedge.data_string",
            "barcode_string",
            "barcode",
            "scan_result",
            "data",
            "value",
            "decode_data"
        )
        keys.forEach { key ->
            val value = intent.getStringExtra(key)
            if (!value.isNullOrBlank()) return value.trim()
        }
        intent.extras?.keySet()?.forEach { key ->
            val raw = intent.extras?.get(key)
            if (raw is String && raw.isNotBlank() && key.contains("data", ignoreCase = true)) return raw.trim()
            if (raw is ByteArray && raw.isNotEmpty()) return String(raw).trim()
            if (raw is CharSequence && raw.isNotBlank() && key.contains("barcode", ignoreCase = true)) return raw.toString().trim()
        }
        return ""
    }

    private fun LinearLayout.LayoutParams.withMargins(): LinearLayout.LayoutParams {
        setMargins(0, 8, 0, 8)
        return this
    }

    private enum class ScanTarget { NONE, LOCATION, SKU }
    private enum class CountStep { NONE, LOCATION, SKU, QTY, TRACE }
    private enum class Screen { LOGIN, COMPANY_SELECT, HOME, ORDER_LIST, PICKING, COMPLETE, FORM, COUNT, SYNC_ISSUES }

    companion object {
        private val BG = Color.rgb(244, 247, 249)
        private val TEXT = Color.rgb(15, 23, 42)
        private val MUTED = Color.rgb(71, 85, 105)
        private val GREEN = Color.rgb(15, 118, 110)
        private val BLUE = Color.rgb(37, 99, 235)
        private val YELLOW = Color.rgb(202, 138, 4)
        private val RED = Color.rgb(185, 28, 28)
        private val DARK = Color.rgb(15, 23, 42)
    }
}
