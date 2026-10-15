package com.bizamiz.android.sync

import com.bizamiz.android.callerid.CallerIdCache
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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

    @Test
    fun `calculates bounded exponential backoff delays`() {
        assertEquals(15_000L, TenantSyncStateStore.calculateBackoffDelayMs(0))
        assertEquals(30_000L, TenantSyncStateStore.calculateBackoffDelayMs(1))
        assertEquals(60_000L, TenantSyncStateStore.calculateBackoffDelayMs(2))
        assertEquals(TenantSyncStateStore.MAX_BACKOFF_MS, TenantSyncStateStore.calculateBackoffDelayMs(20))
    }

    @Test
    fun `schedules work without fabricating lastSyncedAt and stamps lastSyncedAt only on sync completion`() {
        val scheduler = FakeSyncScheduler()
        val syncStore = TenantSyncStateStore(
            store = InMemoryStore(),
            scheduler = scheduler,
        )

        val enqueued = syncStore.recordSyncRequest(
            businessId = "biz-1",
            action = "enqueue",
            pendingCount = 3,
            nowIso = "2026-10-15T10:00:00.000Z",
        )
        assertTrue(enqueued.getBoolean("scheduled"))
        assertEquals(1, scheduler.scheduledCalls.size)
        assertEquals(Triple("biz-1", false, 0), scheduler.scheduledCalls[0])

        // Before execution completes, lastSyncedAt MUST remain null (not fabricated on enqueue).
        val statusBeforeRun = syncStore.readStatus("biz-1", networkAvailable = true)
        assertTrue(statusBeforeRun.getBoolean("scheduled"))
        assertEquals(3, statusBeforeRun.getInt("pendingCount"))
        assertTrue(statusBeforeRun.isNull("lastSyncedAt"))

        // Execute a real sync pass that succeeds.
        val decision = syncStore.executeSyncPass(
            businessId = "biz-1",
            completedAtIso = "2026-10-15T10:02:30.000Z",
            executor = object : TenantSyncStateStore.SyncPassExecutor {
                override fun probeAndReconcile(businessId: String?): TenantSyncStateStore.SyncPassOutcome {
                    return TenantSyncStateStore.SyncPassOutcome.Success(flushedCount = 3, remainingCount = 0)
                }
            },
        )
        assertTrue(decision is TenantSyncStateStore.SyncExecutionDecision.Completed)
        val completed = decision as TenantSyncStateStore.SyncExecutionDecision.Completed
        assertEquals("biz-1", completed.eventPayload.getString("businessId"))
        assertEquals("2026-10-15T10:02:30.000Z", completed.eventPayload.getString("syncedAt"))
        assertFalse(completed.eventPayload.getBoolean("revoked"))
        assertEquals(3, completed.eventPayload.getInt("flushedCount"))

        val statusAfterRun = syncStore.readStatus("biz-1", networkAvailable = true)
        assertFalse(statusAfterRun.getBoolean("scheduled"))
        assertEquals(0, statusAfterRun.getInt("pendingCount"))
        assertEquals("2026-10-15T10:02:30.000Z", statusAfterRun.getString("lastSyncedAt"))
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
        assertTrue(enqueued.getBoolean("scheduled"))

        val status1 = syncStore.readStatus("biz-1", networkAvailable = true)
        assertTrue(status1.getBoolean("scheduled"))
        assertEquals(3, status1.getInt("pendingCount"))
        assertFalse(status1.getBoolean("revoked"))

        // Another tenant has independent status.
        val status2 = syncStore.readStatus("biz-2", networkAvailable = true)
        assertFalse(status2.getBoolean("scheduled"))
        assertEquals(0, status2.getInt("pendingCount"))

        // Revoking biz-1 cancels scheduled work and prevents further background sync scheduling for biz-1.
        syncStore.markTenantRevoked("biz-1")
        assertTrue(syncStore.isTenantRevoked("biz-1"))
        assertTrue(scheduler.cancelledTenants.contains("biz-1"))
        val blocked = syncStore.recordSyncRequest("biz-1", "enqueue", pendingCount = 5)
        assertFalse(blocked.getBoolean("scheduled"))
        assertTrue(clearedTenants.contains("biz-1"))

        // Sign-out clear_all cancels all work, wipes all state, and invokes the clearAll callback.
        val clearAllRes = syncStore.recordSyncRequest(null, "clear_all")
        assertFalse(clearAllRes.getBoolean("scheduled"))
        assertEquals(1, scheduler.cancelledAllCount)
        assertTrue(clearedAll)
    }
}
