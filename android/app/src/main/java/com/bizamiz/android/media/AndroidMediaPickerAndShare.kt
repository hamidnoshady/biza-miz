package com.bizamiz.android.media

import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Android document picker, camera capture temp-file cleanup, MIME validation,
 * and native share intent builder (issue #884).
 *
 * Security invariants:
 * - Only allowlisted MIME types and files <= 20 MB are accepted.
 * - Temporary camera/share files are stored only in app-private `cacheDir` and
 *   cleaned up immediately (`cleanupTempFiles`).
 */
object AndroidMediaPickerAndShare {

    const val MAX_FILE_BYTES: Int = 20 * 1024 * 1024

    val ALLOWED_MIMES: Set<String> = setOf(
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/heic",
        "image/heif",
        "application/pdf",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

    fun isMimeAllowed(mimeType: String?): Boolean {
        if (mimeType.isNullOrBlank()) return false
        return ALLOWED_MIMES.contains(mimeType.trim().lowercase())
    }

    fun sanitizeFileName(rawName: String?): String {
        val base = rawName?.trim()?.substringAfterLast('/')?.substringAfterLast('\\').orEmpty()
        val cleaned = base.replace(Regex("[^A-Za-z0-9._\\-\\u0600-\\u06FF ]"), "_").trim()
        return if (cleaned.isEmpty()) "attachment.bin" else cleaned.take(255)
    }

    fun buildPickedFileJson(
        name: String,
        mimeType: String,
        sizeBytes: Int,
        base64Data: String,
        source: String,
    ): JSONObject? {
        if (!isMimeAllowed(mimeType)) return null
        if (sizeBytes <= 0 || sizeBytes > MAX_FILE_BYTES || base64Data.isBlank()) return null
        val safeSource = when (source) {
            "camera", "document_picker", "gallery" -> source
            else -> "document_picker"
        }
        return JSONObject()
            .put("name", sanitizeFileName(name))
            .put("mimeType", mimeType.trim().lowercase())
            .put("sizeBytes", sizeBytes)
            .put("base64Data", base64Data)
            .put("source", safeSource)
    }

    fun buildMediaPickResult(files: List<JSONObject>): JSONObject =
        JSONObject().put("files", JSONArray(files.take(10)))

    fun createShareChooserIntent(
        title: String,
        text: String?,
        url: String?,
    ): Intent {
        val body = listOfNotNull(
            text?.trim()?.takeIf { it.isNotEmpty() },
            url?.trim()?.takeIf { it.isNotEmpty() },
        ).joinToString("\n").ifEmpty { title.trim() }

        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, title.trim().take(200))
            putExtra(Intent.EXTRA_TEXT, body.take(4000))
        }
        return Intent.createChooser(sendIntent, title.trim().take(120)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    fun cleanupTempFiles(cacheDir: File, prefix: String = "biza_temp_"): Int {
        val children = cacheDir.listFiles() ?: return 0
        var deleted = 0
        for (file in children) {
            if (file.isFile && file.name.startsWith(prefix)) {
                if (file.delete()) deleted += 1
            }
        }
        return deleted
    }

    fun cleanupContextTempFiles(context: Context): Int =
        cleanupTempFiles(context.cacheDir)
}
