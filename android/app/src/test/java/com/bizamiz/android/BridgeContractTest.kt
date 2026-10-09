package com.bizamiz.android

import com.bizamiz.android.bridge.BridgeProtocol
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Keeps this app in step with config/native-bridge-contract.json and
 * config/android-environments.json, the same files the web side and Gradle read.
 * The unit-test working directory is android/app, so the config lives two levels up.
 */
class BridgeContractTest {

    private val contract = JSONObject(File("../../config/native-bridge-contract.json").readText())
    private val environments = JSONObject(File("../../config/android-environments.json").readText())

    private fun keysOf(obj: JSONObject): Set<String> = obj.keys().asSequence().toSet()

    private fun JSONArray.strings(): Set<String> = (0 until length()).map { getString(it) }.toSet()

    @Test
    fun protocolVersionMatchesTheContract() {
        assertEquals(contract.getInt("bridgeVersion"), BridgeProtocol.BRIDGE_VERSION)
        assertEquals(contract.getInt("bridgeVersion"), BuildConfig.NATIVE_BRIDGE_VERSION)
        assertEquals(contract.getString("protocol"), BridgeProtocol.PROTOCOL)
    }

    @Test
    fun commandAllowlistMatchesTheContract() {
        assertEquals(keysOf(contract.getJSONObject("commands")), BridgeProtocol.COMMANDS)
    }

    @Test
    fun errorCodesMatchTheContract() {
        assertEquals(contract.getJSONArray("errorCodes").strings(), BridgeProtocol.ERROR_CODES)
    }

    @Test
    fun theBuildIsTheEnvironmentItClaimsToBe() {
        val environment = BuildConfig.APP_ENVIRONMENT
        val spec = environments.getJSONObject("environments").getJSONObject(environment)
        assertEquals(spec.getString("applicationId"), BuildConfig.APPLICATION_ID)
        assertTrue(contract.getJSONArray("environments").strings().contains(environment))
        val configured = spec.getString("webOrigin")
        if (configured.isNotEmpty()) {
            assertEquals(configured, BuildConfig.WEB_ORIGIN)
        } else {
            assertTrue("a build must have an origin before it is used", BuildConfig.WEB_ORIGIN.startsWith("https://"))
        }
    }
}
