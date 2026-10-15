package com.bizamiz.android.callerid

import android.telecom.Call
import android.telecom.CallScreeningService
import com.bizamiz.android.notifications.NotificationChannelManager

/**
 * Android `CallScreeningService` for Biza Miz CRM Caller ID (issue #884).
 *
 * Never blocks, rejects, silences, or records calls. When an incoming call
 * matches a customer in the active tenant's [CallerIdCache], posts a high-priority
 * CRM caller identification notification that deep-links to the customer detail
 * and post-call activity logging flow.
 */
class BizaCallScreeningService : CallScreeningService() {

    override fun onScreenCall(callDetails: Call.Details) {
        val response = CallResponse.Builder()
            .setDisallowCall(false)
            .setRejectCall(false)
            .setSilenceCall(false)
            .setSkipCallLog(false)
            .setSkipNotification(false)
            .build()
        respondToCall(callDetails, response)

        val handle = callDetails.handle ?: return
        val rawNumber = handle.schemeSpecificPart ?: return
        val cache = CallerIdCache.fromContext(applicationContext)
        val matched = cache.lookup(rawNumber) ?: return

        NotificationChannelManager.showCallerIdNotification(
            context = applicationContext,
            customerId = matched.customerId,
            displayName = matched.displayName,
            organizationName = matched.organizationName,
            phoneNormalized = matched.phoneNormalized,
        )
    }
}
