package com.bizamiz.android.bridge

import com.bizamiz.android.bridge.BridgeCommandRouter.CommandOutcome
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeCommandRouterTest {

    private val allCaps = listOf(
        BridgeProtocol.CAP_NOTIFICATIONS,
        BridgeProtocol.CAP_BARCODE_SCAN,
        BridgeProtocol.CAP_PRINTER,
        BridgeProtocol.CAP_CRM_CALLER_ID,
        BridgeProtocol.CAP_BIOMETRIC,
        BridgeProtocol.CAP_SHARE,
        BridgeProtocol.CAP_MEDIA_CAPTURE,
        BridgeProtocol.CAP_BACKGROUND_SYNC,
    )

    private fun router(
        trustedOrigin: String = "https://pos.bizamiz.com",
        permissionState: String = BridgeProtocol.PERMISSION_GRANTED,
        installationId: String = "a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab",
        enabledCapabilities: List<String> = allCaps,
    ) = BridgeCommandRouter(
        trustedOrigin = trustedOrigin,
        appVersionName = "0.1.0",
        appVersionCode = 1,
        environment = "production",
        enabledCapabilities = enabledCapabilities,
        notificationPermissionProvider = { permissionState },
        installationIdProvider = { installationId },
        scannerScanHandler = {
            CommandOutcome.Success(
                JSONObject()
                    .put("value", "6260123456789")
                    .put("format", "ean_13")
                    .put("source", "code_scanner"),
            )
        },
        biometricAuthenticateHandler = {
            CommandOutcome.Success(
                JSONObject()
                    .put("authenticated", true)
                    .put("method", "biometric")
                    .put("verifiedAt", "2026-10-15T10:00:00Z")
                    .put("challengeId", "chal-1"),
            )
        },
    )

    @Test
    fun `responds to app info from trusted origin`() {
        val r = router()
        val request = """{"v":3,"kind":"request","id":"req-1","command":"app.info","payload":{}}"""
        val rawResponse = r.handleMessage("https://pos.bizamiz.com", request)
        assertNotNull(rawResponse)
        val response = JSONObject(rawResponse!!)
        assertTrue(response.getBoolean("ok"))
        assertEquals("req-1", response.getString("id"))
        val result = response.getJSONObject("result")
        assertEquals("0.1.0", result.getString("appVersionName"))
        assertEquals(1, result.getInt("appVersionCode"))
        assertEquals("production", result.getString("environment"))
        assertEquals(BridgeProtocol.BRIDGE_VERSION, result.getInt("bridgeVersion"))
    }

    @Test
    fun `responds to notifications status from trusted origin`() {
        val r = router(permissionState = BridgeProtocol.PERMISSION_DENIED)
        val request = """{"v":3,"kind":"request","id":"req-2","command":"notifications.status","payload":{}}"""
        val rawResponse = r.handleMessage("https://pos.bizamiz.com:443/", request)
        assertNotNull(rawResponse)
        val response = JSONObject(rawResponse!!)
        assertTrue(response.getBoolean("ok"))
        assertEquals("denied", response.getJSONObject("result").getString("permission"))
    }

    @Test
    fun `responds to device identity from trusted origin`() {
        val r = router(installationId = "f47ac10b-58cc-4372-a567-0e02b2c3d479")
        val request = """{"v":3,"kind":"request","id":"req-id","command":"device.identity","payload":{}}"""
        val rawResponse = r.handleMessage("https://pos.bizamiz.com", request)
        assertNotNull(rawResponse)
        val response = JSONObject(rawResponse!!)
        assertTrue(response.getBoolean("ok"))
        assertEquals(
            "f47ac10b-58cc-4372-a567-0e02b2c3d479",
            response.getJSONObject("result").getString("installationId"),
        )
    }

    @Test
    fun `handles v3 commands notifications register, biometric, scanner, printer, callerId, share, and sync`() {
        val r = router()

        val regRes = JSONObject(
            r.handleMessage(
                "https://pos.bizamiz.com",
                """{"v":3,"kind":"request","id":"r-notif","command":"notifications.register","payload":{"channels":["orders","crm"]}}""",
            )!!,
        )
        assertTrue(regRes.getBoolean("ok"))
        assertEquals("granted", regRes.getJSONObject("result").getString("permission"))

        val bioStatusRes = JSONObject(
            r.handleMessage(
                "https://pos.bizamiz.com",
                """{"v":3,"kind":"request","id":"r-bio-st","command":"biometric.status","payload":{}}""",
            )!!,
        )
        assertTrue(bioStatusRes.getBoolean("ok"))
        assertTrue(bioStatusRes.getJSONObject("result").getBoolean("available"))

        val bioAuthRes = JSONObject(
            r.handleMessage(
                "https://pos.bizamiz.com",
                """{"v":3,"kind":"request","id":"r-bio-au","command":"biometric.authenticate","payload":{"challengeId":"chal-1"}}""",
            )!!,
        )
        assertTrue(bioAuthRes.getBoolean("ok"))
        assertTrue(bioAuthRes.getJSONObject("result").getBoolean("authenticated"))

        val scanRes = JSONObject(
            r.handleMessage(
                "https://pos.bizamiz.com",
                """{"v":3,"kind":"request","id":"r-scan","command":"scanner.scan","payload":{}}""",
            )!!,
        )
        assertTrue(scanRes.getBoolean("ok"))
        assertEquals("6260123456789", scanRes.getJSONObject("result").getString("value"))

        val printDiscRes = JSONObject(
            r.handleMessage(
                "https://pos.bizamiz.com",
                """{"v":3,"kind":"request","id":"r-pdisc","command":"printer.discover","payload":{}}""",
            )!!,
        )
        assertTrue(printDiscRes.getBoolean("ok"))
        assertEquals(1, printDiscRes.getJSONObject("result").getJSONArray("printers").length())

        val printRes = JSONObject(
            r.handleMessage(
                "https://pos.bizamiz.com",
                """{"v":3,"kind":"request","id":"r-print","command":"printer.print","payload":{"transport":"system_print","dataBase64":"AQID"}}""",
            )!!,
        )
        assertTrue(printRes.getBoolean("ok"))
        assertTrue(printRes.getJSONObject("result").getBoolean("printed"))

        val callerSyncRes = JSONObject(
            r.handleMessage(
                "https://pos.bizamiz.com",
                """{"v":3,"kind":"request","id":"r-cid","command":"crm.callerId.sync","payload":{"businessId":"biz-1","entries":[{"customerId":"c1"}]}}""",
            )!!,
        )
        assertTrue(callerSyncRes.getBoolean("ok"))
        assertEquals(1, callerSyncRes.getJSONObject("result").getInt("syncedCount"))

        val syncTrigRes = JSONObject(
            r.handleMessage(
                "https://pos.bizamiz.com",
                """{"v":3,"kind":"request","id":"r-sync","command":"sync.trigger","payload":{"action":"enqueue","businessId":"biz-1"}}""",
            )!!,
        )
        assertTrue(syncTrigRes.getBoolean("ok"))
        assertTrue(syncTrigRes.getJSONObject("result").getBoolean("scheduled"))
    }

    @Test
    fun `rejects capability-gated commands when capability is not enabled on build`() {
        val r = router(enabledCapabilities = listOf(BridgeProtocol.CAP_NOTIFICATIONS))
        val request = """{"v":3,"kind":"request","id":"req-cap","command":"printer.discover","payload":{}}"""
        val response = JSONObject(r.handleMessage("https://pos.bizamiz.com", request)!!)
        assertFalse(response.getBoolean("ok"))
        assertEquals(BridgeProtocol.ERR_UNSUPPORTED_CAPABILITY, response.getJSONObject("error").getString("code"))
    }

    @Test
    fun `rejects malformed command payloads with invalid_payload`() {
        val r = router()
        val badPrint = """{"v":3,"kind":"request","id":"req-p","command":"printer.print","payload":{"transport":"laser","dataBase64":""}}"""
        val resPrint = JSONObject(r.handleMessage("https://pos.bizamiz.com", badPrint)!!)
        assertFalse(resPrint.getBoolean("ok"))
        assertEquals(BridgeProtocol.ERR_INVALID_PAYLOAD, resPrint.getJSONObject("error").getString("code"))

        val badCallerId = """{"v":3,"kind":"request","id":"req-c","command":"crm.callerId.sync","payload":{}}"""
        val resCaller = JSONObject(r.handleMessage("https://pos.bizamiz.com", badCallerId)!!)
        assertFalse(resCaller.getBoolean("ok"))
        assertEquals(BridgeProtocol.ERR_INVALID_PAYLOAD, resCaller.getJSONObject("error").getString("code"))
    }

    @Test
    fun `rejects untrusted sender origin`() {
        val r = router(trustedOrigin = "https://pos.bizamiz.com")
        val request = """{"v":3,"kind":"request","id":"req-3","command":"app.info","payload":{}}"""
        val rawResponse = r.handleMessage("https://evil.example.com", request)
        assertNotNull(rawResponse)
        val response = JSONObject(rawResponse!!)
        assertFalse(response.getBoolean("ok"))
        assertEquals("req-3", response.getString("id"))
        assertEquals(BridgeProtocol.ERR_UNTRUSTED_ORIGIN, response.getJSONObject("error").getString("code"))
    }

    @Test
    fun `rejects unknown command outside allowlist`() {
        val r = router()
        val request = """{"v":3,"kind":"request","id":"req-4","command":"device.execShell","payload":{}}"""
        val rawResponse = r.handleMessage("https://pos.bizamiz.com", request)
        assertNotNull(rawResponse)
        val response = JSONObject(rawResponse!!)
        assertFalse(response.getBoolean("ok"))
        assertEquals("req-4", response.getString("id"))
        assertEquals(BridgeProtocol.ERR_UNKNOWN_COMMAND, response.getJSONObject("error").getString("code"))
    }

    @Test
    fun `ignores non-json or non-envelope noise`() {
        val r = router()
        assertNull(r.handleMessage("https://pos.bizamiz.com", "hello world"))
        assertNull(r.handleMessage("https://pos.bizamiz.com", """{"hello":"world"}"""))
    }
}
