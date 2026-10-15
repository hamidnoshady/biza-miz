package com.bizamiz.android.notifications

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.bizamiz.android.R
import com.bizamiz.android.TwaLauncherActivity
import com.bizamiz.android.bridge.BridgeProtocol
import org.json.JSONArray
import org.json.JSONObject

/**
 * Manages Android notification channels, FCM/push token storage in app-private
 * preferences, rate/spam protection, and deep-link notification intents (issue #884).
 */
object NotificationChannelManager {

    data class ChannelSpec(
        val id: String,
        val titleFa: String,
        val descriptionFa: String,
        val highImportance: Boolean = false,
    )

    val CHANNEL_SPECS: List<ChannelSpec> = listOf(
        ChannelSpec("orders", "سفارش‌ها", "اعلان سفارش‌های جدید و تغییر وضعیت سفارش", highImportance = true),
        ChannelSpec("payments", "پرداخت‌ها و رسیدها", "اعلان دریافت و پرداخت وجه و تسویه‌ها"),
        ChannelSpec("crm", "مشتریان و تماس‌ها", "تشخیص تماس ورودی مشتریان و یادآوری پیگیری‌های CRM", highImportance = true),
        ChannelSpec("inventory", "انبار و موجودی", "هشدار کسری موجودی و شمارش انبار"),
        ChannelSpec("approvals", "تأییدیه‌ها", "درخواست‌های نیازمند تأیید مدیر"),
        ChannelSpec("operations", "عملیات روزانه", "اعلان‌های عملیاتی نوبت، آشپزخانه و تحویل"),
        ChannelSpec("security", "امنیت و نشست‌ها", "هشدارهای امنیتی و مدیریت دستگاه‌ها", highImportance = true),
    )

    private val SENSITIVE_PAYLOAD_KEYS: Set<String> = setOf(
        "password",
        "passwordhash",
        "token",
        "accesstoken",
        "refreshtoken",
        "secret",
        "pin",
        "cvv",
        "cardpan",
        "nationalid",
    )

    private const val PREFS_NAME = "biza_push_notifications"
    private const val KEY_FCM_TOKEN = "fcm_token"
    private const val KEY_TENANT_ID = "business_id"
    private const val MIN_CATEGORY_INTERVAL_MS = 1_500L

    private val recentMessageIds = LinkedHashSet<String>()
    private val lastCategoryTimestampMs = HashMap<String, Long>()

    fun ensureChannels(context: Context): List<String> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            if (manager != null) {
                for (spec in CHANNEL_SPECS) {
                    val importance = if (spec.highImportance) {
                        NotificationManager.IMPORTANCE_HIGH
                    } else {
                        NotificationManager.IMPORTANCE_DEFAULT
                    }
                    val channel = NotificationChannel(spec.id, spec.titleFa, importance).apply {
                        description = spec.descriptionFa
                    }
                    manager.createNotificationChannel(channel)
                }
            }
        }
        return CHANNEL_SPECS.map { it.id }
    }

    fun getStoredPushToken(context: Context): String? {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_FCM_TOKEN, null)?.takeIf { it.length in 16..4096 }
    }

    fun storePushToken(context: Context, token: String?, businessId: String? = null) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val editor = prefs.edit()
        if (token.isNullOrBlank()) {
            editor.remove(KEY_FCM_TOKEN)
        } else {
            editor.putString(KEY_FCM_TOKEN, token.trim().take(4096))
        }
        if (!businessId.isNullOrBlank()) {
            editor.putString(KEY_TENANT_ID, businessId.trim().take(64))
        }
        editor.apply()
    }

    fun clearPushRegistration(context: Context) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
        synchronized(this) {
            recentMessageIds.clear()
            lastCategoryTimestampMs.clear()
        }
    }

    fun buildRegistrationResult(
        permissionState: String,
        fcmToken: String?,
        requestedChannels: List<String>,
    ): JSONObject {
        val safePermission = if (BridgeProtocol.PERMISSION_STATES.contains(permissionState)) {
            permissionState
        } else {
            BridgeProtocol.PERMISSION_NOT_DETERMINED
        }
        val channels = requestedChannels
            .filter { BridgeProtocol.NOTIFICATION_CHANNELS.contains(it) }
            .distinct()
            .ifEmpty { CHANNEL_SPECS.map { it.id } }

        val validToken = fcmToken?.takeIf { it.length in 16..4096 && safePermission == BridgeProtocol.PERMISSION_GRANTED }
        return JSONObject()
            .put("permission", safePermission)
            .put("fcmToken", validToken ?: JSONObject.NULL)
            .put("channels", JSONArray(channels))
            .put("pushProvider", if (validToken != null) "fcm" else "none")
    }

    /**
     * Deduplicates notification IDs and enforces per-category burst rate limits.
     */
    @Synchronized
    fun shouldDeliverNotification(category: String, messageId: String?, nowMs: Long): Boolean {
        if (!BridgeProtocol.NOTIFICATION_CHANNELS.contains(category)) return false
        if (!messageId.isNullOrBlank()) {
            if (recentMessageIds.contains(messageId)) return false
            recentMessageIds.add(messageId)
            if (recentMessageIds.size > 200) {
                val first = recentMessageIds.iterator().next()
                recentMessageIds.remove(first)
            }
        }
        val lastAt = lastCategoryTimestampMs[category] ?: 0L
        if (nowMs - lastAt < MIN_CATEGORY_INTERVAL_MS) return false
        lastCategoryTimestampMs[category] = nowMs
        return true
    }

    /**
     * Strips sensitive keys and validates deep-link paths so push payloads
     * never expose confidential fields or navigate off-origin.
     */
    fun sanitizeNotificationPayload(raw: JSONObject): JSONObject {
        val out = JSONObject()
        val keys = raw.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (SENSITIVE_PAYLOAD_KEYS.contains(key.lowercase())) continue
            if (key == "path") {
                val p = raw.optString("path", "").trim()
                if (p.startsWith("/") && !p.startsWith("//") && !p.contains("\\")) {
                    out.put("path", p.take(512))
                }
                continue
            }
            val value = raw.opt(key)
            if (value is String) {
                out.put(key, value.take(300))
            } else if (value is Number || value is Boolean) {
                out.put(key, value)
            }
        }
        return out
    }

    @SuppressLint("MissingPermission")
    fun showCallerIdNotification(
        context: Context,
        customerId: String,
        displayName: String,
        organizationName: String?,
        phoneNormalized: String,
    ) {
        if (!hasPostNotificationPermission(context)) return
        ensureChannels(context)

        val deepLinkUri = Uri.parse(
            "bizamiz://app/crm/customers/${Uri.encode(customerId)}?callPhone=${Uri.encode(phoneNormalized)}",
        )
        val launchIntent = Intent(context, TwaLauncherActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = deepLinkUri
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            customerId.hashCode(),
            launchIntent,
            pendingFlags,
        )

        val contentText = if (!organizationName.isNullOrBlank()) {
            "$displayName ($organizationName) — ثبت گزارش تماس در CRM"
        } else {
            "$displayName — ثبت گزارش تماس در CRM"
        }

        val notification = NotificationCompat.Builder(context, "crm")
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("تماس مشتری: $displayName")
            .setContentText(contentText)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        NotificationManagerCompat.from(context).notify(customerId.hashCode(), notification)
    }

    private fun hasPostNotificationPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }
}
