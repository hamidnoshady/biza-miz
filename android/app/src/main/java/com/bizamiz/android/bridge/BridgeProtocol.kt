package com.bizamiz.android.bridge

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Kotlin mirror of `config/native-bridge-contract.json` and
 * `src/lib/native/bridge-contract.ts` (issue #884).
 *
 * `BridgeContractTest` verifies at test time that these constants match the
 * shared JSON contract file in the repository root.
 */
object BridgeProtocol {
    const val PROTOCOL: String = "biza-native-bridge"
    const val PROTOCOL_NAME: String = PROTOCOL
    const val BRIDGE_VERSION: Int = 3
    const val MIN_COMPATIBLE_BRIDGE_VERSION: Int = 1

    const val CMD_APP_INFO: String = "app.info"
    const val CMD_NOTIFICATIONS_STATUS: String = "notifications.status"
    const val CMD_DEVICE_IDENTITY: String = "device.identity"
    const val CMD_NOTIFICATIONS_REGISTER: String = "notifications.register"
    const val CMD_BIOMETRIC_STATUS: String = "biometric.status"
    const val CMD_BIOMETRIC_AUTHENTICATE: String = "biometric.authenticate"
    const val CMD_SCANNER_SCAN: String = "scanner.scan"
    const val CMD_MEDIA_PICK: String = "media.pick"
    const val CMD_SHARE_OPEN: String = "share.open"
    const val CMD_PRINTER_DISCOVER: String = "printer.discover"
    const val CMD_PRINTER_PRINT: String = "printer.print"
    const val CMD_CRM_CALLER_ID_STATUS: String = "crm.callerId.status"
    const val CMD_CRM_CALLER_ID_SYNC: String = "crm.callerId.sync"
    const val CMD_SYNC_STATUS: String = "sync.status"
    const val CMD_SYNC_TRIGGER: String = "sync.trigger"

    val ALLOWLISTED_COMMANDS: Set<String> = setOf(
        CMD_APP_INFO,
        CMD_NOTIFICATIONS_STATUS,
        CMD_DEVICE_IDENTITY,
        CMD_NOTIFICATIONS_REGISTER,
        CMD_BIOMETRIC_STATUS,
        CMD_BIOMETRIC_AUTHENTICATE,
        CMD_SCANNER_SCAN,
        CMD_MEDIA_PICK,
        CMD_SHARE_OPEN,
        CMD_PRINTER_DISCOVER,
        CMD_PRINTER_PRINT,
        CMD_CRM_CALLER_ID_STATUS,
        CMD_CRM_CALLER_ID_SYNC,
        CMD_SYNC_STATUS,
        CMD_SYNC_TRIGGER,
    )

    val COMMANDS: Set<String> = ALLOWLISTED_COMMANDS

    val COMMAND_MIN_BRIDGE: Map<String, Int> = mapOf(
        CMD_APP_INFO to 1,
        CMD_NOTIFICATIONS_STATUS to 1,
        CMD_DEVICE_IDENTITY to 2,
        CMD_NOTIFICATIONS_REGISTER to 3,
        CMD_BIOMETRIC_STATUS to 3,
        CMD_BIOMETRIC_AUTHENTICATE to 3,
        CMD_SCANNER_SCAN to 3,
        CMD_MEDIA_PICK to 3,
        CMD_SHARE_OPEN to 3,
        CMD_PRINTER_DISCOVER to 3,
        CMD_PRINTER_PRINT to 3,
        CMD_CRM_CALLER_ID_STATUS to 3,
        CMD_CRM_CALLER_ID_SYNC to 3,
        CMD_SYNC_STATUS to 3,
        CMD_SYNC_TRIGGER to 3,
    )

    const val EVENT_BRIDGE_READY: String = "bridge.ready"
    const val EVENT_NAVIGATION_DEEP_LINK: String = "navigation.deepLink"
    const val EVENT_CRM_CALL_ENDED: String = "crm.callEnded"
    const val EVENT_SYNC_COMPLETED: String = "sync.completed"

    const val EVT_BRIDGE_READY: String = EVENT_BRIDGE_READY
    const val EVT_NAVIGATION_DEEP_LINK: String = EVENT_NAVIGATION_DEEP_LINK
    const val EVT_CRM_CALL_ENDED: String = EVENT_CRM_CALL_ENDED
    const val EVT_SYNC_COMPLETED: String = EVENT_SYNC_COMPLETED

    val ALLOWLISTED_EVENTS: Set<String> = setOf(
        EVENT_BRIDGE_READY,
        EVENT_NAVIGATION_DEEP_LINK,
        EVENT_CRM_CALL_ENDED,
        EVENT_SYNC_COMPLETED,
    )

    val EVENTS: Set<String> = ALLOWLISTED_EVENTS

    const val ERR_UNKNOWN_COMMAND: String = "unknown_command"
    const val ERR_INVALID_PAYLOAD: String = "invalid_payload"
    const val ERR_UNTRUSTED_ORIGIN: String = "untrusted_origin"
    const val ERR_UNSUPPORTED_CAPABILITY: String = "unsupported_capability"
    const val ERR_PERMISSION_DENIED: String = "permission_denied"
    const val ERR_BRIDGE_VERSION_TOO_OLD: String = "bridge_version_too_old"
    const val ERR_BRIDGE_UNAVAILABLE: String = "bridge_unavailable"
    const val ERR_TIMEOUT: String = "timeout"
    const val ERR_CHANNEL_CLOSED: String = "channel_closed"
    const val ERR_NATIVE_FAILURE: String = "native_failure"
    const val ERR_USER_CANCELLED: String = "user_cancelled"

    val ERROR_CODES: Set<String> = setOf(
        ERR_UNKNOWN_COMMAND,
        ERR_INVALID_PAYLOAD,
        ERR_UNTRUSTED_ORIGIN,
        ERR_UNSUPPORTED_CAPABILITY,
        ERR_PERMISSION_DENIED,
        ERR_BRIDGE_VERSION_TOO_OLD,
        ERR_BRIDGE_UNAVAILABLE,
        ERR_TIMEOUT,
        ERR_CHANNEL_CLOSED,
        ERR_NATIVE_FAILURE,
        ERR_USER_CANCELLED,
    )

    const val PERMISSION_GRANTED: String = "granted"
    const val PERMISSION_DENIED: String = "denied"
    const val PERMISSION_NOT_DETERMINED: String = "not_determined"

    val PERMISSION_STATES: Set<String> = setOf(
        PERMISSION_GRANTED,
        PERMISSION_DENIED,
        PERMISSION_NOT_DETERMINED,
    )

    val ENVIRONMENTS: Set<String> = setOf(
        "development",
        "staging",
        "production",
    )

    const val CAP_BARCODE_SCAN: String = "barcode.scan"
    const val CAP_PRINTER: String = "printer"
    const val CAP_CRM_CALLER_ID: String = "crm.caller-id"
    const val CAP_BIOMETRIC: String = "biometric"
    const val CAP_NOTIFICATIONS: String = "notifications"
    const val CAP_SHARE: String = "share"
    const val CAP_MEDIA_CAPTURE: String = "media.capture"
    const val CAP_BACKGROUND_SYNC: String = "background.sync"

    val CAPABILITIES: Set<String> = setOf(
        CAP_BARCODE_SCAN,
        CAP_PRINTER,
        CAP_CRM_CALLER_ID,
        CAP_BIOMETRIC,
        CAP_NOTIFICATIONS,
        CAP_SHARE,
        CAP_MEDIA_CAPTURE,
        CAP_BACKGROUND_SYNC,
    )

    val CAPABILITY_MIN_BRIDGE: Map<String, Int> = mapOf(
        CAP_BARCODE_SCAN to 3,
        CAP_PRINTER to 3,
        CAP_CRM_CALLER_ID to 3,
        CAP_BIOMETRIC to 3,
        CAP_NOTIFICATIONS to 1,
        CAP_SHARE to 3,
        CAP_MEDIA_CAPTURE to 3,
        CAP_BACKGROUND_SYNC to 3,
    )

    val NOTIFICATION_CHANNELS: Set<String> = setOf(
        "orders",
        "payments",
        "crm",
        "inventory",
        "approvals",
        "operations",
        "security",
    )

    private val REQUEST_ID_REGEX = Regex("^[A-Za-z0-9_-]{1,64}$")

    fun isValidRequestId(id: String?): Boolean =
        id != null && REQUEST_ID_REGEX.matches(id)

    data class RequestEnvelope(
        val v: Int,
        val id: String,
        val command: String,
        val payload: JSONObject,
    )

    /**
     * Parses a raw JSON string into a [RequestEnvelope]. Returns `null` if the
     * string is not a valid request envelope or has an invalid request id or
     * unsupported protocol version. Note that `command` is NOT filtered against
     * [ALLOWLISTED_COMMANDS] here so that [BridgeCommandRouter] can reply with a
     * structured `unknown_command` error envelope bearing the caller's request `id`.
     */
    fun parseRequestEnvelope(raw: String): RequestEnvelope? {
        if (raw.isBlank() || raw.length > 65_536) return null
        val obj = try {
            JSONObject(raw)
        } catch (_: JSONException) {
            return null
        }
        val version = obj.optInt("v", -1)
        if (version < MIN_COMPATIBLE_BRIDGE_VERSION || version > BRIDGE_VERSION) return null
        if (obj.optString("kind", "") != "request") return null
        val id = obj.optString("id", "")
        if (!isValidRequestId(id)) return null
        val command = obj.optString("command", "")
        if (command.isEmpty() || command.length > 64) return null
        val payload = obj.optJSONObject("payload") ?: return null
        return RequestEnvelope(v = version, id = id, command = command, payload = payload)
    }

    fun encodeSuccessResponse(id: String, result: JSONObject): String =
        JSONObject()
            .put("v", BRIDGE_VERSION)
            .put("kind", "response")
            .put("id", id)
            .put("ok", true)
            .put("result", result)
            .toString()

    fun encodeErrorResponse(id: String, code: String, message: String? = null): String {
        val safeCode = if (ERROR_CODES.contains(code)) code else ERR_NATIVE_FAILURE
        val errorObj = JSONObject().put("code", safeCode)
        if (!message.isNullOrBlank()) {
            errorObj.put("message", message.take(200))
        }
        return JSONObject()
            .put("v", BRIDGE_VERSION)
            .put("kind", "response")
            .put("id", id)
            .put("ok", false)
            .put("error", errorObj)
            .toString()
    }

    fun encodeEvent(name: String, payload: JSONObject): String {
        require(ALLOWLISTED_EVENTS.contains(name)) { "Event not in allowlist: $name" }
        return JSONObject()
            .put("v", BRIDGE_VERSION)
            .put("kind", "event")
            .put("name", name)
            .put("payload", payload)
            .toString()
    }

    fun buildAppInfoPayload(
        appVersionName: String,
        appVersionCode: Int,
        environment: String,
        capabilities: List<String>,
    ): JSONObject {
        val validCapabilities = capabilities.filter { CAPABILITIES.contains(it) }.distinct()
        return JSONObject()
            .put("appVersionName", appVersionName)
            .put("appVersionCode", appVersionCode)
            .put("environment", environment)
            .put("bridgeVersion", BRIDGE_VERSION)
            .put("capabilities", JSONArray(validCapabilities))
    }

    /**
     * Canonical builder for `crm.callEnded` event payloads matching
     * `parseCrmCallEndedEvent` in `src/lib/native/bridge-contract.ts`:
     * `{ phoneNormalized, direction, durationSeconds, customerId, customerName, endedAt }`.
     */
    fun buildCrmCallEndedEventPayload(
        phoneNormalized: String,
        direction: String,
        durationSeconds: Int,
        customerId: String?,
        customerName: String?,
        endedAt: String,
    ): JSONObject {
        require(phoneNormalized.isNotBlank()) { "phoneNormalized is required" }
        require(direction == "incoming" || direction == "outgoing") {
            "Invalid call direction: $direction"
        }
        require(durationSeconds >= 0) { "durationSeconds must be >= 0" }
        require(endedAt.isNotBlank()) { "endedAt is required" }
        return JSONObject()
            .put("phoneNormalized", phoneNormalized)
            .put("direction", direction)
            .put("durationSeconds", durationSeconds)
            .put("customerId", customerId?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
            .put("customerName", customerName?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
            .put("endedAt", endedAt)
    }

    /**
     * Canonical builder for `navigation.deepLink` event payloads matching
     * `parseDeepLinkEvent` in `src/lib/native/bridge-contract.ts`:
     * `{ path, notificationCategory, businessId }`.
     */
    fun buildNavigationDeepLinkEventPayload(
        path: String,
        businessId: String?,
        notificationCategory: String? = null,
    ): JSONObject {
        require(path.startsWith("/") && !path.startsWith("//")) {
            "Deep link path must be a single-slash internal path"
        }
        val validCategory = notificationCategory?.trim()?.takeIf { NOTIFICATION_CHANNELS.contains(it) }
        return JSONObject()
            .put("path", path)
            .put("notificationCategory", validCategory ?: JSONObject.NULL)
            .put("businessId", businessId?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
    }

    /**
     * Canonical builder for `sync.completed` event payloads matching
     * `parseSyncCompletedEvent` in `src/lib/native/bridge-contract.ts`:
     * `{ businessId, syncedAt, revoked, flushedCount }`.
     */
    fun buildSyncCompletedEventPayload(
        businessId: String?,
        syncedAt: String,
        revoked: Boolean,
        flushedCount: Int,
    ): JSONObject {
        require(syncedAt.isNotBlank()) { "syncedAt is required" }
        return JSONObject()
            .put("businessId", businessId?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
            .put("syncedAt", syncedAt)
            .put("revoked", revoked)
            .put("flushedCount", flushedCount.coerceAtLeast(0))
    }
}
