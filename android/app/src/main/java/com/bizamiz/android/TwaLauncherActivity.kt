package com.bizamiz.android

import android.app.Activity
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.trusted.TrustedWebActivityIntentBuilder
import com.bizamiz.android.bridge.BridgeCommandRouter
import com.bizamiz.android.bridge.TwaChannelCallback
import com.bizamiz.android.bridge.TwaSessionHolder
import com.bizamiz.android.navigation.AppLinkRouter
import com.bizamiz.android.navigation.LaunchDecision

/**
 * The only entry point. It opens the web app as a Trusted Web Activity, or shows the offline or
 * not-configured screen when it cannot.
 *
 * It finishes itself once the TWA is on screen. The process stays alive because
 * [TwaSessionHolder] keeps the Custom Tabs session that carries the native bridge.
 */
class TwaLauncherActivity : Activity() {

    /**
     * Every route gets a new generation. A Custom Tabs connection or a timeout that belongs to an
     * earlier route is then ignored, so it cannot open a second screen over the current one.
     */
    private var launchGeneration = 0

    /** True once the TWA was started or the offline screen was shown for the current generation. */
    private var settled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        route(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent != null) {
            setIntent(intent)
            route(intent)
        }
    }

    private fun route(incoming: Intent?) {
        launchGeneration++
        settled = false
        val data = if (incoming != null && incoming.action == Intent.ACTION_VIEW) incoming.dataString else null
        when (val decision = AppLinkRouter.decide(data, BuildConfig.WEB_ORIGIN)) {
            LaunchDecision.NotConfigured -> {
                settled = true
                startActivity(OfflineActivity.intent(this, OfflineActivity.REASON_NOT_CONFIGURED, null))
                finish()
            }
            is LaunchDecision.Open -> {
                if (isOnline()) {
                    openTrustedWebActivity(decision.url)
                } else {
                    settled = true
                    startActivity(OfflineActivity.intent(this, OfflineActivity.REASON_OFFLINE, decision.url))
                    finish()
                }
            }
        }
    }

    private fun isOnline(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return true
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun openTrustedWebActivity(url: String) {
        val generation = launchGeneration
        val browserPackage = CustomTabsClient.getPackageName(this, null)
        if (browserPackage == null) {
            showBrowserUnavailable(url)
            return
        }

        val appContext = applicationContext
        val callback = TwaChannelCallback(
            router = BridgeCommandRouter(
                environment = BuildConfig.APP_ENVIRONMENT,
                appVersionName = BuildConfig.VERSION_NAME,
                appVersionCode = BuildConfig.VERSION_CODE,
                notificationsEnabled = {
                    appContext.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() ?: false
                },
            ),
            origin = Uri.parse(BuildConfig.WEB_ORIGIN),
        )

        val connection = object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
                if (generation != launchGeneration || settled) return
                // The Custom Tabs guide calls warmup before newSession. Keep that order.
                client.warmup(0L)
                val session = client.newSession(callback)
                if (session == null) {
                    showBrowserUnavailable(url)
                    return
                }
                callback.attach(session)
                TwaSessionHolder.hold(this, callback, session)

                // build() returns a TrustedWebActivityIntent, which is not an Intent. Launch it through
                // its own method, as the androidx.browser documentation recommends.
                val trustedIntent = TrustedWebActivityIntentBuilder(Uri.parse(url))
                    .setToolbarColor(Color.parseColor("#0F172A"))
                    .build(session)
                settled = true
                trustedIntent.launchTrustedWebActivity(this@TwaLauncherActivity)
                finish()
            }

            override fun onServiceDisconnected(name: ComponentName) {
                // The binding lives for the life of the process, so there is nothing to undo here.
            }
        }

        if (!CustomTabsClient.bindCustomTabsService(this, browserPackage, connection)) {
            showBrowserUnavailable(url)
            return
        }
        // A browser that accepts the bind but never answers would leave a blank screen. Give up after a while.
        Handler(Looper.getMainLooper()).postDelayed({
            if (generation == launchGeneration && !settled) showBrowserUnavailable(url)
        }, BROWSER_CONNECT_TIMEOUT_MS)
    }

    private fun showBrowserUnavailable(url: String) {
        if (settled) return
        settled = true
        startActivity(OfflineActivity.intent(this, OfflineActivity.REASON_BROWSER_UNAVAILABLE, url))
        finish()
    }

    companion object {
        private const val BROWSER_CONNECT_TIMEOUT_MS = 5_000L
    }
}
