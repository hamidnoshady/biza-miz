package com.bizamiz.android.navigation

import java.net.URI
import java.net.URISyntaxException

/** Where the TWA should open, or that the build has no origin to open at all. */
sealed class LaunchDecision {
    data class Open(val url: String) : LaunchDecision()

    data object NotConfigured : LaunchDecision()
}

/**
 * Decides which URL the TWA opens for an incoming intent.
 *
 * Only https links on the build's own web host are opened inside the TWA. Anything else falls
 * back to the home page, so an App Link can never send the user to a different site. This uses
 * java.net.URI rather than android.net.Uri so that the rules can be unit-tested on the JVM.
 */
object AppLinkRouter {
    private val hostPattern = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")

    /**
     * @param incoming the intent's data string, or null for the launcher icon.
     * @param webOrigin the build's configured origin, for example `https://app.example.com`.
     */
    fun decide(incoming: String?, webOrigin: String): LaunchDecision {
        val origin = parseOrigin(webOrigin) ?: return LaunchDecision.NotConfigured
        val home = "https://${origin.host}/"
        if (incoming.isNullOrBlank()) return LaunchDecision.Open(home)
        return LaunchDecision.Open(parseLink(incoming, origin.host) ?: home)
    }

    /** Returns the https origin URI, or null when the value is empty, not https, or has a path. */
    fun parseOrigin(webOrigin: String): URI? {
        if (webOrigin.isBlank()) return null
        val uri = try {
            URI(webOrigin)
        } catch (error: URISyntaxException) {
            return null
        }
        val host = uri.host ?: return null
        if (uri.scheme != "https" || uri.rawUserInfo != null) return null
        val path = uri.rawPath
        if (!path.isNullOrEmpty() && path != "/") return null
        if (uri.rawQuery != null || uri.rawFragment != null) return null
        if (uri.port != -1 && uri.port != 443) return null
        if (!hostPattern.matches(host.lowercase())) return null
        return uri
    }

    private fun parseLink(raw: String, expectedHost: String): String? {
        val uri = try {
            URI(raw)
        } catch (error: URISyntaxException) {
            return null
        }
        if (uri.scheme != "https") return null
        if (uri.rawUserInfo != null) return null
        if (!expectedHost.equals(uri.host, ignoreCase = true)) return null
        if (uri.port != -1 && uri.port != 443) return null
        return uri.toString()
    }
}
