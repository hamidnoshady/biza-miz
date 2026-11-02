/**
 * Issue #903 §3 and §9 — the Superadmin's **per-business operational** surface.
 *
 * The epic is explicit that `/platform/businesses/[id]/backups` must stop being
 * a read-only metadata page and become the place an operator can act:
 * "trigger/create, verify, diagnose, list/search, download/export with
 * high-privilege authorization, import/register, retry/catch-up,
 * retention/delete with protected recovery copies".
 *
 * This module holds the acting half; `tenant-backup-artifacts-service.ts` holds
 * the reading half. Both are scoped to the business named in the path and never
 * touch `/platform/backup/*`, which is the separate whole-platform disaster
 * recovery system.
 *
 * Two rules shape everything here:
 *
 *  1. **Operators drive the pipeline; they do not become a second pipeline.**
 *     A trigger calls the same `runBackupNow` the scheduler calls, a catch-up
 *     drains the same durable queue, a verify re-runs the same
 *     `verifyStoredArtifact`. Nothing bypasses the manifest, the custody key or
 *     the inventory.
 *  2. **Deleting an artifact is retention, not destruction.** The platform keeps
 *     `protected_recovery_copies` restorable backups per business, and a request
 *     that would go below that floor is refused rather than honoured. Deletion
 *     removes the stored bytes and marks the row `expired`, so the history — and
 *     the fact that this backup is gone — stays visible.
 */
import { promises as fs } from "node:fs";
import { deploymentRole } from "./deployment-role";
import { readDeploymentProfile, type DeploymentProfile } from "./deployment-mode";
import { getBackupConfig, runBackupNow, runCloudUpload } from "./backup-service";
import { logicalSnapshotScopeTag } from "./backup-policy";
import { s3Delete } from "./s3-lite";
import {
  businessCustodySummary,
  installedSchemaVersion,
  listStoredArtifactRows,
  markArtifactStateByRef,
  resolveOwnedArtifact,
  storageIncludedBytes,
} from "./tenant-backup-artifacts-service";
import { drainUploadQueue, queueDepth, readHeartbeat, type Heartbeat } from "./tenant-backup-hybrid";
import { fetchCloudArtifact } from "./tenant-backup-transport";
import { verifyStoredArtifact } from "./tenant-backup-runner";
import {
  resolveTenantBackupPolicy,
  resolveTenantStorage,
  type TenantBackupPolicy,
} from "./tenant-backup-storage";
import { lastDrillSummary } from "./tenant-backup-drills-job";
import { pendingVerificationCount, localArtifactPath as resolveLocalArtifactPath } from "./tenant-backup-lifecycle";
import type { ArtifactRowState } from "./tenant-backup-inventory";

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

export type OperatorActionCode =
  | "destination_not_configured"
  | "destination_unreadable"
  | "custody_unavailable"
  | "artifacts_failed"
  | "artifacts_never_verified"
  | "uploads_pending"
  | "uploads_dead"
  | "device_offline"
  | "no_artifact_yet"
  /** Issue #903 §12: the scheduled drill could not prove the last backup opens. */
  | "drill_failed"
  /** Issue #903 §1: a cloud copy the platform wrote has not been re-read yet. */
  | "cloud_unverified"
  /**
   * Issue #903 §3: the newest verified backup is already older than the
   * recovery-point objective this business's plan promises. A drill proves a
   * backup opens; this says the *right* one is not there any more.
   */
  | "dr_rpo_breached";

export interface BusinessBackupDiagnosis {
  businessId: string;
  profile: DeploymentProfile;
  role: ReturnType<typeof deploymentRole>;
  policy: TenantBackupPolicy;
  destination: {
    /** `managed`, `legacy` (the install's own historic bucket) or `unavailable`. */
    mode: "managed" | "legacy" | "unavailable";
    /** Provider-neutral refusal code when `mode` is `unavailable`. */
    reason: string | null;
  };
  custody: { keyVersion: number | null; kekAvailable: boolean } | null;
  storage: { includedBytes: number };
  queue: { pending: number };
  device: {
    connectivity: Heartbeat["connectivity"];
    lastSeenAt: string | null;
    siteGeneration: number | null;
    acceptedGeneration: number | null;
    lastErrorCode: string | null;
  };
  artifacts: Record<ArtifactRowState, number> & { total: number };
  /**
   * The last scheduled drill for this business, or `null` when none has run yet.
   * `ok: false` is the fact the console escalates: the backup exists and does
   * not open.
   */
  drill: {
    ok: boolean;
    artifactRef: string;
    missingSteps: string[];
    finishedAt: string;
  } | null;
  /**
   * Issue #903 §3 — the disaster-recovery objective this business is held to,
   * and how it stands against it. `rpoHours: null` means the fleet promises
   * none, which is reported as unset rather than met: a target nobody set is not
   * a target that was hit.
   */
  dr: {
    rpoHours: number | null;
    /** Capture time of the newest restorable-verified backup, or null. */
    newestVerifiedAt: string | null;
    /** Hours since that backup, or null when there is none. */
    ageHours: number | null;
    breached: boolean;
  };
  /** Codes, not prose: the console translates, the route stays stable. */
  actions: OperatorActionCode[];
}

