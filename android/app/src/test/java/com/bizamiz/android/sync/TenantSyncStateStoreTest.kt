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

    @Test
    fun `calculates bounded exponential backoff delays`() {
        assertEquals(15_000L, TenantSyncStateStore.calculateBackoffDelayMs(0))
        assertEquals(30_000L, TenantSyncStateStore.calculateBackoffDelayMs(1))
        assertEquals(60_000L, TenantSyncStateStore.calculateBackoffDelayMs(2))
        assertEquals(TenantSyncStateStore.MAX_BACKOFF_MS, TenantSyncStateStore.calculateBackoffDelayMs(20))
    }

    @Test
    fun `isolates sync state per tenant, blocks revoked tenants, and clears on sign-out`() {
        val clearedTenants = mutableListOf<String>()
        var clearedAll = false
        val syncStore = TenantSyncStateStore(
            store = InMemoryStore(),
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

        // Revoking biz-1 prevents further background sync scheduling for biz-1.
        syncStore.markTenantRevoked("biz-1")
        assertTrue(syncStore.isTenantRevoked("biz-1"))
        val blocked = syncStore.recordSyncRequest("biz-1", "enqueue", pendingCount = 5)
        assertFalse(blocked.getBoolean("scheduled"))
        assertTrue(clearedTenants.contains("biz-1"))

        // Sign-out clear_all wipes all state and invokes the clearAll callback.
        val clearAllRes = syncStore.recordSyncRequest(null, "clear_all")
        assertFalse(clearAllRes.getBoolean("scheduled"))
        assertTrue(clearedAll)
    }
}
