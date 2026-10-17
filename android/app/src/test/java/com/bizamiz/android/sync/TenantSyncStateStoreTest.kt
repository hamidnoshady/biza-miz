package com.bizamiz.android.sync

import com.bizamiz.android.callerid.CallerIdCache
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL

class TenantSyncStateStoreTest {

    private class InMemoryStore : CallerIdCache.KeyValueStore {
        private val map = HashMap<String, String>()
        override fun getString(key: String): String? = map[key]
        override fun putString(key: String, value: String) {
            map[key] = value
        }
        override fun remove(key: String) {
            map.remove(key)
        }
        override fun clearAll() {
            map.clear()
        }
    }

    private class FakeSyncScheduler : NativeSyncScheduler {
        val scheduledCalls = mutableListOf<Triple<String?, Boolean, Int>>()
        val cancelledTenants = mutableListOf<String>()
        var cancelledAllCount = 0

        override fun scheduleSync(businessId: String?, expedited: Boolean, attempt: Int): Boolean {
            scheduledCalls.add(Triple(businessId, expedited, attempt))
            return true
        }

        override fun cancelTenantSync(businessId: String) {
            cancelledTenants.add(businessId)
        }

        override fun cancelAllSync() {
            cancelledAllCount += 1
        }
    }

    private class FakeHttpURLConnection(
        url: URL,
        private val status: Int,
    ) : HttpURLConnection(url) {
        override fun disconnect() {}
        override fun usingProxy(): Boolean = false
        override fun connect() {}
        override fun getResponseCode(): Int = status
    }

    @Test
    fun `calculates bounded exponential backoff delays`() {
        assertEquals(15_000L, TenantSyncStateStore.calculateBackoffDelayMs(0))
        assertEquals(30_000L, TenantSyncStateStore.calculateBackoffDelayMs(1))
        assertEquals(60_000L, TenantSyncStateStore.calculateBackoffDelayMs(2))
        assertEquals(TenantSyncStateStore.MAX_BACKOFF_MS, TenantSyncStateStore.calculateBackoffDelayMs(20))
    }

    @Test
    fun `api health 200 and closed web runtime never mark business sync complete until web queue acknowledges`() {
        val backingStore = InMemoryStore()
        val scheduler = FakeSyncScheduler()
        val syncStore = TenantSyncStateStore(
            store = backingStore,
            scheduler = scheduler,
        )

        val enqueued = syncStore.recordSyncRequest(
            businessId = "biz-1",
            action = "enqueue",
            pendingCount = 3,
            nowIso = "2026-10-16T08:00:00.000Z",
            installationId = "inst-alpha-1234567890",
            sessionGeneration = 4,
        )
        assertTrue(enqueued.getBoolean("scheduled"))
        assertEquals("scheduled", enqueued.getString("state"))
        val initialReqId = enqueued.getString("syncRequestId")
        assertTrue(initialReqId.isNotBlank())

        // Simulate BizaSyncWorker probing /api/health -> HTTP 200 while browser is closed.
        val healthOutcome = BizaSyncWorker.probeOriginHealth(
            webOrigin = "https://app.eshobe.com",
            webRuntimeConnected = false,
            connectionFactory = { url -> FakeHttpURLConnection(url, 200) },
        )
        assertTrue(healthOutcome is TenantSyncStateStore.SyncPassOutcome.OriginReachable)

        val decision = syncStore.executeSyncPass(
            businessId = "biz-1",
            completedAtIso = "2026-10-16T08:01:00.000Z",
            executor = object : TenantSyncStateStore.SyncPassExecutor {
                override fun probeAndReconcile(businessId: String?): TenantSyncStateStore.SyncPassOutcome {
                    return healthOutcome
                }
            },
        )
        assertTrue(decision is TenantSyncStateStore.SyncExecutionDecision.WaitingForApp)
        val waiting = decision as TenantSyncStateStore.SyncExecutionDecision.WaitingForApp
        assertFalse(waiting.webRuntimeConnected)
        assertEquals(initialReqId, waiting.syncRequestId)
        assertEquals("biz-1", waiting.reconcileEventPayload.getString("businessId"))
        assertEquals(3, waiting.reconcileEventPayload.getInt("pendingCount"))

        // Pending count and lastSyncedAt MUST remain untouched; status explicitly reports waiting_for_app.
        val statusWhileClosed = syncStore.readStatus("biz-1", networkAvailable = true)
        assertTrue(statusWhileClosed.getBoolean("scheduled"))
        assertEquals("waiting_for_app", statusWhileClosed.getString("state"))
        assertTrue(statusWhileClosed.getBoolean("waitingForApp"))
        assertEquals(3, statusWhileClosed.getInt("pendingCount"))
        assertTrue(statusWhileClosed.isNull("lastSyncedAt"))
        assertEquals(initialReqId, statusWhileClosed.getString("pendingSyncRequestId"))

        // Simulate process restart: a fresh TenantSyncStateStore over the same durable KeyValueStore
        // preserves waiting_for_app, pendingCount, and reconstructs the reconcile event when the app opens.
        val restartedStore = TenantSyncStateStore(
            store = backingStore,
            scheduler = scheduler,
        )
        val statusAfterRestart = restartedStore.readStatus("biz-1", networkAvailable = true)
        assertEquals("waiting_for_app", statusAfterRestart.getString("state"))
        assertTrue(statusAfterRestart.getBoolean("waitingForApp"))
        assertEquals(3, statusAfterRestart.getInt("pendingCount"))
        assertTrue(statusAfterRestart.isNull("lastSyncedAt"))

        val replayedReconcile = restartedStore.buildPendingReconcileEventIfWaiting("biz-1")
        assertNotNull(replayedReconcile)
        assertEquals(initialReqId, replayedReconcile!!.getString("syncRequestId"))
        assertEquals(3, replayedReconcile.getInt("pendingCount"))

        // Now the web runtime flushes IndexedDB to /api/sync/events and acknowledges all 3 items.
        val ack = restartedStore.acknowledgeSyncCompletion(
            businessId = "biz-1",
            syncRequestId = initialReqId,
            flushedCount = 3,
            remainingCount = 0,
            installationId = "inst-alpha-1234567890",
            sessionGeneration = 4,
            completedAtIso = "2026-10-16T08:02:30.000Z",
        )
        assertTrue(ack.getBoolean("accepted"))
        assertEquals("acknowledged", ack.getString("reason"))
        assertEquals(3, ack.getInt("flushedCount"))
        assertEquals(0, ack.getInt("remainingCount"))
        assertEquals("2026-10-16T08:02:30.000Z", ack.getString("lastSyncedAt"))
        assertEquals("idle", ack.getString("state"))

        val statusAfterAck = restartedStore.readStatus("biz-1", networkAvailable = true)
        assertFalse(statusAfterAck.getBoolean("scheduled"))
        assertFalse(statusAfterAck.getBoolean("waitingForApp"))
        assertEquals("idle", statusAfterAck.getString("state"))
        assertEquals(0, statusAfterAck.getInt("pendingCount"))
        assertEquals("2026-10-16T08:02:30.000Z", statusAfterAck.getString("lastSyncedAt"))
        assertNull(restartedStore.buildPendingReconcileEventIfWaiting("biz-1"))
    }