const ARTIFACT_STATES: ArtifactRowState[] = [
  "pending_upload",
  "uploading",
  "verifying",
  "ready",
  "failed",
  "expired",
  "superseded",
];

/**
 * One honest picture of "is this business actually protected right now", made
 * of facts the platform already holds. Every `actions` entry is a real finding —
 * nothing is emitted for a healthy business.
 */
export async function diagnoseBusinessBackup(businessId: string): Promise<BusinessBackupDiagnosis> {
  const role = deploymentRole();
  const profile = (await readDeploymentProfile(businessId)).profile;
  const config = await getBackupConfig(businessId);

  const [policy, storage, rows, custody, includedBytes, pending, heartbeat, drill, unverified] = await Promise.all([
    resolveTenantBackupPolicy(businessId),
    resolveTenantStorage({
      businessId,
      profile,
      role,
      // A self-hosted install keeps uploading to its own historic bucket; the
      // diagnosis must say `legacy` rather than crying "not configured".
      legacyCloud: config.cloud,
    }),
    listStoredArtifactRows(businessId),
    // `legacyArtifacts: false` here: the count is about which artifacts this
    // business can still open, which the per-artifact rows already answer.
    businessCustodySummary(businessId, { legacyArtifacts: false }).catch(() => null),
    storageIncludedBytes(businessId),
    queueDepth(businessId).catch(() => 0),
    readHeartbeat(businessId).catch(() => null),
    // A deployment that has not run migration 0270 yet reports `null`, not an
    // error: "no drill has run" is a truthful answer to "did the drill pass?".
    lastDrillSummary(businessId).catch(() => null),
    // A cloud copy is registered `verifying` when it is uploaded and promoted by
    // the lifecycle pass once the object has actually been read back.
    pendingVerificationCount(businessId).catch(() => 0),
  ]);

  const artifacts = Object.fromEntries(ARTIFACT_STATES.map((state) => [state, 0])) as Record<
    ArtifactRowState,
    number
  > & { total: number };
  artifacts.total = rows.length;
  for (const row of rows) artifacts[row.state] += 1;

  const actions: OperatorActionCode[] = [];
  if (storage.mode === "unavailable") {
    actions.push(
      storage.reason === "local_profile" ? "destination_not_configured" : "destination_not_configured",
    );
  }
  if (custody && custody.scheme === "unconfigured") actions.push("custody_unavailable");
  if (artifacts.failed > 0) actions.push("artifacts_failed");
  if (artifacts.ready === 0 && artifacts.total > 0) actions.push("artifacts_never_verified");
  if (artifacts.total === 0) actions.push("no_artifact_yet");
  if (pending > 0) actions.push("uploads_pending");
  if (heartbeat?.lastErrorCode && heartbeat.lastErrorCode !== "ok") actions.push("uploads_dead");
  if (heartbeat && heartbeat.connectivity === "offline") actions.push("device_offline");
  if (drill && !drill.ok) actions.push("drill_failed");
  if (unverified > 0) actions.push("cloud_unverified");

  // Issue #903 §3 — the recovery-point objective, judged on what is *verified*:
  // an artifact that exists but has never been re-read is not a recovery point.
  const now = new Date();
  const verifiedRows = rows
    .filter((row) => row.state === "ready" && Boolean(row.verifiedAt))
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  const newestVerifiedAt = verifiedRows[0]?.capturedAt ?? null;
  const ageHours = newestVerifiedAt ? (now.getTime() - Date.parse(newestVerifiedAt)) / 3_600_000 : null;
  // `?? null`, not the bare field: a policy resolved from an older cache or a
  // fixture without the threshold has `undefined`, and "no objective" must not
  // read as "a zero-hour objective that is already breached".
  const rpoHours = policy.drRpoHours ?? null;
  const breached = rpoHours !== null && (ageHours === null || ageHours > rpoHours);
  if (breached) actions.push("dr_rpo_breached");

  return {
    businessId,
    profile,
    role,
    policy,
    destination: {
      mode: storage.mode,
      reason: storage.mode === "unavailable" ? storage.reason : null,
    },
    custody: custody
      ? { keyVersion: custody.activeVersion, kekAvailable: custody.scheme !== "unconfigured" }
      : null,
    storage: { includedBytes },
    queue: { pending },
    device: {
      connectivity: heartbeat?.connectivity ?? "unknown",
      lastSeenAt: heartbeat?.lastSeenAt ?? null,
      siteGeneration: heartbeat?.siteGeneration ?? null,
      acceptedGeneration: heartbeat?.acceptedGeneration ?? null,
      lastErrorCode: heartbeat?.lastErrorCode ?? null,
    },
    artifacts,
    dr: {
      rpoHours,
      newestVerifiedAt: newestVerifiedAt ?? null,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      breached,
    },
    drill: drill
      ? {
          ok: drill.ok,
          artifactRef: drill.artifactRef,
          missingSteps: drill.missingSteps,
          finishedAt: drill.finishedAt,
        }
      : null,
    actions: [...new Set(actions)],
  };
}

