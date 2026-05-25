package com.wms365.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

enum class PickState {
    GO_TO_LOCATION,
    SCAN_LOCATION,
    SCAN_ITEM,
    ENTER_QTY,
    COMPLETE,
    EXCEPTION
}

data class AppSession(
    val email: String,
    val cookieHeader: String,
    val company: String,
    val warehouseId: String,
    val deviceId: String
)

data class PickOrder(
    val id: String,
    val orderCode: String,
    val accountName: String,
    val customer: String,
    val status: String,
    val updatedAt: String,
    val rawJson: String
)

data class PickTask(
    val id: String,
    val orderId: String,
    val lineId: String,
    val orderCode: String,
    val accountName: String,
    val location: String,
    val sku: String,
    val upc: String,
    val description: String,
    val requiredQty: Int,
    val availableQty: Int,
    val pickedQty: Int,
    val lotNumber: String,
    val expiry: String,
    val trackingLevel: String,
    val sequence: Int,
    val state: PickState,
    val serverUpdatedAt: String
) {
    val remainingQty: Int get() = (requiredQty - pickedQty).coerceAtLeast(0)
    val locationRequired: Boolean get() = location.isNotBlank()
}

enum class OutboxType(val apiPath: String) {
    PICK_ARRIVAL("/api/mobile/pick-arrivals"),
    PICK_CONFIRMATION("/api/mobile/pick-confirmations"),
    PICK_EXCEPTION("/api/mobile/pick-exceptions"),
    PUT_AWAY("/api/mobile/put-away-confirmations"),
    MOVE("/api/mobile/move-confirmations"),
    RECEIVING("/api/mobile/receiving-confirmations")
}

data class OutboxItem(
    val id: Long,
    val type: OutboxType,
    val idempotencyKey: String,
    val payload: String,
    val status: String,
    val attempts: Int,
    val lastError: String,
    val createdAt: Long,
    val updatedAt: Long
)

fun JSONObject.stringValue(name: String): String = optString(name, "").trim()
fun JSONObject.intValue(name: String): Int = optInt(name, 0)

fun buildPickTasks(order: JSONObject): List<PickTask> {
    val orderId = order.stringValue("id")
    val orderCode = order.stringValue("orderCode").ifBlank { "Order $orderId" }
    val accountName = order.stringValue("accountName")
    val lines = order.optJSONArray("lines") ?: JSONArray()
    val tasks = mutableListOf<PickTask>()
    var sequence = 0

    for (lineIndex in 0 until lines.length()) {
        val line = lines.optJSONObject(lineIndex) ?: continue
        val lineId = line.stringValue("id").ifBlank { "${lineIndex + 1}" }
        val locations = line.optJSONArray("pickLocations") ?: JSONArray()
        if (locations.length() == 0) {
            tasks += taskFromJson(orderId, orderCode, accountName, line, JSONObject(), lineId, ++sequence)
            continue
        }
        val locationRows = mutableListOf<JSONObject>()
        for (i in 0 until locations.length()) {
            locations.optJSONObject(i)?.let(locationRows::add)
        }
        locationRows
            .sortedWith(compareBy<JSONObject> {
                val expiry = it.stringValue("expirationDate")
                if (expiry.isBlank()) "9999-12-31" else expiry
            }.thenBy { it.stringValue("location") })
            .forEach { tasks += taskFromJson(orderId, orderCode, accountName, line, it, lineId, ++sequence) }
    }
    return tasks.sortedWith(compareBy<PickTask> { it.location.ifBlank { "ZZZ" } }.thenBy { it.expiry.ifBlank { "9999-12-31" } }.thenBy { it.sequence })
        .mapIndexed { index, task -> task.copy(sequence = index + 1) }
}

private fun taskFromJson(
    orderId: String,
    orderCode: String,
    accountName: String,
    line: JSONObject,
    location: JSONObject,
    lineId: String,
    sequence: Int
): PickTask {
    val sku = line.stringValue("sku")
    val locationQty = location.intValue("quantity")
    val requestedQty = line.intValue("quantity")
    val requiredQty = if (locationQty > 0) locationQty else requestedQty
    return PickTask(
        id = stableTaskId(orderId, lineId, location.stringValue("location"), sku, location.stringValue("lotNumber"), location.stringValue("expirationDate"), sequence),
        orderId = orderId,
        lineId = lineId,
        orderCode = orderCode,
        accountName = accountName,
        location = location.stringValue("location"),
        sku = sku,
        upc = line.stringValue("upc"),
        description = line.stringValue("description"),
        requiredQty = requiredQty,
        availableQty = line.intValue("availableQuantity"),
        pickedQty = 0,
        lotNumber = location.stringValue("lotNumber"),
        expiry = location.stringValue("expirationDate"),
        trackingLevel = location.stringValue("trackingLevel").ifBlank { line.stringValue("trackingLevel") },
        sequence = sequence,
        state = PickState.GO_TO_LOCATION,
        serverUpdatedAt = line.stringValue("updatedAt")
    )
}

fun stableTaskId(orderId: String, lineId: String, location: String, sku: String, lot: String, expiry: String, sequence: Int): String {
    return listOf(orderId, lineId, location, sku, lot, expiry, sequence.toString())
        .joinToString("|")
        .uppercase()
        .let { UUID.nameUUIDFromBytes(it.toByteArray()).toString() }
}

fun nowMillis(): Long = System.currentTimeMillis()
