package com.bizamiz.android.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import com.bizamiz.android.bridge.BridgeProtocol
import com.bizamiz.android.callerid.CallerIdCache
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * Tenant-scoped operational sync state store, `WorkManager` scheduler coordinator,
 * and execution state machine for the Android TWA runtime (issue #884).
 *
 * Invariants:
 * - Never creates a second business database in Android; the web app's IndexedDB
 *   queue (`src/app/dashboard/offline-queue.tsx`) and `/api/sync/events` remain
 *   the single mutation pipeline.
 * - Separates connectivity probing (`/api/health` returning 200) from actual
 *   business-sync completion (`sync.acknowledge` after `/api/sync/events`).
 * - When `BizaSyncWorker` verifies origin reachability while `pendingCount > 0`,
 *   the tenant transitions to [STATE_WAITING_FOR_APP] (`waitingForApp = true`)
 *   with a durable `pendingSyncRequestId`, preserving `pendingCount` and
 *   `lastSyncedAt` untouched until the web runtime flushes IndexedDB and sends
 *   a verified `sync.acknowledge`.
 * - Enforces tenant, installation identity, session generation, request identity,
 *   and duplicate/stale acknowledgement checks before updating `pendingCount`
 *   or stamping `lastSyncedAt`.
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
        /**
         * Origin `/api/health` answered 2xx. Proves connectivity ONLY — never
         * proves that web IndexedDB mutations synchronized.
         */
        data class OriginReachable(val webRuntimeConnected: Boolean = false) : SyncPassOutcome()

        /**
         * Explicit completion with verified counts (used only when an executor
         * has already received a verified acknowledgement).
         */
        data class Success(val flushedCount: Int = 0, val remainingCount: Int = 0) : SyncPassOutcome()
        data class TransientFailure(val reason: String) : SyncPassOutcome()
        object Revoked : SyncPassOutcome()
    }

    sealed class SyncExecutionDecision {
        data class WaitingForApp(
            val syncRequestId: String,
            val reconcileEventPayload: JSONObject,
            val webRuntimeConnected: Boolean,
        ) : SyncExecutionDecision()
        data class NoPendingWork(val businessId: String?) : SyncExecutionDecision()
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
        installationId: String? = null,
        sessionGeneration: Int? = null,
        syncRequestId: String? = null,
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
                    .put("syncRequestId", JSONObject.NULL)
                    .put("state", STATE_IDLE)
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
                    .put("syncRequestId", JSONObject.NULL)
                    .put("state", STATE_IDLE)
            }
            "enqueue", "immediate" -> {
                if (cleanBiz != null && isTenantRevoked(cleanBiz)) {
                    scheduler?.cancelTenantSync(cleanBiz)
                    return JSONObject()
                        .put("scheduled", false)
                        .put("action", action)
                        .put("businessId", cleanBiz)
                        .put("clearedEntries", 0)
                        .put("syncRequestId", JSONObject.NULL)
                        .put("state", STATE_REVOKED)
                }

                val expedited = action == "immediate"
                val scheduledOk = scheduler?.scheduleSync(
                    businessId = cleanBiz,
                    expedited = expedited,
                    attempt = 0,
                ) ?: true

                var resolvedRequestId: String? = null
                val nextState = if (scheduledOk) STATE_SCHEDULED else STATE_IDLE

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

                    val existingGen = existing?.let {
                        if (it.isNull("sessionGeneration")) null else it.optInt("sessionGeneration", -1).takeIf { g -> g >= 0 }
                    }
                    val generationChanged = sessionGeneration != null && existingGen != null && sessionGeneration != existingGen
                    val effectiveGen = sessionGeneration ?: existingGen
                    val effectiveInstallId = installationId?.trim()?.takeIf { it.isNotEmpty() }
                        ?: existing?.optString("installationId", "")?.takeIf { it.isNotEmpty() }

                    val existingReqId = if (generationChanged) {
                        null
                    } else {
                        existing?.optString("pendingSyncRequestId", "")?.takeIf { it.isNotEmpty() }
                    }
                    resolvedRequestId = syncRequestId?.trim()?.takeIf { it.isNotEmpty() }
                        ?: existingReqId
                        ?: generateSyncRequestId(cleanBiz)

                    val ackHistory = existing?.optJSONArray("acknowledgedRequestIds") ?: JSONArray()

                    val state = JSONObject()
                        .put("businessId", cleanBiz)
                        .put("scheduled", scheduledOk)
                        .put("state", nextState)
                        .put("waitingForApp", false)
                        .put("pendingCount", nextPending.coerceAtLeast(0))
                        .put("lastRequestedAt", nowIso)
                        .put("lastSyncedAt", previousLastSyncedAt ?: JSONObject.NULL)
                        .put("retryAttempt", existing?.optInt("retryAttempt", 0) ?: 0)
                        .put("revoked", false)
                        .put("pendingSyncRequestId", resolvedRequestId)
                        .put("installationId", effectiveInstallId ?: JSONObject.NULL)
                        .put("sessionGeneration", effectiveGen ?: JSONObject.NULL)
                        .put("acknowledgedRequestIds", ackHistory)
                    store.putString(tenantKey(cleanBiz), state.toString())
                    store.putString(KEY_ACTIVE_BUSINESS, cleanBiz)
                }

                JSONObject()
                    .put("scheduled", scheduledOk)
                    .put("action", action)
                    .put("businessId", cleanBiz ?: JSONObject.NULL)
                    .put("clearedEntries", 0)
                    .put("syncRequestId", resolvedRequestId ?: JSONObject.NULL)
                    .put("state", nextState)
            }
            else -> JSONObject()
                .put("scheduled", false)
                .put("action", "enqueue")
                .put("businessId", cleanBiz ?: JSONObject.NULL)
                .put("clearedEntries", 0)
                .put("syncRequestId", JSONObject.NULL)
                .put("state", STATE_IDLE)
        }
    }

    /**
     * Binds or updates the authoritative `installationId` and `sessionGeneration`
     * for [businessId] without fabricating sync completion. If [sessionGeneration]
     * advances past a previously recorded generation, any unacknowledged
     * `pendingSyncRequestId` from the older generation is rotated so stale
     * in-flight acknowledgements from the old session are rejected.
     */
    fun bindTenantSessionContext(
        businessId: String,
        installationId: String?,
        sessionGeneration: Int?,
    ) {
        val cleanBiz = businessId.trim()
        if (cleanBiz.isEmpty() || isTenantRevoked(cleanBiz)) return
        val existing = readRawTenantJson(cleanBiz) ?: JSONObject().put("businessId", cleanBiz)
        val existingGen = if (existing.isNull("sessionGeneration")) {
            null
        } else {
            existing.optInt("sessionGeneration", -1).takeIf { it >= 0 }
        }
        val cleanInstall = installationId?.trim()?.takeIf { it.isNotEmpty() }
            ?: existing.optString("installationId", "").takeIf { it.isNotEmpty() }
        val effectiveGen = sessionGeneration ?: existingGen

        if (sessionGeneration != null && existingGen != null && sessionGeneration != existingGen) {
            val currentPending = existing.optInt("pendingCount", 0)
            if (currentPending > 0) {
                existing.put("pendingSyncRequestId", generateSyncRequestId(cleanBiz))
            } else {
                existing.put("pendingSyncRequestId", JSONObject.NULL)
            }
        }
        existing.put("installationId", cleanInstall ?: JSONObject.NULL)
        existing.put("sessionGeneration", effectiveGen ?: JSONObject.NULL)
        store.putString(tenantKey(cleanBiz), existing.toString())
        store.putString(KEY_ACTIVE_BUSINESS, cleanBiz)
    }

    /**
     * Validates and applies a typed `sync.acknowledge` report from the web
     * runtime after `flushQueue()` runs against IndexedDB `pendingActions` and
     * `POST /api/sync/events`.
     */
    fun acknowledgeSyncCompletion(
        businessId: String?,
        syncRequestId: String?,
        flushedCount: Int,
        remainingCount: Int,
        installationId: String? = null,
        sessionGeneration: Int? = null,
        failedCount: Int = 0,
        conflictCount: Int = 0,
        transientFailure: Boolean = false,
        revoked: Boolean = false,
        completedAtIso: String = utcNowIso(),
    ): JSONObject {
        val cleanBiz = businessId?.trim()?.takeIf { it.isNotEmpty() }
        val cleanReqId = syncRequestId?.trim()?.takeIf { it.isNotEmpty() && BridgeProtocol.isValidRequestId(it) }

        if (cleanBiz == null || cleanReqId == null || flushedCount < 0 || remainingCount < 0) {
            return buildAckRejection(
                reason = ACK_INVALID_REQUEST,
                businessId = cleanBiz,
                syncRequestId = cleanReqId,
            )
        }

        val activeBiz = store.getString(KEY_ACTIVE_BUSINESS)?.takeIf { it.isNotEmpty() }
        if (activeBiz != null && activeBiz != cleanBiz) {
            return buildAckRejection(
                reason = ACK_TENANT_MISMATCH,
                businessId = cleanBiz,
                syncRequestId = cleanReqId,
            )
        }

        val existing = readRawTenantJson(cleanBiz)
            ?: return buildAckRejection(
                reason = ACK_TENANT_MISMATCH,
                businessId = cleanBiz,
                syncRequestId = cleanReqId,
            )

        if (existing.optBoolean("revoked", false) || revoked) {
            if (revoked) {
                markTenantRevoked(cleanBiz)
            }
            return JSONObject()
                .put("accepted", false)
                .put("reason", ACK_REVOKED)
                .put("businessId", cleanBiz)
                .put("syncRequestId", cleanReqId)
                .put("flushedCount", 0)
                .put("remainingCount", 0)
                .put("lastSyncedAt", JSONObject.NULL)
                .put("state", STATE_REVOKED)
        }

        val storedInstallId = existing.optString("installationId", "").takeIf { it.isNotEmpty() }
        val cleanInstallId = installationId?.trim()?.takeIf { it.isNotEmpty() }
        if (storedInstallId != null && (cleanInstallId == null || cleanInstallId != storedInstallId)) {
            return buildAckRejection(
                reason = ACK_INSTALLATION_MISMATCH,
                businessId = cleanBiz,
                syncRequestId = cleanReqId,
                existing = existing,
            )
        }

        val storedGen = if (existing.isNull("sessionGeneration")) {
            null
        } else {
            existing.optInt("sessionGeneration", -1).takeIf { it >= 0 }
        }
        if (storedGen != null && (sessionGeneration == null || sessionGeneration != storedGen)) {
            return buildAckRejection(
                reason = ACK_SESSION_GENERATION_MISMATCH,
                businessId = cleanBiz,
                syncRequestId = cleanReqId,
                existing = existing,
            )
        }

        val ackHistory = existing.optJSONArray("acknowledgedRequestIds") ?: JSONArray()
        for (i in 0 until ackHistory.length()) {
            if (ackHistory.optString(i, "") == cleanReqId) {
                return buildAckRejection(
                    reason = ACK_DUPLICATE_OR_STALE,
                    businessId = cleanBiz,
                    syncRequestId = cleanReqId,
                    existing = existing,
                )
            }
        }

        val pendingReqId = existing.optString("pendingSyncRequestId", "").takeIf { it.isNotEmpty() }
        if (pendingReqId == null || pendingReqId != cleanReqId) {
            return buildAckRejection(
                reason = ACK_DUPLICATE_OR_STALE,
                businessId = cleanBiz,
                syncRequestId = cleanReqId,
                existing = existing,
            )
        }

        val previousLastSyncedAt = if (existing.isNull("lastSyncedAt")) {
            null
        } else {
            existing.optString("lastSyncedAt", "").takeIf { it.isNotEmpty() }
        }
        val effectiveInstall = cleanInstallId ?: storedInstallId
        val effectiveGen = sessionGeneration ?: storedGen

        if (transientFailure) {
            val preservedPending = maxOf(remainingCount, existing.optInt("pendingCount", 0)).coerceAtLeast(1)
            val nextAttempt = existing.optInt("retryAttempt", 0) + 1
            val nextReqId = generateSyncRequestId(cleanBiz)
            val exhausted = nextAttempt >= MAX_RETRY_ATTEMPTS
            val nextState = if (exhausted) STATE_FAILED else STATE_RETRYING
            val nextScheduled = if (exhausted) {
                scheduler?.cancelTenantSync(cleanBiz)
                false
            } else {
                scheduler?.scheduleSync(cleanBiz, expedited = false, attempt = nextAttempt) ?: true
            }
            val updated = JSONObject()
                .put("businessId", cleanBiz)
                .put("scheduled", nextScheduled)
                .put("state", nextState)
                .put("waitingForApp", false)
                .put("pendingCount", preservedPending)
                .put("lastSyncedAt", previousLastSyncedAt ?: JSONObject.NULL)
                .put("retryAttempt", nextAttempt)
                .put("lastFailureReason", "web_flush_transient_failure")
                .put("revoked", false)
                .put("pendingSyncRequestId", nextReqId)
                .put("installationId", effectiveInstall ?: JSONObject.NULL)
                .put("sessionGeneration", effectiveGen ?: JSONObject.NULL)
                .put("acknowledgedRequestIds", ackHistory)
            store.putString(tenantKey(cleanBiz), updated.toString())

            return JSONObject()
                .put("accepted", true)
                .put("reason", ACK_PARTIAL_REMAINING)
                .put("businessId", cleanBiz)
                .put("syncRequestId", cleanReqId)
                .put("flushedCount", 0)
                .put("remainingCount", preservedPending)
                .put("lastSyncedAt", previousLastSyncedAt ?: JSONObject.NULL)
                .put("state", nextState)
        }

        val updatedAckHistory = appendBoundedRequestId(ackHistory, cleanReqId)
        val safeRemaining = remainingCount.coerceAtLeast(0)
        // Stamp lastSyncedAt ONLY when actual writes were acknowledged (`flushedCount > 0`).
        val nextLastSyncedAt = if (flushedCount > 0) completedAtIso else previousLastSyncedAt

        val nextState: String
        val nextScheduled: Boolean
        if (safeRemaining == 0) {
            nextState = STATE_IDLE
            nextScheduled = false
            scheduler?.cancelTenantSync(cleanBiz)
        } else if (flushedCount == 0 && (failedCount > 0 || conflictCount > 0)) {
            nextState = STATE_FAILED
            nextScheduled = false
        } else {
            nextState = STATE_SCHEDULED
            nextScheduled = true
        }

        val updated = JSONObject()
            .put("businessId", cleanBiz)
            .put("scheduled", nextScheduled)
            .put("state", nextState)
            .put("waitingForApp", false)
            .put("pendingCount", safeRemaining)
            .put("lastSyncedAt", nextLastSyncedAt ?: JSONObject.NULL)
            .put("retryAttempt", 0)
            .put("revoked", false)
            .put("pendingSyncRequestId", if (safeRemaining > 0) generateSyncRequestId(cleanBiz) else JSONObject.NULL)
            .put("installationId", effectiveInstall ?: JSONObject.NULL)
            .put("sessionGeneration", effectiveGen ?: JSONObject.NULL)
            .put("acknowledgedRequestIds", updatedAckHistory)
        store.putString(tenantKey(cleanBiz), updated.toString())

        val ackReason = if (safeRemaining > 0) ACK_PARTIAL_REMAINING else ACK_ACKNOWLEDGED
        return JSONObject()
            .put("accepted", true)
            .put("reason", ackReason)
            .put("businessId", cleanBiz)
            .put("syncRequestId", cleanReqId)
            .put("flushedCount", flushedCount)
            .put("remainingCount", safeRemaining)
            .put("lastSyncedAt", nextLastSyncedAt ?: JSONObject.NULL)
            .put("state", nextState)
    }

    fun markSyncCompleted(
        businessId: String?,
        flushedCount: Int = 0,
        remainingCount: Int = 0,
        completedAtIso: String = utcNowIso(),
    ): JSONObject {
        val targetBiz = businessId?.trim()?.takeIf { it.isNotEmpty() }
            ?: store.getString(KEY_ACTIVE_BUSINESS)?.takeIf { it.isNotEmpty() }

        var nextLastSyncedAt: String? = completedAtIso
        var syncReqId: String? = null
        if (targetBiz != null) {
            val existing = readRawTenantJson(targetBiz)
            val previousLastSyncedAt = existing?.let {
                if (it.isNull("lastSyncedAt")) null else it.optString("lastSyncedAt", "").takeIf { s -> s.isNotEmpty() }
            }
            nextLastSyncedAt = if (flushedCount > 0 || remainingCount == 0) completedAtIso else previousLastSyncedAt
            syncReqId = existing?.optString("pendingSyncRequestId", "")?.takeIf { it.isNotEmpty() }
            val ackHistory = existing?.optJSONArray("acknowledgedRequestIds") ?: JSONArray()
            val updatedAckHistory = if (syncReqId != null) appendBoundedRequestId(ackHistory, syncReqId) else ackHistory
            val safeRemaining = remainingCount.coerceAtLeast(0)
            val stillScheduled = safeRemaining > 0
            val nextState = if (stillScheduled) STATE_SCHEDULED else STATE_IDLE
            val state = JSONObject()
                .put("businessId", targetBiz)
                .put("scheduled", stillScheduled)
                .put("state", nextState)
                .put("waitingForApp", false)
                .put("pendingCount", safeRemaining)
                .put("lastSyncedAt", nextLastSyncedAt ?: JSONObject.NULL)
                .put("retryAttempt", 0)
                .put("revoked", false)
                .put("pendingSyncRequestId", if (stillScheduled) generateSyncRequestId(targetBiz) else JSONObject.NULL)
                .put("installationId", existing?.opt("installationId") ?: JSONObject.NULL)
                .put("sessionGeneration", existing?.opt("sessionGeneration") ?: JSONObject.NULL)
                .put("acknowledgedRequestIds", updatedAckHistory)
            store.putString(tenantKey(targetBiz), state.toString())
        }

        return BridgeProtocol.buildSyncCompletedEventPayload(
            businessId = targetBiz,
            syncedAt = nextLastSyncedAt ?: completedAtIso,
            revoked = false,
            flushedCount = flushedCount,
            remainingCount = remainingCount,
            syncRequestId = syncReqId,
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
            is SyncPassOutcome.OriginReachable -> {
                if (targetBiz == null) {
                    return SyncExecutionDecision.NoPendingWork(null)
                }
                val existing = readRawTenantJson(targetBiz)
                val pendingBefore = existing?.optInt("pendingCount", 0) ?: 0
                val previousLastSyncedAt = existing?.let {
                    if (it.isNull("lastSyncedAt")) null else it.optString("lastSyncedAt", "").takeIf { s -> s.isNotEmpty() }
                }
                val installId = existing?.optString("installationId", "")?.takeIf { it.isNotEmpty() }
                val sessionGen = existing?.let {
                    if (it.isNull("sessionGeneration")) null else it.optInt("sessionGeneration", -1).takeIf { g -> g >= 0 }
                }
                val ackHistory = existing?.optJSONArray("acknowledgedRequestIds") ?: JSONArray()

                if (pendingBefore <= 0) {
                    val idleState = JSONObject()
                        .put("businessId", targetBiz)
                        .put("scheduled", false)
                        .put("state", STATE_IDLE)
                        .put("waitingForApp", false)
                        .put("pendingCount", 0)
                        .put("lastSyncedAt", previousLastSyncedAt ?: JSONObject.NULL)
                        .put("retryAttempt", 0)
                        .put("revoked", false)
                        .put("pendingSyncRequestId", JSONObject.NULL)
                        .put("installationId", installId ?: JSONObject.NULL)
                        .put("sessionGeneration", sessionGen ?: JSONObject.NULL)
                        .put("acknowledgedRequestIds", ackHistory)
                    store.putString(tenantKey(targetBiz), idleState.toString())
                    return SyncExecutionDecision.NoPendingWork(targetBiz)
                }

                // Origin is reachable, but queued mutations live in the web app's IndexedDB.
                // Never fabricate lastSyncedAt or zero pendingCount here; transition to
                // STATE_WAITING_FOR_APP and persist a durable syncRequestId until acknowledged.
                val syncRequestId = existing?.optString("pendingSyncRequestId", "")?.takeIf { it.isNotEmpty() }
                    ?: generateSyncRequestId(targetBiz)

                val waitingState = JSONObject()
                    .put("businessId", targetBiz)
                    .put("scheduled", true)
                    .put("state", STATE_WAITING_FOR_APP)
                    .put("waitingForApp", true)
                    .put("pendingCount", pendingBefore)
                    .put("lastSyncedAt", previousLastSyncedAt ?: JSONObject.NULL)
                    .put("lastReconcileRequestedAt", completedAtIso)
                    .put("retryAttempt", 0)
                    .put("revoked", false)
                    .put("pendingSyncRequestId", syncRequestId)
                    .put("installationId", installId ?: JSONObject.NULL)
                    .put("sessionGeneration", sessionGen ?: JSONObject.NULL)
                    .put("acknowledgedRequestIds", ackHistory)
                store.putString(tenantKey(targetBiz), waitingState.toString())

                val reconcilePayload = BridgeProtocol.buildSyncReconcileRequestedEventPayload(
                    businessId = targetBiz,
                    syncRequestId = syncRequestId,
                    pendingCount = pendingBefore,
                    requestedAt = completedAtIso,
                    installationId = installId,
                    sessionGeneration = sessionGen,
                )
                SyncExecutionDecision.WaitingForApp(
                    syncRequestId = syncRequestId,
                    reconcileEventPayload = reconcilePayload,
                    webRuntimeConnected = outcome.webRuntimeConnected,
                )
            }
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
                val previousLastSynced = existing?.let {
                    if (it.isNull("lastSyncedAt")) JSONObject.NULL else it.optString("lastSyncedAt")
                } ?: JSONObject.NULL
                val existingReqId = existing?.optString("pendingSyncRequestId", "")?.takeIf { it.isNotEmpty() }
                val ackHistory = existing?.optJSONArray("acknowledgedRequestIds") ?: JSONArray()

                if (nextAttempt >= MAX_RETRY_ATTEMPTS) {
                    if (targetBiz != null) {
                        scheduler?.cancelTenantSync(targetBiz)
                        val state = JSONObject()
                            .put("businessId", targetBiz)
                            .put("scheduled", false)
                            .put("state", STATE_FAILED)
                            .put("waitingForApp", false)
                            .put("pendingCount", existing?.optInt("pendingCount", 0) ?: 0)
                            .put("lastSyncedAt", previousLastSynced)
                            .put("retryAttempt", nextAttempt)
                            .put("lastFailureReason", outcome.reason)
                            .put("revoked", false)
                            .put("pendingSyncRequestId", existingReqId ?: JSONObject.NULL)
                            .put("installationId", existing?.opt("installationId") ?: JSONObject.NULL)
                            .put("sessionGeneration", existing?.opt("sessionGeneration") ?: JSONObject.NULL)
                            .put("acknowledgedRequestIds", ackHistory)
                        store.putString(tenantKey(targetBiz), state.toString())
                    }
                    SyncExecutionDecision.ExhaustedRetries(nextAttempt)
                } else {
                    val delayMs = calculateBackoffDelayMs(nextAttempt - 1)
                    if (targetBiz != null) {
                        val state = JSONObject()
                            .put("businessId", targetBiz)
                            .put("scheduled", true)
                            .put("state", STATE_RETRYING)
                            .put("waitingForApp", false)
                            .put("pendingCount", existing?.optInt("pendingCount", 0) ?: 0)
                            .put("lastSyncedAt", previousLastSynced)
                            .put("retryAttempt", nextAttempt)
                            .put("lastFailureReason", outcome.reason)
                            .put("revoked", false)
                            .put("pendingSyncRequestId", existingReqId ?: JSONObject.NULL)
                            .put("installationId", existing?.opt("installationId") ?: JSONObject.NULL)
                            .put("sessionGeneration", existing?.opt("sessionGeneration") ?: JSONObject.NULL)
                            .put("acknowledgedRequestIds", ackHistory)
                        store.putString(tenantKey(targetBiz), state.toString())
                    }
                    SyncExecutionDecision.Retry(attempt = nextAttempt, backoffDelayMs = delayMs)
                }
            }
        }
    }

    /**
     * Reconstructs the `sync.reconcileRequested` event payload if [businessId]
     * (or the active business) has durable pending work waiting for the web
     * runtime (`state == "waiting_for_app"`). Used when the TWA opens or
     * reconnects after browser closure or process death.
     */
    fun buildPendingReconcileEventIfWaiting(businessId: String? = null): JSONObject? {
        val targetBiz = businessId?.trim()?.takeIf { it.isNotEmpty() }
            ?: store.getString(KEY_ACTIVE_BUSINESS)?.takeIf { it.isNotEmpty() }
            ?: return null
        val existing = readRawTenantJson(targetBiz) ?: return null
        if (existing.optBoolean("revoked", false)) return null
        val pendingCount = existing.optInt("pendingCount", 0)
        val waiting = existing.optBoolean("waitingForApp", false) ||
            existing.optString("state", "") == STATE_WAITING_FOR_APP
        val syncReqId = existing.optString("pendingSyncRequestId", "").takeIf { it.isNotEmpty() }
            ?: return null
        if (!waiting || pendingCount <= 0) return null

        val installId = existing.optString("installationId", "").takeIf { it.isNotEmpty() }
        val sessionGen = if (existing.isNull("sessionGeneration")) {
            null
        } else {
            existing.optInt("sessionGeneration", -1).takeIf { it >= 0 }
        }
        val requestedAt = existing.optString("lastReconcileRequestedAt", "").takeIf { it.isNotEmpty() }
            ?: existing.optString("lastRequestedAt", "").takeIf { it.isNotEmpty() }
            ?: utcNowIso()

        return BridgeProtocol.buildSyncReconcileRequestedEventPayload(
            businessId = targetBiz,
            syncRequestId = syncReqId,
            pendingCount = pendingCount,
            requestedAt = requestedAt,
            installationId = installId,
            sessionGeneration = sessionGen,
        )
    }

    fun drainDurablePendingReconcileEvents(): List<Pair<String, JSONObject>> {
        val payload = buildPendingReconcileEventIfWaiting() ?: return emptyList()
        return listOf(BridgeProtocol.EVENT_SYNC_RECONCILE_REQUESTED to payload)
    }

    fun markTenantRevoked(businessId: String) {
        val clean = businessId.trim()
        if (clean.isEmpty()) return
        scheduler?.cancelTenantSync(clean)
        val state = JSONObject()
            .put("businessId", clean)
            .put("scheduled", false)
            .put("state", STATE_REVOKED)
            .put("waitingForApp", false)
            .put("pendingCount", 0)
            .put("lastSyncedAt", JSONObject.NULL)
            .put("retryAttempt", 0)
            .put("revoked", true)
            .put("pendingSyncRequestId", JSONObject.NULL)
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
                .put("state", STATE_IDLE)
                .put("waitingForApp", false)
                .put("networkAvailable", networkAvailable)
                .put("businessId", JSONObject.NULL)
                .put("pendingCount", 0)
                .put("lastSyncedAt", JSONObject.NULL)
                .put("pendingSyncRequestId", JSONObject.NULL)
                .put("installationId", JSONObject.NULL)
                .put("sessionGeneration", JSONObject.NULL)
                .put("revoked", false)
        }

        val obj = readRawTenantJson(targetBiz)
            ?: return JSONObject()
                .put("scheduled", false)
                .put("state", STATE_IDLE)
                .put("waitingForApp", false)
                .put("networkAvailable", networkAvailable)
                .put("businessId", targetBiz)
                .put("pendingCount", 0)
                .put("lastSyncedAt", JSONObject.NULL)
                .put("pendingSyncRequestId", JSONObject.NULL)
                .put("installationId", JSONObject.NULL)
                .put("sessionGeneration", JSONObject.NULL)
                .put("revoked", false)

        val lastSynced = if (obj.isNull("lastSyncedAt")) {
            JSONObject.NULL
        } else {
            obj.optString("lastSyncedAt", "").takeIf { it.isNotEmpty() } ?: JSONObject.NULL
        }
        val revoked = obj.optBoolean("revoked", false)
        val scheduled = obj.optBoolean("scheduled", false)
        val waitingForApp = obj.optBoolean("waitingForApp", false)
        val rawState = obj.optString("state", "").takeIf { it.isNotEmpty() }
            ?: when {
                revoked -> STATE_REVOKED
                waitingForApp -> STATE_WAITING_FOR_APP
                scheduled -> STATE_SCHEDULED
                else -> STATE_IDLE
            }
        val pendingReqId = if (obj.isNull("pendingSyncRequestId")) {
            JSONObject.NULL
        } else {
            obj.optString("pendingSyncRequestId", "").takeIf { it.isNotEmpty() } ?: JSONObject.NULL
        }
        val installId = if (obj.isNull("installationId")) {
            JSONObject.NULL
        } else {
            obj.optString("installationId", "").takeIf { it.isNotEmpty() } ?: JSONObject.NULL
        }
        val sessionGen = if (obj.isNull("sessionGeneration")) {
            JSONObject.NULL
        } else {
            obj.optInt("sessionGeneration", -1).takeIf { it >= 0 } ?: JSONObject.NULL
        }

        return JSONObject()
            .put("scheduled", scheduled)
            .put("state", rawState)
            .put("waitingForApp", waitingForApp || rawState == STATE_WAITING_FOR_APP)
            .put("networkAvailable", networkAvailable)
            .put("businessId", targetBiz)
            .put("pendingCount", obj.optInt("pendingCount", 0))
            .put("lastSyncedAt", lastSynced)
            .put("pendingSyncRequestId", pendingReqId)
            .put("installationId", installId)
            .put("sessionGeneration", sessionGen)
            .put("revoked", revoked)
    }

    fun status(businessId: String?, networkAvailable: Boolean = true): JSONObject =
        readStatus(businessId, networkAvailable)

    private fun buildAckRejection(
        reason: String,
        businessId: String?,
        syncRequestId: String?,
        existing: JSONObject? = null,
    ): JSONObject {
        val lastSynced = existing?.let {
            if (it.isNull("lastSyncedAt")) JSONObject.NULL else it.optString("lastSyncedAt", "").takeIf { s -> s.isNotEmpty() } ?: JSONObject.NULL
        } ?: JSONObject.NULL
        val state = existing?.optString("state", "")?.takeIf { it.isNotEmpty() } ?: STATE_IDLE
        val remaining = existing?.optInt("pendingCount", 0) ?: 0
        return JSONObject()
            .put("accepted", false)
            .put("reason", reason)
            .put("businessId", businessId ?: JSONObject.NULL)
            .put("syncRequestId", syncRequestId ?: JSONObject.NULL)
            .put("flushedCount", 0)
            .put("remainingCount", remaining)
            .put("lastSyncedAt", lastSynced)
            .put("state", state)
    }

    private fun appendBoundedRequestId(history: JSONArray, requestId: String): JSONArray {
        val list = mutableListOf<String>()
        for (i in 0 until history.length()) {
            val item = history.optString(i, "")
            if (item.isNotEmpty() && item != requestId) {
                list.add(item)
            }
        }
        list.add(requestId)
        val trimmed = if (list.size > MAX_ACK_HISTORY) list.takeLast(MAX_ACK_HISTORY) else list
        return JSONArray(trimmed)
    }

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
        private const val MAX_ACK_HISTORY = 16

        const val STATE_IDLE = "idle"
        const val STATE_SCHEDULED = "scheduled"
        const val STATE_WAITING_FOR_APP = "waiting_for_app"
        const val STATE_RETRYING = "retrying"
        const val STATE_FAILED = "failed"
        const val STATE_REVOKED = "revoked"

        const val ACK_ACKNOWLEDGED = "acknowledged"
        const val ACK_PARTIAL_REMAINING = "partial_remaining"
        const val ACK_REVOKED = "revoked"
        const val ACK_DUPLICATE_OR_STALE = "duplicate_or_stale"
        const val ACK_TENANT_MISMATCH = "tenant_mismatch"
        const val ACK_INSTALLATION_MISMATCH = "installation_mismatch"
        const val ACK_SESSION_GENERATION_MISMATCH = "session_generation_mismatch"
        const val ACK_INVALID_REQUEST = "invalid_request"

        const val BASE_BACKOFF_MS: Long = 15_000L
        const val MAX_BACKOFF_MS: Long = 15 * 60 * 1_000L
        const val MAX_RETRY_ATTEMPTS: Int = 5

        private fun tenantKey(businessId: String): String = "tenant_sync:$businessId"

        internal fun generateSyncRequestId(businessId: String?): String {
            val safeBiz = businessId?.replace(Regex("[^A-Za-z0-9_-]"), "")?.take(20)?.takeIf { it.isNotEmpty() } ?: "biz"
            val randomSuffix = UUID.randomUUID().toString().replace("-", "").take(16)
            return "syncreq_${safeBiz}_$randomSuffix"
        }

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
