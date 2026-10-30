/**
 * Issue #903 §1 / §7 — artifact lifecycle: what stops existing, and when.
 *
 * Two things wrote artifact rows and nothing ever took them away:
 *
 *  1. **Cloud had a persistent local copy.** §1 says a Cloud deployment keeps
 *     tenant backups *only* on the platform's managed storage; the app server
 *     may stage bytes, never keep them. In practice every logical run wrote
 *     `backups/tenants/<scope>/<artifact>` and left it there after the upload
 *     succeeded, so the platform held a second, unmanaged copy of every tenant's
 *     data on its own disk.
 *  2. **Retention was written down and never enforced.** `retention_until` was
 *     recorded on every row by the runner, and no scheduler ever read it back.
 *     Worse, the hourly byte sample summed every cloud row regardless of
 *     retention, so a business kept being billed for bytes the policy said had
 *     expired.
 *
 * This module is the single owner of "remove it": it deletes bytes and only then
 * records the removal, it never crosses the protected-copy floor, and it refuses
 * to claim a deletion that did not happen.
 *
 * The three passes, in the order they run:
 *
 * ```text
 * verify    promoting `verifying` cloud rows by re-reading the object, bounded
 *           per business per tick — the "later verify pass" the upload path has
 *           always promised and nothing performed. A transient provider failure
 *           leaves the row alone (the next tick retries); only bytes that
 *           arrived and failed their own checks turn a row `failed`.
 * reclaim   Cloud + managed storage only: once a cloud copy is `ready`, the
 *           local twin's bytes and row are removed. The backup itself does not
 *           disappear — same `artifact_id`, still restorable — so this is the
 *           row deletion §1 requires rather than an `expired` marker that would
 *           make every cloud backup read as expired in the inventory.
 * expire    rows past `retention_until`, oldest first, while at least
 *           `protected_recovery_copies` distinct backups stay `ready`.
 * ```
 *
 * Why bytes first, always: a row that says `expired` while the object is still
 * in the bucket is the exact failure §7/§8 punish — the platform stops showing
 * a backup it is still paying for, and an operator stops worrying about data
 * that is still there and still billable.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { query, withoutTenantScope } from "./db";
import { getBackupConfig, tenantBackupDir } from "./backup-service";
import { deploymentRole } from "./deployment-role";
import { readDeploymentProfile } from "./deployment-mode";
import { s3Delete } from "./s3-lite";
import { logicalSnapshotScopeTag } from "./backup-policy";
import {
  installedSchemaVersion,
  markArtifactState,
  type StoredArtifactRow,
} from "./tenant-backup-artifacts-service";
import { verifyStoredArtifact } from "./tenant-backup-runner";
import { tenantBackupArtifactRef } from "./tenant-backup-artifact-ref";
import { resolveTenantBackupPolicy, resolveTenantStorage } from "./tenant-backup-storage";
import { fetchCloudArtifact } from "./tenant-backup-transport";

/** Cloud rows are re-read at most this many per business per tick. */
export const VERIFY_BATCH = 2;

/** States whose bytes may still be on disk and are therefore sweepable. */
const SWEEPABLE: ReadonlyArray<StoredArtifactRow["state"]> = ["ready", "verifying", "failed"];

export interface LifecycleOutcome {
  /** Cloud rows promoted to `ready` (or failed) by re-reading the object. */
  verified: number;
  verifyFailed: number;
  /** Cloud backups whose staged local twin was removed (§1). */
  reclaimed: number;
  reclaimedBytes: number;
  /** Artifacts whose retention passed and whose bytes were removed. */
  expired: number;
  /** Rows left alone because expiring them would breach the protected floor. */
  protectedSkipped: number;
  /** Rows whose bytes could not be removed, so nothing was recorded. */
  failedRemovals: number;
}

function emptyOutcome(): LifecycleOutcome {
  return {
    verified: 0,
    verifyFailed: 0,
    reclaimed: 0,
    reclaimedBytes: 0,
    expired: 0,
    protectedSkipped: 0,
    failedRemovals: 0,
  };
}