    @Test
    fun `partial failure preserves remaining work and zero-flush failure never advances lastSyncedAt`() {
        val scheduler = FakeSyncScheduler()
        val syncStore = TenantSyncStateStore(
            store = InMemoryStore(),
            scheduler = scheduler,
        )

        val enqueued = syncStore.recordSyncRequest(
            businessId = "biz-partial",
            action = "enqueue",
            pendingCount = 3,
            nowIso = "2026-10-16T09:00:00.000Z",
            installationId = "inst-partial-12345678",
            sessionGeneration = 1,
        )
        val req1 = enqueued.getString("syncRequestId")

        // First acknowledgement: 0 flushed, 3 failed -> lastSyncedAt must remain null, pendingCount stays 3.
        val zeroFlushAck = syncStore.acknowledgeSyncCompletion(
            businessId = "biz-partial",
            syncRequestId = req1,
            flushedCount = 0,
            remainingCount = 3,
            failedCount = 3,
            installationId = "inst-partial-12345678",
            sessionGeneration = 1,
            completedAtIso = "2026-10-16T09:01:00.000Z",
        )
        assertTrue(zeroFlushAck.getBoolean("accepted"))
        assertEquals("partial_remaining", zeroFlushAck.getString("reason"))
        assertTrue(zeroFlushAck.isNull("lastSyncedAt"))
        assertEquals(3, zeroFlushAck.getInt("remainingCount"))
        assertEquals("failed", zeroFlushAck.getString("state"))

        val statusAfterZeroFlush = syncStore.readStatus("biz-partial")
        assertTrue(statusAfterZeroFlush.isNull("lastSyncedAt"))
        assertEquals(3, statusAfterZeroFlush.getInt("pendingCount"))

        // Second acknowledgement on rotated request ID: 2 flushed, 1 remaining -> stamps lastSyncedAt, keeps pendingCount = 1.
        val req2 = statusAfterZeroFlush.getString("pendingSyncRequestId")
        val partialAck = syncStore.acknowledgeSyncCompletion(
            businessId = "biz-partial",
            syncRequestId = req2,
            flushedCount = 2,
            remainingCount = 1,
            failedCount = 1,
            installationId = "inst-partial-12345678",
            sessionGeneration = 1,
            completedAtIso = "2026-10-16T09:05:00.000Z",
        )
        assertTrue(partialAck.getBoolean("accepted"))
        assertEquals("partial_remaining", partialAck.getString("reason"))
        assertEquals(2, partialAck.getInt("flushedCount"))
        assertEquals(1, partialAck.getInt("remainingCount"))
        assertEquals("2026-10-16T09:05:00.000Z", partialAck.getString("lastSyncedAt"))

        val statusAfterPartial = syncStore.readStatus("biz-partial")
        assertTrue(statusAfterPartial.getBoolean("scheduled"))
        assertEquals("scheduled", statusAfterPartial.getString("state"))
        assertEquals(1, statusAfterPartial.getInt("pendingCount"))
        assertEquals("2026-10-16T09:05:00.000Z", statusAfterPartial.getString("lastSyncedAt"))
    }

