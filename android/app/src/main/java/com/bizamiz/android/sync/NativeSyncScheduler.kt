package com.bizamiz.android.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Abstraction over Android's supported background execution API (`WorkManager`)
 * for tenant-scoped operational reconciliation (issue #884, Root Cause 3).
 *
 * Invariants:
 * - Requires `NetworkType.CONNECTED` so sync passes only run when a network
 *   interface is available.
 * - Uses exponential backoff (`BackoffPolicy.EXPONENTIAL`) and unique work names
 *   per tenant so duplicate requests coalesce rather than stacking.
 * - `cancelTenantSync` and `cancelAllSync` immediately cancel queued/running
 *   `WorkManager` work on tenant switch, sign-out, or revocation.
 */
interface NativeSyncScheduler {
    fun scheduleSync(businessId: String?, expedited: Boolean, attempt: Int = 0): Boolean
    fun cancelTenantSync(businessId: String)
    fun cancelAllSync()
}

class WorkManagerSyncScheduler(
    context: Context,
) : NativeSyncScheduler {
    private val appContext: Context = context.applicationContext

    override fun scheduleSync(businessId: String?, expedited: Boolean, attempt: Int): Boolean {
        return try {
            val workManager = WorkManager.getInstance(appContext)
            val cleanBiz = businessId?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_SCOPE
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val inputData = Data.Builder()
                .putString(BizaSyncWorker.KEY_BUSINESS_ID, cleanBiz)
                .putInt(BizaSyncWorker.KEY_ATTEMPT, attempt.coerceAtLeast(0))
                .build()

            val oneTimeRequest = OneTimeWorkRequestBuilder<BizaSyncWorker>()
                .setConstraints(constraints)
                .setInputData(inputData)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    TenantSyncStateStore.BASE_BACKOFF_MS,
                    TimeUnit.MILLISECONDS,
                )
                .addTag(ALL_SYNC_TAG)
                .addTag(tenantTag(cleanBiz))
                .build()

            val policy = if (expedited) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP
            workManager.enqueueUniqueWork(uniqueOneTimeName(cleanBiz), policy, oneTimeRequest)

            val periodicRequest = PeriodicWorkRequestBuilder<BizaSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .setInputData(inputData)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    TenantSyncStateStore.BASE_BACKOFF_MS,
                    TimeUnit.MILLISECONDS,
                )
                .addTag(ALL_SYNC_TAG)
                .addTag(tenantTag(cleanBiz))
                .build()

            workManager.enqueueUniquePeriodicWork(
                uniquePeriodicName(cleanBiz),
                ExistingPeriodicWorkPolicy.KEEP,
                periodicRequest,
            )
            true
        } catch (_: Exception) {
            false
        }
    }

    override fun cancelTenantSync(businessId: String) {
        val cleanBiz = businessId.trim().takeIf { it.isNotEmpty() } ?: return
        try {
            val workManager = WorkManager.getInstance(appContext)
            workManager.cancelUniqueWork(uniqueOneTimeName(cleanBiz))
            workManager.cancelUniqueWork(uniquePeriodicName(cleanBiz))
            workManager.cancelAllWorkByTag(tenantTag(cleanBiz))
        } catch (_: Exception) {
        }
    }

    override fun cancelAllSync() {
        try {
            val workManager = WorkManager.getInstance(appContext)
            workManager.cancelAllWorkByTag(ALL_SYNC_TAG)
        } catch (_: Exception) {
        }
    }

    companion object {
        const val ALL_SYNC_TAG = "biza_native_sync_all"
        private const val DEFAULT_SCOPE = "active_session"

        fun tenantTag(businessId: String): String = "biza_native_sync_tenant:$businessId"
        fun uniqueOneTimeName(businessId: String): String = "biza_sync_once:$businessId"
        fun uniquePeriodicName(businessId: String): String = "biza_sync_periodic:$businessId"
    }
}
