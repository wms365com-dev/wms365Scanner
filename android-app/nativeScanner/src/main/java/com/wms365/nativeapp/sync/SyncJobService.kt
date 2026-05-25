package com.wms365.nativeapp.sync

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import com.wms365.nativeapp.data.LocalStore
import com.wms365.nativeapp.network.WmsApiClient
import org.json.JSONObject
import java.util.concurrent.Executors

class SyncJobService : JobService() {
    private val executor = Executors.newSingleThreadExecutor()

    override fun onStartJob(params: JobParameters): Boolean {
        executor.execute {
            try {
                val store = LocalStore(applicationContext)
                val api = WmsApiClient()
                val session = store.getSession() ?: return@execute
                val orders = api.fetchPickOrders(session)
                val orderRows = mutableListOf<JSONObject>()
                for (i in 0 until orders.length()) orders.optJSONObject(i)?.let(orderRows::add)
                store.upsertPickOrders(orderRows)
                store.pendingOutbox().forEach { item ->
                    try {
                        api.submitOutbox(session, item)
                        store.markOutboxSynced(item.id)
                    } catch (error: Throwable) {
                        store.markOutboxFailed(item.id, item.attempts + 1, error.message ?: "Sync failed")
                    }
                }
            } catch (_: Throwable) {
                // Background sync must never crash the scanner app. The foreground UI shows retry state.
            } finally {
                jobFinished(params, false)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true

    companion object {
        private const val JOB_ID = 36501

        fun schedule(context: Context) {
            val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            val info = JobInfo.Builder(JOB_ID, ComponentName(context, SyncJobService::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .setPeriodic(15 * 60 * 1000L)
                .build()
            scheduler.schedule(info)
        }
    }
}
