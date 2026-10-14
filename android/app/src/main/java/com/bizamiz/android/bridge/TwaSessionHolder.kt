package com.bizamiz.android.bridge

import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession

/**
 * Keeps the Custom Tabs connection, callback and session reachable while the TWA runs.
 *
 * The launcher activity finishes once the TWA is on screen, so nothing else holds these objects.
 * Without this, the binder that Chrome uses to reach the callback can be collected, and the page
 * silently loses its native channel.
 */
object TwaSessionHolder {
    @Volatile
    private var connection: CustomTabsServiceConnection? = null

    @Volatile
    private var callback: TwaChannelCallback? = null

    @Volatile
    private var session: CustomTabsSession? = null

    fun hold(
        connection: CustomTabsServiceConnection,
        callback: TwaChannelCallback,
        session: CustomTabsSession,
    ) {
        this.connection = connection
        this.callback = callback
        this.session = session
    }
}
