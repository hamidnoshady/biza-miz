package com.bizamiz.android.bridge

import android.content.Context
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsSession
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.ArrayDeque

/**
 * Keeps the active [CustomTabsSession] and its callback reachable while the browser is in the
 * foreground, and buffers native-to-web events (such as cold-start notification `navigation.deepLink`
 * or post-call `crm.callEnded`) until [onChannelReady] fires on the Custom Tabs message channel.
 */
internal object TwaSessionHolder {
    private const val MAX_BUFFERED_EVENTS = 16

    private var contextRef: WeakReference<Context>? = null
    private var callbackRef: WeakReference<CustomTabsCallback>? = null
    private var sessionRef: WeakReference<CustomTabsSession>? = null

    @Volatile
    private var channelReady: Boolean = false

    private val pendingEvents = ArrayDeque<Pair<String, JSONObject>>()
    private var pendingReconcileProvider: (() -> List<Pair<String, JSONObject>>)? = null

    @Synchronized
    fun hold(context: Context, callback: CustomTabsCallback, session: CustomTabsSession) {
        contextRef = WeakReference(context)
        callbackRef = WeakReference(callback)
        sessionRef = WeakReference(session)
        channelReady = false
    }

    @Synchronized
    fun setPendingReconcileProvider(provider: (() -> List<Pair<String, JSONObject>>)?) {
        pendingReconcileProvider = provider
    }

    @Synchronized
    fun isChannelReady(): Boolean = channelReady && sessionRef?.get() != null

    @Synchronized
    fun onChannelReady(session: CustomTabsSession?) {
        val activeSession = session ?: sessionRef?.get() ?: return
        channelReady = true
        while (pendingEvents.isNotEmpty()) {
            val (name, payload) = pendingEvents.pollFirst() ?: break
            try {
                val frame = BridgeProtocol.encodeEvent(name, payload)
                activeSession.postMessage(frame, null)
            } catch (_: Exception) {
                // Drop malformed or unsendable frame rather than blocking subsequent events.
            }
        }
        val durableReconcileEvents = try {
            pendingReconcileProvider?.invoke().orEmpty()
        } catch (_: Exception) {
            emptyList()
        }
        for ((name, payload) in durableReconcileEvents) {
            try {
                val frame = BridgeProtocol.encodeEvent(name, payload)
                activeSession.postMessage(frame, null)
            } catch (_: Exception) {
                // Keep durable state in TenantSyncStateStore for next channel ready or status pull.
            }
        }
    }

    @Synchronized
    fun postEvent(name: String, payload: JSONObject): Boolean {
        val session = sessionRef?.get()
        if (channelReady && session != null) {
            return try {
                val frame = BridgeProtocol.encodeEvent(name, payload)
                session.postMessage(frame, null)
                true
            } catch (_: Exception) {
                enqueuePendingEvent(name, payload)
                false
            }
        }
        enqueuePendingEvent(name, payload)
        return false
    }

    @Synchronized
    private fun enqueuePendingEvent(name: String, payload: JSONObject) {
        if (!BridgeProtocol.ALLOWLISTED_EVENTS.contains(name)) return
        while (pendingEvents.size >= MAX_BUFFERED_EVENTS) {
            pendingEvents.pollFirst()
        }
        pendingEvents.addLast(name to payload)
    }

    @Synchronized
    fun clearPendingEvents() {
        pendingEvents.clear()
    }

    @Synchronized
    fun clear() {
        contextRef = null
        callbackRef = null
        sessionRef = null
        channelReady = false
    }
}
