package com.bizamiz.android.updates

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.bizamiz.android.BuildConfig
import java.util.concurrent.TimeUnit

/**
 * Daily GitHub Releases update check. The app also checks on launch, so a device
 * that is reopened daily does not depend on this worker at all; it exists so a
 * long-running kiosk install still learns about a new stable build.
 */
class UpdateCheckWorker(
    appContext: Context,
    workerParams: WorkerParameters,
) : Worker(appContext, workerParams) {

    override fun doWork(): Result {
        AppUpdateChecker.checkNow(applicationContext)
        return Result.success()
    }
}

object AppUpdateScheduler {
    private const val UNIQUE_WORK = "biza_app_update_check"

    /** Production only, network required, one unique periodic check per install. */
    fun schedule(context: Context) {
        if (BuildConfig.APP_ENVIRONMENT != "production") return
        try {
            val request = PeriodicWorkRequestBuilder<UpdateCheckWorker>(1, TimeUnit.DAYS)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .addTag(UNIQUE_WORK)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
        } catch (_: Exception) {
            // Background scheduling is an enhancement; the launch check still runs.
        }
    }
}
