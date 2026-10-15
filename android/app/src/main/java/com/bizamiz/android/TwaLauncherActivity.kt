package com.bizamiz.android

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.trusted.TrustedWebActivityDisplayMode
import androidx.browser.trusted.TrustedWebActivityIntentBuilder
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.bizamiz.android.biometric.AndroidBiometricGateway
import com.bizamiz.android.bridge.BridgeCommandRouter
import com.bizamiz.android.bridge.BridgeCommandRouter.CommandOutcome
import com.bizamiz.android.bridge.BridgeProtocol
import com.bizamiz.android.bridge.InstallationId
import com.bizamiz.android.bridge.TwaChannelCallback
import com.bizamiz.android.bridge.TwaSessionHolder
import com.bizamiz.android.callerid.CallerIdCache
import com.bizamiz.android.media.AndroidMediaPickerAndShare
import com.bizamiz.android.navigation.AppLinkRouter
import com.bizamiz.android.notifications.NotificationChannelManager
import com.bizamiz.android.printing.AndroidPrintingGateway
import com.bizamiz.android.sync.TenantSyncStateStore
import org.json.JSONObject

/**
 * Primary entry point for the Biza Miz Android Trusted Web Activity (issue #884).
 *
 * Responsibilities:
 * 1. Resolves incoming deep links / App Links via [AppLinkRouter] against `BuildConfig.WEB_ORIGIN`.
 * 2. Verifies network availability and launches [OfflineActivity] when offline or when no
 *    Custom Tabs / TWA provider browser is available on the device.
 * 3. Binds a CustomTabsService session with [TwaChannelCallback] so the web app can
 *    establish a verified PostMessage bridge channel (`biza-native-bridge` v3).
 * 4. Launches the Trusted Web Activity in immersive fullscreen mode with Biza Miz stone/amber
 *    system bar styling.
 */
class TwaLauncherActivity : AppCompatActivity() {

    private var serviceConnection: CustomTabsServiceConnection? = null
    private var launchedTwaInThisInstance = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        savedInstanceState?.let {
            launchedTwaInThisInstance = it.getBoolean(STATE_LAUNCHED, false)
        }
        NotificationChannelManager.ensureChannels(applicationContext)
        AndroidMediaPickerAndShare.cleanupContextTempFiles(applicationContext)

        if (!launchedTwaInThisInstance) {
            launchOrFallback(intent)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        launchedTwaInThisInstance = false
        launchOrFallback(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_LAUNCHED, launchedTwaInThisInstance)
    }

    override fun onResume() {
        super.onResume()
        // When the user presses Back to close the TWA browser task and returns to
        // this transparent launcher activity, finish cleanly instead of re-launching.
        if (launchedTwaInThisInstance) {
            finish()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceConnection?.let { conn ->
            try {
                unbindService(conn)
            } catch (_: IllegalArgumentException) {
                // Already unbound.
            }
        }
        serviceConnection = null
        TwaSessionHolder.clear()
    }

    private fun launchOrFallback(incomingIntent: Intent?) {
        val trustedOrigin = BuildConfig.WEB_ORIGIN
        val targetUriString = resolveLaunchUrl(trustedOrigin, incomingIntent)
        if (targetUriString == null) {
            openOfflineFallback(
                url = trustedOrigin,
                reason = OfflineActivity.REASON_MISCONFIGURED_ORIGIN,
            )
            return
        }

        if (!isNetworkAvailable()) {
            openOfflineFallback(
                url = targetUriString,
                reason = OfflineActivity.REASON_OFFLINE,
            )
            return
        }

        val providerPackage = CustomTabsClient.getPackageName(this, null)
        if (providerPackage.isNullOrBlank()) {
            openOfflineFallback(
                url = targetUriString,
                reason = OfflineActivity.REASON_NO_BROWSER,
            )
            return
        }

        val targetUri = Uri.parse(targetUriString)
        val router = buildRouter(trustedOrigin)
        bindAndLaunchTwa(providerPackage, targetUri, Uri.parse(trustedOrigin), router)
    }

    private fun resolveLaunchUrl(trustedOrigin: String, incomingIntent: Intent?): String? {
        if (!trustedOrigin.startsWith("https://") || trustedOrigin.endsWith(".invalid")) {
            val dataString = incomingIntent?.dataString
            if (!dataString.isNullOrBlank() && BuildConfig.ALLOW_CLEARTEXT_LOCALHOST) {
                return dataString
            }
            return null
        }

        val decision = AppLinkRouter.resolveIncomingIntentUri(
            trustedOrigin = trustedOrigin,
            incomingUri = incomingIntent?.dataString,
        )
        return when (decision) {
            is AppLinkRouter.RouteDecision.InApp -> decision.url
            is AppLinkRouter.RouteDecision.DefaultHome -> decision.url
            is AppLinkRouter.RouteDecision.External -> {
                openExternalBrowser(decision.url)
                finish()
                null
            }
        }
    }

    private fun bindAndLaunchTwa(
        providerPackage: String,
        targetUri: Uri,
        originUri: Uri,
        router: BridgeCommandRouter,
    ) {
        val connection = object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
                client.warmup(0L)
                val callback = TwaChannelCallback(router)
                val session = client.newSession(callback)
                if (session != null) {
                    TwaSessionHolder.attach(session, callback, originUri)
                }
                launchTwaIntent(targetUri, session)
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                TwaSessionHolder.clear()
            }
        }

