package com.bizamiz.android.callerid

import com.bizamiz.android.bridge.BridgeProtocol
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Tracks a screened CRM phone call from incoming identification (`onScreenCall`)
 * through off-hook connection (`CALL_STATE_OFFHOOK`) to genuine call disconnection
 * (`CALL_STATE_IDLE`), emitting `crm.callEnded` ONLY when the call has ended
 * (issue #884, Root Cause 2).
 *
 * Invariants:
 * - `onCallScreened` records the identified caller for the active `businessId`
 *   and never emits `crm.callEnded` or fabricates call end times / durations.
 * - `onCallOffHook` records the real connected timestamp when the call is answered.
 * - `onCallDisconnected` computes `durationSeconds` from the measured interval
 *   `[connectedAtEpochMs, endedAtEpochMs]` (or `0` with direction `"missed"` when
 *   an incoming call disconnects without ever going off-hook) and builds a
 *   canonical `crm.callEnded` payload matching `parseCrmCallEndedEvent`.
 */
class CallLifecycleTracker {

    data class ScreenedCallSession(
        val entry: CallerIdCache.CallerEntry,
        val businessId: String,
        val initialDirection: String,
        val screenedAtEpochMs: Long,
        val connectedAtEpochMs: Long? = null,
    )

    data class CompletedCallRecord(
        val businessId: String,
        val phoneNormalized: String,
        val direction: String,
        val durationSeconds: Int,
        val customerId: String,
        val customerName: String,
        val endedAt: String,
    ) {
        fun toBridgeEventPayload(): JSONObject =
            BridgeProtocol.buildCrmCallEndedEventPayload(
                phoneNormalized = phoneNormalized,
                direction = direction,
                durationSeconds = durationSeconds,
                customerId = customerId,
                customerName = customerName,
                endedAt = endedAt,
            )
    }

    @Volatile
    private var activeSession: ScreenedCallSession? = null

    @Synchronized
    fun onCallScreened(
        entry: CallerIdCache.CallerEntry,
        businessId: String,
        direction: String = "incoming",
        screenedAtEpochMs: Long = System.currentTimeMillis(),
    ): ScreenedCallSession {
        val cleanDirection = if (direction == "outgoing") "outgoing" else "incoming"
        val session = ScreenedCallSession(
            entry = entry,
            businessId = businessId.trim(),
            initialDirection = cleanDirection,
            screenedAtEpochMs = screenedAtEpochMs,
            connectedAtEpochMs = if (cleanDirection == "outgoing") screenedAtEpochMs else null,
        )
        activeSession = session
        return session
    }

    @Synchronized
    fun onCallOffHook(offHookAtEpochMs: Long = System.currentTimeMillis()): Boolean {
        val current = activeSession ?: return false
        if (current.connectedAtEpochMs == null) {
            activeSession = current.copy(connectedAtEpochMs = offHookAtEpochMs)
        }
        return true
    }

    @Synchronized
    fun onCallDisconnected(
        endedAtEpochMs: Long = System.currentTimeMillis(),
        endedAtIso: String = formatUtcIso(endedAtEpochMs),
    ): CompletedCallRecord? {
        val current = activeSession ?: return null
        activeSession = null

        val connectedAt = current.connectedAtEpochMs
        val durationSeconds: Int = if (connectedAt != null) {
            ((endedAtEpochMs - connectedAt) / 1000L)
                .coerceAtLeast(0L)
                .coerceAtMost(86_400L)
                .toInt()
        } else {
            0
        }

        return CompletedCallRecord(
            businessId = current.businessId,
            phoneNormalized = current.entry.phoneNormalized,
            direction = current.initialDirection,
            durationSeconds = durationSeconds,
            customerId = current.entry.customerId,
            customerName = current.entry.displayName,
            endedAt = endedAtIso,
        )
    }

    @Synchronized
    fun getActiveSession(): ScreenedCallSession? = activeSession

    @Synchronized
    fun clear() {
        activeSession = null
    }

    companion object {
        val shared = CallLifecycleTracker()

        fun formatUtcIso(epochMs: Long): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.format(Date(epochMs))
    }
}
