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
import com.bizamiz.android.BuildConfig
import com.bizamiz.android.R
import com.bizamiz.android.TwaLauncherActivity
import com.bizamiz.android.bridge.BridgeProtocol
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Registers Bizamiz's Android 8+ notification channels, manages safe Firebase
 * Cloud Messaging (FCM) initialization and token lifecycle, and enforces
 * notification deduplication, category preferences, and payload sanitization
 * (issue #884, Root Cause 4).
 *
 * Invariants:
 * - Uses the real `com.google.firebase:firebase-messaging` SDK (no reflection).
 * - When external Firebase project credentials (`BuildConfig.FIREBASE_*`) are not
 *   configured in the build environment, [ensureFirebaseInitialized] and
 *   [resolvePushToken] explicitly return `false` / `null` (`pushProvider = "none"`)
 *   and never fabricate a token or crash startup.
 * - Sign-out or revocation ([clearPushToken]) wipes local token/preferences and
 *   requests `FirebaseMessaging.getInstance().deleteToken()`.
 */
object NotificationChannelManager {

    const val EXTRA_NOTIFICATION_PATH = "com.bizamiz.android.extra.NOTIFICATION_PATH"
    const val EXTRA_NOTIFICATION_BUSINESS_ID = "com.bizamiz.android.extra.NOTIFICATION_BUSINESS_ID"
    const val EXTRA_NOTIFICATION_CATEGORY = "com.bizamiz.android.extra.NOTIFICATION_CATEGORY"

    private const val PREFS_NAME = "biza_push_state"
    private const val KEY_FCM_TOKEN = "fcm_token"
    private const val KEY_ENABLED_CHANNELS = "enabled_channels"

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
    private val tokenExecutor = Executors.newSingleThreadExecutor()

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

    fun isNotificationPermissionGranted(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager?.areNotificationsEnabled() ?: true
        }
    }

    fun resolvePermissionState(context: Context): String =
        if (isNotificationPermissionGranted(context)) {
            BridgeProtocol.PERMISSION_GRANTED
        } else {
            BridgeProtocol.PERMISSION_DENIED
        }

    fun setEnabledChannels(context: Context, channels: Collection<String>): List<String> {
        val valid = channels
            .map { it.trim() }
            .filter { BridgeProtocol.NOTIFICATION_CHANNELS.contains(it) }
            .distinct()
        val effective = if (valid.isEmpty()) CHANNELS.map { it.id } else valid
        context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putStringSet(KEY_ENABLED_CHANNELS, effective.toSet())
            .apply()
        return effective
    }

    fun getEnabledChannels(context: Context): List<String> {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val stored = prefs.getStringSet(KEY_ENABLED_CHANNELS, null)
        if (stored.isNullOrEmpty()) {
            return CHANNELS.map { it.id }
        }
        return CHANNELS.map { it.id }.filter { stored.contains(it) }
    }

    fun isCategoryEnabled(context: Context, category: String): Boolean {
        if (category == "security") return true
        return getEnabledChannels(context).contains(category)
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
            val prev = recentMessageTimestamps[messageId]
            if (prev != null && nowEpochMs - prev <= DEDUP_WINDOW_MS) {
                return false
            }
        }

        val safeCategory = if (CHANNELS.any { it.id == category }) category else "operations"
        val lastCat = lastCategoryTimestamp[safeCategory]
        if (lastCat != null && nowEpochMs - lastCat < MIN_INTERVAL_PER_KEY_MS) {
            return false
        }

        if (!messageId.isNullOrBlank()) {
            recentMessageTimestamps[messageId] = nowEpochMs
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
     * Returns `true` only when explicit Firebase credentials were supplied at build time
     * (`BIZA_FIREBASE_*` / `-Pbiza.firebase.*`) or via a default `FirebaseApp` resource.
     */
    fun isFirebaseConfigured(): Boolean =
        BuildConfig.FIREBASE_PROJECT_ID.isNotBlank() &&
            BuildConfig.FIREBASE_APP_ID.isNotBlank() &&
            BuildConfig.FIREBASE_API_KEY.isNotBlank() &&
            BuildConfig.FIREBASE_SENDER_ID.isNotBlank()

    @Synchronized
    fun ensureFirebaseInitialized(context: Context): Boolean {
        val appContext = context.applicationContext
        return try {
            if (FirebaseApp.getApps(appContext).isNotEmpty()) {
                return true
            }
            if (!isFirebaseConfigured()) {
                return false
            }
            val options = FirebaseOptions.Builder()
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                .setApplicationId(BuildConfig.FIREBASE_APP_ID)
                .setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                .build()
            FirebaseApp.initializeApp(appContext, options) != null
        } catch (_: Throwable) {
            false
        }
    }

    fun storePushToken(context: Context, token: String?) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (token.isNullOrBlank()) {
            prefs.edit().remove(KEY_FCM_TOKEN).apply()
        } else {
            prefs.edit().putString(KEY_FCM_TOKEN, token.trim()).apply()
        }
    }

    /**
     * Resolves an FCM registration token using the `FirebaseMessaging` SDK when
     * Firebase credentials are configured, or returns `null` (`pushProvider = "none"`)
     * when unconfigured. Never fabricates a token.
     */
    fun resolvePushToken(context: Context): String? {
        val appContext = context.applicationContext
        if (!ensureFirebaseInitialized(appContext)) {
            return null
        }
        val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val cached = prefs.getString(KEY_FCM_TOKEN, null)?.takeIf { it.isNotBlank() }
        if (cached != null) {
            return cached
        }
        return try {
            val future = tokenExecutor.submit(
                Callable {
                    Tasks.await(FirebaseMessaging.getInstance().token, 4L, TimeUnit.SECONDS)
                },
            )
            val token = future.get(5L, TimeUnit.SECONDS)?.trim()?.takeIf { it.isNotEmpty() }
            if (token != null) {
                storePushToken(appContext, token)
            }
            token
        } catch (_: Throwable) {
            null
        }
    }

    fun fetchFcmTokenIfAvailable(context: Context): String? = resolvePushToken(context)

    fun clearPushToken(context: Context) {
        val appContext = context.applicationContext
        appContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_FCM_TOKEN)
            .remove(KEY_ENABLED_CHANNELS)
            .apply()
        if (ensureFirebaseInitialized(appContext)) {
            tokenExecutor.execute {
                try {
                    Tasks.await(FirebaseMessaging.getInstance().deleteToken(), 4L, TimeUnit.SECONDS)
                } catch (_: Throwable) {
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    fun postPushNotification(
        context: Context,
        rawPayload: JSONObject,
        messageId: String? = null,
    ): Boolean {
        if (!isNotificationPermissionGranted(context)) return false
        val safe = sanitizeNotificationPayload(rawPayload)
        val category = safe.optString("category", "operations")
        if (!isCategoryEnabled(context, category)) return false
        if (!shouldDeliverNotification(category, messageId)) return false

        ensureChannelsCreated(context)
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        if (!manager.areNotificationsEnabled()) return false

        val path = safe.optString("path", "/dashboard").ifBlank { "/dashboard" }
        val businessId = safe.optString("businessId", "").takeIf { it.isNotEmpty() }
        val title = safe.optString("title", "بیزمیز").ifBlank { "بیزمیز" }
        val body = safe.optString("body", "")

        val deepLinkBuilder = Uri.parse("bizamiz://app$path").buildUpon()
        if (businessId != null) {
            deepLinkBuilder.appendQueryParameter("businessId", businessId)
        }
        deepLinkBuilder.appendQueryParameter("category", category)

        val openIntent = Intent(context, TwaLauncherActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = deepLinkBuilder.build()
            putExtra(EXTRA_NOTIFICATION_PATH, path)
            if (businessId != null) {
                putExtra(EXTRA_NOTIFICATION_BUSINESS_ID, businessId)
            }
            putExtra(EXTRA_NOTIFICATION_CATEGORY, category)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val notificationId = (messageId ?: "$category:$path:${System.currentTimeMillis()}").hashCode()
        val pendingIntent = PendingIntent.getActivity(
            context,
            notificationId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, category)
        } else {
            Notification.Builder(context)
        }

        val notification = builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        manager.notify(notificationId, notification)
        return true
    }

    @Suppress("DEPRECATION")
    fun postCallerIdNotification(
        context: Context,
        businessId: String? = null,
        customerId: String,
        displayName: String,
        phoneNormalized: String,
        organizationName: String?,
        tags: List<String>,
    ) {
        if (!isNotificationPermissionGranted(context)) return
        if (!isCategoryEnabled(context, "crm")) return
        if (!shouldDeliverNotification("crm", "caller:$customerId:$phoneNormalized")) return

        ensureChannelsCreated(context)
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (!manager.areNotificationsEnabled()) return

        val path = "/crm/customers/${Uri.encode(customerId)}?callPhone=${Uri.encode(phoneNormalized)}"
        val deepLinkBuilder = Uri.parse("bizamiz://app$path").buildUpon()
        if (!businessId.isNullOrBlank()) {
            deepLinkBuilder.appendQueryParameter("businessId", businessId)
        }
        deepLinkBuilder.appendQueryParameter("category", "crm")

        val openIntent = Intent(context, TwaLauncherActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = deepLinkBuilder.build()
            putExtra(EXTRA_NOTIFICATION_PATH, path)
            if (!businessId.isNullOrBlank()) {
                putExtra(EXTRA_NOTIFICATION_BUSINESS_ID, businessId)
            }
            putExtra(EXTRA_NOTIFICATION_CATEGORY, "crm")
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
