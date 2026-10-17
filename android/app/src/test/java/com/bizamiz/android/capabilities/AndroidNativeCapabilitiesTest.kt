package com.bizamiz.android.capabilities

import com.bizamiz.android.bridge.BridgeProtocol
import com.bizamiz.android.media.AndroidMediaPickerAndShare
import com.bizamiz.android.notifications.BizaFirebaseMessagingService
import com.bizamiz.android.notifications.NotificationChannelManager
import com.bizamiz.android.printing.AndroidPrintingGateway
import com.bizamiz.android.scanner.AndroidBarcodeScanner
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class AndroidNativeCapabilitiesTest {

    @Test
    fun `normalizes barcode formats and Persian digits in scanned values`() {
        val result = AndroidBarcodeScanner.buildScanResult(
            rawValue = "۶۲۶۰۱۲۳۴۵۶۷۸۹",
            rawFormat = "EAN-13",
            source = "code_scanner",
        )
        assertNotNull(result)
        assertEquals("6260123456789", result!!.getString("value"))
        assertEquals("ean_13", result.getString("format"))
        assertEquals("code_scanner", result.getString("source"))
    }

    @Test
    fun `enforces notification deduplication, burst rate limit, and payload sanitization`() {
        assertTrue(NotificationChannelManager.shouldDeliverNotification("orders", "msg-1", 10_000L))
        // Duplicate messageId is dropped even after interval.
        assertFalse(NotificationChannelManager.shouldDeliverNotification("orders", "msg-1", 20_000L))
        // Burst on the same category within 1500ms is dropped.
        assertFalse(NotificationChannelManager.shouldDeliverNotification("orders", "msg-2", 10_500L))
        // After interval, a new messageId is allowed.
        assertTrue(NotificationChannelManager.shouldDeliverNotification("orders", "msg-2", 12_000L))

        val dirtyPayload = JSONObject()
            .put("title", "سفارش جدید")
            .put("password", "secret123")
            .put("accessToken", "tok_abc")
            .put("path", "//evil.example/phish")
        val sanitized = NotificationChannelManager.sanitizeNotificationPayload(dirtyPayload)
        assertEquals("سفارش جدید", sanitized.getString("title"))
        assertFalse(sanitized.has("password"))
        assertFalse(sanitized.has("accessToken"))
        assertFalse(sanitized.has("path"))

        val validPathPayload = JSONObject().put("path", "/accounting/orders/123")
        assertEquals(
            "/accounting/orders/123",
            NotificationChannelManager.sanitizeNotificationPayload(validPathPayload).getString("path"),
        )
    }

    @Test
    fun `validates picked media MIME types, size limits, and cleans up temp files`() {
        assertNotNull(
            AndroidMediaPickerAndShare.buildPickedFileJson(
                name = "../../invoice.pdf",
                mimeType = "application/pdf",
                sizeBytes = 2048,
                base64Data = "JVBERi0xLjQK",
                source = "document_picker",
            ),
        )
        assertNull(
            AndroidMediaPickerAndShare.buildPickedFileJson(
                name = "malware.apk",
                mimeType = "application/vnd.android.package-archive",
                sizeBytes = 1024,
                base64Data = "AAAA",
                source = "document_picker",
            ),
        )
        assertNull(
            AndroidMediaPickerAndShare.buildPickedFileJson(
                name = "huge.jpg",
                mimeType = "image/jpeg",
                sizeBytes = 25 * 1024 * 1024,
                base64Data = "AAAA",
                source = "camera",
            ),
        )

        val tempDir = Files.createTempDirectory("biza_test_cache").toFile()
        try {
            File(tempDir, "biza_temp_1.jpg").writeText("a")
            File(tempDir, "biza_temp_2.pdf").writeText("b")
            File(tempDir, "keep_me.txt").writeText("c")
            val deleted = AndroidMediaPickerAndShare.cleanupTempFiles(tempDir)
            assertEquals(2, deleted)
            assertTrue(File(tempDir, "keep_me.txt").exists())
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun `parses network printer host and port`() {
        assertEquals("192.168.1.50" to 9100, AndroidPrintingGateway.parseNetworkHostPort("192.168.1.50"))
        assertEquals("10.0.0.12" to 9101, AndroidPrintingGateway.parseNetworkHostPort("10.0.0.12:9101"))
        assertNull(AndroidPrintingGateway.parseNetworkHostPort(""))
    }

    @Test
    fun `maps FCM remote data and builds canonical bridge event payloads`() {
        val rawFcm = BizaFirebaseMessagingService.buildNotificationPayloadFromRemoteData(
            data = mapOf(
                "eventType" to "new_order",
                "title" to "سفارش جدید #109",
                "body" to "مبلغ ۳,۲۰۰,۰۰۰ ریال",
                "path" to "/accounting/orders/109",
                "businessId" to "biz-42",
            ),
        )
        val sanitized = NotificationChannelManager.sanitizeNotificationPayload(rawFcm)
        assertEquals("orders", sanitized.getString("category"))
        assertEquals("/accounting/orders/109", sanitized.getString("path"))
        assertEquals("biz-42", sanitized.getString("businessId"))

        val deepLinkPayload = BridgeProtocol.buildNavigationDeepLinkEventPayload(
            path = sanitized.getString("path"),
            businessId = sanitized.getString("businessId"),
            notificationCategory = sanitized.getString("category"),
        )
        assertEquals("/accounting/orders/109", deepLinkPayload.getString("path"))
        assertEquals("orders", deepLinkPayload.getString("notificationCategory"))
        assertEquals("biz-42", deepLinkPayload.getString("businessId"))

        val callEndedPayload = BridgeProtocol.buildCrmCallEndedEventPayload(
            phoneNormalized = "+989121112233",
            direction = "incoming",
            durationSeconds = 95,
            customerId = "11111111-2222-4333-8444-555555555555",
            customerName = "رضا محمدی",
            endedAt = "2026-10-15T12:00:00.000Z",
        )
        assertEquals("+989121112233", callEndedPayload.getString("phoneNormalized"))
        assertEquals("رضا محمدی", callEndedPayload.getString("customerName"))
        assertFalse(callEndedPayload.has("displayName"))
    }
}
