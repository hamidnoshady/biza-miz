package com.bizamiz.android.callerid

import com.bizamiz.android.security.EncryptedKeyValueStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallerIdCacheTest {

    private class InspectableBackingStore : EncryptedKeyValueStore.BackingStore {
        val rawMap = HashMap<String, String>()
        override fun getRaw(key: String): String? = rawMap[key]
        override fun putRaw(key: String, ciphertextPayload: String) {
            rawMap[key] = ciphertextPayload
        }
        override fun removeRaw(key: String) {
            rawMap.remove(key)
        }
        override fun clearRaw() {
            rawMap.clear()
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
    fun `encrypts caller ID cache at rest with AES-256-GCM and binds AAD per key`() {
        val backing = InspectableBackingStore()
        val keyProvider = EncryptedKeyValueStore.JvmSecretKeyProvider()
        val encryptedStore = EncryptedKeyValueStore(backing, keyProvider)
        val cache = CallerIdCache(encryptedStore)

        val countA = cache.syncTenantEntries(
            businessId = "biz-alpha",
            entries = listOf(
                CallerIdCache.CallerEntry(
                    customerId = "11111111-2222-4333-8444-555555555555",
                    displayName = "رضا محمدی",
                    phoneNormalized = "0912 111 2233",
                    organizationName = "کافه بهار",
                    tags = listOf("VIP", "وفادار"),
                ),
            ),
            syncedAtIso = "2026-10-15T10:00:00Z",
        )
        assertEquals(1, countA)

        // Verify that raw storage contains only encrypted v1:<iv>:<ciphertext> payloads and zero plaintext PII.
        val rawTenantPayload = backing.rawMap[CallerIdCache.tenantKey("biz-alpha")]
        assertNotNull(rawTenantPayload)
        assertTrue(rawTenantPayload!!.startsWith("v1:"))
        assertFalse(rawTenantPayload.contains("رضا محمدی"))
        assertFalse(rawTenantPayload.contains("9121112233"))
        assertFalse(rawTenantPayload.contains("کافه بهار"))

        // Verify round-trip decryption works for biz-alpha.
        val foundAlpha = cache.lookup("۰۹۱۲۱۱۱۲۲۳۳", "biz-alpha")
        assertNotNull(foundAlpha)
        assertEquals("رضا محمدی", foundAlpha!!.displayName)
        assertEquals("کافه بهار", foundAlpha.organizationName)

        // Verify per-key AAD prevents substituting biz-alpha's ciphertext into biz-beta's slot.
        backing.putRaw(CallerIdCache.tenantKey("biz-beta"), rawTenantPayload)
        assertNull(cache.lookup("09121112233", "biz-beta"))
        // Corrupted/substituted entry is evicted automatically on failed GCM authentication.
        assertNull(backing.getRaw(CallerIdCache.tenantKey("biz-beta")))

        // Cryptographic erasure: rotating/deleting the key makes any residual ciphertext undecryptable.
        val savedCiphertext = rawTenantPayload
        keyProvider.rotateOrDeleteKey()
        backing.putRaw(CallerIdCache.tenantKey("biz-alpha"), savedCiphertext)
        assertNull(cache.lookup("09121112233", "biz-alpha"))
    }

    @Test
    fun `isolates caller ID cache by tenant and clears on tenant switch, sign-out, permission loss, revocation, and process death`() {
        val backing = InspectableBackingStore()
        val keyProvider = EncryptedKeyValueStore.JvmSecretKeyProvider()
        val encryptedStore = EncryptedKeyValueStore(backing, keyProvider)
        val cache = CallerIdCache(encryptedStore)

        cache.syncTenantEntries(
            businessId = "biz-alpha",
            entries = listOf(
                CallerIdCache.CallerEntry(
                    customerId = "cust-a1",
                    displayName = "رضا محمدی",
                    phoneNormalized = "0912 111 2233",
                    organizationName = "کافه بهار",
                    tags = listOf("VIP"),
                ),
            ),
        )
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
        )

        assertNull(cache.lookup("09121112233", "biz-beta"))
        assertNotNull(cache.lookup("09121112233", "biz-alpha"))

        // Clearing biz-alpha removes only biz-alpha.
        cache.clearTenant("biz-alpha")
        assertNull(cache.lookup("09121112233", "biz-alpha"))
        assertNotNull(cache.lookup("09129998877", "biz-beta"))

        // Permission loss (`ROLE_CALL_SCREENING` revoked) immediately purges remaining cached callers.
        val statusAfterRoleLoss = cache.status(businessId = "biz-beta", roleHeld = false, supported = true)
        assertEquals(0, statusAfterRoleLoss.getInt("cachedCustomerCount"))
        assertNull(cache.lookup("09129998877", "biz-beta"))

        // Simulate process death mid-wipe: write entries + pending wipe marker, then construct a fresh CallerIdCache.
        cache.syncTenantEntries(
            businessId = "biz-gamma",
            entries = listOf(
                CallerIdCache.CallerEntry(
                    customerId = "cust-g1",
                    displayName = "نگار کریمی",
                    phoneNormalized = "09125556677",
                    organizationName = null,
                    tags = emptyList(),
                ),
            ),
        )
        encryptedStore.putString(CallerIdCache.KEY_PENDING_WIPE, CallerIdCache.WIPE_ALL_MARKER)

        val restartedCache = CallerIdCache(encryptedStore)
        assertNull(restartedCache.lookup("09125556677", "biz-gamma"))
        assertNull(restartedCache.getActiveBusinessId())
    }

    @Test
    fun `separates incoming call screening from post-call completion and emits schema-valid crm callEnded payload`() {
        val tracker = CallLifecycleTracker()
        val entry = CallerIdCache.CallerEntry(
            customerId = "11111111-2222-4333-8444-555555555555",
            displayName = "رضا محمدی",
            phoneNormalized = "+989121112233",
            organizationName = "کافه بهار",
            tags = listOf("VIP"),
        )

        // 1. Screening the call records the session and does NOT emit callEnded.
        val session = tracker.onCallScreened(
            entry = entry,
            businessId = "biz-alpha",
            direction = "incoming",
            screenedAtEpochMs = 1_700_000_000_000L,
        )
        assertEquals("biz-alpha", session.businessId)
        assertNull(session.connectedAtEpochMs)

        // 2. Answering the call (CALL_STATE_OFFHOOK) records connectedAtEpochMs.
        assertTrue(tracker.onCallOffHook(1_700_000_005_000L))

        // 3. Disconnecting the call (CALL_STATE_IDLE) computes the real 95s duration and emits the event payload.
        val completed = tracker.onCallDisconnected(
            endedAtEpochMs = 1_700_000_100_000L,
            endedAtIso = "2026-10-15T12:00:00.000Z",
        )
        assertNotNull(completed)
        val json = completed!!.toBridgeEventPayload()
        assertEquals("+989121112233", json.getString("phoneNormalized"))
        assertEquals("incoming", json.getString("direction"))
        assertEquals(95, json.getInt("durationSeconds"))
        assertEquals("11111111-2222-4333-8444-555555555555", json.getString("customerId"))
        assertEquals("رضا محمدی", json.getString("customerName"))
        assertEquals("2026-10-15T12:00:00.000Z", json.getString("endedAt"))
        assertFalse(json.has("displayName"))

        // Subsequent disconnect with no active call returns null.
        assertNull(tracker.onCallDisconnected(1_700_000_105_000L))
    }
}
