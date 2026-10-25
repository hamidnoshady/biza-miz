package com.bizamiz.android.printing

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import com.bizamiz.android.bridge.BridgeProtocol
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.util.UUID

/**
 * Android printing gateway for Bizamiz (issue #884).
 *
 * Supports:
 * - Android System Print Framework (`system_print`)
 * - Network TCP/IP thermal printers on port 9100 (`network_tcp`)
 * - Paired Bluetooth SPP thermal receipt/label printers (`bluetooth`)
 * - PDF share fallback (`pdf_share`)
 *
 * Bluetooth permissions (`BLUETOOTH_CONNECT` on API 31+, `BLUETOOTH` on API <= 30)
 * are checked ONLY when Bluetooth discovery or printing is requested.
 */
object AndroidPrintingGateway {

    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    fun checkBluetoothPermissionState(context: Context): String {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val granted = context.checkSelfPermission(
                Manifest.permission.BLUETOOTH_CONNECT,
            ) == PackageManager.PERMISSION_GRANTED
            if (granted) BridgeProtocol.PERMISSION_GRANTED else BridgeProtocol.PERMISSION_NOT_DETERMINED
        } else {
            val granted = context.checkSelfPermission(
                Manifest.permission.BLUETOOTH,
            ) == PackageManager.PERMISSION_GRANTED
            if (granted) BridgeProtocol.PERMISSION_GRANTED else BridgeProtocol.PERMISSION_DENIED
        }
    }

    @SuppressLint("MissingPermission")
    fun discoverPrinters(
        context: Context,
        includeBluetooth: Boolean = false,
    ): JSONObject {
        val printers = JSONArray()
        printers.put(
            JSONObject()
                .put("id", "system_print")
                .put("name", "سرویس چاپ سیستم اندروید")
                .put("transport", "system_print")
                .put("address", JSONObject.NULL)
                .put("paperWidthMm", 80)
                .put("online", true),
        )
        printers.put(
            JSONObject()
                .put("id", "pdf_share")
                .put("name", "خروجی PDF و اشتراک‌گذاری")
                .put("transport", "pdf_share")
                .put("address", JSONObject.NULL)
                .put("paperWidthMm", 210)
                .put("online", true),
        )

        val btPermState = checkBluetoothPermissionState(context)
        if (includeBluetooth && btPermState == BridgeProtocol.PERMISSION_GRANTED) {
            try {
                val btManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
                val adapter = btManager?.adapter
                val bonded = adapter?.bondedDevices.orEmpty()
                for (device in bonded) {
                    val addr = device.address ?: continue
                    val name = device.name?.takeIf { it.isNotBlank() } ?: "چاپگر بلوتوث ($addr)"
                    printers.put(
                        JSONObject()
                            .put("id", "bt:$addr")
                            .put("name", name.take(128))
                            .put("transport", "bluetooth")
                            .put("address", addr)
                            .put("paperWidthMm", 80)
                            .put("online", adapter?.isEnabled == true),
                    )
                }
            } catch (_: SecurityException) {
                // Bluetooth permission revoked at runtime; omit paired devices safely.
            }
        }

        return JSONObject()
            .put("printers", printers)
            .put("bluetoothPermission", btPermState)
    }

    fun decodePrintPayload(dataBase64: String): ByteArray? {
        if (dataBase64.isBlank() || dataBase64.length > 10 * 1024 * 1024) return null
        return try {
            Base64.decode(dataBase64, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    fun parseNetworkHostPort(address: String?): Pair<String, Int>? {
        if (address.isNullOrBlank()) return null
        val trimmed = address.trim()
        val colon = trimmed.lastIndexOf(':')
        val host = if (colon > 0) trimmed.substring(0, colon) else trimmed
        val port = if (colon > 0) trimmed.substring(colon + 1).toIntOrNull() ?: 9100 else 9100
        if (host.isBlank() || port !in 1..65535) return null
        return host to port
    }

    fun sendRawTcp(host: String, port: Int, bytes: ByteArray, timeoutMs: Int = 5_000): Boolean {
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), timeoutMs)
                socket.soTimeout = timeoutMs
                socket.getOutputStream().use { out ->
                    out.write(bytes)
                    out.flush()
                }
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    @SuppressLint("MissingPermission")
    fun sendRawBluetooth(context: Context, macAddress: String, bytes: ByteArray): Boolean {
        if (checkBluetoothPermissionState(context) != BridgeProtocol.PERMISSION_GRANTED) return false
        val cleanMac = macAddress.removePrefix("bt:").trim()
        if (cleanMac.isEmpty()) return false
        return try {
            val btManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            val adapter = btManager?.adapter ?: return false
            val device = adapter.getRemoteDevice(cleanMac) ?: return false
            device.createRfcommSocketToServiceRecord(SPP_UUID).use { socket ->
                socket.connect()
                socket.outputStream.use { out ->
                    out.write(bytes)
                    out.flush()
                }
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    fun buildPrintResult(
        printed: Boolean,
        transport: String,
        jobId: String,
        bytesSent: Int,
    ): JSONObject =
        JSONObject()
            .put("printed", printed)
            .put("transport", transport)
            .put("jobId", jobId.take(128))
            .put("bytesSent", bytesSent.coerceAtLeast(0))
}
