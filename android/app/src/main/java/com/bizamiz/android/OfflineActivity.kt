package com.bizamiz.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView

/**
 * Shown instead of the web app when it cannot be opened: no network, no browser that supports
 * Trusted Web Activities, or a build with no web origin configured. Persian text, dark theme.
 */
class OfflineActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_offline)

        val reason = intent?.getStringExtra(EXTRA_REASON) ?: REASON_OFFLINE
        findViewById<TextView>(R.id.message).setText(
            when (reason) {
                REASON_NOT_CONFIGURED -> R.string.not_configured_body
                REASON_BROWSER_UNAVAILABLE -> R.string.browser_unavailable_body
                else -> R.string.offline_body
            },
        )

        val retry = findViewById<Button>(R.id.retry)
        // Retrying a build that has no origin cannot succeed, so the button is hidden.
        retry.visibility = if (reason == REASON_NOT_CONFIGURED) View.GONE else View.VISIBLE
        retry.setOnClickListener { retryLaunch() }
    }

    private fun retryLaunch() {
        val target = Intent(this, TwaLauncherActivity::class.java)
        val url = intent?.getStringExtra(EXTRA_URL)
        if (!url.isNullOrBlank()) {
            target.action = Intent.ACTION_VIEW
            target.data = Uri.parse(url)
        }
        startActivity(target)
        finish()
    }

    companion object {
        const val EXTRA_REASON = "com.bizamiz.android.extra.OFFLINE_REASON"
        const val EXTRA_URL = "com.bizamiz.android.extra.OFFLINE_URL"

        const val REASON_OFFLINE = "offline"
        const val REASON_NOT_CONFIGURED = "not_configured"
        const val REASON_BROWSER_UNAVAILABLE = "browser_unavailable"

        fun intent(context: Context, reason: String, url: String?): Intent =
            Intent(context, OfflineActivity::class.java)
                .putExtra(EXTRA_REASON, reason)
                .putExtra(EXTRA_URL, url)
    }
}