    @Test
    fun `rejects duplicate, stale, cross-tenant, mismatched-installation, and stale-session-generation acknowledgements`() {
        val syncStore = TenantSyncStateStore(
            store = InMemoryStore(),
            scheduler = FakeSyncScheduler(),
        )

        val enqueued = syncStore.recordSyncRequest(
            businessId = "biz-1",
            action = "enqueue",
            pendingCount = 2,
            nowIso = "2026-10-16T10:00:00.000Z",
            installationId = "inst-valid-1234567890",
            sessionGeneration = 7,
        )
        val reqId = enqueued.getString("syncRequestId")

        // 1. Cross-tenant acknowledgement is rejected.
        val wrongTenant = syncStore.acknowledgeSyncCompletion(
            businessId = "biz-other",
            syncRequestId = reqId,
            flushedCount = 2,
            remainingCount = 0,
            installationId = "inst-valid-1234567890",
            sessionGeneration = 7,
        )
        assertFalse(wrongTenant.getBoolean("accepted"))
        assertEquals("tenant_mismatch", wrongTenant.getString("reason"))

        // 2. Mismatched installationId is rejected.
        val wrongInstall = syncStore.acknowledgeSyncCompletion(
            businessId = "biz-1",
            syncRequestId = reqId,
            flushedCount = 2,
            remainingCount = 0,
            installationId = "inst-attacker-999999",
            sessionGeneration = 7,
        )
        assertFalse(wrongInstall.getBoolean("accepted"))
        assertEquals("installation_mismatch", wrongInstall.getString("reason"))

        // 3. Stale sessionGeneration is rejected.
        val staleGen = syncStore.acknowledgeSyncCompletion(
            businessId = "biz-1",
            syncRequestId = reqId,
            flushedCount = 2,
            remainingCount = 0,
            installationId = "inst-valid-1234567890",
            sessionGeneration = 6,
        )
        assertFalse(staleGen.getBoolean("accepted"))
        assertEquals("session_generation_mismatch", staleGen.getString("reason"))

        // 4. Stale / unknown syncRequestId is rejected.
        val staleReq = syncStore.acknowledgeSyncCompletion(
            businessId = "biz-1",
            syncRequestId = "syncreq_biz1_stale0000",
            flushedCount = 2,
            remainingCount = 0,
            installationId = "inst-valid-1234567890",
            sessionGeneration = 7,
        )
        assertFalse(staleReq.getBoolean("accepted"))
        assertEquals("duplicate_or_stale", staleReq.getString("reason"))

        // State of biz-1 is still untouched (pendingCount = 2, lastSyncedAt = null).
        val statusBeforeValidAck = syncStore.readStatus("biz-1")
        assertEquals(2, statusBeforeValidAck.getInt("pendingCount"))
        assertTrue(statusBeforeValidAck.isNull("lastSyncedAt"))

        // 5. Valid acknowledgement succeeds.
        val validAck = syncStore.acknowledgeSyncCompletion(
            businessId = "biz-1",
            syncRequestId = reqId,
            flushedCount = 2,
            remainingCount = 0,
            installationId = "inst-valid-1234567890",
            sessionGeneration = 7,
            completedAtIso = "2026-10-16T10:03:00.000Z",
        )
        assertTrue(validAck.getBoolean("accepted"))
        assertEquals("acknowledged", validAck.getString("reason"))

        // 6. Replaying the exact same syncRequestId is rejected as duplicate_or_stale.
        val duplicateAck = syncStore.acknowledgeSyncCompletion(
            businessId = "biz-1",
            syncRequestId = reqId,
            flushedCount = 2,
            remainingCount = 0,
            installationId = "inst-valid-1234567890",
            sessionGeneration = 7,
            completedAtIso = "2026-10-16T10:09:00.000Z",
        )
        assertFalse(duplicateAck.getBoolean("accepted"))
        assertEquals("duplicate_or_stale", duplicateAck.getString("reason"))
        assertEquals("2026-10-16T10:03:00.000Z", syncStore.readStatus("biz-1").getString("lastSyncedAt"))
    }

