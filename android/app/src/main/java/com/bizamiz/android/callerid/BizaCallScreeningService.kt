package com.bizamiz.android.callerid

import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import com.bizamiz.android.bridge.BridgeProtocol
import com.bizamiz.android.bridge.TwaSessionHolder
import com.bizamiz.android.notifications.NotificationChannelManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android 10+ `CallScreeningService` for Biza Miz CRM Caller ID (issue #884).
 *
 * Security & privacy invariants:
 * - Never blocks, rejects, or silences any call.
 * - Never records call audio or call content.
 * - Only looks up numbers in the active tenant's local `CallerIdCache`.
 * - Posts a local CRM notification with a deep link to the customer's post-call
 *   activity sheet and emits `crm.callEnded` over the active TWA bridge channel.
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

        val cache = CallerIdCache.fromContext(applicationContext)
        val activeBusinessId = cache.getActiveBusinessId() ?: return
        val match = cache.lookup(rawNumber, activeBusinessId) ?: return

        NotificationChannelManager.postCallerIdNotification(
            context = applicationContext,
            customerId = match.customerId,
            displayName = match.displayName,
            phoneNormalized = match.phoneNormalized,
            organizationName = match.organizationName,
            tags = match.tags,
        )

        val payload = JSONObject()
            .put("businessId", activeBusinessId)
            .put("customerId", match.customerId)
            .put("displayName", match.displayName)
            .put("phoneNormalized", match.phoneNormalized)
            .put("organizationName", match.organizationName ?: JSONObject.NULL)
            .put("tags", JSONArray(match.tags))
            .put("direction", "incoming")

        TwaSessionHolder.postEvent(BridgeProtocol.EVENT_CRM_CALL_ENDED, payload)
    }
}
