package com.bizamiz.android.bridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeProtocolTest {

    @Test
    fun `parses a valid request envelope`() {
        val raw = """{"v":3,"kind":"request","id":"req-101","command":"app.info","payload":{"ping":1}}"""
        val parsed = BridgeProtocol.parseRequestEnvelope(raw)
        assertNotNull(parsed)
        assertEquals(3, parsed!!.v)
        assertEquals("req-101", parsed.id)
        assertEquals("app.info", parsed.command)
        assertEquals(1, parsed.payload.getInt("ping"))
    }

    @Test
    fun `accepts backward-compatible v1 and v2 request envelopes`() {
        val v1 = """{"v":1,"kind":"request","id":"req-1","command":"app.info","payload":{}}"""
        val v2 = """{"v":2,"kind":"request","id":"req-2","command":"device.identity","payload":{}}"""
        assertNotNull(BridgeProtocol.parseRequestEnvelope(v1))
        assertNotNull(BridgeProtocol.parseRequestEnvelope(v2))
    }

    @Test
    fun `rejects an envelope with an unsupported version`() {
        val rawHigh = """{"v":99,"kind":"request","id":"req-1","command":"app.info","payload":{}}"""
        val rawZero = """{"v":0,"kind":"request","id":"req-1","command":"app.info","payload":{}}"""
        assertNull(BridgeProtocol.parseRequestEnvelope(rawHigh))
        assertNull(BridgeProtocol.parseRequestEnvelope(rawZero))
    }

    @Test
    fun `rejects an envelope with an invalid request id`() {
        val raw = """{"v":3,"kind":"request","id":"bad id with spaces","command":"app.info","payload":{}}"""
        assertNull(BridgeProtocol.parseRequestEnvelope(raw))
    }

    @Test
    fun `rejects an envelope whose payload is not a JSON object`() {
        val raw = """{"v":3,"kind":"request","id":"req-1","command":"app.info","payload":"not-an-object"}"""
        assertNull(BridgeProtocol.parseRequestEnvelope(raw))
    }

    @Test
    fun `encodes a success response with protocol version and result`() {
        val encoded = BridgeProtocol.encodeSuccessResponse("req-7", JSONObject().put("permission", "granted"))
        val obj = JSONObject(encoded)
        assertEquals(BridgeProtocol.BRIDGE_VERSION, obj.getInt("v"))
        assertEquals("response", obj.getString("kind"))
        assertEquals("req-7", obj.getString("id"))
        assertTrue(obj.getBoolean("ok"))
        assertEquals("granted", obj.getJSONObject("result").getString("permission"))
    }

    @Test
    fun `encodes an error response and normalizes unknown error codes to native_failure`() {
        val encoded = BridgeProtocol.encodeErrorResponse("req-8", "made_up_error", "Something broke")
        val obj = JSONObject(encoded)
        assertEquals("response", obj.getString("kind"))
        assertEquals(false, obj.getBoolean("ok"))
        assertEquals(BridgeProtocol.ERR_NATIVE_FAILURE, obj.getJSONObject("error").getString("code"))
        assertEquals("Something broke", obj.getJSONObject("error").getString("message"))
    }

    @Test
    fun `filters unknown capabilities when building app info payload`() {
        val payload = BridgeProtocol.buildAppInfoPayload(
            appVersionName = "1.2.0",
            appVersionCode = 12,
            environment = "staging",
            capabilities = listOf("notifications", "unknown.cap", "notifications", "printer"),
        )
        assertEquals("1.2.0", payload.getString("appVersionName"))
        assertEquals(12, payload.getInt("appVersionCode"))
        assertEquals("staging", payload.getString("environment"))
        val caps = payload.getJSONArray("capabilities")
        assertEquals(2, caps.length())
        assertEquals("notifications", caps.getString(0))
        assertEquals("printer", caps.getString(1))
    }
}
