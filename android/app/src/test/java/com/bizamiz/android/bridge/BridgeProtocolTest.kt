package com.bizamiz.android.bridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeProtocolTest {

    private val version = BridgeProtocol.BRIDGE_VERSION

    @Test
    fun parsesAWellFormedRequest() {
        val request = BridgeProtocol.parseRequest(
            """{"v":$version,"kind":"request","id":"abc-123","command":"app.info","payload":{}}""",
        )
        assertEquals("abc-123", request?.id)
        assertEquals("app.info", request?.command)
        assertEquals(0, request?.payload?.length())
    }

    @Test
    fun aMissingPayloadBecomesAnEmptyObject() {
        val request = BridgeProtocol.parseRequest("""{"v":$version,"kind":"request","id":"a","command":"app.info"}""")
        assertEquals(0, request?.payload?.length())
    }

    @Test
    fun refusesAFrameFromAnotherProtocolVersion() {
        assertNull(BridgeProtocol.parseRequest("""{"v":${version + 1},"kind":"request","id":"a","command":"app.info"}"""))
    }

    @Test
    fun refusesANonRequestKind() {
        assertNull(BridgeProtocol.parseRequest("""{"v":$version,"kind":"response","id":"a","command":"app.info"}"""))
    }

    @Test
    fun refusesAnIdOutsideTheAllowedShape() {
        for (id in listOf("", "has space", "x".repeat(65), "../../etc")) {
            val frame = JSONObject().put("v", version).put("kind", "request").put("id", id).put("command", "app.info").toString()
            assertNull(id, BridgeProtocol.parseRequest(frame))
        }
    }

    @Test
    fun refusesAPayloadThatIsNotAnObject() {
        assertNull(BridgeProtocol.parseRequest("""{"v":$version,"kind":"request","id":"a","command":"app.info","payload":"x"}"""))
    }

    @Test
    fun refusesFramesThatAreNotJson() {
        assertNull(BridgeProtocol.parseRequest("not json"))
        assertNull(BridgeProtocol.parseRequest(""))
    }

    @Test
    fun buildsASuccessResponseWithTheRequestId() {
        val reply = JSONObject(BridgeProtocol.success("abc", JSONObject().put("permission", "granted")))
        assertEquals(version, reply.getInt("v"))
        assertEquals("response", reply.getString("kind"))
        assertEquals("abc", reply.getString("id"))
        assertTrue(reply.getBoolean("ok"))
        assertEquals("granted", reply.getJSONObject("result").getString("permission"))
    }

    @Test
    fun buildsAFailureResponseAndTruncatesALongMessage() {
        val reply = JSONObject(BridgeProtocol.failure("abc", "permission_denied", "m".repeat(500)))
        assertEquals(false, reply.getBoolean("ok"))
        val error = reply.getJSONObject("error")
        assertEquals("permission_denied", error.getString("code"))
        assertEquals(200, error.getString("message").length)
    }

    @Test
    fun buildsAnEvent() {
        val event = JSONObject(BridgeProtocol.event("bridge.ready", JSONObject().put("bridgeVersion", version)))
        assertEquals("event", event.getString("kind"))
        assertEquals("bridge.ready", event.getString("name"))
        assertEquals(version, event.getJSONObject("payload").getInt("bridgeVersion"))
    }
}