// ---------------------------------------------------------------------------
// Trigger / retry
// ---------------------------------------------------------------------------

export type OperatorRunResult =
  | {
      ok: true;
      local: { status: "ok"; runId: string; sizeBytes: number; mode: "physical" | "logical" } | { status: string };
      cloud: { status: string };
    }
  | { ok: false; error: string };

/**
 * Trigger a run now, on the operator's behalf, through the shipped pipeline.
 *
 * The failure detail is deliberately reduced to a code: the underlying error can
 * name a filesystem path or an object key, and `diagnose` already reports the
 * provider-neutral `failure_code` from the inventory. There is no charge: a
 * Superadmin action is not a billable tenant use (§8 bills *verified* managed
 * usage measured in byte-days, not operator curiosity).
 */
export async function runBusinessBackup(businessId: string): Promise<OperatorRunResult> {
  const result = await runBackupNow(businessId);
  if (result.local.status === "ok") {
    return {
      ok: true,
      local: {
        status: "ok",
        runId: result.local.runId,
        sizeBytes: result.local.sizeBytes,
        mode: result.local.mode,
      },
      cloud: { status: result.cloud.status },
    };
  }
  if (result.local.status === "failed") return { ok: false, error: "backup_run_failed" };
  // busy / disabled: not a failure, and not something to retry in a loop.
  return { ok: true, local: { status: result.local.status }, cloud: { status: result.cloud.status } };
}

export interface CatchUpResult {
  attempted: number;
  uploaded: number;
  failed: number;
  remaining: number;
}

/**
 * Retry the durable upload queue for one business — the operator's version of
 * "come back online". Same queue, same backoff, same generation fence; the
 * operator only decides *when* to look again.
 */
