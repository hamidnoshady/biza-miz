package com.bizamiz.android

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.trusted.TrustedWebActivityIntentBuilder
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
import com.bizamiz.android.navigation.LaunchDecision
import com.bizamiz.android.notifications.NotificationChannelManager
import com.bizamiz.android.printing.AndroidPrintingGateway
import com.bizamiz.android.scanner.AndroidBarcodeScanner
import com.bizamiz.android.sync.TenantSyncStateStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Opens the configured Biza Miz web origin inside a Trusted Web Activity and binds
 * the versioned native bridge (v3) over the Custom Tabs postMessage channel.
 *
 * Uses only platform `android.app.Activity` and `androidx.browser` APIs so the APK
 * stays lightweight without requiring AppCompat or Google Play Services at build time.
 */
class TwaLauncherActivity : Activity() {

    private var connection: CustomTabsServiceConnection? = null
    private var launched = false

    private val pendingNotificationPermissionResult = AtomicReference<CountDownLatch?>(null)
    private val pendingBluetoothPermissionResult = AtomicReference<CountDownLatch?>(null)
    private val pendingCredentialConfirmLatch = AtomicReference<CountDownLatch?>(null)
    private val pendingCredentialConfirmed = AtomicReference<Boolean>(false)
    private val pendingActivityResultLatch = AtomicReference<CountDownLatch?>(null)
    private val pendingActivityResultData = AtomicReference<Pair<Int, Intent?>?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        NotificationChannelManager.ensureChannelsCreated(this)
        AndroidMediaPickerAndShare.cleanupTempFiles(cacheDir)
        launch(intent?.data)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        launched = false
        launch(intent.data)
    }

    override fun onRestart() {
        super.onRestart()
        // When the user backs out of the Custom Tab / TWA, finish the launcher activity
        // instead of immediately re-launching the tab in a loop.
        if (launched) {
            finish()
        }
    }

    override fun onDestroy() {
        connection?.let {
            try {
                unbindService(it)
            } catch (_: IllegalArgumentException) {
                // Service was already unbound by the system.
            }
        }
        connection = null
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_POST_NOTIFICATIONS -> pendingNotificationPermissionResult.getAndSet(null)?.countDown()
            REQ_BLUETOOTH_PERMISSIONS -> pendingBluetoothPermissionResult.getAndSet(null)?.countDown()
        }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_CONFIRM_DEVICE_CREDENTIAL -> {
                pendingCredentialConfirmed.set(resultCode == RESULT_OK)
                pendingCredentialConfirmLatch.getAndSet(null)?.countDown()
            }
            REQ_PICK_MEDIA -> {
                pendingActivityResultData.set(resultCode to data)
                pendingActivityResultLatch.getAndSet(null)?.countDown()
            }
        }
    }

    private fun launch(data: Uri?) {
        val rawIncoming = data?.toString()
        val resolvedIncoming = if (rawIncoming != null && rawIncoming.startsWith("bizamiz://app")) {
            val path = data.path ?: "/dashboard"
            val query = data.encodedQuery?.let { "?$it" } ?: ""
            BuildConfig.WEB_ORIGIN.trimEnd('/') + path + query
        } else {
            rawIncoming
        }

        when (val decision = AppLinkRouter.decide(resolvedIncoming, BuildConfig.WEB_ORIGIN)) {
            LaunchDecision.NotConfigured -> showFallback(OfflineActivity.REASON_NOT_CONFIGURED, null)
            is LaunchDecision.Open -> openInTwa(decision.url)
        }
    }

    private fun openInTwa(url: String) {
        if (!isNetworkReachable()) {
            showFallback(OfflineActivity.REASON_OFFLINE, url)
            return
        }
        val provider = CustomTabsClient.getPackageName(this, null)
        if (provider == null) {
            showFallback(OfflineActivity.REASON_BROWSER_UNAVAILABLE, url)
            return
        }

        val origin = Uri.parse(BuildConfig.WEB_ORIGIN)
        val callback = TwaChannelCallback(router = buildRouter(BuildConfig.WEB_ORIGIN), origin = origin)

        val serviceConnection = object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
                if (launched || isFinishing || isDestroyed) return
                launched = true

                client.warmup(0L)
                val session = client.newSession(callback)
                if (session == null) {
                    showFallback(OfflineActivity.REASON_BROWSER_UNAVAILABLE, url)
                    return
                }
                callback.attach(session)
                session.requestPostMessageChannel(origin)
                TwaSessionHolder.hold(this@TwaLauncherActivity, callback, session)

                val twaIntent = TrustedWebActivityIntentBuilder(Uri.parse(url)).build(session)
                twaIntent.launchTrustedWebActivity(this@TwaLauncherActivity)
            }

            override fun onServiceDisconnected(name: ComponentName) {
                TwaSessionHolder.clear()
            }
        }
        connection = serviceConnection
        val bound = CustomTabsClient.bindCustomTabsService(this, provider, serviceConnection)
        if (!bound) {
            connection = null
            showFallback(OfflineActivity.REASON_BROWSER_UNAVAILABLE, url)
        }
    }

    private fun buildRouter(trustedOrigin: String): BridgeCommandRouter {
        val callerIdCache = CallerIdCache.fromContext(applicationContext)
        val syncStore = TenantSyncStateStore.fromContext(
            context = applicationContext,
            onClearTenant = { businessId -> callerIdCache.clearTenant(businessId) },
            onClearAll = { callerIdCache.clearAll() },
        )

        return BridgeCommandRouter(
            trustedOrigin = trustedOrigin,
            environment = BuildConfig.APP_ENVIRONMENT,
            appVersionName = BuildConfig.VERSION_NAME,
            appVersionCode = BuildConfig.VERSION_CODE,
            enabledCapabilities = listOf(
                BridgeProtocol.CAP_NOTIFICATIONS,
                BridgeProtocol.CAP_BARCODE_SCAN,
                BridgeProtocol.CAP_PRINTER,
                BridgeProtocol.CAP_CRM_CALLER_ID,
                BridgeProtocol.CAP_BIOMETRIC,
                BridgeProtocol.CAP_SHARE,
                BridgeProtocol.CAP_MEDIA_CAPTURE,
                BridgeProtocol.CAP_BACKGROUND_SYNC,
            ),
            notificationPermissionProvider = ::readNotificationPermissionState,
            installationIdProvider = { InstallationId.read(applicationContext) },
            notificationsRegisterHandler = ::handleNotificationsRegister,
            biometricStatusHandler = {
                CommandOutcome.Success(AndroidBiometricGateway.readStatus(applicationContext))
            },
            biometricAuthenticateHandler = ::handleBiometricAuthenticate,
            scannerScanHandler = ::handleScannerScan,
            mediaPickHandler = ::handleMediaPick,
            shareOpenHandler = { payload ->
                val title = payload.optString("title", "اشتراک‌گذاری")
                val text = payload.optString("text", "").takeIf { it.isNotBlank() }
                val url = payload.optString("url", "").takeIf { it.isNotBlank() }
                val chooser = AndroidMediaPickerAndShare.createShareChooserIntent(title, text, url)
                runOnUiThread { startActivity(chooser) }
                CommandOutcome.Success(JSONObject().put("shared", true))
            },
            printerDiscoverHandler = { payload ->
                handlePrinterDiscover(payload)
            },
            printerPrintHandler = { payload ->
                handlePrinterPrint(payload)
            },
            callerIdStatusHandler = { payload ->
                val businessId = payload.optString("businessId", "").takeIf { it.isNotBlank() }
                CommandOutcome.Success(
                    callerIdCache.status(
                        businessId = businessId,
                        roleHeld = CallerIdCache.isCallScreeningRoleHeld(applicationContext),
                        supported = CallerIdCache.isCallScreeningSupported(),
                    ),
                )
            },
            callerIdSyncHandler = { payload ->
                handleCallerIdSync(callerIdCache, payload)
            },
            syncStatusHandler = { payload ->
                val businessId = payload.optString("businessId", "").takeIf { it.isNotBlank() }
                CommandOutcome.Success(
                    syncStore.readStatus(
                        businessId = businessId,
                        networkAvailable = isNetworkReachable(),
                    ),
                )
            },
            syncTriggerHandler = { payload ->
                val action = payload.optString("action", "enqueue")
                val businessId = payload.optString("businessId", "").takeIf { it.isNotBlank() }
                val pendingCount = payload.optInt("pendingCount", 0)
                CommandOutcome.Success(
                    syncStore.recordSyncRequest(
                        businessId = businessId,
                        action = action,
                        pendingCount = pendingCount,
                    ),
                )
            },
        )
    }

    private fun readNotificationPermissionState(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val perm = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
            if (perm != PackageManager.PERMISSION_GRANTED) {
                return BridgeProtocol.PERMISSION_DENIED
            }
        }
        val manager = getSystemService(NotificationManager::class.java)
        return if (manager?.areNotificationsEnabled() != false) {
            BridgeProtocol.PERMISSION_GRANTED
        } else {
            BridgeProtocol.PERMISSION_DENIED
        }
    }

    private fun handleNotificationsRegister(payload: JSONObject): CommandOutcome {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            val latch = CountDownLatch(1)
            pendingNotificationPermissionResult.set(latch)
            runOnUiThread {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_POST_NOTIFICATIONS)
            }
            latch.await(15, TimeUnit.SECONDS)
        }

        val permissionState = readNotificationPermissionState()
        val requestedChannels = mutableListOf<String>()
        val channelsArr = payload.optJSONArray("channels")
        if (channelsArr != null) {
            for (i in 0 until channelsArr.length()) {
                val id = channelsArr.optString(i, "")
                if (BridgeProtocol.NOTIFICATION_CHANNELS.contains(id)) {
                    requestedChannels.add(id)
                }
            }
        }
        if (requestedChannels.isEmpty()) {
            requestedChannels.addAll(BridgeProtocol.NOTIFICATION_CHANNELS)
        }

        val token = NotificationChannelManager.resolvePushToken(applicationContext)
        return CommandOutcome.Success(
            JSONObject()
                .put("permission", permissionState)
                .put("token", token ?: JSONObject.NULL)
                .put("provider", if (token != null) "fcm" else "none")
                .put("channels", JSONArray(requestedChannels.distinct())),
        )
    }

    @Suppress("DEPRECATION")
    private fun handleBiometricAuthenticate(payload: JSONObject): CommandOutcome {
        val status = AndroidBiometricGateway.readStatus(applicationContext)
        if (!status.optBoolean("available", false)) {
            return CommandOutcome.Failure(
                BridgeProtocol.ERR_UNSUPPORTED_CAPABILITY,
                "Biometric or device credential lock is not available on this device.",
            )
        }
        val challengeId = payload.optString("challengeId", "").takeIf { it.isNotBlank() }
        val promptTitle = payload.optString("promptTitle", "تأیید هویت بیومتریک")
        val promptSubtitle = payload.optString("promptSubtitle", "برای ادامه هویت خود را تأیید کنید")

        val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            ?: return CommandOutcome.Failure(BridgeProtocol.ERR_UNSUPPORTED_CAPABILITY)

        val confirmIntent = keyguard.createConfirmDeviceCredentialIntent(promptTitle, promptSubtitle)
            ?: return CommandOutcome.Success(
                AndroidBiometricGateway.buildSuccessResult(
                    method = "biometric",
                    challengeId = challengeId,
                    verifiedAtIso = utcNowIso(),
                ),
            )

        val latch = CountDownLatch(1)
        pendingCredentialConfirmed.set(false)
        pendingCredentialConfirmLatch.set(latch)
        runOnUiThread {
            startActivityForResult(confirmIntent, REQ_CONFIRM_DEVICE_CREDENTIAL)
        }
        val completed = latch.await(45, TimeUnit.SECONDS)
        if (!completed) {
            return CommandOutcome.Failure(BridgeProtocol.ERR_TIMEOUT, "Biometric authentication timed out.")
        }
        return if (pendingCredentialConfirmed.get()) {
            CommandOutcome.Success(
                AndroidBiometricGateway.buildSuccessResult(
                    method = "biometric",
                    challengeId = challengeId,
                    verifiedAtIso = utcNowIso(),
                ),
            )
        } else {
            CommandOutcome.Failure(BridgeProtocol.ERR_USER_CANCELLED, "Biometric authentication cancelled.")
        }
    }

    private fun handleScannerScan(payload: JSONObject): CommandOutcome {
        // Prefer Google Code Scanner (permissionless) when bundled via reflection;
        // otherwise return unsupported_capability so the web client immediately uses its
        // camera/BarcodeDetector/manual fallback without crashing.
        return try {
            val scannerClass = Class.forName("com.google.mlkit.vision.codescanner.GmsBarcodeScanning")
            val getClient = scannerClass.getMethod("getClient", Context::class.java)
            val client = getClient.invoke(null, this)
            val startScan = client.javaClass.getMethod("startScan")
            val task = startScan.invoke(client)
            val latch = CountDownLatch(1)
            val scanOutcome = AtomicReference<CommandOutcome>(
                CommandOutcome.Failure(BridgeProtocol.ERR_USER_CANCELLED, "Scan cancelled."),
            )

            val onSuccessClass = Class.forName("com.google.android.gms.tasks.OnSuccessListener")
            val successProxy = java.lang.reflect.Proxy.newProxyInstance(
                onSuccessClass.classLoader,
                arrayOf(onSuccessClass),
            ) { _, method, args ->
                if (method.name == "onSuccess" && args != null && args.isNotEmpty() && args[0] != null) {
                    val barcode = args[0]
                    val rawValue = barcode.javaClass.getMethod("getRawValue").invoke(barcode) as? String ?: ""
                    val built = AndroidBarcodeScanner.buildScanResult(
                        rawValue = rawValue,
                        rawFormat = payload.optString("purpose", "code_128"),
                        source = "code_scanner",
                    )
                    scanOutcome.set(
                        if (built != null) {
                            CommandOutcome.Success(built)
                        } else {
                            CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "Empty barcode value.")
                        },
                    )
                    latch.countDown()
                }
                null
            }
            task.javaClass.getMethod("addOnSuccessListener", onSuccessClass).invoke(task, successProxy)
            val completed = latch.await(30, TimeUnit.SECONDS)
            if (!completed) {
                CommandOutcome.Failure(BridgeProtocol.ERR_TIMEOUT, "Barcode scan timed out.")
            } else {
                scanOutcome.get()
            }
        } catch (_: ClassNotFoundException) {
            CommandOutcome.Failure(
                BridgeProtocol.ERR_UNSUPPORTED_CAPABILITY,
                "Google Code Scanner is not bundled; fall back to web camera scanner.",
            )
        } catch (err: Exception) {
            CommandOutcome.Failure(
                BridgeProtocol.ERR_NATIVE_FAILURE,
                err.message ?: "Native barcode scan failed.",
            )
        }
    }

    @Suppress("DEPRECATION")
    private fun handleMediaPick(payload: JSONObject): CommandOutcome {
        val source = payload.optString("source", "document")
        val multiple = payload.optBoolean("multiple", false)
        val acceptArr = payload.optJSONArray("accept")
        val acceptTypes = mutableListOf<String>()
        if (acceptArr != null) {
            for (i in 0 until acceptArr.length()) {
                val mime = acceptArr.optString(i, "")
                if (mime.isNotBlank()) acceptTypes.add(mime)
            }
        }
        val intent = when (source) {
            "camera" -> Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            else -> Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = if (acceptTypes.size == 1) acceptTypes[0] else "*/*"
                if (acceptTypes.size > 1) {
                    putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes.toTypedArray())
                }
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
            }
        }

        val latch = CountDownLatch(1)
        pendingActivityResultData.set(null)
        pendingActivityResultLatch.set(latch)
        runOnUiThread {
            startActivityForResult(intent, REQ_PICK_MEDIA)
        }
        val completed = latch.await(60, TimeUnit.SECONDS)
        if (!completed) {
            return CommandOutcome.Failure(BridgeProtocol.ERR_TIMEOUT, "Media picker timed out.")
        }
        val (resultCode, resultIntent) = pendingActivityResultData.get()
            ?: return CommandOutcome.Failure(BridgeProtocol.ERR_USER_CANCELLED, "Media selection cancelled.")
        if (resultCode != RESULT_OK || resultIntent == null) {
            return CommandOutcome.Failure(BridgeProtocol.ERR_USER_CANCELLED, "Media selection cancelled.")
        }

        val filesArray = JSONArray()
        val singleUri = resultIntent.data
        if (singleUri != null) {
            readPickedUri(singleUri, if (source == "camera") "camera" else "document_picker")?.let {
                filesArray.put(it)
            }
        }
        return CommandOutcome.Success(JSONObject().put("files", filesArray))
    }

    private fun readPickedUri(uri: Uri, sourceLabel: String): JSONObject? {
        return try {
            val mimeType = contentResolver.getType(uri) ?: "application/octet-stream"
            val bytes = contentResolver.openInputStream(uri)?.use { input ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(8192)
                var total = 0
                while (true) {
                    val read = input.read(buf)
                    if (read <= 0) break
                    total += read
                    if (total > AndroidMediaPickerAndShare.MAX_FILE_BYTES) {
                        return null
                    }
                    out.write(buf, 0, read)
                }
                out.toByteArray()
            } ?: return null

            val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
            AndroidMediaPickerAndShare.buildPickedFileJson(
                name = uri.lastPathSegment ?: "attachment",
                mimeType = mimeType,
                sizeBytes = bytes.size,
                base64Data = base64,
                source = sourceLabel,
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun handlePrinterDiscover(payload: JSONObject): CommandOutcome {
        val transport = payload.optString("transport", "all")
        val includeBluetooth = payload.optBoolean("includeBluetooth", true) || transport == "bluetooth" || transport == "all"
        if (includeBluetooth &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            AndroidPrintingGateway.checkBluetoothPermissionState(applicationContext) != BridgeProtocol.PERMISSION_GRANTED
        ) {
            val latch = CountDownLatch(1)
            pendingBluetoothPermissionResult.set(latch)
            runOnUiThread {
                requestPermissions(
                    arrayOf(
                        Manifest.permission.BLUETOOTH_CONNECT,
                        Manifest.permission.BLUETOOTH_SCAN,
                    ),
                    REQ_BLUETOOTH_PERMISSIONS,
                )
            }
            latch.await(15, TimeUnit.SECONDS)
        }
        val discovered = AndroidPrintingGateway.discoverPrinters(
            context = applicationContext,
            includeBluetooth = includeBluetooth,
        )
        return CommandOutcome.Success(discovered)
    }

    private fun handlePrinterPrint(payload: JSONObject): CommandOutcome {
        val transport = payload.optString("transport", "")
        val targetAddress = payload.optString("targetAddress", "")
        val dataBase64 = payload.optString("dataBase64", "")
        val jobName = payload.optString("jobName", "Biza Miz Print Job")
        val rawBytes = AndroidPrintingGateway.decodePrintPayload(dataBase64)
            ?: return CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "Invalid base64 print payload.")

        return when (transport) {
            "network_tcp" -> {
                val (host, port) = AndroidPrintingGateway.parseNetworkHostPort(targetAddress)
                    ?: return CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "Invalid network printer address.")
                val ok = AndroidPrintingGateway.sendRawTcp(host, port, rawBytes)
                if (ok) {
                    CommandOutcome.Success(
                        AndroidPrintingGateway.buildPrintResult(
                            printed = true,
                            transport = "network_tcp",
                            jobId = jobName,
                            bytesSent = rawBytes.size,
                        ),
                    )
                } else {
                    CommandOutcome.Failure(BridgeProtocol.ERR_NATIVE_FAILURE, "Network TCP print failed.")
                }
            }
            "bluetooth" -> {
                val ok = AndroidPrintingGateway.sendRawBluetooth(applicationContext, targetAddress, rawBytes)
                if (ok) {
                    CommandOutcome.Success(
                        AndroidPrintingGateway.buildPrintResult(
                            printed = true,
                            transport = "bluetooth",
                            jobId = jobName,
                            bytesSent = rawBytes.size,
                        ),
                    )
                } else {
                    CommandOutcome.Failure(BridgeProtocol.ERR_NATIVE_FAILURE, "Bluetooth print failed.")
                }
            }
            "system_print" -> {
                CommandOutcome.Success(
                    AndroidPrintingGateway.buildPrintResult(
                        printed = true,
                        transport = "system_print",
                        jobId = jobName,
                        bytesSent = rawBytes.size,
                    ),
                )
            }
            "pdf_share" -> {
                val chooser = AndroidMediaPickerAndShare.createShareChooserIntent(
                    title = jobName,
                    text = jobName,
                    url = null,
                )
                runOnUiThread { startActivity(chooser) }
                CommandOutcome.Success(
                    AndroidPrintingGateway.buildPrintResult(
                        printed = true,
                        transport = "pdf_share",
                        jobId = jobName,
                        bytesSent = rawBytes.size,
                    ),
                )
            }
            else -> CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "Unsupported print transport.")
        }
    }

    private fun handleCallerIdSync(callerIdCache: CallerIdCache, payload: JSONObject): CommandOutcome {
        val businessId = payload.optString("businessId", "")
        val entriesArr = payload.optJSONArray("entries")
            ?: return CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "Missing callerId entries.")
        val parsedEntries = mutableListOf<CallerIdCache.CallerEntry>()
        for (i in 0 until entriesArr.length()) {
            val item = entriesArr.optJSONObject(i) ?: continue
            val customerId = item.optString("customerId", "")
            val displayName = item.optString("displayName", "")
            val phone = item.optString("phoneNormalized", "")
            if (customerId.isBlank() || displayName.isBlank() || phone.isBlank()) continue
            val tags = mutableListOf<String>()
            val tagsArr = item.optJSONArray("tags")
            if (tagsArr != null) {
                for (t in 0 until tagsArr.length()) {
                    val tag = tagsArr.optString(t, "")
                    if (tag.isNotBlank()) tags.add(tag)
                }
            }
            parsedEntries.add(
                CallerIdCache.CallerEntry(
                    customerId = customerId,
                    displayName = displayName,
                    phoneNormalized = phone,
                    organizationName = item.optString("organizationName", "").takeIf { it.isNotBlank() },
                    tags = tags,
                ),
            )
        }
        val syncedCount = callerIdCache.syncTenantEntries(
            businessId = businessId,
            entries = parsedEntries,
            syncedAtIso = utcNowIso(),
        )
        return CommandOutcome.Success(
            JSONObject()
                .put("supported", CallerIdCache.isCallScreeningSupported())
                .put("roleHeld", CallerIdCache.isCallScreeningRoleHeld(applicationContext))
                .put("syncedCount", syncedCount),
        )
    }

    private fun isNetworkReachable(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return false
        val network = cm.activeNetwork ?: return false
        val capabilities = cm.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun showFallback(reason: String, url: String?) {
        startActivity(OfflineActivity.intent(this, reason, url))
        finish()
    }

    companion object {
        private const val REQ_POST_NOTIFICATIONS = 1001
        private const val REQ_BLUETOOTH_PERMISSIONS = 1002
        private const val REQ_CONFIRM_DEVICE_CREDENTIAL = 1003
        private const val REQ_PICK_MEDIA = 1004

        private fun utcNowIso(): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.format(Date())
    }
}
