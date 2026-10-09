package com.bizamiz.android.bridge

import android.net.Uri
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsSession

/**
 * Carries the bridge over the Custom Tabs post-message channel that Chrome opens inside the TWA.
 *
 * Flow: after the TWA finishes navigating, ask for a channel to the web origin. Chrome then
 * delivers a MessagePort to the page. When the channel is ready, announce `bridge.ready`. Answer
 * each page request through [BridgeCommandRouter], which accepts only named commands.
 *
 * [origin] is both the source and the target. The Digital Asset Links statement for this origin
 * is what makes the app's `use_as_origin` valid (see public/.well-known/assetlinks.json).
 */
class TwaChannelCallback(
    private val router: BridgeCommandRouter,
    private val origin: Uri,
) : CustomTabsCallback() {

    @Volatile
    private var session: CustomTabsSession? = null

    fun attach(session: CustomTabsSession) {
        this.session = session
    }

    override fun onNavigationEvent(navigationEvent: Int, extras: Bundle?) {
        if (navigationEvent == CustomTabsCallback.NAVIGATION_FINISHED) {
            // If Chrome refuses the channel (for example, the origin is not validated), this returns
            // false and no port reaches the page. The page then stays in web mode, which is intended.
            session?.requestPostMessageChannel(origin, origin, Bundle())
        }
    }

    override fun onMessageChannelReady(extras: Bundle?) {
        session?.postMessage(router.readyEvent(), null)
    }

    override fun onPostMessage(message: String, extras: Bundle?) {
        val reply = router.handleFrame(message) ?: return
        session?.postMessage(reply, null)
    }
}
