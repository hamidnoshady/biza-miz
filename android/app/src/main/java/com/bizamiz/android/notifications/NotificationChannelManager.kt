package com.bizamiz.android.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import com.bizamiz.android.R
import com.bizamiz.android.TwaLauncherActivity
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Registers Biza Miz's Android 8+ notification channels and enforces notification
 * rate/spam deduplication and payload sanitization (issue #884).
 *
 * Uses only platform `android.app.Notification` and `NotificationManager` APIs so
 * the shell compiles without `androidx.core`.
 */
object NotificationChannelManager {

    data class ChannelSpec(
        val id: String,
        val nameFa: String,
        val descriptionFa: String,
        val importance: Int,
    )

    val CHANNELS: List<ChannelSpec> = listOf(
        ChannelSpec(
            id = "orders",
            nameFa = "سفارش‌ها و فروش",
            descriptionFa = "اعلان سفارش‌های جدید، تغییر وضعیت و فاکتورها",
            importance = NotificationManager.IMPORTANCE_HIGH,
        ),
        ChannelSpec(
            id = "payments",
            nameFa = "دریافت و پرداخت",
            descriptionFa = "تأییدیه پرداخت‌ها، رسیدها و سررسید چک‌ها",
            importance = NotificationManager.IMPORTANCE_DEFAULT,
        ),
        ChannelSpec(
            id = "crm",
            nameFa = "مشتریان و تماس‌ها (CRM)",
            descriptionFa = "تشخیص تماس مشتری، پیگیری‌ها و یادآورهای CRM",
            importance = NotificationManager.IMPORTANCE_HIGH,
        ),
        ChannelSpec(
            id = "inventory",
            nameFa = "انبار و موجودی",
            descriptionFa = "هشدار کسری موجودی، حواله‌ها و انبارگردانی",
            importance = NotificationManager.IMPORTANCE_DEFAULT,
        ),
        ChannelSpec(
            id = "approvals",
            nameFa = "تأییدیه‌ها و کارتابل",
            descriptionFa = "درخواست‌های منتظر تأیید مدیر یا مسئول مالی",
            importance = NotificationManager.IMPORTANCE_HIGH,
        ),
        ChannelSpec(
            id = "operations",
            nameFa = "عملیات روزانه و همگام‌سازی",
            descriptionFa = "وضعیت همگام‌سازی آفلاین و وظایف تیمی",
            importance = NotificationManager.IMPORTANCE_LOW,
        ),
        ChannelSpec(
            id = "security",
            nameFa = "امنیت و نشست‌ها",
            descriptionFa = "ورود دستگاه جدید، قفل امنیتی و هشدارهای حساب",
            importance = NotificationManager.IMPORTANCE_HIGH,
        ),
    )

    private const val MIN_INTERVAL_PER_KEY_MS = 1_500L
    private const val DEDUP_WINDOW_MS = 60_000L
    private val recentMessageTimestamps = ConcurrentHashMap<String, Long>()
    private val lastCategoryTimestamp = ConcurrentHashMap<String, Long>()

    fun ensureChannelsCreated(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        for (spec in CHANNELS) {
            val channel = NotificationChannel(spec.id, spec.nameFa, spec.importance).apply {
                description = spec.descriptionFa
            }
            manager.createNotificationChannel(channel)
        }
    }

    /**
     * Rate-limit and deduplicate incoming notifications so a burst or retry loop cannot
     * spam the device tray.
     */
    fun shouldDeliverNotification(
        category: String,
        messageId: String?,
        nowEpochMs: Long = System.currentTimeMillis(),
    ): Boolean {
        recentMessageTimestamps.entries.removeIf { nowEpochMs - it.value > DEDUP_WINDOW_MS }

        if (!messageId.isNullOrBlank()) {
            val prev = recentMessageTimestamps.putIfAbsent(messageId, nowEpochMs)
            if (prev != null && nowEpochMs - prev <= DEDUP_WINDOW_MS) {
                return false
            }
        }

        val safeCategory = if (CHANNELS.any { it.id == category }) category else "operations"
        val lastCat = lastCategoryTimestamp[safeCategory]
        if (lastCat != null && nowEpochMs - lastCat < MIN_INTERVAL_PER_KEY_MS) {
            return false
        }
        lastCategoryTimestamp[safeCategory] = nowEpochMs
        return true
    }

    /**
     * Strips any sensitive or non-display fields from an incoming push payload before
     * rendering or routing.
     */
    fun sanitizeNotificationPayload(raw: JSONObject): JSONObject {
        val safe = JSONObject()
        val category = raw.optString("category", "operations")
        safe.put(
            "category",
            if (CHANNELS.any { it.id == category }) category else "operations",
        )
        safe.put("title", raw.optString("title", "بیزمیز").take(120))
        safe.put("body", raw.optString("body", "").take(240))

        val path = raw.optString("path", "").trim()
        if (path.startsWith("/") && !path.startsWith("//") && !path.contains("://")) {
            safe.put("path", path.take(256))
        }
        val businessId = raw.optString("businessId", "").trim()
        if (businessId.isNotEmpty() && businessId.length <= 64) {
            safe.put("businessId", businessId)
        }
        return safe
    }

    /**
     * Resolves an FCM registration token via reflection if `com.google.firebase:firebase-messaging`
     * is linked into the build, or returns `null` when building without `google-services.json`.
     */
    fun resolvePushToken(context: Context): String? {
        return try {
            val prefs = context.applicationContext.getSharedPreferences(
                "biza_push_state",
                Context.MODE_PRIVATE,
            )
            val cached = prefs.getString("fcm_token", null)
            if (!cached.isNullOrBlank()) return cached

            val firebaseMessagingClass = Class.forName("com.google.firebase.messaging.FirebaseMessaging")
            val getInstance = firebaseMessagingClass.getMethod("getInstance")
            val instance = getInstance.invoke(null) ?: return null
            val getToken = firebaseMessagingClass.getMethod("getToken")
            val task = getToken.invoke(instance) ?: return null
            val tasksClass = Class.forName("com.google.android.gms.tasks.Tasks")
            val awaitMethod = tasksClass.getMethod(
                "await",
                Class.forName("com.google.android.gms.tasks.Task"),
                Long::class.javaPrimitiveType,
                java.util.concurrent.TimeUnit::class.java,
            )
            val token = awaitMethod.invoke(null, task, 5L, java.util.concurrent.TimeUnit.SECONDS) as? String
            if (!token.isNullOrBlank()) {
                prefs.edit().putString("fcm_token", token).apply()
            }
            token
        } catch (_: Throwable) {
            null
        }
    }

    fun clearPushToken(context: Context) {
        val prefs = context.applicationContext.getSharedPreferences(
            "biza_push_state",
            Context.MODE_PRIVATE,
        )
        prefs.edit().remove("fcm_token").apply()
    }

    @Suppress("DEPRECATION")
    fun postCallerIdNotification(
        context: Context,
        customerId: String,
        displayName: String,
        phoneNormalized: String,
        organizationName: String?,
        tags: List<String>,
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            if (!granted) return
        }
        if (!shouldDeliverNotification("crm", "caller:$customerId:$phoneNormalized")) return

        ensureChannelsCreated(context)
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (!manager.areNotificationsEnabled()) return

        val deepLinkUri = Uri.parse(
            "bizamiz://app/crm/customers/${Uri.encode(customerId)}?callPhone=${Uri.encode(phoneNormalized)}",
        )
        val openIntent = Intent(context, TwaLauncherActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = deepLinkUri
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            customerId.hashCode(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val subtitleParts = mutableListOf<String>()
        if (!organizationName.isNullOrBlank()) subtitleParts.add(organizationName)
        if (tags.isNotEmpty()) subtitleParts.add(tags.joinToString(" • "))
        val bodyText = if (subtitleParts.isNotEmpty()) {
            "${subtitleParts.joinToString(" — ")} ($phoneNormalized)"
        } else {
            "تماس ورودی از $phoneNormalized — ثبت نتیجه تماس در CRM"
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, "crm")
        } else {
            Notification.Builder(context)
        }

        val notification = builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("تماس مشتری: $displayName")
            .setContentText(bodyText)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        manager.notify(customerId.hashCode(), notification)
    }
}
