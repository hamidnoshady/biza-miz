package com.bizamiz.android.bridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class BridgeCommandRouterTest {

    private fun router(notificationsOn: Boolean = true) = BridgeCommandRouter(
        environment = "staging",
        appVersionName = "0.1.0",
        appVersionCode = 4,
        notificationsEnabled = { notificationsOn },
    )

    private fun request(command: String, id: String = "req-1") =
        """{"v":${BridgeProtocol.BRIDGE_VERSION},"kind":"request","id":"$id","command":"$command","payload":{}}"""

    @Test
    fun appInfoReportsTheBuildAndItsCapabilities() {
        val reply = JSONObject(router().handleFrame(request("app.info"))!!)
        assertEquals("req-1", reply.getString("id"))
        assertEquals(true, reply.getBoolean("ok"))
        val result = reply.getJSONObject("result")
        assertEquals("0.1.0", result.getString("appVersionName"))
        assertEquals(4, result.getInt("appVersionCode"))
        assertEquals("staging", result.getString("environment"))
        assertEquals(BridgeProtocol.BRIDGE_VERSION, result.getInt("bridgeVersion"))
        assertEquals(listOf("notifications"), result.getJSONArray("capabilities").toList())
    }

    @Test
    fun notificationStatusReportsGrantedOrDenied() {
        val granted = JSONObject(router(notificationsOn = true).handleFrame(request("notifications.status"))!!)
        assertEquals("granted", granted.getJSONObject("result").getString("permission"))

        val denied = JSONObject(router(notificationsOn = false).handleFrame(request("notifications.status"))!!)
        assertEquals("denied", denied.getJSONObject("result").getString("permission"))
    }

    @Test
    fun anUnknownCommandIsRefusedAndNothingRuns() {
        var consulted = false
        val guarded = BridgeCommandRouter(
            environment = "staging",
            appVersionName = "0.1.0",
            appVersionCode = 4,
            notificationsEnabled = {
                consulted = true
                true
            },
        )
        val reply = JSONObject(guarded.handleFrame(request("shell.exec"))!!)
        assertEquals(false, reply.getBoolean("ok"))
        assertEquals("unknown_command", reply.getJSONObject("error").getString("code"))
        assertFalse(consulted)
    }

    @Test
    fun aFrameThatIsNotARequestGetsNoReply() {
        assertNull(router().handleFrame("""{"v":${BridgeProtocol.BRIDGE_VERSION},"kind":"event","name":"x"}"""))
        assertNull(router().handleFrame("garbage"))
    }

    @Test
    fun theReadyEventCarriesTheSameInfoAsAppInfo() {
        val event = JSONObject(router().readyEvent())
        assertEquals("bridge.ready", event.getString("name"))
        assertEquals("staging", event.getJSONObject("payload").getString("environment"))
    }
}
