package com.bizamiz.android.biometric

import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.os.Build
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Android biometric & device-credential capability detector and response builder
 * (issue #884).
 *
 * Security invariants:
 * - Bizamiz never reads or stores raw biometric templates.
 * - Biometric unlock on Android only proves local presence; the web client must
 *   still verify the server session and `native_app_devices` revocation status.
 */
object AndroidBiometricGateway {

    data class CapabilityStatus(
        val available: Boolean,
        val enrolled: Boolean,
        val strength: String,
        val credentialManagerAvailable: Boolean,
    ) {
        fun toJson(): JSONObject =
            JSONObject()
                .put("available", available)
                .put("enrolled", enrolled)
                .put("strength", strength)
                .put("credentialManagerAvailable", credentialManagerAvailable)
    }

    fun inspectCapability(context: Context): CapabilityStatus {
        val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        val deviceSecure = keyguard?.isDeviceSecure == true
        val hasFingerprintHardware = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
        } else {
            false
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val manager = context.getSystemService(BiometricManager::class.java)
            if (manager != null) {
                val strong = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                if (strong == BiometricManager.BIOMETRIC_SUCCESS) {
                    return CapabilityStatus(
                        available = true,
                        enrolled = true,
                        strength = "strong",
                        credentialManagerAvailable = true,
                    )
                }
                val weak = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
                if (weak == BiometricManager.BIOMETRIC_SUCCESS) {
                    return CapabilityStatus(
                        available = true,
                        enrolled = true,
                        strength = "weak",
                        credentialManagerAvailable = true,
                    )
                }
                val cred = manager.canAuthenticate(BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                if (cred == BiometricManager.BIOMETRIC_SUCCESS) {
                    return CapabilityStatus(
                        available = true,
                        enrolled = true,
                        strength = "device_credential",
                        credentialManagerAvailable = true,
                    )
                }
                val hardwarePresent = strong == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ||
                    weak == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED
                return CapabilityStatus(
                    available = hardwarePresent || deviceSecure,
                    enrolled = deviceSecure,
                    strength = if (deviceSecure) "device_credential" else "none",
                    credentialManagerAvailable = true,
                )
            }
        }

        return CapabilityStatus(
            available = hasFingerprintHardware || deviceSecure,
            enrolled = deviceSecure,
            strength = when {
                hasFingerprintHardware && deviceSecure -> "strong"
                deviceSecure -> "device_credential"
                else -> "none"
            },
            credentialManagerAvailable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P,
        )
    }

    fun readStatus(context: Context): JSONObject = inspectCapability(context).toJson()

    fun buildAuthSuccessResult(
        method: String,
        challengeId: String?,
        verifiedAtIso: String = utcNowIso(),
    ): JSONObject {
        val safeMethod = when (method) {
            "biometric", "device_credential", "passkey" -> method
            else -> "biometric"
        }
        return JSONObject()
            .put("authenticated", true)
            .put("method", safeMethod)
            .put("verifiedAt", verifiedAtIso)
            .put("challengeId", challengeId?.takeIf { it.isNotBlank() }?.take(128) ?: JSONObject.NULL)
    }

    fun buildSuccessResult(
        method: String,
        challengeId: String?,
        verifiedAtIso: String = utcNowIso(),
    ): JSONObject = buildAuthSuccessResult(method, challengeId, verifiedAtIso)

    private fun utcNowIso(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date())
}
