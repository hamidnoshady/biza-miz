package com.bizamiz.android.callerid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class CallerIdCacheTest {

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
    fun `normalizes Iranian and international numbers across Persian digits and prefixes`() {
        assertEquals("+989123456789", CallerIdCache.normalizePhone("0912 345 6789"))
        assertEquals("+989123456789", CallerIdCache.normalizePhone("۰۹۱۲۳۴۵۶۷۸۹"))
        assertEquals("+989123456789", CallerIdCache.normalizePhone("+98-912-345-6789"))
        assertEquals("+989123456789", CallerIdCache.normalizePhone("00989123456789"))
        assertEquals("+989123456789", CallerIdCache.normalizePhone("9123456789"))
        assertEquals("+496912345678", CallerIdCache.normalizePhone("+49 69 12345678"))
        assertEquals("", CallerIdCache.normalizePhone("   "))
    }

    @Test
    fun `isolates caller ID cache by tenant and clears cleanly on tenant switch or sign-out`() {
        val cache = CallerIdCache(InMemoryStore())

        val countA = cache.syncTenantEntries(
            businessId = "biz-alpha",
            entries = listOf(
                CallerIdCache.CallerEntry(
                    customerId = "cust-a1",
                    displayName = "رضا محمدی",
                    phoneNormalized = "0912 111 2233",
                    organizationName = "کافه بهار",
                    tags = listOf("VIP", "وفادار"),
                ),
            ),
            syncedAtIso = "2026-10-15T10:00:00Z",
        )
        assertEquals(1, countA)

        cache.syncTenantEntries(
            businessId = "biz-beta",
            entries = listOf(
                CallerIdCache.CallerEntry(
                    customerId = "cust-b1",
                    displayName = "سارا احمدی",
                    phoneNormalized = "0912 999 8877",
                    organizationName = null,
                    tags = emptyList(),
                ),
            ),
            syncedAtIso = "2026-10-15T10:01:00Z",
        )

        // Active tenant is now biz-beta; looking up biz-alpha's customer in biz-beta returns null.
        assertNull(cache.lookup("09121112233", "biz-beta"))

        // Looking up in biz-alpha finds the customer even when typed with Persian digits.
        val foundAlpha = cache.lookup("۰۹۱۲۱۱۱۲۲۳۳", "biz-alpha")
        assertNotNull(foundAlpha)
        assertEquals("cust-a1", foundAlpha!!.customerId)
        assertEquals("رضا محمدی", foundAlpha.displayName)
        assertEquals("کافه بهار", foundAlpha.organizationName)

        // Clearing biz-alpha removes only biz-alpha.
        cache.clearTenant("biz-alpha")
        assertNull(cache.lookup("09121112233", "biz-alpha"))
        assertNotNull(cache.lookup("09129998877", "biz-beta"))

        // Clearing all removes everything.
        cache.clearAll()
        assertNull(cache.lookup("09129998877", "biz-beta"))
    }
}