export async function catchUpBusinessUploads(businessId: string): Promise<CatchUpResult> {
  let attempted = 0;
  let uploaded = 0;
  let failed = 0;
  await drainUploadQueue(businessId, async (artifactName) => {
    attempted += 1;
    const result = await runCloudUpload(businessId, artifactName, "manual");
    if (result.status === "ok") {
      uploaded += 1;
      return { ok: true };
    }
    failed += 1;
    // A missing destination is a configuration problem, not a bad artifact: the
    // entry stays queued (with backoff) exactly as the scheduler leaves it.
    return { ok: false, error: result.status === "disabled" ? "storage_unavailable" : result.error };
  });
  return { attempted, uploaded, failed, remaining: await queueDepth(businessId).catch(() => 0) };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export type OperatorVerifyResult =
  | { ok: true; state: "ready"; tables: number }
  | { ok: false; error: string };

/**
 * Re-prove an artifact from its stored bytes — the operator's "verify" button,
 * and the only way back for an artifact a failed run left `failed`.
 *
 * Unlike the download plan, this does **not** refuse a `failed` row: verifying a
 * failure is the whole point. It does refuse a row belonging to another business
 * (it is not resolvable at all).
 */
export async function verifyBusinessArtifact(
  businessId: string,
  ref: string,
): Promise<OperatorVerifyResult> {
  const role = deploymentRole();
  const profile = (await readDeploymentProfile(businessId)).profile;
  const row = await resolveOwnedArtifact(businessId, ref);
  if (!row) return { ok: false, error: "artifact_not_found" };

  const schemaVersion = await installedSchemaVersion();
  let stagedPath: string;
  let cleanup: () => Promise<void> = async () => {};

  if (row.destination === "local") {
    const located = await localArtifactPath(businessId, row.storageRef);
    if (!located.ok) return { ok: false, error: located.error };
    stagedPath = located.path;
  } else {
    const fetched = await fetchCloudArtifact({ businessId, ref, profile, role, suffix: "ops-verify" });
    if (!fetched.ok) return { ok: false, error: fetched.error };
    stagedPath = fetched.path;
    cleanup = fetched.cleanup;
  }

  try {
    const verified = await verifyStoredArtifact(businessId, { ref, stagedPath, schemaVersion });
    await markArtifactStateByRef(
      businessId,
      ref,
      verified.ok ? { state: "ready", failureCode: null } : { state: "failed", failureCode: verified.error },
    );
    return verified.ok ? { ok: true, state: "ready", tables: verified.tables } : { ok: false, error: verified.error };
  } finally {
    await cleanup();
  }
}

/**
 * The artifact's file. Delegated to the lifecycle module rather than resolved
 * here: on central a tenant's artifacts live in `backups/tenants/<scope>/`, so a
 * flat `config.directory` path would miss them and report `artifact_missing` for
 * a file that is sitting right there.
 */
const localArtifactPath = async (businessId: string, storageRef: string) => {
  const config = await getBackupConfig(businessId);
  return resolveLocalArtifactPath(businessId, storageRef, config.directory);
};

// ---------------------------------------------------------------------------
// Retention delete
// ---------------------------------------------------------------------------

export type OperatorDeleteResult =
  | { ok: true; state: "expired"; deletedBytes: boolean }
  | { ok: false; error: "artifact_not_found" | "protected_copies" | "storage_delete_failed" };

/**
 * Delete one stored artifact, while keeping the platform's protected recovery
 * floor intact.
 *
 * The count is of **logical backups** (distinct artifact ids) still `ready`, not
 * of rows: a mirror's local and cloud rows are one backup at two destinations,
 * and destroying the second half of the last backup must not be possible just
 * because two rows existed.
 */
export async function deleteBusinessArtifact(
  businessId: string,
  ref: string,
): Promise<OperatorDeleteResult> {
  const row = await resolveOwnedArtifact(businessId, ref);
  if (!row) return { ok: false, error: "artifact_not_found" };

  const [policy, rows] = await Promise.all([
    resolveTenantBackupPolicy(businessId),
    listStoredArtifactRows(businessId),
  ]);
  const restorable = new Set(
    rows.filter((candidate) => candidate.state === "ready").map((candidate) => candidate.artifactId),
  );
  const counts = row.state === "ready" && restorable.has(row.artifactId);
  const remaining = counts ? restorable.size - 1 : restorable.size;
  if (remaining < policy.protectedCopies) return { ok: false, error: "protected_copies" };

  let deletedBytes = false;
  try {
    if (row.destination === "local") {
      const located = await localArtifactPath(businessId, row.storageRef);
      // An already-missing file is not an error: retention is idempotent.
      if (located.ok) {
        await fs.rm(located.path, { force: true });
        deletedBytes = true;
      }
    } else {
      const profile = (await readDeploymentProfile(businessId)).profile;
      const config = await getBackupConfig(businessId);
      const storage = await resolveTenantStorage({
        businessId,
        profile,
        role: deploymentRole(),
        legacyCloud: config.cloud,
      });
      if (storage.mode === "unavailable") return { ok: false, error: "storage_delete_failed" };
      const key =
        storage.mode === "managed"
          ? `${storage.prefix}tenants/${logicalSnapshotScopeTag(businessId)}/${row.storageRef}`
          : `${storage.prefix}${row.storageRef}`;
      await s3Delete(storage.s3, key);
      deletedBytes = true;
    }
  } catch {
    // The bytes may still exist. Saying "deleted" would let an operator stop
    // worrying about an object that is still billable and still recoverable.
    return { ok: false, error: "storage_delete_failed" };
  }

  await markArtifactStateByRef(businessId, ref, { state: "expired", failureCode: "deleted_by_operator" });
  return { ok: true, state: "expired", deletedBytes };
}
