package com.bizamiz.android.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import com.bizamiz.android.bridge.BridgeProtocol
import com.bizamiz.android.callerid.CallerIdCache
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Tenant-scoped operational sync state store, `WorkManager` scheduler coordinator,
 * and execution state machine for the Android TWA runtime (issue #884, Root Cause 3).
 *
 * Invariants:
 * - Never creates a second business database in Android; the web app's IndexedDB
 *   queue (`src/app/dashboard/offline-queue.tsx`) and `/api/sync/events` remain
 *   the single mutation pipeline.
 * - `recordSyncRequest` ("enqueue" / "immediate") schedules work via
 *   [NativeSyncScheduler] (`WorkManagerSyncScheduler` on device) and records
 *   `lastRequestedAt` without fabricating `lastSyncedAt`.
 * - `lastSyncedAt` is stamped ONLY when [markSyncCompleted] or [executeSyncPass]
 *   completes a real sync pass.
 * - `clearTenant`, `clearAll`, and `markTenantRevoked` cancel queued/running
 *   `WorkManager` work and wipe operational state (and caller ID cache).
 * - Bounded exponential retry backoff (`MAX_RETRY_ATTEMPTS = 5`) prevents
 *   unbounded battery/network drain.
 */
class TenantSyncStateStore(
    private val store: CallerIdCache.KeyValueStore,
    private val scheduler: NativeSyncScheduler? = null,
    private val onClearTenantCallback: ((String) -> Unit)? = null,
    private val onClearAllCallback: (() -> Unit)? = null,
) {
    interface SyncPassExecutor {
        fun probeAndReconcile(businessId: String?): SyncPassOutcome
    }

    sealed class SyncPassOutcome {
        data class Success(val flushedCount: Int = 0, val remainingCount: Int = 0) : SyncPassOutcome()
        data class TransientFailure(val reason: String) : SyncPassOutcome()
        object Revoked : SyncPassOutcome()
    }

    sealed class SyncExecutionDecision {
        data class Completed(val eventPayload: JSONObject) : SyncExecutionDecision()
        data class Retry(val attempt: Int, val backoffDelayMs: Long) : SyncExecutionDecision()
        data class ExhaustedRetries(val attempts: Int) : SyncExecutionDecision()
        data class AbortRevoked(val eventPayload: JSONObject) : SyncExecutionDecision()
    }

    fun recordSyncRequest(
        businessId: String?,
        action: String,
        pendingCount: Int = 0,
        nowIso: String = utcNowIso(),
    ): JSONObject {
        val cleanBiz = businessId?.trim()?.takeIf { it.isNotEmpty() }
            ?: store.getString(KEY_ACTIVE_BUSINESS)?.takeIf { it.isNotEmpty() }

        return when (action) {
            "clear_all" -> {
                scheduler?.cancelAllSync()
                store.clearAll()
                onClearAllCallback?.invoke()
                JSONObject()
                    .put("scheduled", false)
                    .put("action", "clear_all")
                    .put("businessId", JSONObject.NULL)
                    .put("clearedEntries", 1)
            }
            "clear_tenant" -> {
                val targetBiz = businessId?.trim()?.takeIf { it.isNotEmpty() }
                var cleared = 0
                if (targetBiz != null) {
                    scheduler?.cancelTenantSync(targetBiz)
                    if (store.getString(tenantKey(targetBiz)) != null) cleared = 1
                    store.remove(tenantKey(targetBiz))
                    if (store.getString(KEY_ACTIVE_BUSINESS) == targetBiz) {
                        store.remove(KEY_ACTIVE_BUSINESS)
                    }
                    onClearTenantCallback?.invoke(targetBiz)
                }
                JSONObject()
                    .put("scheduled", false)
                    .put("action", "clear_tenant")
                    .put("businessId", targetBiz ?: JSONObject.NULL)
                    .put("clearedEntries", cleared)
            }
            "enqueue", "immediate" -> {
                if (cleanBiz != null && isTenantRevoked(cleanBiz)) {
                    scheduler?.cancelTenantSync(cleanBiz)
                    return JSONObject()
                        .put("scheduled", false)
                        .put("action", action)
                        .put("businessId", cleanBiz)
                        .put("clearedEntries", 0)
                }

                val expedited = action == "immediate"
                val scheduledOk = scheduler?.scheduleSync(
                    businessId = cleanBiz,
                    expedited = expedited,
                    attempt = 0,
                ) ?: true

                if (cleanBiz != null) {
                    val existing = readRawTenantJson(cleanBiz)
                    val previousLastSyncedAt = existing?.let {
                        if (it.isNull("lastSyncedAt")) null else it.optString("lastSyncedAt", "").takeIf { s -> s.isNotEmpty() }
                    }
                    val previousPending = existing?.optInt("pendingCount", 0) ?: 0
                    val nextPending = if (pendingCount > 0) {
                        pendingCount
                    } else if (action == "enqueue") {
                        maxOf(1, previousPending)
                    } else {
                        previousPending
                    }

                    val state = JSONObject()
                        .put("businessId", cleanBiz)
                        .put("scheduled", scheduledOk)
                        .put("pendingCount", nextPending.coerceAtLeast(0))
                        .put("lastRequestedAt", nowIso)
                        .put("lastSyncedAt", previousLastSyncedAt ?: JSONObject.NULL)
                        .put("retryAttempt", existing?.optInt("retryAttempt", 0) ?: 0)
                        .put("revoked", false)
                    store.putString(tenantKey(cleanBiz), state.toString())
                    store.putString(KEY_ACTIVE_BUSINESS, cleanBiz)
                }

                JSONObject()
                    .put("scheduled", scheduledOk)
                    .put("action", action)
                    .put("businessId", cleanBiz ?: JSONObject.NULL)
                    .put("clearedEntries", 0)
            }
            else -> JSONObject()
                .put("scheduled", false)
                .put("action", "enqueue")
                .put("businessId", cleanBiz ?: JSONObject.NULL)
                .put("clearedEntries", 0)
        }
    }

    fun markSyncCompleted(
        businessId: String?,
        flushedCount: Int = 0,
        remainingCount: Int = 0,
        completedAtIso: String = utcNowIso(),
    ): JSONObject {
        val targetBiz = businessId?.trim()?.takeIf { it.isNotEmpty() }
            ?: store.getString(KEY_ACTIVE_BUSINESS)?.takeIf { it.isNotEmpty() }

        if (targetBiz != null) {
            val stillScheduled = remainingCount > 0
            val state = JSONObject()
                .put("businessId", targetBiz)
                .put("scheduled", stillScheduled)
                .put("pendingCount", remainingCount.coerceAtLeast(0))
                .put("lastSyncedAt", completedAtIso)
                .put("retryAttempt", 0)
                .put("revoked", false)
            store.putString(tenantKey(targetBiz), state.toString())
        }

        return BridgeProtocol.buildSyncCompletedEventPayload(
            businessId = targetBiz,
            syncedAt = completedAtIso,
            revoked = false,
            flushedCount = flushedCount,
        )
    }

    fun executeSyncPass(
        businessId: String?,
        executor: SyncPassExecutor,
        completedAtIso: String = utcNowIso(),
    ): SyncExecutionDecision {
        val targetBiz = businessId?.trim()?.takeIf { it.isNotEmpty() }
            ?: store.getString(KEY_ACTIVE_BUSINESS)?.takeIf { it.isNotEmpty() }

        if (targetBiz != null && isTenantRevoked(targetBiz)) {
            scheduler?.cancelTenantSync(targetBiz)
            return SyncExecutionDecision.AbortRevoked(
                BridgeProtocol.buildSyncCompletedEventPayload(
                    businessId = targetBiz,
                    syncedAt = completedAtIso,
                    revoked = true,
                    flushedCount = 0,
                ),
            )
        }

        return when (val outcome = executor.probeAndReconcile(targetBiz)) {
            is SyncPassOutcome.Success -> {
                val eventPayload = markSyncCompleted(
                    businessId = targetBiz,
                    flushedCount = outcome.flushedCount,
                    remainingCount = outcome.remainingCount,
                    completedAtIso = completedAtIso,
                )
                SyncExecutionDecision.Completed(eventPayload)
            }
            is SyncPassOutcome.Revoked -> {
                if (targetBiz != null) {
                    markTenantRevoked(targetBiz)
                } else {
                    recordSyncRequest(null, "clear_all")
                }
                SyncExecutionDecision.AbortRevoked(
                    BridgeProtocol.buildSyncCompletedEventPayload(
                        businessId = targetBiz,
                        syncedAt = completedAtIso,
                        revoked = true,
                        flushedCount = 0,
                    ),
                )
            }
            is SyncPassOutcome.TransientFailure -> {
                val existing = if (targetBiz != null) readRawTenantJson(targetBiz) else null
                val nextAttempt = (existing?.optInt("retryAttempt", 0) ?: 0) + 1
                if (nextAttempt >= MAX_RETRY_ATTEMPTS) {
                    if (targetBiz != null) {
                        scheduler?.cancelTenantSync(targetBiz)
                        val state = JSONObject()
                            .put("businessId", targetBiz)
                            .put("scheduled", false)
                            .put("pendingCount", existing?.optInt("pendingCount", 0) ?: 0)
                            .put(
                                "lastSyncedAt",
                                existing?.let {
                                    if (it.isNull("lastSyncedAt")) JSONObject.NULL else it.optString("lastSyncedAt")
                                } ?: JSONObject.NULL,
                            )
                            .put("retryAttempt", nextAttempt)
                            .put("lastFailureReason", outcome.reason)
                            .put("revoked", false)
                        store.putString(tenantKey(targetBiz), state.toString())
                    }
                    SyncExecutionDecision.ExhaustedRetries(nextAttempt)
                } else {
                    val delayMs = calculateBackoffDelayMs(nextAttempt - 1)
                    if (targetBiz != null) {
                        val state = JSONObject()
                            .put("businessId", targetBiz)
                            .put("scheduled", true)
                            .put("pendingCount", existing?.optInt("pendingCount", 0) ?: 0)
                            .put(
                                "lastSyncedAt",
                                existing?.let {
                                    if (it.isNull("lastSyncedAt")) JSONObject.NULL else it.optString("lastSyncedAt")
                                } ?: JSONObject.NULL,
                            )
                            .put("retryAttempt", nextAttempt)
                            .put("lastFailureReason", outcome.reason)
                            .put("revoked", false)
                        store.putString(tenantKey(targetBiz), state.toString())
                    }
                    SyncExecutionDecision.Retry(attempt = nextAttempt, backoffDelayMs = delayMs)
                }
            }
        }
    }

    fun markTenantRevoked(businessId: String) {
        val clean = businessId.trim()
        if (clean.isEmpty()) return
        scheduler?.cancelTenantSync(clean)
        val state = JSONObject()
            .put("businessId", clean)
            .put("scheduled", false)
            .put("pendingCount", 0)
            .put("lastSyncedAt", JSONObject.NULL)
            .put("retryAttempt", 0)
            .put("revoked", true)
        store.putString(tenantKey(clean), state.toString())
        onClearTenantCallback?.invoke(clean)
    }

    fun isTenantRevoked(businessId: String): Boolean {
        val raw = store.getString(tenantKey(businessId.trim())) ?: return false
        return try {
            JSONObject(raw).optBoolean("revoked", false)
        } catch (_: Exception) {
            false
        }
    }

    fun readStatus(businessId: String?, networkAvailable: Boolean = true): JSONObject {
        val targetBiz = businessId?.trim()?.takeIf { it.isNotEmpty() }
            ?: store.getString(KEY_ACTIVE_BUSINESS)?.takeIf { it.isNotEmpty() }

        if (targetBiz == null) {
            return JSONObject()
                .put("scheduled", false)
                .put("networkAvailable", networkAvailable)
                .put("businessId", JSONObject.NULL)
                .put("pendingCount", 0)
                .put("lastSyncedAt", JSONObject.NULL)
                .put("revoked", false)
        }

        val obj = readRawTenantJson(targetBiz)
            ?: return JSONObject()
                .put("scheduled", false)
                .put("networkAvailable", networkAvailable)
                .put("businessId", targetBiz)
                .put("pendingCount", 0)
                .put("lastSyncedAt", JSONObject.NULL)
                .put("revoked", false)

        val lastSynced = if (obj.isNull("lastSyncedAt")) {
            JSONObject.NULL
        } else {
            obj.optString("lastSyncedAt", "").takeIf { it.isNotEmpty() } ?: JSONObject.NULL
        }
        return JSONObject()
            .put("scheduled", obj.optBoolean("scheduled", false))
            .put("networkAvailable", networkAvailable)
            .put("businessId", targetBiz)
            .put("pendingCount", obj.optInt("pendingCount", 0))
            .put("lastSyncedAt", lastSynced)
            .put("revoked", obj.optBoolean("revoked", false))
    }

    fun status(businessId: String?, networkAvailable: Boolean = true): JSONObject =
        readStatus(businessId, networkAvailable)

    private fun readRawTenantJson(businessId: String): JSONObject? {
        val raw = store.getString(tenantKey(businessId)) ?: return null
        if (raw.isBlank()) return null
        return try {
            JSONObject(raw)
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        private const val PREFS_NAME = "biza_tenant_sync_state"
        private const val KEY_ACTIVE_BUSINESS = "active_business_id"
        const val BASE_BACKOFF_MS: Long = 15_000L
        const val MAX_BACKOFF_MS: Long = 15 * 60 * 1_000L
        const val MAX_RETRY_ATTEMPTS: Int = 5

        private fun tenantKey(businessId: String): String = "tenant_sync:$businessId"

        /**
         * Bounded exponential backoff (15s, 30s, 60s, ..., capped at 15 minutes).
         */
        fun calculateBackoffDelayMs(attempt: Int): Long {
            val safeAttempt = attempt.coerceIn(0, 10)
            val delay = BASE_BACKOFF_MS * (1L shl safeAttempt)
            return delay.coerceAtMost(MAX_BACKOFF_MS)
        }

        fun isNetworkAvailable(context: Context): Boolean {
            val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val active = cm.activeNetwork ?: return false
                val caps = cm.getNetworkCapabilities(active) ?: return false
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            } else {
                @Suppress("DEPRECATION")
                cm.activeNetworkInfo?.isConnected == true
            }
        }

        fun fromContext(
            context: Context,
            scheduler: NativeSyncScheduler? = null,
            onClearTenant: ((String) -> Unit)? = null,
            onClearAll: (() -> Unit)? = null,
        ): TenantSyncStateStore {
            val appContext = context.applicationContext
            val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val callerCache = CallerIdCache.fromContext(appContext)
            val effectiveScheduler = scheduler ?: WorkManagerSyncScheduler(appContext)
            return TenantSyncStateStore(
                store = object : CallerIdCache.KeyValueStore {
                    override fun getString(key: String): String? = prefs.getString(key, null)
                    override fun putString(key: String, value: String) {
                        prefs.edit().putString(key, value).apply()
                    }
                    override fun remove(key: String) {
                        prefs.edit().remove(key).apply()
                    }
                    override fun clearAll() {
                        prefs.edit().clear().apply()
                    }
                },
                scheduler = effectiveScheduler,
                onClearTenantCallback = onClearTenant ?: { bizId -> callerCache.clearTenant(bizId) },
                onClearAllCallback = onClearAll ?: { callerCache.clearAll() },
            )
        }

        private fun utcNowIso(): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.format(Date())
    }
}
