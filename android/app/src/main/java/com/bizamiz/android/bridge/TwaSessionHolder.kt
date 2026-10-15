package com.bizamiz.android.bridge

import android.content.Context
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsSession
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * Keeps the active [CustomTabsSession] and its callback reachable while the browser is in the
 * foreground. [CustomTabsClient.newSession] stores the callback inside the framework's stub via a
 * weak reference on some Android versions, and our launcher activity may stop once the browser
 * covers it, so we hold a weak reference here tied to the service connection's lifetime.
 */
internal object TwaSessionHolder {
    private var contextRef: WeakReference<Context>? = null
    private var callbackRef: WeakReference<CustomTabsCallback>? = null
    private var sessionRef: WeakReference<CustomTabsSession>? = null

    fun hold(context: Context, callback: CustomTabsCallback, session: CustomTabsSession) {
        contextRef = WeakReference(context)
        callbackRef = WeakReference(callback)
        sessionRef = WeakReference(session)
    }

    fun postEvent(name: String, payload: JSONObject): Boolean {
        val session = sessionRef?.get() ?: return false
        return try {
            val frame = BridgeProtocol.encodeEvent(name, payload)
            session.postMessage(frame, null)
            true
        } catch (_: Exception) {
            false
        }
    }

    fun clear() {
        contextRef = null
        callbackRef = null
        sessionRef = null
    }
}