/**
 * The file a local artifact actually lives at.
 *
 * This goes through `tenantBackupDir`, not `config.directory`: on central each
 * business's artifacts sit in their own `tenants/<scope>` subdirectory, so the
 * flat path a self-hosted install uses would point at a file that has never
 * existed there — a "delete failed" that quietly leaves every tenant artifact on
 * the platform's disk.
 */
export async function localArtifactPath(
  businessId: string,
  storageRef: string,
  configuredDirectory?: string | null,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const directory = tenantBackupDir(businessId, configuredDirectory ?? undefined);
  const resolved = path.resolve(path.join(directory, storageRef));
  if (!resolved.startsWith(path.resolve(directory) + path.sep)) {
    return { ok: false, error: "artifact_not_found" };
  }
  try {
    await fs.stat(resolved);
  } catch {
    return { ok: false, error: "artifact_missing" };
  }
  return { ok: true, path: resolved };
}

export type RemoveBytesResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

/**
 * Remove one artifact's bytes. Idempotent: a file or object that is already gone
 * counts as removed, because retention must be safe to retry.
 */
export async function removeArtifactBytes(
  businessId: string,
  row: Pick<StoredArtifactRow, "destination" | "storageRef">,
): Promise<RemoveBytesResult> {
  try {
    if (row.destination === "local") {
      const located = await localArtifactPath(businessId, row.storageRef);
      // Already gone (or an unsafe name, which cannot name a file here at all):
      // retention must be safe to retry, so this is success with nothing removed.
      if (!located.ok) return { ok: true, removed: false };
      await fs.rm(located.path, { force: true });
      return { ok: true, removed: true };
    }

    const profile = (await readDeploymentProfile(businessId)).profile;
    const config = await getBackupConfig(businessId);
    const storage = await resolveTenantStorage({
      businessId,
      profile,
      role: deploymentRole(),
      legacyCloud: config.cloud,
    });
    if (storage.mode === "unavailable") return { ok: false, error: "storage_unavailable" };
    const key =
      storage.mode === "managed"
        ? `${storage.prefix}tenants/${logicalSnapshotScopeTag(businessId)}/${row.storageRef}`
        : `${storage.prefix}${row.storageRef}`;
    await s3Delete(storage.s3, key);
    return { ok: true, removed: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 80) : "storage_delete_failed" };
  }
}

/** Delete one artifact row after its bytes are gone. */
async function deleteArtifactRow(businessId: string, id: string): Promise<void> {
  await query(`DELETE FROM tenant_backup_artifacts WHERE business_id = $1 AND id = $2`, [businessId, id]);
}

interface LifecycleRow {
  id: string;
  artifactId: string;
  destination: "local" | "cloud";
  storageRef: string;
  state: StoredArtifactRow["state"];
  retentionUntil: string | null;
  storedBytes: number | null;
}

interface LifecycleDbRow extends Record<string, unknown> {
  id: string;
  artifact_id: string;
  destination: "local" | "cloud";
  storage_ref: string;
  state: StoredArtifactRow["state"];
  retention_until: Date | null;
  stored_bytes: string | null;
}

async function lifecycleRows(businessId: string): Promise<LifecycleRow[]> {
  const { rows } = await query<LifecycleDbRow>(
    `SELECT id, artifact_id, destination, storage_ref, state, retention_until, stored_bytes
       FROM tenant_backup_artifacts
      WHERE business_id = $1
      ORDER BY captured_at ASC`,
    [businessId],
  );
  return rows.map((row) => ({
    id: row.id,
    artifactId: row.artifact_id,
    destination: row.destination,
    storageRef: row.storage_ref,
    state: row.state,
    retentionUntil: row.retention_until ? row.retention_until.toISOString() : null,
    storedBytes: row.stored_bytes === null ? null : Number(row.stored_bytes),
  }));
}

/**
 * Enforce `retention_until` for one business.
 *
 * Candidates are grouped by `artifact_id`: a Hybrid mirror's two rows are one
 * backup and must expire together, and the protected floor counts backups, not
 * rows — otherwise destroying the second half of the last backup would look like
 * keeping one.
 */
