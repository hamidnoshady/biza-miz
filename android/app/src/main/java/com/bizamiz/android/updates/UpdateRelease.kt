package com.bizamiz.android.updates

import org.json.JSONArray

/** One stable Android build published on this repository's GitHub Releases. */
data class UpdateRelease(
    val version: String,
    val apkUrl: String,
    val notes: String,
    val releaseUrl: String,
)

/**
 * Which published release may be offered as an update.
 *
 * Stable builds of all three products live in the same repository, separated by
 * tag prefix: `android-vX.Y.Z` here, `desktop-vX.Y.Z` for the Windows app and
 * `vX.Y.Z` for the WordPress plugin. Only the Android prefix is this app's, and
 * only a release that is neither a draft nor a prerelease and actually carries an
 * APK can be installed. Nothing here downloads or installs anything; the caller
 * posts a notification and the user decides.
 *
 * Pure (no Android imports) so it is unit-tested on the JVM.
 */
object UpdateReleasePolicy {
    const val TAG_PREFIX = "android-v"
    const val APK_SUFFIX = ".apk"

    /** `android-v1.2.3` or `1.2.3` -> [1, 2, 3]; anything else is refused, never guessed. */
    fun parseVersion(value: String?): List<Int>? {
        val parts = value?.trim()?.removePrefix(TAG_PREFIX)?.split(".") ?: return null
        if (parts.size != 3) return null
        val numbers = parts.map { it.toIntOrNull() ?: return null }
        return if (numbers.all { it >= 0 }) numbers else null
    }

    /** True only when [candidate] is a strictly newer plain `X.Y.Z` than [installed]. */
    fun isNewer(candidate: String?, installed: String?): Boolean {
        val next = parseVersion(candidate) ?: return false
        val current = parseVersion(installed) ?: return false
        for (index in 0..2) {
            if (next[index] != current[index]) return next[index] > current[index]
        }
        return false
    }

    /**
     * The newest published stable Android release newer than [installedVersion],
     * or null when there is nothing to offer.
     */
    fun newestAvailable(releases: JSONArray, installedVersion: String): UpdateRelease? {
        var best: UpdateRelease? = null
        var bestVersion = ""
        for (index in 0 until releases.length()) {
            val release = releases.optJSONObject(index) ?: continue
            if (release.optBoolean("draft", false) || release.optBoolean("prerelease", false)) continue
            val tag = release.optString("tag_name", "")
            if (!tag.startsWith(TAG_PREFIX)) continue
            val version = tag.removePrefix(TAG_PREFIX)
            if (!isNewer(version, installedVersion)) continue
            val apkUrl = apkAssetUrl(release.optJSONArray("assets")) ?: continue
            if (best == null || isNewer(version, bestVersion)) {
                best = UpdateRelease(
                    version = version,
                    apkUrl = apkUrl,
                    notes = release.optString("body", ""),
                    releaseUrl = release.optString("html_url", ""),
                )
                bestVersion = version
            }
        }
        return best
    }

    /** The first HTTPS APK asset of a release; a release without one cannot update the app. */
    private fun apkAssetUrl(assets: JSONArray?): String? {
        if (assets == null) return null
        for (index in 0 until assets.length()) {
            val asset = assets.optJSONObject(index) ?: continue
            val name = asset.optString("name", "")
            val url = asset.optString("browser_download_url", "")
            if (name.endsWith(APK_SUFFIX, ignoreCase = true) && url.startsWith("https://")) return url
        }
        return null
    }
}
