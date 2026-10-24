package com.bizamiz.android.bridge

import android.content.Context
import java.util.UUID

/**
 * The app's own persistent installation identity (issue #884's device registry).
 *
 * Generated once, on whichever launch first asks for it, and kept in a private
 * [android.content.SharedPreferences] file — not a login credential, so it needs no stronger
 * protection than that: `POST /api/native-devices` only ever accepts it from an
 * already-authenticated web session (see `docs/deployment/android-runtime.md#bridge-contract`). A
 * reinstall wipes app-private storage, so it correctly gets a new id rather than reviving the
 * uninstalled app's old registration — exactly what `native_app_devices`'s unique
 * `(business_id, install_id)` constraint assumes.
 *
 * [UUID.randomUUID] is backed by [java.security.SecureRandom] on the JVM/Android, the same
 * source `crypto.getRandomValues` uses on the web side (bridge.ts's `createRequestId`), so this
 * is not a weaker source of randomness than the id the page itself mints for bridge requests.
 */
object InstallationId {
    private const val PREFS_NAME = "biza_native_device"
    private const val KEY_INSTALLATION_ID = "installation_id"

    fun read(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.getString(KEY_INSTALLATION_ID, null)?.let { return it }

        val generated = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_INSTALLATION_ID, generated).apply()
        return generated
    }

    fun isValid(id: String): Boolean =
        id.length in 8..128 && id.all { it.isLetterOrDigit() || it == '-' || it == '_' }
}
