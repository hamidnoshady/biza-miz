package com.bizamiz.android.callerid

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import com.bizamiz.android.bridge.BridgeProtocol
import com.bizamiz.android.bridge.TwaSessionHolder
import com.bizamiz.android.notifications.NotificationChannelManager

/**
 * Android 10+ `CallScreeningService` for Biza Miz CRM Caller ID (issue #884).
 *
 * Security & privacy invariants:
 * - Never blocks, rejects, or silences any call.
 * - Never records call audio or call content.
 * - `onScreenCall` ONLY identifies the caller in the active tenant's encrypted
 *   `CallerIdCache`, posts a local heads-up Caller ID notification, and records
 *   the screened call in `CallLifecycleTracker`.
 * - `crm.callEnded` is NEVER emitted during `onScreenCall`; it is emitted only
 *   after the call genuinely disconnects (`CALL_STATE_IDLE`).
 */
class BizaCallScreeningService : CallScreeningService() {

    override fun onScreenCall(callDetails: Call.Details) {
        val builder = CallResponse.Builder()
            .setDisallowCall(false)
            .setRejectCall(false)
            .setSkipCallLog(false)
            .setSkipNotification(false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setSilenceCall(false)
        }
        respondToCall(callDetails, builder.build())

        val handleUri = callDetails.handle ?: return
        val rawNumber = handleUri.schemeSpecificPart ?: return
        if (rawNumber.isBlank()) return

        val appContext = applicationContext
        val cache = CallerIdCache.fromContext(appContext)
        val roleHeld = CallerIdCache.isCallScreeningRoleHeld(appContext)
        cache.reconcileRoleState(roleHeld)
        if (!roleHeld) return

        val activeBusinessId = cache.getActiveBusinessId() ?: return
        val match = cache.lookup(rawNumber, activeBusinessId) ?: return

        val direction = if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            callDetails.callDirection == Call.Details.DIRECTION_OUTGOING
        ) {
            "outgoing"
        } else {
            "incoming"
        }

        // 1. Incoming-call identification: heads-up local notification with tenant scope.
        NotificationChannelManager.postCallerIdNotification(
            context = appContext,
            businessId = activeBusinessId,
            customerId = match.customerId,
            displayName = match.displayName,
            phoneNormalized = match.phoneNormalized,
            organizationName = match.organizationName,
            tags = match.tags,
        )

        // 2. Track call lifecycle so `crm.callEnded` is emitted only on disconnect.
        CallLifecycleTracker.shared.onCallScreened(
            entry = match,
            businessId = activeBusinessId,
            direction = direction,
        )

        observeCallUntilDisconnected(appContext)
    }

    private fun observeCallUntilDisconnected(context: Context) {
        if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return
        }
        val telephonyManager = context.getSystemService(TelephonyManager::class.java) ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val callback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                    override fun onCallStateChanged(state: Int) {
                        when (state) {
                            TelephonyManager.CALL_STATE_OFFHOOK -> {
                                CallLifecycleTracker.shared.onCallOffHook()
                            }
                            TelephonyManager.CALL_STATE_IDLE -> {
                                try {
                                    telephonyManager.unregisterTelephonyCallback(this)
                                } catch (_: Exception) {
                                }
                                emitCompletedCallIfAny()
                            }
                        }
                    }
                }
                telephonyManager.registerTelephonyCallback(context.mainExecutor, callback)
            } else {
                @Suppress("DEPRECATION")
                val listener = object : PhoneStateListener() {
                    @Deprecated("Deprecated in API 31")
                    override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                        when (state) {
                            TelephonyManager.CALL_STATE_OFFHOOK -> {
                                CallLifecycleTracker.shared.onCallOffHook()
                            }
                            TelephonyManager.CALL_STATE_IDLE -> {
                                try {
                                    telephonyManager.listen(this, LISTEN_NONE)
                                } catch (_: Exception) {
                                }
                                emitCompletedCallIfAny()
                            }
                        }
                    }
                }
                @Suppress("DEPRECATION")
                telephonyManager.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
            }
        } catch (_: SecurityException) {
            // Permission revoked concurrently; TwaLauncherActivity.onResume will reconcile on return.
        }
    }

    companion object {
        fun emitCompletedCallIfAny(endedAtEpochMs: Long = System.currentTimeMillis()): Boolean {
            val completed = CallLifecycleTracker.shared.onCallDisconnected(endedAtEpochMs) ?: return false
            val payload = completed.toBridgeEventPayload()
            TwaSessionHolder.postEvent(BridgeProtocol.EVENT_CRM_CALL_ENDED, payload)
            return true
        }
    }
}
