package com.bizamiz.android.sync

import android.content.Context
import com.bizamiz.android.callerid.CallerIdCache
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Tenant-scoped operational sync state store and backoff calculator for the
 * Android TWA runtime (issue #884).
 *
 * Invariants:
 * - Never creates a second business database in Android; the web app's IndexedDB
 *   queue (`src/app/dashboard/offline-queue.tsx`) and `/api/sync/events` remain
 *   the single mutation pipeline.
 * - Operational metadata (pending count, last sync timestamp, revocation state)
 *   is isolated per `businessId` in `Context.MODE_PRIVATE` preferences.
 * - `clearTenant` and `clearAll` wipe operational sync state (and caller ID cache
 *   when invoked via [fromContext]) on tenant switch or sign-out.
 * - Bounded exponential retry backoff prevents battery/network drain.
 */
class TenantSyncStateStore(
    private val store: CallerIdCache.KeyValueStore,
    private val onClearTenantCallback: ((String) -> Unit)? = null,
    private val onClearAllCallback: (() -> Unit)? = null,
) {
    fun recordSyncRequest(
        businessId: String?,
        action: String,
        pendingCount: Int = 0,
        nowIso: String = utcNowIso(),
    ): JSONObject {
        val cleanBiz = businessId?.trim()?.takeIf { it.isNotEmpty() }
        return when (action) {
            "clear_all" -> {
                store.clearAll()
                onClearAllCallback?.invoke()
                JSONObject()
                    .put("scheduled", false)
                    .put("action", "clear_all")
                    .put("businessId", JSONObject.NULL)
                    .put("clearedEntries", 1)
            }
            "clear_tenant" -> {
                var cleared = 0
                if (cleanBiz != null) {
                    if (store.getString(tenantKey(cleanBiz)) != null) cleared = 1
                    store.remove(tenantKey(cleanBiz))
                    onClearTenantCallback?.invoke(cleanBiz)
                }
                JSONObject()
                    .put("scheduled", false)
                    .put("action", "clear_tenant")
                    .put("businessId", cleanBiz ?: JSONObject.NULL)
                    .put("clearedEntries", cleared)
            }
            "enqueue", "immediate" -> {
                if (cleanBiz != null && isTenantRevoked(cleanBiz)) {
                    return JSONObject()
                        .put("scheduled", false)
                        .put("action", action)
                        .put("businessId", cleanBiz)
                        .put("clearedEntries", 0)
                }
                if (cleanBiz != null) {
                    val state = JSONObject()
                        .put("businessId", cleanBiz)
                        .put("scheduled", true)
                        .put("pendingCount", pendingCount.coerceAtLeast(0))
                        .put("lastSyncedAt", nowIso)
                        .put("revoked", false)
                    store.putString(tenantKey(cleanBiz), state.toString())
                    store.putString(KEY_ACTIVE_BUSINESS, cleanBiz)
                }
                JSONObject()
                    .put("scheduled", true)
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

    fun markTenantRevoked(businessId: String) {
        val clean = businessId.trim()
        if (clean.isEmpty()) return
        val state = JSONObject()
            .put("businessId", clean)
            .put("scheduled", false)
            .put("pendingCount", 0)
            .put("lastSyncedAt", JSONObject.NULL)
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

        val raw = store.getString(tenantKey(targetBiz))
        if (raw.isNullOrBlank()) {
            return JSONObject()
                .put("scheduled", false)
                .put("networkAvailable", networkAvailable)
                .put("businessId", targetBiz)
                .put("pendingCount", 0)
                .put("lastSyncedAt", JSONObject.NULL)
                .put("revoked", false)
        }

        return try {
            val obj = JSONObject(raw)
            JSONObject()
                .put("scheduled", obj.optBoolean("scheduled", false))
                .put("networkAvailable", networkAvailable)
                .put("businessId", targetBiz)
                .put("pendingCount", obj.optInt("pendingCount", 0))
                .put("lastSyncedAt", if (obj.isNull("lastSyncedAt")) JSONObject.NULL else obj.optString("lastSyncedAt"))
                .put("revoked", obj.optBoolean("revoked", false))
        } catch (_: Exception) {
            JSONObject()
                .put("scheduled", false)
                .put("networkAvailable", networkAvailable)
                .put("businessId", targetBiz)
                .put("pendingCount", 0)
                .put("lastSyncedAt", JSONObject.NULL)
                .put("revoked", false)
        }
    }

    companion object {
        private const val PREFS_NAME = "biza_tenant_sync_state"
        private const val KEY_ACTIVE_BUSINESS = "active_business_id"
        const val BASE_BACKOFF_MS: Long = 15_000L
        const val MAX_BACKOFF_MS: Long = 15 * 60 * 1_000L

        private fun tenantKey(businessId: String): String = "tenant_sync:$businessId"

        /**
         * Bounded exponential backoff (15s, 30s, 60s, ..., capped at 15 minutes).
         */
        fun calculateBackoffDelayMs(attempt: Int): Long {
            val safeAttempt = attempt.coerceIn(0, 10)
            val delay = BASE_BACKOFF_MS * (1L shl safeAttempt)
            return delay.coerceAtMost(MAX_BACKOFF_MS)
        }

        fun fromContext(
            context: Context,
            onClearTenant: ((String) -> Unit)? = null,
            onClearAll: (() -> Unit)? = null,
        ): TenantSyncStateStore {
            val appContext = context.applicationContext
            val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val callerCache = CallerIdCache.fromContext(appContext)
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
