package com.bizamiz.android.updates

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
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Notifies the user when a newer stable Android build is published on this
 * repository's GitHub Releases.
 *
 * The check reads the versioned release feed (`android-vX.Y.Z`), compares it with
 * the installed version, and posts one notification per new version. Nothing is
 * installed silently: tapping the notification opens that release's APK asset,
 * and Android's own installer asks the user to confirm. The APK is the signed
 * production build published by `android-production-release.yml`; signature
 * verification is Android's own (an APK signed by another key is refused by the
 * package manager), so no second trust store is introduced here.
 *
 * Only the production flavor checks — development and staging builds must never
 * offer to replace themselves with a production APK.
 */
object AppUpdateChecker {
    const val REPO = "hamidnoshady/biza-miz"
    const val RELEASES_URL = "https://api.github.com/repos/$REPO/releases?per_page=30"
    const val CHANNEL_ID = "app_updates"

    private const val NOTIFICATION_ID = 9071
    private const val PREFS = "biza_app_update"
    private const val KEY_NOTIFIED_VERSION = "notified_version"
    private val executor = Executors.newSingleThreadExecutor()

    /** Cheap fire-and-forget entry point (app launch, WorkManager). Never throws. */
    fun checkInBackground(context: Context) {
        if (BuildConfig.APP_ENVIRONMENT != "production") return
        val appContext = context.applicationContext
        executor.execute {
            try {
                checkNow(appContext)
            } catch (_: Exception) {
                // An update check must never break the app.
            }
        }
    }

    /**
     * One synchronous check. Returns the release that was offered, or null when
     * there is no newer build or the notification was already shown for it.
     */
    fun checkNow(context: Context): UpdateRelease? {
        val installed = BuildConfig.VERSION_NAME
        val releases = fetchReleases() ?: return null
        val release = UpdateReleasePolicy.newestAvailable(releases, installed) ?: return null
        if (release.version == notifiedVersion(context)) return null
        if (!postNotification(context, release, installed)) return null
        rememberNotifiedVersion(context, release.version)
        return release
    }

    internal fun fetchReleases(
        url: String = RELEASES_URL,
        connectionFactory: (URL) -> HttpURLConnection = { target -> target.openConnection() as HttpURLConnection },
    ): JSONArray? {
        var connection: HttpURLConnection? = null
        return try {
            val opened = connectionFactory(URL(url)).apply {
                requestMethod = "GET"
                connectTimeout = 10_000
                readTimeout = 10_000
                useCaches = false
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "bizamiz-android/${BuildConfig.VERSION_NAME}")
            }
            connection = opened
            if (opened.responseCode !in 200..299) {
                null
            } else {
                val body = opened.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                JSONArray(body)
            }
        } catch (_: Exception) {
            null
        } finally {
            connection?.disconnect()
        }
    }

    private fun postNotification(context: Context, release: UpdateRelease, installedVersion: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        if (!manager.areNotificationsEnabled()) return false
        ensureChannel(context, manager)

        // Opening the asset hands the download and the install prompt to Android,
        // which is the only thing allowed to install a package.
        val openIntent = Intent(Intent.ACTION_VIEW, Uri.parse(release.apkUrl)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            Notification.Builder(context)
        }
        val body = context.getString(R.string.update_available_body, installedVersion)
        val notification = builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(context.getString(R.string.update_available_title, release.version))
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(if (release.notes.isBlank()) body else "${body}\n${release.notes}"))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        manager.notify(NOTIFICATION_ID, notification)
        return true
    }

    private fun ensureChannel(context: Context, manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.update_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.update_channel_description)
        }
        manager.createNotificationChannel(channel)
    }

    private fun notifiedVersion(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_NOTIFIED_VERSION, null)

    private fun rememberNotifiedVersion(context: Context, version: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_NOTIFIED_VERSION, version)
            .apply()
    }
}
