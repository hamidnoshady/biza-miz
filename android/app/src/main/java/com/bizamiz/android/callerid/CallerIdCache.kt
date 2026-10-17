package com.bizamiz.android.callerid

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import com.bizamiz.android.security.EncryptedKeyValueStore
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Tenant-isolated local caller lookup cache for CRM Caller ID (issue #884).
 *
 * Security & privacy invariants:
 * - At-rest storage uses `EncryptedKeyValueStore` (AES-256-GCM backed by
 *   AndroidKeyStore with per-key AAD binding), never plain `SharedPreferences`.
 * - Entries are partitioned by `businessId`; a lookup only searches the active
 *   tenant's cache and never leaks contacts across tenants.
 * - Clearing a tenant (`clearTenant`), signing out (`clearAll`), losing
 *   `ROLE_CALL_SCREENING` (`reconcileRoleState(false)`), or device revocation
 *   (`onDeviceRevoked()`) removes cached entries immediately.
 * - Crash-safe wipe recovery (`KEY_PENDING_WIPE`) guarantees that if process
 *   death interrupts a wipe, the next process start completes the purge before
 *   serving any lookup.
 * - Never records call audio or call content.
 */
class CallerIdCache(
    private val store: KeyValueStore,
) {
    interface KeyValueStore {
        fun getString(key: String): String?
        fun putString(key: String, value: String)
        fun remove(key: String)
        fun clearAll()
    }

    data class CallerEntry(
        val customerId: String,
        val displayName: String,
        val phoneNormalized: String,
        val organizationName: String?,
        val tags: List<String>,
    )

    init {
        recoverInterruptedWipe()
    }

    private fun recoverInterruptedWipe() {
        val pending = store.getString(KEY_PENDING_WIPE) ?: return
        when {
            pending == WIPE_ALL_MARKER -> {
                store.clearAll()
            }
            pending.startsWith(WIPE_TENANT_PREFIX) -> {
                val targetBiz = pending.removePrefix(WIPE_TENANT_PREFIX)
                if (targetBiz.isNotEmpty()) {
                    store.remove(tenantKey(targetBiz))
                    if (store.getString(KEY_ACTIVE_BUSINESS) == targetBiz) {
                        store.remove(KEY_ACTIVE_BUSINESS)
                    }
                }
                store.remove(KEY_PENDING_WIPE)
            }
            else -> store.remove(KEY_PENDING_WIPE)
        }
    }

    fun getActiveBusinessId(): String? {
        recoverInterruptedWipe()
        return store.getString(KEY_ACTIVE_BUSINESS)?.takeIf { it.isNotBlank() }
    }

    fun setActiveBusinessId(businessId: String?) {
        val next = businessId?.trim()?.takeIf { it.isNotEmpty() }
        if (next == null) {
            store.remove(KEY_ACTIVE_BUSINESS)
        } else {
            store.putString(KEY_ACTIVE_BUSINESS, next)
        }
    }

    fun syncTenantEntries(
        businessId: String,
        entries: List<CallerEntry>,
        syncedAtIso: String = utcNowIso(),
    ): Int {
        val cleanBusinessId = businessId.trim()
        require(cleanBusinessId.isNotEmpty() && cleanBusinessId.length <= 64) { "Invalid businessId" }

        val mapObj = JSONObject()
        var count = 0
        for (entry in entries.take(MAX_ENTRIES_PER_TENANT)) {
            val normalized = normalizePhone(entry.phoneNormalized)
            if (normalized.isEmpty() || entry.customerId.isBlank() || entry.displayName.isBlank()) continue
            val item = JSONObject()
                .put("customerId", entry.customerId.take(64))
                .put("displayName", entry.displayName.take(160))
                .put("phoneNormalized", normalized)
                .put("organizationName", entry.organizationName?.take(160) ?: JSONObject.NULL)
                .put("tags", JSONArray(entry.tags.take(8).map { it.take(64) }))
            mapObj.put(normalized, item)
            count += 1
        }

        val wrapper = JSONObject()
            .put("businessId", cleanBusinessId)
            .put("syncedAt", syncedAtIso)
            .put("count", count)
            .put("entries", mapObj)

        store.putString(tenantKey(cleanBusinessId), wrapper.toString())
        store.putString(KEY_ACTIVE_BUSINESS, cleanBusinessId)
        store.putString(KEY_ROLE_LAST_HELD, "true")
        return count
    }

    fun lookup(rawPhone: String, businessId: String? = getActiveBusinessId()): CallerEntry? {
        recoverInterruptedWipe()
        val targetBusinessId = businessId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val normalized = normalizePhone(rawPhone)
        if (normalized.isEmpty()) return null

        val rawJson = store.getString(tenantKey(targetBusinessId)) ?: return null
        val wrapper = try {
            JSONObject(rawJson)
        } catch (_: Exception) {
            return null
        }
        val entriesObj = wrapper.optJSONObject("entries") ?: return null
        val item = entriesObj.optJSONObject(normalized) ?: return null
        val tagsArr = item.optJSONArray("tags")
        val tags = mutableListOf<String>()
        if (tagsArr != null) {
            for (i in 0 until tagsArr.length()) {
                val t = tagsArr.optString(i, "")
                if (t.isNotEmpty()) tags.add(t)
            }
        }
        val org = if (item.isNull("organizationName")) null else item.optString("organizationName", "").takeIf { it.isNotEmpty() }
        return CallerEntry(
            customerId = item.optString("customerId", ""),
            displayName = item.optString("displayName", ""),
            phoneNormalized = item.optString("phoneNormalized", normalized),
            organizationName = org,
            tags = tags,
        )
    }

    /**
     * If `ROLE_CALL_SCREENING` was previously held and has now been revoked in
     * Android system settings, immediately purges the local caller-ID cache so
     * customer phone metadata does not remain on disk without user consent.
     */
    fun reconcileRoleState(roleHeld: Boolean) {
        if (!roleHeld && store.getString(KEY_ROLE_LAST_HELD) == "true") {
            clearAll()
        } else if (roleHeld) {
            store.putString(KEY_ROLE_LAST_HELD, "true")
        }
    }

    fun onDeviceRevoked() {
        clearAll()
    }

    fun status(businessId: String? = getActiveBusinessId(), roleHeld: Boolean = false, supported: Boolean = true): JSONObject {
        reconcileRoleState(roleHeld)
        val targetBusinessId = businessId?.trim()?.takeIf { it.isNotEmpty() }
        var count = 0
        var lastSyncedAt: String? = null
        if (targetBusinessId != null) {
            val rawJson = store.getString(tenantKey(targetBusinessId))
            if (!rawJson.isNullOrBlank()) {
                try {
                    val obj = JSONObject(rawJson)
                    count = obj.optInt("count", 0)
                    lastSyncedAt = obj.optString("syncedAt", "").takeIf { it.isNotEmpty() }
                } catch (_: Exception) {
                    count = 0
                }
            }
        }
        return JSONObject()
            .put("roleHeld", roleHeld)
            .put("supported", supported)
            .put("cachedCustomerCount", count)
            .put("businessId", targetBusinessId ?: JSONObject.NULL)
            .put("lastSyncedAt", lastSyncedAt ?: JSONObject.NULL)
    }

    fun clearTenant(businessId: String) {
        val clean = businessId.trim()
        if (clean.isEmpty()) return
        store.putString(KEY_PENDING_WIPE, "$WIPE_TENANT_PREFIX$clean")
        store.remove(tenantKey(clean))
        if (store.getString(KEY_ACTIVE_BUSINESS) == clean) {
            store.remove(KEY_ACTIVE_BUSINESS)
        }
        store.remove(KEY_PENDING_WIPE)
    }

    fun clearAll() {
        store.putString(KEY_PENDING_WIPE, WIPE_ALL_MARKER)
        store.clearAll()
    }

    companion object {
        private const val KEY_ACTIVE_BUSINESS = "active_business_id"
        private const val KEY_ROLE_LAST_HELD = "role_last_held"
        internal const val KEY_PENDING_WIPE = "__pending_wipe__"
        internal const val WIPE_ALL_MARKER = "all"
        internal const val WIPE_TENANT_PREFIX = "tenant:"
        private const val MAX_ENTRIES_PER_TENANT = 5_000

        internal fun tenantKey(businessId: String): String = "tenant_callers:$businessId"

        /**
         * Normalizes Iranian (`09...`, `989...`, `00989...`, Persian/Arabic digits)
         * and international E.164 phone numbers identically to `normalizeCallerPhone`
         * in `src/lib/native/capabilities-client.ts`.
         */
        fun normalizePhone(raw: String): String {
            val mapped = buildString(raw.length) {
                for (ch in raw.trim()) {
                    when (ch) {
                        in '\u06F0'..'\u06F9' -> append((ch.code - 0x06F0).toString())
                        in '\u0660'..'\u0669' -> append((ch.code - 0x0660).toString())
                        else -> append(ch)
                    }
                }
            }
            val hasLeadingPlus = mapped.startsWith("+")
            val digits = mapped.filter { it.isDigit() }
            if (digits.isEmpty()) return ""

            return when {
                digits.startsWith("0098") && digits.length >= 12 -> "+98${digits.substring(4)}"
                digits.startsWith("98") && digits.length == 12 -> "+$digits"
                digits.startsWith("09") && digits.length == 11 -> "+98${digits.substring(1)}"
                digits.startsWith("0") && digits.length == 11 -> "+98${digits.substring(1)}"
                digits.length == 10 && digits.startsWith("9") -> "+98$digits"
                hasLeadingPlus && digits.length in 7..15 -> "+$digits"
                digits.length >= 4 -> digits
                else -> ""
            }
        }

        fun fromContext(context: Context): CallerIdCache =
            CallerIdCache(EncryptedKeyValueStore.fromContext(context))

        fun isCallScreeningSupported(): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

        fun isCallScreeningRoleHeld(context: Context): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
            val roleManager = context.getSystemService(RoleManager::class.java) ?: return false
            return roleManager.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING) &&
                roleManager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
        }

        fun createRoleRequestIntent(context: Context): Intent? {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
            val roleManager = context.getSystemService(RoleManager::class.java) ?: return null
            if (!roleManager.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING)) return null
            return roleManager.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
        }

        private fun utcNowIso(): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.format(Date())
    }
}