export async function expireDueArtifacts(
  businessId: string,
  now: Date = new Date(),
): Promise<Pick<LifecycleOutcome, "expired" | "protectedSkipped" | "failedRemovals">> {
  const result = { expired: 0, protectedSkipped: 0, failedRemovals: 0 };
  const rows = await lifecycleRows(businessId);

  const readyIds = new Set(rows.filter((row) => row.state === "ready").map((row) => row.artifactId));
  const policy = await resolveTenantBackupPolicy(businessId);
  const floor = Math.max(0, policy.protectedCopies);

  const due = rows.filter(
    (row) =>
      row.retentionUntil !== null &&
      Date.parse(row.retentionUntil) <= now.getTime() &&
      SWEEPABLE.includes(row.state),
  );
  if (due.length === 0) return result;

  const groups = new Map<string, LifecycleRow[]>();
  for (const row of due) {
    const group = groups.get(row.artifactId) ?? [];
    group.push(row);
    groups.set(row.artifactId, group);
  }

  // Oldest retention first: the backup that has been past its deadline longest
  // is the one to give up, not whichever row happened to be returned first.
  const ordered = [...groups.entries()].sort((a, b) => {
    const at = (group: LifecycleRow[]) =>
      Math.min(...group.map((row) => Date.parse(row.retentionUntil ?? "")).filter(Number.isFinite));
    return at(a[1]) - at(b[1]);
  });

  for (const [artifactId, group] of ordered) {
    const isReady = readyIds.has(artifactId);
    if (isReady && readyIds.size - 1 < floor) {
      // The floor is about what a recovery can still reach. Below it, retention
      // waits: an expired-by-policy backup that has no successor is worse than a
      // backup kept a day too long.
      result.protectedSkipped += 1;
      continue;
    }

    let removedAny = false;
    for (const row of group) {
      const removed = await removeArtifactBytes(businessId, row);
      if (!removed.ok) {
        // The bytes may still be there. Recording `expired` would let everyone
        // stop worrying about an object that is still stored and still billed.
        result.failedRemovals += 1;
        continue;
      }
      await markArtifactState(businessId, row.id, { state: "expired", failureCode: "retention_expired" });
      removedAny = true;
    }
    if (removedAny) {
      result.expired += 1;
      if (isReady) readyIds.delete(artifactId);
    }
  }
  return result;
}

/**
 * Promote `verifying` cloud rows by re-reading the stored object.
 *
 * The upload path registers a cloud copy as `verifying` on purpose — a 200 from
 * the provider proves a write was accepted, not that the bytes on the far side
 * are the bytes we hold. This is the pass that settles it, and it is bounded per
 * tick so one large fleet cannot turn a scheduler wake into an unbounded
 * download.
 */
export async function verifyPendingCloudCopies(
  businessId: string,
  now: Date = new Date(),
  limit: number = VERIFY_BATCH,
): Promise<Pick<LifecycleOutcome, "verified" | "verifyFailed">> {
  const result = { verified: 0, verifyFailed: 0 };
  const rows = (await lifecycleRows(businessId))
    .filter((row) => row.destination === "cloud" && row.state === "verifying")
    .slice(0, Math.max(1, limit));
  if (rows.length === 0) return result;

  const profile = (await readDeploymentProfile(businessId)).profile;
  const role = deploymentRole();
  const schemaVersion = await installedSchemaVersion();

  for (const candidate of rows) {
    if (candidate.retentionUntil && Date.parse(candidate.retentionUntil) <= now.getTime()) {
      // Past retention: expiring it is the sweep's job, and downloading it first
      // would spend bandwidth to prove something we are about to delete.
      continue;
    }
    const ref = tenantBackupArtifactRef(businessId, "cloud", candidate.storageRef);
    const fetched = await fetchCloudArtifact({ businessId, ref, profile, role, suffix: "lifecycle-verify" });
    if (!fetched.ok) {
      // Transient (or the destination is down). Leave the row for the next tick;
      // turning a provider hiccup into `failed` would destroy a good backup.
      continue;
    }
    try {
      const verified = await verifyStoredArtifact(businessId, { ref, stagedPath: fetched.path, schemaVersion });
      await markArtifactState(businessId, candidate.id, {
        state: verified.ok ? "ready" : "failed",
        failureCode: verified.ok ? null : verified.error,
      });
      if (verified.ok) result.verified += 1;
      else result.verifyFailed += 1;
    } finally {
      await fetched.cleanup().catch(() => undefined);
    }
  }
  return result;
}

