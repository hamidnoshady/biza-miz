package com.bizamiz.android.bridge

import org.json.JSONArray
import org.json.JSONObject

/**
 * Answers allowlisted bridge requests. There is no generic executor. A command that is not in
 * [BridgeProtocol.COMMANDS] gets `unknown_command`, and nothing runs.
 *
 * A native permission is not platform authorization. A future command that reads or changes
 * Biza Miz data must still be checked by the server against the signed-in user's role.
 */
class BridgeCommandRouter(
    private val environment: String,
    private val appVersionName: String,
    private val appVersionCode: Int,
    private val notificationsEnabled: () -> Boolean,
    private val capabilities: List<String> = listOf("notifications"),
) {
    fun appInfo(): JSONObject = JSONObject()
        .put("appVersionName", appVersionName)
        .put("appVersionCode", appVersionCode)
        .put("environment", environment)
        .put("bridgeVersion", BridgeProtocol.BRIDGE_VERSION)
        .put("capabilities", JSONArray(capabilities))

    /** The announcement sent once the channel is ready. The page can also ask with `app.info`. */
    fun readyEvent(): String = BridgeProtocol.event("bridge.ready", appInfo())

    /** Returns the reply frame for a page frame, or null when the frame must be ignored. */
    fun handleFrame(frame: String): String? {
        val request = BridgeProtocol.parseRequest(frame) ?: return null
        return when (request.command) {
            "app.info" -> BridgeProtocol.success(request.id, appInfo())
            "notifications.status" ->
                BridgeProtocol.success(request.id, JSONObject().put("permission", permissionState()))
            else -> BridgeProtocol.failure(request.id, "unknown_command")
        }
    }

    private fun permissionState(): String = if (notificationsEnabled()) "granted" else "denied"
}
