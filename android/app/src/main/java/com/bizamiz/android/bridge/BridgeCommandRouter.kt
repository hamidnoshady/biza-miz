package com.bizamiz.android.bridge

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure, testable command router for the Biza Miz native bridge (issue #884).
 *
 * Security invariants enforced here:
 * 1. Only messages from [trustedOrigin] (exact scheme + host + port match) are accepted.
 * 2. Only valid v1..v3 request envelopes are accepted.
 * 3. Only commands in [BridgeProtocol.ALLOWLISTED_COMMANDS] are executed.
 * 4. Capability-gated commands require their capability to be present in [enabledCapabilities].
 * 5. No reflection, shell execution, or dynamic class loading.
 */
class BridgeCommandRouter(
    trustedOrigin: String,
    private val appVersionName: String,
    private val appVersionCode: Int,
    private val environment: String,
    private val enabledCapabilities: List<String>,
    private val notificationPermissionProvider: () -> String,
    private val installationIdProvider: () -> String,
    private val notificationsRegisterHandler: (JSONObject) -> CommandOutcome = { payload ->
        val perm = notificationPermissionProvider()
        val safePerm = if (BridgeProtocol.PERMISSION_STATES.contains(perm)) perm else BridgeProtocol.PERMISSION_NOT_DETERMINED
        val requestedChannels = mutableListOf<String>()
        val rawChannels = payload.optJSONArray("channels")
        if (rawChannels != null) {
            for (i in 0 until rawChannels.length()) {
                val ch = rawChannels.optString(i, "")
                if (BridgeProtocol.NOTIFICATION_CHANNELS.contains(ch) && !requestedChannels.contains(ch)) {
                    requestedChannels.add(ch)
                }
            }
        } else {
            requestedChannels.addAll(BridgeProtocol.NOTIFICATION_CHANNELS)
        }
        CommandOutcome.Success(
            JSONObject()
                .put("permission", safePerm)
                .put("fcmToken", JSONObject.NULL)
                .put("channels", JSONArray(requestedChannels))
                .put("pushProvider", "none"),
        )
    },
    private val biometricStatusHandler: (JSONObject) -> CommandOutcome = {
        val available = enabledCapabilities.contains(BridgeProtocol.CAP_BIOMETRIC)
        CommandOutcome.Success(
            JSONObject()
                .put("available", available)
                .put("enrolled", available)
                .put("strength", if (available) "strong" else "none")
                .put("credentialManagerAvailable", available),
        )
    },
    private val biometricAuthenticateHandler: (JSONObject) -> CommandOutcome = {
        CommandOutcome.Failure(BridgeProtocol.ERR_UNSUPPORTED_CAPABILITY, "Biometric prompt requires foreground activity.")
    },
    private val scannerScanHandler: (JSONObject) -> CommandOutcome = {
        CommandOutcome.Failure(BridgeProtocol.ERR_UNSUPPORTED_CAPABILITY, "Scanner requires foreground activity.")
    },
    private val mediaPickHandler: (JSONObject) -> CommandOutcome = {
        CommandOutcome.Failure(BridgeProtocol.ERR_UNSUPPORTED_CAPABILITY, "Media picker requires foreground activity.")
    },
    private val shareOpenHandler: (JSONObject) -> CommandOutcome = {
        CommandOutcome.Success(
            JSONObject()
                .put("shared", true)
                .put("target", "android_chooser"),
        )
    },
    private val printerDiscoverHandler: (JSONObject) -> CommandOutcome = {
        val printers = JSONArray().put(
            JSONObject()
                .put("id", "system_print")
                .put("name", "Android System Print")
                .put("transport", "system_print")
                .put("address", JSONObject.NULL)
                .put("paperWidthMm", 80)
                .put("online", true),
        )
        CommandOutcome.Success(
            JSONObject()
                .put("printers", printers)
                .put("bluetoothPermission", BridgeProtocol.PERMISSION_NOT_DETERMINED),
        )
    },
    private val printerPrintHandler: (JSONObject) -> CommandOutcome = { payload ->
        val transport = payload.optString("transport", "system_print")
        val dataBase64 = payload.optString("dataBase64", "")
        CommandOutcome.Success(
            JSONObject()
                .put("printed", true)
                .put("transport", transport)
                .put("jobId", "android-job-${System.currentTimeMillis()}")
                .put("bytesSent", dataBase64.length),
        )
    },
    private val callerIdStatusHandler: (JSONObject) -> CommandOutcome = { payload ->
        val businessId = payload.optString("businessId", "").takeIf { it.isNotBlank() }
        CommandOutcome.Success(
            JSONObject()
                .put("roleHeld", false)
                .put("supported", true)
                .put("cachedCustomerCount", 0)
                .put("businessId", businessId ?: JSONObject.NULL)
                .put("lastSyncedAt", JSONObject.NULL),
        )
    },
    private val callerIdSyncHandler: (JSONObject) -> CommandOutcome = { payload ->
        val businessId = payload.optString("businessId", "")
        val entries = payload.optJSONArray("entries") ?: JSONArray()
        CommandOutcome.Success(
            JSONObject()
                .put("roleHeld", false)
                .put("syncedCount", entries.length())
                .put("businessId", businessId),
        )
    },
    private val syncStatusHandler: (JSONObject) -> CommandOutcome = { payload ->
        val businessId = payload.optString("businessId", "").takeIf { it.isNotBlank() }
        CommandOutcome.Success(
            JSONObject()
                .put("scheduled", false)
                .put("networkAvailable", true)
                .put("businessId", businessId ?: JSONObject.NULL)
                .put("pendingCount", 0)
                .put("lastSyncedAt", JSONObject.NULL)
                .put("revoked", false),
        )
    },
    private val syncTriggerHandler: (JSONObject) -> CommandOutcome = { payload ->
        val action = payload.optString("action", "enqueue")
        val businessId = payload.optString("businessId", "").takeIf { it.isNotBlank() }
        CommandOutcome.Success(
            JSONObject()
                .put("scheduled", action == "enqueue" || action == "immediate")
                .put("action", action)
                .put("businessId", businessId ?: JSONObject.NULL)
                .put("clearedEntries", 0),
        )
    },
) {
    sealed class CommandOutcome {
        data class Success(val result: JSONObject) : CommandOutcome()
        data class Failure(val code: String, val message: String? = null) : CommandOutcome()
    }

    private val normalizedTrustedOrigin: String = normalizeOrigin(trustedOrigin)

    fun isOriginTrusted(origin: Uri?): Boolean {
        if (origin == null || normalizedTrustedOrigin.isEmpty()) return false
        return normalizeUriOrigin(origin) == normalizedTrustedOrigin
    }

    fun isOriginTrusted(origin: String?): Boolean {
        if (origin.isNullOrBlank() || normalizedTrustedOrigin.isEmpty()) return false
        return normalizeOrigin(origin) == normalizedTrustedOrigin
    }

    /**
     * Handles an incoming raw string message from a PostMessage channel.
     *
     * @param senderOrigin Origin reported for the web frame that sent the message.
     * @param rawMessage Raw JSON string sent over the port.
     * @return Encoded JSON response string, or `null` if the message is not a
     *   parseable request envelope (so random non-bridge frames are ignored).
     */
    fun handleMessage(senderOrigin: String?, rawMessage: String): String? {
        val request = BridgeProtocol.parseRequestEnvelope(rawMessage) ?: return null
        if (!isOriginTrusted(senderOrigin)) {
            return BridgeProtocol.encodeErrorResponse(
                id = request.id,
                code = BridgeProtocol.ERR_UNTRUSTED_ORIGIN,
                message = "Origin is not permitted to invoke native bridge commands.",
            )
        }
        if (!BridgeProtocol.ALLOWLISTED_COMMANDS.contains(request.command)) {
            return BridgeProtocol.encodeErrorResponse(
                id = request.id,
                code = BridgeProtocol.ERR_UNKNOWN_COMMAND,
                message = "Command is not in the native bridge allowlist.",
            )
        }

        val requiredCapability = REQUIRED_CAPABILITY[request.command]
        if (requiredCapability != null && !enabledCapabilities.contains(requiredCapability)) {
            return BridgeProtocol.encodeErrorResponse(
                id = request.id,
                code = BridgeProtocol.ERR_UNSUPPORTED_CAPABILITY,
                message = "Capability '$requiredCapability' is not enabled on this build.",
            )
        }

        return try {
            val outcome = dispatchCommand(request.command, request.payload)
            when (outcome) {
                is CommandOutcome.Success -> BridgeProtocol.encodeSuccessResponse(request.id, outcome.result)
                is CommandOutcome.Failure -> BridgeProtocol.encodeErrorResponse(request.id, outcome.code, outcome.message)
            }
        } catch (_: Exception) {
            BridgeProtocol.encodeErrorResponse(
                id = request.id,
                code = BridgeProtocol.ERR_NATIVE_FAILURE,
                message = "Native command execution failed.",
            )
        }
    }

    private fun dispatchCommand(command: String, payload: JSONObject): CommandOutcome {
        return when (command) {
            BridgeProtocol.CMD_APP_INFO -> CommandOutcome.Success(buildAppInfoResult())
            BridgeProtocol.CMD_NOTIFICATIONS_STATUS -> CommandOutcome.Success(buildNotificationStatusResult())
            BridgeProtocol.CMD_DEVICE_IDENTITY -> CommandOutcome.Success(buildDeviceIdentityResult())
            BridgeProtocol.CMD_NOTIFICATIONS_REGISTER -> notificationsRegisterHandler(payload)
            BridgeProtocol.CMD_BIOMETRIC_STATUS -> biometricStatusHandler(payload)
            BridgeProtocol.CMD_BIOMETRIC_AUTHENTICATE -> biometricAuthenticateHandler(payload)
            BridgeProtocol.CMD_SCANNER_SCAN -> scannerScanHandler(payload)
            BridgeProtocol.CMD_MEDIA_PICK -> {
                val mode = payload.optString("mode", "document")
                if (mode != "camera" && mode != "document" && mode != "gallery") {
                    return CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "Invalid media.pick mode.")
                }
                mediaPickHandler(payload)
            }
            BridgeProtocol.CMD_SHARE_OPEN -> {
                val title = payload.optString("title", "")
                if (title.isBlank() || title.length > 200) {
                    return CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "share.open requires a non-empty title.")
                }
                shareOpenHandler(payload)
            }
            BridgeProtocol.CMD_PRINTER_DISCOVER -> printerDiscoverHandler(payload)
            BridgeProtocol.CMD_PRINTER_PRINT -> {
                val transport = payload.optString("transport", "")
                val dataBase64 = payload.optString("dataBase64", "")
                if (!VALID_PRINTER_TRANSPORTS.contains(transport) || dataBase64.isBlank()) {
                    return CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "Invalid printer.print payload.")
                }
                printerPrintHandler(payload)
            }
            BridgeProtocol.CMD_CRM_CALLER_ID_STATUS -> callerIdStatusHandler(payload)
            BridgeProtocol.CMD_CRM_CALLER_ID_SYNC -> {
                val businessId = payload.optString("businessId", "")
                if (businessId.isBlank() || businessId.length > 64) {
                    return CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "crm.callerId.sync requires businessId.")
                }
                callerIdSyncHandler(payload)
            }
            BridgeProtocol.CMD_SYNC_STATUS -> syncStatusHandler(payload)
            BridgeProtocol.CMD_SYNC_TRIGGER -> {
                val action = payload.optString("action", "")
                if (!VALID_SYNC_ACTIONS.contains(action)) {
                    return CommandOutcome.Failure(BridgeProtocol.ERR_INVALID_PAYLOAD, "Invalid sync.trigger action.")
                }
                syncTriggerHandler(payload)
            }
            else -> CommandOutcome.Failure(BridgeProtocol.ERR_UNKNOWN_COMMAND)
        }
    }

    fun buildAppInfoResult(): JSONObject =
        BridgeProtocol.buildAppInfoPayload(
            appVersionName = appVersionName,
            appVersionCode = appVersionCode,
            environment = environment,
            capabilities = enabledCapabilities,
        )

    private fun buildNotificationStatusResult(): JSONObject {
        val rawState = notificationPermissionProvider()
        val safeState = if (BridgeProtocol.PERMISSION_STATES.contains(rawState)) {
            rawState
        } else {
            BridgeProtocol.PERMISSION_NOT_DETERMINED
        }
        return JSONObject().put("permission", safeState)
    }

    private fun buildDeviceIdentityResult(): JSONObject {
        val id = installationIdProvider()
        check(InstallationId.isValid(id)) { "Invalid installationId from provider" }
        return JSONObject().put("installationId", id)
    }

    companion object {
        private val REQUIRED_CAPABILITY: Map<String, String> = mapOf(
            BridgeProtocol.CMD_NOTIFICATIONS_REGISTER to BridgeProtocol.CAP_NOTIFICATIONS,
            BridgeProtocol.CMD_BIOMETRIC_AUTHENTICATE to BridgeProtocol.CAP_BIOMETRIC,
            BridgeProtocol.CMD_SCANNER_SCAN to BridgeProtocol.CAP_BARCODE_SCAN,
            BridgeProtocol.CMD_MEDIA_PICK to BridgeProtocol.CAP_MEDIA_CAPTURE,
            BridgeProtocol.CMD_SHARE_OPEN to BridgeProtocol.CAP_SHARE,
            BridgeProtocol.CMD_PRINTER_DISCOVER to BridgeProtocol.CAP_PRINTER,
            BridgeProtocol.CMD_PRINTER_PRINT to BridgeProtocol.CAP_PRINTER,
            BridgeProtocol.CMD_CRM_CALLER_ID_SYNC to BridgeProtocol.CAP_CRM_CALLER_ID,
            BridgeProtocol.CMD_SYNC_TRIGGER to BridgeProtocol.CAP_BACKGROUND_SYNC,
        )

        private val VALID_PRINTER_TRANSPORTS: Set<String> = setOf(
            "system_print",
            "network_tcp",
            "bluetooth",
            "pdf_share",
        )

        private val VALID_SYNC_ACTIONS: Set<String> = setOf(
            "enqueue",
            "immediate",
            "clear_tenant",
            "clear_all",
        )

        fun normalizeOrigin(raw: String): String {
            val trimmed = raw.trim().trimEnd('/')
            if (trimmed.isEmpty()) return ""
            return try {
                val uri = java.net.URI(trimmed)
                val scheme = uri.scheme?.lowercase() ?: return ""
                val host = uri.host?.lowercase() ?: return ""
                if (scheme != "https" && scheme != "http") return ""
                val port = uri.port
                val defaultPort = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
                if (port > 0 && !defaultPort) "$scheme://$host:$port" else "$scheme://$host"
            } catch (_: Exception) {
                ""
            }
        }

        private fun normalizeUriOrigin(uri: Uri): String {
            val scheme = uri.scheme?.lowercase() ?: return ""
            val host = uri.host?.lowercase() ?: return ""
            if (scheme != "https" && scheme != "http") return ""
            val port = uri.port
            val defaultPort = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
            return if (port > 0 && !defaultPort) "$scheme://$host:$port" else "$scheme://$host"
        }
    }
}