/**
 * Cloud deployments keep tenant backups **only** on managed storage (§1).
 *
 * Once the cloud copy is proved `ready`, the local twin is staging that outlived
 * its purpose: the artifact is the same `artifact_id` and stays restorable, so
 * the local row is removed rather than marked `expired` — an `expired` row would
 * make the whole backup read as expired in the inventory, which is exactly the
 * wrong story. Hybrid and Local keep their local copies; a legacy (self-hosted)
 * bucket is not platform-managed storage, so it is left alone too.
 */
export async function reclaimCloudStagedLocalCopies(
  businessId: string,
): Promise<Pick<LifecycleOutcome, "reclaimed" | "reclaimedBytes">> {
  const result = { reclaimed: 0, reclaimedBytes: 0 };
  const profile = (await readDeploymentProfile(businessId)).profile;
  if (profile !== "cloud") return result;

  const config = await getBackupConfig(businessId);
  const storage = await resolveTenantStorage({
    businessId,
    profile,
    role: deploymentRole(),
    legacyCloud: config.cloud,
  });
  if (storage.mode !== "managed") return result;

  const rows = await lifecycleRows(businessId);
  const readyCloud = new Set(
    rows.filter((row) => row.destination === "cloud" && row.state === "ready").map((row) => row.artifactId),
  );
  const localTwin = rows.filter(
    (row) => row.destination === "local" && row.state === "ready" && readyCloud.has(row.artifactId),
  );

  for (const row of localTwin) {
    const located = await localArtifactPath(businessId, row.storageRef, config.directory);
    const removed = await removeArtifactBytes(businessId, row);
    if (!removed.ok) continue;
    // The row goes only after the bytes are gone: a row that outlives its file
    // is a restore that fails at the worst possible moment.
    await deleteArtifactRow(businessId, row.id);
    result.reclaimed += 1;
    if (located.ok) result.reclaimedBytes += row.storedBytes ?? 0;
  }
  return result;
}

/** How many cloud artifacts still need their first real verification, fleet-wide. */
export async function pendingVerificationCount(businessId: string): Promise<number> {
  const rows = await lifecycleRows(businessId);
  return rows.filter((row) => row.destination === "cloud" && row.state === "verifying").length;
}

async function businessesWithArtifacts(): Promise<string[]> {
  const rows = await withoutTenantScope("backup-lifecycle", async () => {
    const result = await query<{ business_id: string }>(
      `SELECT DISTINCT business_id FROM tenant_backup_artifacts`,
    );
    return result.rows;
  });
  return rows.map((row) => row.business_id);
}

/**
 * One lifecycle tick: verify what is unproven, reclaim what Cloud may not keep,
 * expire what the policy has retired. Per business, so one broken tenant does
 * not stall the rest.
 */
export async function runBackupLifecycleTick(now: Date = new Date()): Promise<LifecycleOutcome> {
  const total = emptyOutcome();
  for (const businessId of await businessesWithArtifacts()) {
    try {
      const verified = await verifyPendingCloudCopies(businessId, now);
      total.verified += verified.verified;
      total.verifyFailed += verified.verifyFailed;

      const reclaimed = await reclaimCloudStagedLocalCopies(businessId);
      total.reclaimed += reclaimed.reclaimed;
      total.reclaimedBytes += reclaimed.reclaimedBytes;

      const expired = await expireDueArtifacts(businessId, now);
      total.expired += expired.expired;
      total.protectedSkipped += expired.protectedSkipped;
      total.failedRemovals += expired.failedRemovals;
    } catch (error) {
      console.error(
        `backup lifecycle: tick failed for business ${businessId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return total;
}
