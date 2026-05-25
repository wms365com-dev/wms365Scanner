package com.wms365.nativeapp.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

class LocalStore(context: Context) : SQLiteOpenHelper(context, "wms365_native_scanner.db", null, 1) {
    private val crypto = CryptoBox()

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            create table settings (
                key text primary key,
                value text not null
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            create table pick_orders (
                id text primary key,
                order_code text not null,
                account_name text not null,
                customer text not null default '',
                status text not null,
                updated_at text not null default '',
                raw_json text not null
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            create table pick_tasks (
                id text primary key,
                order_id text not null,
                line_id text not null,
                order_code text not null,
                account_name text not null,
                location text not null default '',
                sku text not null,
                upc text not null default '',
                description text not null default '',
                required_qty integer not null,
                available_qty integer not null default 0,
                picked_qty integer not null default 0,
                lot_number text not null default '',
                expiry text not null default '',
                tracking_level text not null default '',
                sequence integer not null,
                state text not null,
                server_updated_at text not null default ''
            )
            """.trimIndent()
        )
        db.execSQL("create index idx_pick_tasks_order_sequence on pick_tasks(order_id, sequence)")
        db.execSQL("create index idx_pick_tasks_state on pick_tasks(state)")
        db.execSQL(
            """
            create table outbox (
                id integer primary key autoincrement,
                type text not null,
                idempotency_key text not null unique,
                payload text not null,
                status text not null default 'PENDING',
                attempts integer not null default 0,
                last_error text not null default '',
                created_at integer not null,
                updated_at integer not null
            )
            """.trimIndent()
        )
        db.execSQL("create index idx_outbox_status on outbox(status, updated_at)")
        db.execSQL(
            """
            create table scan_history (
                id integer primary key autoincrement,
                value text not null,
                target text not null,
                result text not null,
                order_id text not null default '',
                task_id text not null default '',
                created_at integer not null
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun getSetting(key: String): String = readableDatabase.rawQuery("select value from settings where key = ?", arrayOf(key)).use {
        if (it.moveToFirst()) it.getString(0) else ""
    }

    fun setSetting(key: String, value: String) {
        writableDatabase.insertWithOnConflict("settings", null, ContentValues().apply {
            put("key", key)
            put("value", value)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun saveSession(session: AppSession) {
        setSetting("email", session.email)
        setSetting("cookie", crypto.encrypt(session.cookieHeader))
        setSetting("company", session.company)
        setSetting("warehouseId", session.warehouseId)
        setSetting("deviceId", session.deviceId)
    }

    fun getSession(): AppSession? {
        val cookie = crypto.decrypt(getSetting("cookie"))
        if (cookie.isBlank()) return null
        val deviceId = getSetting("deviceId").ifBlank {
            java.util.UUID.randomUUID().toString().also { setSetting("deviceId", it) }
        }
        return AppSession(
            email = getSetting("email"),
            cookieHeader = cookie,
            company = getSetting("company"),
            warehouseId = getSetting("warehouseId"),
            deviceId = deviceId
        )
    }

    fun clearSession() {
        listOf("email", "cookie", "company", "warehouseId").forEach { setSetting(it, "") }
    }

    fun upsertPickOrders(orders: List<JSONObject>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            orders.forEach { order ->
                val orderId = order.stringValue("id")
                if (orderId.isBlank()) return@forEach
                db.insertWithOnConflict("pick_orders", null, ContentValues().apply {
                    put("id", orderId)
                    put("order_code", order.stringValue("orderCode").ifBlank { "Order $orderId" })
                    put("account_name", order.stringValue("accountName"))
                    put("customer", order.stringValue("shipToName").ifBlank { order.stringValue("contactName") })
                    put("status", order.stringValue("status").ifBlank { "RELEASED" })
                    put("updated_at", order.stringValue("updatedAt"))
                    put("raw_json", order.toString())
                }, SQLiteDatabase.CONFLICT_REPLACE)

                buildPickTasks(order).forEach { task ->
                    val existing = getPickTask(task.id)
                    val savedState = existing?.state ?: task.state
                    val savedPicked = existing?.pickedQty ?: 0
                    db.insertWithOnConflict("pick_tasks", null, task.toValues(savedState, savedPicked), SQLiteDatabase.CONFLICT_REPLACE)
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun getPickOrders(company: String = ""): List<PickOrder> {
        val args = if (company.isBlank()) emptyArray() else arrayOf(company)
        val where = if (company.isBlank()) "" else " where account_name = ?"
        return readableDatabase.rawQuery(
            "select id, order_code, account_name, customer, status, updated_at, raw_json from pick_orders$where order by updated_at asc, order_code asc",
            args
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(PickOrder(cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3), cursor.getString(4), cursor.getString(5), cursor.getString(6)))
                }
            }
        }
    }

    fun getPickTasks(orderId: String): List<PickTask> {
        return readableDatabase.rawQuery(
            "select * from pick_tasks where order_id = ? order by sequence asc",
            arrayOf(orderId)
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(cursorToTask(cursor))
            }
        }
    }

    fun getPickTask(id: String): PickTask? {
        return readableDatabase.rawQuery("select * from pick_tasks where id = ? limit 1", arrayOf(id)).use {
            if (it.moveToFirst()) cursorToTask(it) else null
        }
    }

    fun updateTaskState(taskId: String, state: PickState, pickedQty: Int? = null) {
        writableDatabase.update("pick_tasks", ContentValues().apply {
            put("state", state.name)
            if (pickedQty != null) put("picked_qty", pickedQty)
        }, "id = ?", arrayOf(taskId))
    }

    fun enqueue(type: OutboxType, idempotencyKey: String, payload: JSONObject) {
        val now = nowMillis()
        writableDatabase.insertWithOnConflict("outbox", null, ContentValues().apply {
            put("type", type.name)
            put("idempotency_key", idempotencyKey)
            put("payload", payload.toString())
            put("status", "PENDING")
            put("attempts", 0)
            put("last_error", "")
            put("created_at", now)
            put("updated_at", now)
        }, SQLiteDatabase.CONFLICT_IGNORE)
    }

    fun pendingOutbox(limit: Int = 50): List<OutboxItem> {
        return readableDatabase.rawQuery(
            "select id, type, idempotency_key, payload, status, attempts, last_error, created_at, updated_at from outbox where status in ('PENDING','FAILED') order by created_at asc limit ?",
            arrayOf(limit.toString())
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(OutboxItem(cursor.getLong(0), OutboxType.valueOf(cursor.getString(1)), cursor.getString(2), cursor.getString(3), cursor.getString(4), cursor.getInt(5), cursor.getString(6), cursor.getLong(7), cursor.getLong(8)))
                }
            }
        }
    }

    fun markOutboxSynced(id: Long) {
        writableDatabase.update("outbox", ContentValues().apply {
            put("status", "SYNCED")
            put("updated_at", nowMillis())
        }, "id = ?", arrayOf(id.toString()))
    }

    fun markOutboxFailed(id: Long, attempts: Int, error: String) {
        writableDatabase.update("outbox", ContentValues().apply {
            put("status", "FAILED")
            put("attempts", attempts)
            put("last_error", error.take(500))
            put("updated_at", nowMillis())
        }, "id = ?", arrayOf(id.toString()))
    }

    fun outboxSummary(): Pair<Int, Int> {
        return readableDatabase.rawQuery("select status, count(*) from outbox where status <> 'SYNCED' group by status", emptyArray()).use {
            var pending = 0
            var failed = 0
            while (it.moveToNext()) {
                when (it.getString(0)) {
                    "PENDING" -> pending = it.getInt(1)
                    "FAILED" -> failed = it.getInt(1)
                }
            }
            pending to failed
        }
    }

    fun recordScan(value: String, target: String, result: String, orderId: String = "", taskId: String = "") {
        writableDatabase.insert("scan_history", null, ContentValues().apply {
            put("value", value)
            put("target", target)
            put("result", result)
            put("order_id", orderId)
            put("task_id", taskId)
            put("created_at", nowMillis())
        })
    }

    private fun PickTask.toValues(stateOverride: PickState, pickedOverride: Int): ContentValues = ContentValues().apply {
        put("id", id)
        put("order_id", orderId)
        put("line_id", lineId)
        put("order_code", orderCode)
        put("account_name", accountName)
        put("location", location)
        put("sku", sku)
        put("upc", upc)
        put("description", description)
        put("required_qty", requiredQty)
        put("available_qty", availableQty)
        put("picked_qty", pickedOverride)
        put("lot_number", lotNumber)
        put("expiry", expiry)
        put("tracking_level", trackingLevel)
        put("sequence", sequence)
        put("state", stateOverride.name)
        put("server_updated_at", serverUpdatedAt)
    }

    private fun cursorToTask(cursor: android.database.Cursor): PickTask = PickTask(
        id = cursor.getString(cursor.getColumnIndexOrThrow("id")),
        orderId = cursor.getString(cursor.getColumnIndexOrThrow("order_id")),
        lineId = cursor.getString(cursor.getColumnIndexOrThrow("line_id")),
        orderCode = cursor.getString(cursor.getColumnIndexOrThrow("order_code")),
        accountName = cursor.getString(cursor.getColumnIndexOrThrow("account_name")),
        location = cursor.getString(cursor.getColumnIndexOrThrow("location")),
        sku = cursor.getString(cursor.getColumnIndexOrThrow("sku")),
        upc = cursor.getString(cursor.getColumnIndexOrThrow("upc")),
        description = cursor.getString(cursor.getColumnIndexOrThrow("description")),
        requiredQty = cursor.getInt(cursor.getColumnIndexOrThrow("required_qty")),
        availableQty = cursor.getInt(cursor.getColumnIndexOrThrow("available_qty")),
        pickedQty = cursor.getInt(cursor.getColumnIndexOrThrow("picked_qty")),
        lotNumber = cursor.getString(cursor.getColumnIndexOrThrow("lot_number")),
        expiry = cursor.getString(cursor.getColumnIndexOrThrow("expiry")),
        trackingLevel = cursor.getString(cursor.getColumnIndexOrThrow("tracking_level")),
        sequence = cursor.getInt(cursor.getColumnIndexOrThrow("sequence")),
        state = PickState.valueOf(cursor.getString(cursor.getColumnIndexOrThrow("state"))),
        serverUpdatedAt = cursor.getString(cursor.getColumnIndexOrThrow("server_updated_at"))
    )
}
