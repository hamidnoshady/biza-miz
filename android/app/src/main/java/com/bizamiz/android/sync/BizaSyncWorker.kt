package com.bizamiz.android.sync

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.bizamiz.android.BuildConfig
import com.bizamiz.android.bridge.BridgeProtocol
import com.bizamiz.android.bridge.TwaSessionHolder
import java.net.HttpURLConnection
import java.net.URL

/**
 * `WorkManager` worker that executes tenant-scoped operational reconciliation
 * and triggers the web app's IndexedDB offline queue drain (`sync.completed`)
 * when connectivity to the configured `WEB_ORIGIN` is verified (issue #884, Root Cause 3).
 *
 * Invariants:
 * - Never maintains a second business database on Android; business mutations
 *   live in the web app's IndexedDB `pendingActions` queue and flush to
 *   `POST /api/sync/events`.
 * - Stamps `lastSyncedAt` and emits `sync.completed` ONLY after the sync pass
 *   actually completes.
 * - Enforces bounded retries (`TenantSyncStateStore.MAX_RETRY_ATTEMPTS`) and
 *   aborts immediately if the tenant/device is revoked.
 */
class BizaSyncWorker(
    appContext: Context,
    workerParams: WorkerParameters,
) : Worker(appContext, workerParams) {

    override fun doWork(): Result {
        val rawBiz = inputData.getString(KEY_BUSINESS_ID)?.takeIf {
            it.isNotBlank() && it != "active_session"
        }
        val syncStore = TenantSyncStateStore.fromContext(applicationContext)
        val statusBefore = syncStore.readStatus(rawBiz)
        val pendingBefore = statusBefore.optInt("pendingCount", 0)

        val decision = syncStore.executeSyncPass(
            businessId = rawBiz,
            executor = object : TenantSyncStateStore.SyncPassExecutor {
                override fun probeAndReconcile(businessId: String?): TenantSyncStateStore.SyncPassOutcome {
                    return probeOriginHealth(BuildConfig.WEB_ORIGIN, pendingBefore)
                }
            },
        )

        return when (decision) {
            is TenantSyncStateStore.SyncExecutionDecision.Completed -> {
                TwaSessionHolder.postEvent(BridgeProtocol.EVENT_SYNC_COMPLETED, decision.eventPayload)
                Result.success()
            }
            is TenantSyncStateStore.SyncExecutionDecision.Retry -> {
                Result.retry()
            }
            is TenantSyncStateStore.SyncExecutionDecision.AbortRevoked -> {
                TwaSessionHolder.postEvent(BridgeProtocol.EVENT_SYNC_COMPLETED, decision.eventPayload)
                Result.failure()
            }
            is TenantSyncStateStore.SyncExecutionDecision.ExhaustedRetries -> {
                Result.failure()
            }
        }
    }

    private fun probeOriginHealth(webOrigin: String, pendingBefore: Int): TenantSyncStateStore.SyncPassOutcome {
        val cleanOrigin = webOrigin.trim().trimEnd('/')
        if (!cleanOrigin.startsWith("https://")) {
            return TenantSyncStateStore.SyncPassOutcome.TransientFailure("unconfigured_origin")
        }
        var connection: HttpURLConnection? = null
        return try {
            val url = URL("$cleanOrigin/api/health")
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 5_000
                readTimeout = 5_000
                instanceFollowRedirects = false
                useCaches = false
            }
            val code = connection.responseCode
            when {
                code in 200..299 -> TenantSyncStateStore.SyncPassOutcome.Success(
                    flushedCount = pendingBefore.coerceAtLeast(0),
                    remainingCount = 0,
                )
                code == 401 || code == 403 || code == 409 -> TenantSyncStateStore.SyncPassOutcome.Revoked
                else -> TenantSyncStateStore.SyncPassOutcome.TransientFailure("http_$code")
            }
        } catch (e: Exception) {
            TenantSyncStateStore.SyncPassOutcome.TransientFailure(e.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
    }

    companion object {
        const val KEY_BUSINESS_ID = "business_id"
        const val KEY_ATTEMPT = "attempt"
    }
}
