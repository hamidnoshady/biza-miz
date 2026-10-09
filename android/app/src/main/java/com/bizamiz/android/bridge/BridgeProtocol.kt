package com.bizamiz.android.bridge

import com.bizamiz.android.BuildConfig
import org.json.JSONException
import org.json.JSONObject

/**
 * Frame encoding for the Web ↔ app bridge (issue #884).
 *
 * The allowlists here mirror config/native-bridge-contract.json. BridgeContractTest fails if
 * they drift, so change both files together and keep the protocol version in step.
 */
object BridgeProtocol {
    const val PROTOCOL = "biza-native-bridge"

    val BRIDGE_VERSION: Int = BuildConfig.NATIVE_BRIDGE_VERSION

    val COMMANDS: Set<String> = setOf("app.info", "notifications.status")

    val ERROR_CODES: Set<String> = setOf(
        "unknown_command",
        "unsupported",
        "invalid_payload",
        "permission_denied",
        "native_failure",
        "timeout",
        "channel_closed",
        "bridge_unavailable",
        "bridge_version_too_old",
    )

    private val idPattern = Regex("^[A-Za-z0-9-]{1,64}$")
    private const val MAX_MESSAGE_LENGTH = 200

    data class Request(val id: String, val command: String, val payload: JSONObject)

    /**
     * Parses a frame from the page. Returns null unless it is a complete request of this protocol
     * version. A malformed frame is dropped, not answered, so a page cannot probe the app with it.
     */
    fun parseRequest(frame: String): Request? {
        val json = try {
            JSONObject(frame)
        } catch (error: JSONException) {
            return null
        }
        if (json.opt("v") != BRIDGE_VERSION) return null
        if (json.opt("kind") != "request") return null
        val id = json.opt("id") as? String ?: return null
        if (!idPattern.matches(id)) return null
        val command = json.opt("command") as? String ?: return null
        val payload = when (val raw = json.opt("payload")) {
            null, JSONObject.NULL -> JSONObject()
            is JSONObject -> raw
            else -> return null
        }
        return Request(id = id, command = command, payload = payload)
    }

    fun success(id: String, result: JSONObject): String =
        envelope()
            .put("kind", "response")
            .put("id", id)
            .put("ok", true)
            .put("result", result)
            .toString()

    fun failure(id: String, code: String, message: String? = null): String {
        val error = JSONObject().put("code", code)
        if (message != null) error.put("message", message.take(MAX_MESSAGE_LENGTH))
        return envelope()
            .put("kind", "response")
            .put("id", id)
            .put("ok", false)
            .put("error", error)
            .toString()
    }

    fun event(name: String, payload: JSONObject): String =
        envelope()
            .put("kind", "event")
            .put("name", name)
            .put("payload", payload)
            .toString()

    private fun envelope(): JSONObject = JSONObject().put("v", BRIDGE_VERSION)
}