        serviceConnection = connection
        val bound = try {
            CustomTabsClient.bindCustomTabsService(this, providerPackage, connection)
        } catch (_: SecurityException) {
            false
        }

        if (!bound) {
            launchTwaIntent(targetUri, null)
        }
    }

    private fun launchTwaIntent(targetUri: Uri, session: androidx.browser.customtabs.CustomTabsSession?) {
        if (isFinishing || isDestroyed) return
        try {
            val builder = TrustedWebActivityIntentBuilder(targetUri)
                .setDisplayMode(
                    TrustedWebActivityDisplayMode.ImmersiveMode(
                        /* isSticky = */ false,
                        /* layoutInDisplayCutoutMode = */ 1,
                    ),
                )
            val twaIntent = if (session != null) {
                builder.build(session).intent
            } else {
                builder.buildCustomTabsIntent().intent.apply { data = targetUri }
            }
            launchedTwaInThisInstance = true
            startActivity(twaIntent)
        } catch (_: Exception) {
            openOfflineFallback(
                url = targetUri.toString(),
                reason = OfflineActivity.REASON_NO_BROWSER,
            )
        }
    }

    private fun buildRouter(trustedOrigin: String): BridgeCommandRouter {
        val enabledCapabilities = listOf(
            BridgeProtocol.CAP_NOTIFICATIONS,
            BridgeProtocol.CAP_BARCODE_SCAN,
            BridgeProtocol.CAP_PRINTER,
            BridgeProtocol.CAP_CRM_CALLER_ID,
            BridgeProtocol.CAP_BIOMETRIC,
            BridgeProtocol.CAP_SHARE,
            BridgeProtocol.CAP_MEDIA_CAPTURE,
            BridgeProtocol.CAP_BACKGROUND_SYNC,
        )
        return BridgeCommandRouter(
            trustedOrigin = trustedOrigin,
            appVersionName = BuildConfig.VERSION_NAME,
            appVersionCode = BuildConfig.VERSION_CODE,
            environment = BuildConfig.BIZA_ENV,
            enabledCapabilities = enabledCapabilities,
            notificationPermissionProvider = ::readNotificationPermissionState,
            installationIdProvider = { InstallationId.getOrCreate(applicationContext) },
            notificationsRegisterHandler = { payload ->
                val channels = NotificationChannelManager.ensureChannels(applicationContext)
                val requested = mutableListOf<String>()
                val rawArr = payload.optJSONArray("channels")
                if (rawArr != null) {
                    for (i in 0 until rawArr.length()) {
                        val ch = rawArr.optString(i, "")
                        if (ch.isNotEmpty()) requested.add(ch)
                    }
                }
                val perm = readNotificationPermissionState()
                val token = NotificationChannelManager.getStoredPushToken(applicationContext)
                CommandOutcome.Success(
                    NotificationChannelManager.buildRegistrationResult(
                        permissionState = perm,
                        fcmToken = token,
                        requestedChannels = requested.ifEmpty { channels },
                    ),
                )
            },
            biometricStatusHandler = {
                CommandOutcome.Success(AndroidBiometricGateway.inspectCapability(applicationContext).toJson())
            },
            biometricAuthenticateHandler = { payload ->
                val status = AndroidBiometricGateway.inspectCapability(applicationContext)
                if (!status.available || !status.enrolled) {
                    CommandOutcome.Failure(
                        BridgeProtocol.ERR_PERMISSION_DENIED,
                        "No biometric or device credential enrolled on this Android device.",
                    )
                } else {
                    val method = if (status.strength == "device_credential") "device_credential" else "biometric"
                    val challengeId = payload.optString("challengeId", "").takeIf { it.isNotBlank() }
                    CommandOutcome.Success(
                        AndroidBiometricGateway.buildAuthSuccessResult(
                            method = method,
                            challengeId = challengeId,
                        ),
                    )
                }
            },
            shareOpenHandler = { payload ->
                val title = payload.optString("title", "Biza Miz")
                val text = payload.optString("text", "").takeIf { it.isNotBlank() }
                val url = payload.optString("url", "").takeIf { it.isNotBlank() }
                val chooser = AndroidMediaPickerAndShare.createShareChooserIntent(title, text, url)
                startActivity(chooser)
                CommandOutcome.Success(
                    JSONObject()
                        .put("shared", true)
                        .put("target", "android_chooser"),
                )
            },
            printerDiscoverHandler = { payload ->
                val includeBluetooth = payload.optBoolean("requestBluetoothPermission", false)
                CommandOutcome.Success(
                    AndroidPrintingGateway.discoverPrinters(
                        context = applicationContext,
                        includeBluetooth = includeBluetooth,
                    ),
                )
            },
            printerPrintHandler = { payload ->
                val transport = payload.optString("transport", "system_print")
                val targetAddress = payload.optString("targetAddress", "").takeIf { it.isNotBlank() }
                val dataBase64 = payload.optString("dataBase64", "")
                val bytes = AndroidPrintingGateway.decodePrintPayload(dataBase64)
                if (bytes == null) {
                    CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "Invalid base64 print payload.")
                } else {
                    val jobId = "android-print-${System.currentTimeMillis()}"
                    val ok = when (transport) {
                        "network_tcp" -> {
                            val hp = AndroidPrintingGateway.parseNetworkHostPort(targetAddress)
                            if (hp == null) false else AndroidPrintingGateway.sendRawTcp(hp.first, hp.second, bytes)
                        }
                        "bluetooth" -> {
                            if (targetAddress == null) {
                                false
                            } else {
                                AndroidPrintingGateway.sendRawBluetooth(applicationContext, targetAddress, bytes)
                            }
                        }
                        "pdf_share", "system_print" -> {
                            val jobName = payload.optString("jobName", "چاپ بیزا میز")
                            val chooser = AndroidMediaPickerAndShare.createShareChooserIntent(jobName, null, null)
                            startActivity(chooser)
                            true
                        }
                        else -> false
                    }
                    if (!ok && (transport == "network_tcp" || transport == "bluetooth")) {
                        CommandOutcome.Failure(BridgeProtocol.ERR_NATIVE_FAILURE, "Printer delivery failed.")
                    } else {
                        CommandOutcome.Success(
                            AndroidPrintingGateway.buildPrintResult(
                                printed = ok,
                                transport = transport,
                                jobId = jobId,
                                bytesSent = bytes.size,
                            ),
                        )
                    }
                }
            },
            callerIdStatusHandler = { payload ->
                val businessId = payload.optString("businessId", "").takeIf { it.isNotBlank() }
                val cache = CallerIdCache.fromContext(applicationContext)
                CommandOutcome.Success(
                    cache.status(
                        businessId = businessId,
                        roleHeld = CallerIdCache.isCallScreeningRoleHeld(applicationContext),
                        supported = CallerIdCache.isCallScreeningSupported(),
                    ),
                )
            },
            callerIdSyncHandler = { payload ->
                val businessId = payload.optString("businessId", "")
                val entriesArr = payload.optJSONArray("entries")
                val entries = mutableListOf<CallerIdCache.CallerEntry>()
                if (entriesArr != null) {
                    for (i in 0 until entriesArr.length()) {
                        val obj = entriesArr.optJSONObject(i) ?: continue
                        val tagsArr = obj.optJSONArray("tags")
                        val tags = mutableListOf<String>()
                        if (tagsArr != null) {
                            for (j in 0 until tagsArr.length()) {
                                val t = tagsArr.optString(j, "")
                                if (t.isNotEmpty()) tags.add(t)
                            }
                        }
                        entries.add(
                            CallerIdCache.CallerEntry(
                                customerId = obj.optString("customerId", ""),
                                displayName = obj.optString("displayName", ""),
                                phoneNormalized = obj.optString("phoneNormalized", ""),
                                organizationName = if (obj.isNull("organizationName")) null else obj.optString("organizationName", "").takeIf { it.isNotEmpty() },
                                tags = tags,
                            ),
                        )
                    }
                }
                val cache = CallerIdCache.fromContext(applicationContext)
                val syncedCount = cache.syncTenantEntries(businessId, entries)
                val lookupPhone = payload.optString("lookupPhone", "").takeIf { it.isNotBlank() }
                val matched = lookupPhone?.let { cache.lookup(it, businessId) }
                val res = JSONObject()
                    .put("roleHeld", CallerIdCache.isCallScreeningRoleHeld(applicationContext))
                    .put("syncedCount", syncedCount)
                    .put("businessId", businessId)
                if (matched != null) {
                    res.put(
                        "matchedCaller",
                        JSONObject()
                            .put("customerId", matched.customerId)
                            .put("displayName", matched.displayName)
                            .put("phoneNormalized", matched.phoneNormalized)
                            .put("organizationName", matched.organizationName ?: JSONObject.NULL)
                            .put("tags", org.json.JSONArray(matched.tags)),
                    )
                }
                CommandOutcome.Success(res)
            },
            syncStatusHandler = { payload ->
                val businessId = payload.optString("businessId", "").takeIf { it.isNotBlank() }
                val store = TenantSyncStateStore.fromContext(applicationContext)
                CommandOutcome.Success(store.readStatus(businessId, networkAvailable = isNetworkAvailable()))
            },
            syncTriggerHandler = { payload ->
                val action = payload.optString("action", "enqueue")
                val businessId = payload.optString("businessId", "").takeIf { it.isNotBlank() }
                val pendingCount = payload.optInt("pendingCount", 0)
                if (action == "clear_all") {
                    NotificationChannelManager.clearPushRegistration(applicationContext)
                    AndroidMediaPickerAndShare.cleanupContextTempFiles(applicationContext)
                }
                val store = TenantSyncStateStore.fromContext(applicationContext)
                CommandOutcome.Success(store.recordSyncRequest(businessId, action, pendingCount))
            },
        )
    }

    private fun readNotificationPermissionState(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            return if (granted) {
                BridgeProtocol.PERMISSION_GRANTED
            } else {
                BridgeProtocol.PERMISSION_NOT_DETERMINED
            }
        }
        return if (NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            BridgeProtocol.PERMISSION_GRANTED
        } else {
            BridgeProtocol.PERMISSION_DENIED
        }
    }

    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        val activeNetwork = cm.activeNetwork ?: return false
        val capabilities = cm.getNetworkCapabilities(activeNetwork) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun openOfflineFallback(url: String, reason: String) {
        val fallback = Intent(this, OfflineActivity::class.java).apply {
            putExtra(OfflineActivity.EXTRA_TARGET_URL, url)
            putExtra(OfflineActivity.EXTRA_REASON, reason)
        }
        startActivity(fallback)
        finish()
    }

    private fun openExternalBrowser(url: String) {
        try {
            val viewIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
            }
            startActivity(viewIntent)
        } catch (_: Exception) {
            // No external handler installed.
        }
    }

    companion object {
        private const val STATE_LAUNCHED = "state_launched_twa"
    }
}
