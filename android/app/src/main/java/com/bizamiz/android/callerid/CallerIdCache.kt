package com.bizamiz.android.callerid

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * Tenant-isolated local caller lookup cache for CRM Caller ID (issue #884).
 *
 * Security & privacy invariants:
 * - Entries are partitioned by `businessId`; a lookup only searches the active
 *   tenant's cache and never leaks contacts across tenants.
 * - Clearing a tenant (`clearTenant`) or signing out (`clearAll`) removes cached
 *   entries immediately.
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

    fun getActiveBusinessId(): String? =
        store.getString(KEY_ACTIVE_BUSINESS)?.takeIf { it.isNotBlank() }

    fun setActiveBusinessId(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            store.remove(KEY_ACTIVE_BUSINESS)
        } else {
            store.putString(KEY_ACTIVE_BUSINESS, businessId.trim())
        }
    }

    fun syncTenantEntries(
        businessId: String,
        entries: List<CallerEntry>,
        syncedAtIso: String = Instant.now().toString(),
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
        return count
    }

    fun lookup(rawPhone: String, businessId: String? = getActiveBusinessId()): CallerEntry? {
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

    fun status(businessId: String? = getActiveBusinessId(), roleHeld: Boolean = false, supported: Boolean = true): JSONObject {
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
        store.remove(tenantKey(clean))
        if (getActiveBusinessId() == clean) {
            store.remove(KEY_ACTIVE_BUSINESS)
        }
    }

    fun clearAll() {
        store.clearAll()
    }

    companion object {
        private const val PREFS_NAME = "biza_caller_id_cache"
        private const val KEY_ACTIVE_BUSINESS = "active_business_id"
        private const val MAX_ENTRIES_PER_TENANT = 5_000

        private fun tenantKey(businessId: String): String = "tenant_callers:$businessId"

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

        fun fromContext(context: Context): CallerIdCache {
            val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return CallerIdCache(
                object : KeyValueStore {
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
            )
        }

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
    }
}
