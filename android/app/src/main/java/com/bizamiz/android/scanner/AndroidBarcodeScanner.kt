package com.bizamiz.android.scanner

import org.json.JSONObject

/**
 * Barcode / QR scanner normalization and payload builder for Android (issue #884).
 *
 * Normalizes barcode symbologies returned by Google Play Services Code Scanner
 * or camera scan intents into the contract's allowlisted format names.
 */
object AndroidBarcodeScanner {

    val ALLOWED_FORMATS: Set<String> = setOf(
        "qr_code",
        "ean_13",
        "ean_8",
        "upc_a",
        "upc_e",
        "code_128",
        "code_39",
        "itf",
        "data_matrix",
        "pdf_417",
        "unknown",
    )

    fun normalizeFormat(rawFormat: String?): String {
        val cleaned = rawFormat?.trim()?.lowercase()?.replace('-', '_') ?: return "unknown"
        return when (cleaned) {
            "qr", "qr_code", "qrcode", "256" -> "qr_code"
            "ean13", "ean_13", "32" -> "ean_13"
            "ean8", "ean_8", "64" -> "ean_8"
            "upca", "upc_a", "512" -> "upc_a"
            "upce", "upc_e", "1024" -> "upc_e"
            "code128", "code_128", "1" -> "code_128"
            "code39", "code_39", "2" -> "code_39"
            "itf", "128" -> "itf"
            "datamatrix", "data_matrix", "16" -> "data_matrix"
            "pdf417", "pdf_417", "2048" -> "pdf_417"
            else -> if (ALLOWED_FORMATS.contains(cleaned)) cleaned else "unknown"
        }
    }

    fun normalizeValue(rawValue: String?): String {
        if (rawValue.isNullOrBlank()) return ""
        val mapped = buildString(rawValue.length) {
            for (ch in rawValue.trim()) {
                when (ch) {
                    in '\u06F0'..'\u06F9' -> append((ch.code - 0x06F0).toString())
                    in '\u0660'..'\u0669' -> append((ch.code - 0x0660).toString())
                    else -> if (ch.code >= 0x20 && ch.code != 0x7F) append(ch)
                }
            }
        }
        return mapped.trim().take(4096)
    }

    fun buildScanResult(
        rawValue: String,
        rawFormat: String?,
        source: String = "code_scanner",
    ): JSONObject? {
        val value = normalizeValue(rawValue)
        if (value.isEmpty()) return null
        val safeSource = when (source) {
            "code_scanner", "camera", "manual" -> source
            else -> "code_scanner"
        }
        return JSONObject()
            .put("value", value)
            .put("format", normalizeFormat(rawFormat))
            .put("source", safeSource)
    }
}