    @Test
    fun `enforces bounded retries on transient failure and cancels work on exhaustion`() {
        val scheduler = FakeSyncScheduler()
        val syncStore = TenantSyncStateStore(
            store = InMemoryStore(),
            scheduler = scheduler,
        )
        syncStore.recordSyncRequest(businessId = "biz-retry", action = "enqueue", pendingCount = 2)

        val failingExecutor = object : TenantSyncStateStore.SyncPassExecutor {
            override fun probeAndReconcile(businessId: String?): TenantSyncStateStore.SyncPassOutcome {
                return TenantSyncStateStore.SyncPassOutcome.TransientFailure("http_503")
            }
        }

        // Attempts 1..4 return Retry with exponential backoff.
        val r1 = syncStore.executeSyncPass("biz-retry", failingExecutor) as TenantSyncStateStore.SyncExecutionDecision.Retry
        assertEquals(1, r1.attempt)
        assertEquals(15_000L, r1.backoffDelayMs)

        val r2 = syncStore.executeSyncPass("biz-retry", failingExecutor) as TenantSyncStateStore.SyncExecutionDecision.Retry
        assertEquals(2, r2.attempt)
        assertEquals(30_000L, r2.backoffDelayMs)

        syncStore.executeSyncPass("biz-retry", failingExecutor)
        syncStore.executeSyncPass("biz-retry", failingExecutor)

        // Attempt 5 reaches MAX_RETRY_ATTEMPTS = 5 and exhausts retries.
        val r5 = syncStore.executeSyncPass("biz-retry", failingExecutor)
        assertTrue(r5 is TenantSyncStateStore.SyncExecutionDecision.ExhaustedRetries)
        assertTrue(scheduler.cancelledTenants.contains("biz-retry"))
        assertFalse(syncStore.readStatus("biz-retry").getBoolean("scheduled"))
        assertEquals("failed", syncStore.readStatus("biz-retry").getString("state"))
    }

    @Test
    fun `isolates sync state per tenant, blocks revoked tenants, and clears on sign-out`() {
        val clearedTenants = mutableListOf<String>()
        var clearedAll = false
        val scheduler = FakeSyncScheduler()
        val syncStore = TenantSyncStateStore(
            store = InMemoryStore(),
            scheduler = scheduler,
            onClearTenantCallback = { clearedTenants.add(it) },
            onClearAllCallback = { clearedAll = true },
        )

        val enqueued = syncStore.recordSyncRequest(
            businessId = "biz-1",
            action = "enqueue",
            pendingCount = 3,
            nowIso = "2026-10-15T10:00:00Z",
        )
        val reqId = enqueued.getString("syncRequestId")
        assertTrue(enqueued.getBoolean("scheduled"))

        val status1 = syncStore.readStatus("biz-1", networkAvailable = true)
        assertTrue(status1.getBoolean("scheduled"))
        assertEquals(3, status1.getInt("pendingCount"))
        assertFalse(status1.getBoolean("revoked"))

        // Another tenant has independent status.
        val status2 = syncStore.readStatus("biz-2", networkAvailable = true)
        assertFalse(status2.getBoolean("scheduled"))
        assertEquals(0, status2.getInt("pendingCount"))

        // Revoking biz-1 cancels scheduled work and blocks both new triggers and late acknowledgements.
        syncStore.markTenantRevoked("biz-1")
        assertTrue(syncStore.isTenantRevoked("biz-1"))
        assertTrue(scheduler.cancelledTenants.contains("biz-1"))
        val blocked = syncStore.recordSyncRequest("biz-1", "enqueue", pendingCount = 5)
        assertFalse(blocked.getBoolean("scheduled"))
        assertEquals("revoked", blocked.getString("state"))
        assertTrue(clearedTenants.contains("biz-1"))

        val lateAckAfterRevoke = syncStore.acknowledgeSyncCompletion(
            businessId = "biz-1",
            syncRequestId = reqId,
            flushedCount = 3,
            remainingCount = 0,
        )
        assertFalse(lateAckAfterRevoke.getBoolean("accepted"))
        assertEquals("revoked", lateAckAfterRevoke.getString("reason"))

        // Sign-out clear_all cancels all work, wipes all state, and invokes the clearAll callback.
        val clearAllRes = syncStore.recordSyncRequest(null, "clear_all")
        assertFalse(clearAllRes.getBoolean("scheduled"))
        assertEquals(1, scheduler.cancelledAllCount)
        assertTrue(clearedAll)
    }
}
