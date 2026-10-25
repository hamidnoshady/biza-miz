package com.bizamiz.android.notifications

import com.bizamiz.android.sync.TenantSyncStateStore
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * Firebase Cloud Messaging (FCM) receiver service for Bizamiz (issue #884, Root Cause 4).
 *
 * Security & multi-tenant invariants:
 * - Refreshed FCM tokens are cached locally and reconciled with `POST /api/native-devices`
 *   only when an authenticated user session is active.
 * - Incoming push messages are sanitized (`NotificationChannelManager.sanitizeNotificationPayload`),
 *   checked against tenant revocation (`TenantSyncStateStore.isTenantRevoked`), deduplicated,
 *   and routed through `TwaLauncherActivity` with explicit `businessId` context so
 *   `NativeDeviceRegistrar` validates or switches tenant before navigating.
 */
class BizaFirebaseMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        if (token.isBlank()) return
        NotificationChannelManager.storePushToken(applicationContext, token)
        val syncStore = TenantSyncStateStore.fromContext(applicationContext)
        syncStore.recordSyncRequest(businessId = null, action = "immediate")
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        val businessId = data["businessId"]?.trim().orEmpty()
        if (businessId.isNotEmpty()) {
            val syncStore = TenantSyncStateStore.fromContext(applicationContext)
            if (syncStore.isTenantRevoked(businessId)) {
                return
            }
        }

        val rawPayload = buildNotificationPayloadFromRemoteData(
            data = data,
            fallbackTitle = message.notification?.title,
            fallbackBody = message.notification?.body,
        )
        NotificationChannelManager.postPushNotification(
            context = applicationContext,
            rawPayload = rawPayload,
            messageId = message.messageId ?: data["eventId"],
        )
    }

    companion object {
        fun buildNotificationPayloadFromRemoteData(
            data: Map<String, String>,
            fallbackTitle: String? = null,
            fallbackBody: String? = null,
        ): JSONObject {
            val category = data["category"] ?: mapEventTypeToCategory(data["eventType"])
            val title = data["title"] ?: fallbackTitle ?: "بیزمیز"
            val body = data["body"] ?: fallbackBody ?: ""
            val path = data["path"] ?: data["url"] ?: "/dashboard"
            val businessId = data["businessId"] ?: ""

            return JSONObject()
                .put("category", category)
                .put("title", title)
                .put("body", body)
                .put("path", path)
                .put("businessId", businessId)
        }

        fun mapEventTypeToCategory(eventType: String?): String = when (eventType?.trim()?.lowercase()) {
            "order_ready", "new_order", "order_cancelled", "orders" -> "orders"
            "payment", "payments", "receipt_created", "check_due" -> "payments"
            "crm", "call_missed", "follow_up_due" -> "crm"
            "low_stock", "inventory" -> "inventory"
            "approval_requested", "approvals", "shift_discrepancy" -> "approvals"
            "security", "device_revoked", "new_login" -> "security"
            else -> "operations"
        }
    }
}
