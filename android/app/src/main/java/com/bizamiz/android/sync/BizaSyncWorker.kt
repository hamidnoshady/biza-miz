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
 * `WorkManager` worker that probes connectivity to the configured `WEB_ORIGIN`
 * and coordinates reconciliation with the web app's IndexedDB `pendingActions`
 * queue (`POST /api/sync/events`) when reachable (issue #884).
 *
 * Invariants:
 * - Never maintains a second business database on Android; business mutations
 *   live in the web app's IndexedDB `pendingActions` queue and flush to
 *   `POST /api/sync/events`.
 * - A `200 OK` from `/api/health` proves origin reachability ONLY; it never
 *   marks business sync complete, never zeroes `pendingCount`, and never stamps
 *   `lastSyncedAt`.
 * - When `pendingCount > 0` and `/api/health` returns 2xx, `TenantSyncStateStore`
 *   transitions to `state = "waiting_for_app"` with a durable `pendingSyncRequestId`
 *   and emits `sync.reconcileRequested` if the TWA bridge is connected (or retains
 *   `waiting_for_app` durably while the browser is closed until `sync.acknowledge`
 *   is received).
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
        val channelReady = TwaSessionHolder.isChannelReady()

        val decision = syncStore.executeSyncPass(
            businessId = rawBiz,
            executor = object : TenantSyncStateStore.SyncPassExecutor {
                override fun probeAndReconcile(businessId: String?): TenantSyncStateStore.SyncPassOutcome {
                    return probeOriginHealth(
                        webOrigin = BuildConfig.WEB_ORIGIN,
                        webRuntimeConnected = channelReady,
                    )
                }
            },
        )

        return when (decision) {
            is TenantSyncStateStore.SyncExecutionDecision.WaitingForApp -> {
                if (TwaSessionHolder.isChannelReady()) {
                    TwaSessionHolder.postEvent(
                        BridgeProtocol.EVENT_SYNC_RECONCILE_REQUESTED,
                        decision.reconcileEventPayload,
                    )
                }
                Result.success()
            }
            is TenantSyncStateStore.SyncExecutionDecision.NoPendingWork -> {
                Result.success()
            }
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

    companion object {
        const val KEY_BUSINESS_ID = "business_id"
        const val KEY_ATTEMPT = "attempt"

        internal fun probeOriginHealth(
            webOrigin: String,
            webRuntimeConnected: Boolean = TwaSessionHolder.isChannelReady(),
            connectionFactory: (URL) -> HttpURLConnection = { url -> url.openConnection() as HttpURLConnection },
        ): TenantSyncStateStore.SyncPassOutcome {
            val cleanOrigin = webOrigin.trim().trimEnd('/')
            if (!cleanOrigin.startsWith("https://")) {
                return TenantSyncStateStore.SyncPassOutcome.TransientFailure("unconfigured_origin")
            }
            var connection: HttpURLConnection? = null
            return try {
                val url = URL("$cleanOrigin/api/health")
                connection = connectionFactory(url).apply {
                    requestMethod = "GET"
                    connectTimeout = 5_000
                    readTimeout = 5_000
                    instanceFollowRedirects = false
                    useCaches = false
                }
                val code = connection.responseCode
                when {
                    code in 200..299 -> TenantSyncStateStore.SyncPassOutcome.OriginReachable(
                        webRuntimeConnected = webRuntimeConnected,
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
    }
}
