package com.wms365.nativeapp

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
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

        if (store.getSession() == null) showLogin() else {
            showHome()
            sync.syncNow(downloadOrders = true)
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

    private fun showLogin() {
        activeScanTarget = ScanTarget.NONE
        currentScreen = Screen.LOGIN
        root.removeAllViews()
        val email = input("Warehouse email", InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val password = input("Password", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val company = input("Company to lock, optional", InputType.TYPE_CLASS_TEXT)
        val savedCompany = store.getSetting("company")
        if (savedCompany.isNotBlank()) company.setText(savedCompany)
        val status = statusView("Sign in once. The device remembers the session and company lock.")
        messageText = status

        root.addView(screen {
            addView(header("WMS365 Scanner", "Warehouse terminal"))
            addView(email)
            addView(password)
            addView(company)
            addView(primaryButton("Sign In") {
                val deviceId = store.getSetting("deviceId").ifBlank {
                    UUID.randomUUID().toString().also { store.setSetting("deviceId", it) }
                }
                runAsync("Signing in...") {
                    val session = api.login(email.text.toString(), password.text.toString(), company.text.toString().trim(), deviceId)
                    store.saveSession(session)
                    runOnUiThread {
                        showHome()
                        sync.syncNow(downloadOrders = true)
                    }
                }
            })
            addView(status)
            addView(footer())
        })
        email.requestFocus()
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
            addView(header("WMS365", "Scanner Terminal"))
            addView(banner("Company Locked", session?.company?.ifBlank { "All assigned companies" } ?: "Not signed in", BLUE))
            addView(statusView("Work"))
            addView(primaryButton("Picking") { showOrderList() })
            addView(secondaryButton("Receiving") { openMobileSection("inbounds") })
            addView(secondaryButton("Putaway") { openMobileSection("actions", subviewGroup = "actions", subviewTarget = "putaway") })
            addView(secondaryButton("Inventory Count") { openMobileRoute("/mobile-count") })
            addView(secondaryButton("Lookup SKU / BIN") { openMobileSection("search") })
            addView(secondaryButton("Move Item") { openMobileSection("actions", subviewGroup = "actions", subviewTarget = "transfer") })
            addView(secondaryButton("Receive Without PO") { openMobileSection("scan") })
            addView(secondaryButton("Pallets / Labels") { openMobileSection("labels", labelMode = "pallet") })
            addView(statusView("Device"))
            addView(secondaryButton("Sync Now") { sync.syncNow(downloadOrders = true) })
            addView(secondaryButton("Report Issue") { openMobileRoute("/mobile", reportIssue = true) })
            addView(secondaryButton("Logout / Switch Company") {
                store.clearSession()
                showLogin()
            })
            addView(statusView("Sync queue: ${summary.first} pending, ${summary.second} failed. App ${BuildConfig.VERSION_NAME}"))
        })
    }

    private fun openMobileSection(
        section: String,
        subviewGroup: String = "",
        subviewTarget: String = "",
        labelMode: String = ""
    ) {
        openMobileRoute("/mobile", section, subviewGroup, subviewTarget, labelMode)
    }

    private fun openMobileRoute(
        path: String,
        section: String = "",
        subviewGroup: String = "",
        subviewTarget: String = "",
        labelMode: String = "",
        reportIssue: Boolean = false
    ) {
        val session = store.getSession()
        val uri = Uri.parse(BuildConfig.WMS365_BASE_URL.trimEnd('/') + path).buildUpon()
            .appendQueryParameter("mode", "mobile")
            .appendQueryParameter("source", "native_scanner")
            .appendQueryParameter("nativeTs", System.currentTimeMillis().toString())
            .apply {
                if (session?.company?.isNotBlank() == true) appendQueryParameter("accountName", session.company)
                if (section.isNotBlank()) appendQueryParameter("section", section)
                if (subviewGroup.isNotBlank()) appendQueryParameter("subviewGroup", subviewGroup)
                if (subviewTarget.isNotBlank()) appendQueryParameter("subviewTarget", subviewTarget)
                if (labelMode.isNotBlank()) appendQueryParameter("labelMode", labelMode)
                if (reportIssue) appendQueryParameter("reportIssue", "1")
            }
            .build()
        val targetPackage = when {
            isPackageInstalled("com.wms365.app") -> "com.wms365.app"
            isPackageInstalled("com.android.chrome") -> "com.android.chrome"
            else -> ""
        }
        val intent = Intent(Intent.ACTION_VIEW, uri)
        if (targetPackage.isNotBlank()) intent.setPackage(targetPackage)
        startActivity(intent)
    }

    private fun isPackageInstalled(packageName: String): Boolean {
        return try {
            packageManager.getPackageInfo(packageName, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
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
            PickState.SCAN_ITEM -> showScanItem(next, tasks)
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
        activeScanTarget = ScanTarget.NONE
        currentScreen = Screen.PICKING
        val qty = input("Picked Qty", InputType.TYPE_CLASS_NUMBER).apply {
            setText(task.remainingQty.toString())
            textSize = 30f
            gravity = Gravity.CENTER
        }
        root.removeAllViews()
        root.addView(taskScreen(task, tasks, "Confirm picked quantity", "${task.remainingQty} required") {
            addView(fieldLabel("Available", task.availableQty.toString()))
            addView(qty)
            addView(primaryButton("Confirm Pick") { confirmPick(task, qty.text.toString().toIntOrNull() ?: 0, shortPick = false) })
            addView(secondaryButton("Short Pick / Not Enough Stock") { confirmPick(task, qty.text.toString().toIntOrNull() ?: 0, shortPick = true) })
            addProblemButtons(task)
        })
        qty.requestFocus()
    }

    private fun showPickComplete(tasks: List<PickTask>) {
        activeScanTarget = ScanTarget.NONE
        currentScreen = Screen.COMPLETE
        root.removeAllViews()
        val exceptions = tasks.count { it.state == PickState.EXCEPTION }
        root.addView(screen {
            addView(header("Picking Complete", activeOrderId))
            addView(banner(if (exceptions > 0) "Needs Review" else "Ready to Pack", if (exceptions > 0) "$exceptions exception(s) reported" else "All picks confirmed", if (exceptions > 0) YELLOW else GREEN))
            addView(primaryButton("Sync Now") { sync.syncNow(downloadOrders = true) })
            addView(secondaryButton("Choose Another Order") { showOrderList() })
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
        store.updateTaskState(task.id, PickState.SCAN_ITEM)
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
        store.recordScan(value, "sku", "accepted", task.orderId, task.id)
        store.updateTaskState(task.id, PickState.ENTER_QTY)
        openNextTask()
    }

    private fun confirmPick(task: PickTask, qty: Int, shortPick: Boolean) {
        if (qty <= 0) {
            scanner.error()
            toastStatus("Qty must be greater than zero.", true)
            return
        }
        if (qty > task.remainingQty) {
            scanner.error()
            toastStatus("Cannot pick more than required.", true)
            return
        }
        if (task.availableQty > 0 && qty > task.availableQty) {
            scanner.error()
            toastStatus("Cannot pick more than available.", true)
            return
        }

        val pickKey = newKey("pick", task)
        store.enqueue(
            OutboxType.PICK_CONFIRMATION,
            pickKey,
            basePayload(task, pickKey)
                .put("location", task.location)
                .put("sku", task.sku)
                .put("skuOrUpc", task.sku)
                .put("quantity", qty)
                .put("lot", task.lotNumber)
                .put("expiry", task.expiry)
        )

        val newPicked = task.pickedQty + qty
        if (shortPick || newPicked < task.requiredQty) {
            val exceptionKey = newKey("short-pick", task)
            store.enqueue(
                OutboxType.PICK_EXCEPTION,
                exceptionKey,
                basePayload(task, exceptionKey)
                    .put("reason", "SHORT_PICK")
                    .put("note", "Worker picked $qty of ${task.requiredQty}; supervisor review required.")
                    .put("location", task.location)
                    .put("sku", task.sku)
                    .put("quantity", qty)
            )
            store.updateTaskState(task.id, PickState.EXCEPTION, newPicked)
        } else {
            store.updateTaskState(task.id, PickState.COMPLETE, newPicked)
        }

        scanner.success()
        sync.syncNow(downloadOrders = false)
        openNextTask()
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
        val task = activeTask ?: return
        when (activeScanTarget) {
            ScanTarget.LOCATION -> confirmLocation(task, value)
            ScanTarget.SKU -> confirmSku(task, value)
            ScanTarget.NONE -> toastStatus("Scan received: $value", false)
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

    private fun newKey(prefix: String, task: PickTask): String = "android-$prefix-${store.getSession()?.deviceId}-${task.id}-${System.currentTimeMillis()}"

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
        textSize = 18f
        setSingleLine(true)
        setPadding(18, 8, 18, 8)
        minHeight = 64
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).withMargins()
    }

    private fun primaryButton(text: String, onClick: () -> Unit): Button = button(text, GREEN, Color.WHITE, false, onClick)
    private fun cameraButton(text: String, onClick: () -> Unit): Button = button(text, DARK, Color.WHITE, false, onClick)
    private fun secondaryButton(text: String, disabled: Boolean = false, onClick: () -> Unit): Button = button(text, Color.WHITE, TEXT, disabled, onClick)

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
        }
        return ""
    }

    private fun LinearLayout.LayoutParams.withMargins(): LinearLayout.LayoutParams {
        setMargins(0, 8, 0, 8)
        return this
    }

    private enum class ScanTarget { NONE, LOCATION, SKU }
    private enum class Screen { LOGIN, HOME, ORDER_LIST, PICKING, COMPLETE }

    companion object {
        private val BG = Color.rgb(244, 247, 249)
        private val TEXT = Color.rgb(15, 23, 42)
        private val MUTED = Color.rgb(71, 85, 105)
        private val GREEN = Color.rgb(15, 118, 110)
        private val BLUE = Color.rgb(37, 99, 235)
        private val YELLOW = Color.rgb(202, 138, 4)
        private val DARK = Color.rgb(15, 23, 42)
    }
}
