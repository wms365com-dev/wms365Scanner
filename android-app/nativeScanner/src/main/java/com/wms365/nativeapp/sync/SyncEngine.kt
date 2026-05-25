package com.wms365.nativeapp.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import com.wms365.nativeapp.data.LocalStore
import com.wms365.nativeapp.network.WmsApiClient
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class SyncEngine(
    private val context: Context,
    private val store: LocalStore,
    private val api: WmsApiClient,
    private val onStatus: (SyncStatus) -> Unit
) {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val running = AtomicBoolean(false)

    fun syncNow(downloadOrders: Boolean = true) {
        if (!running.compareAndSet(false, true)) return
        executor.execute {
            val status = SyncStatus()
            try {
                val session = store.getSession() ?: throw IllegalStateException("Not signed in")
                if (!isOnline()) throw IllegalStateException("Device is offline")

                if (downloadOrders) {
                    val orders = api.fetchPickOrders(session)
                    val rows = mutableListOf<JSONObject>()
                    for (i in 0 until orders.length()) orders.optJSONObject(i)?.let(rows::add)
                    store.upsertPickOrders(rows)
                    status.downloadedOrders = rows.size
                }

                val pending = store.pendingOutbox()
                status.pendingBefore = pending.size
                pending.forEach { item ->
                    try {
                        api.submitOutbox(session, item)
                        store.markOutboxSynced(item.id)
                        status.synced += 1
                    } catch (error: Throwable) {
                        store.markOutboxFailed(item.id, item.attempts + 1, error.message ?: "Sync failed")
                        status.failed += 1
                    }
                }
                val summary = store.outboxSummary()
                status.pendingAfter = summary.first
                status.failedAfter = summary.second
            } catch (error: Throwable) {
                status.failed += 1
                status.message = error.message ?: "Sync failed"
            } finally {
                running.set(false)
                main.post { onStatus(status) }
            }
        }
    }

    fun isOnline(): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = manager.activeNetwork ?: return false
        val caps = manager.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}

data class SyncStatus(
    var downloadedOrders: Int = 0,
    var pendingBefore: Int = 0,
    var synced: Int = 0,
    var failed: Int = 0,
    var pendingAfter: Int = 0,
    var failedAfter: Int = 0,
    var message: String = ""
) {
    fun label(): String {
        if (message.isNotBlank()) return message
        if (failedAfter > 0) return "$failedAfter failed, $pendingAfter pending"
        if (pendingAfter > 0) return "$pendingAfter pending sync"
        if (downloadedOrders > 0 || synced > 0) return "Synced $downloadedOrders orders, sent $synced"
        return "Synced"
    }
}
