/**
 * Issue #903 §4 — the central, tenant-only logical restore engine.
 *
 * The hard constraint the epic sets, and the reason this module exists at all:
 * on a shared database a business may never be restored by replaying a dump.
 * This engine restores **rows**, for **one business**, through code that cannot
 * be talked into doing anything else:
 *
 * ```text
 * preflight   the preview's blockers, the apply guard (typed phrase + recent
 *             re-authentication) and the business's durable restore lock
 * lock        LOCK_KEYS.tenantRestore(businessId) — one restore per business
 * journal     apply_started (with the artifact fingerprint) before any write
 * checkpoint  the tenant's *current* rows, written as a typed archive first
 * apply       one transaction: DELETE then parameterised INSERT per table,
 *             pinned to the business, so RLS confines every statement and any
 *             failure rolls the whole replacement back
 * audit       post-verification counts, journal phases, artifact `last_restore_at`
 * ```
 *
 * What it deliberately does **not** do:
 *
 *  • It never runs SQL from an artifact. The payload must parse as a typed
 *    archive whose tables and columns are validated against this build; an
 *    INSERT script is refused by name (`logical_sql_v1` is not restorable).
 *  • It never touches a table outside the tenant's own set, and never the
 *    `businesses` row itself: a restore cannot rename a tenant, change its plan
 *    or move it between deployments.
 *  • It never restores across businesses. The archive carries a business id and
 *    a mismatch is a refusal, not a warning.
 *  • It never leaves the business locked: the lock is released in `finally`,
 *    and a failed apply leaves the pre-existing rows intact (rollback) plus a
 *    checkpoint on disk for an operator to inspect.
 *
 * Ownership/authorization lives at the route (`backup.restore`, Owner-only); the
 * engine takes the facts it needs and refuses when they are not satisfied, so a
 * future caller cannot skip the gate by calling the library directly.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { query, withTenantTransaction } from "./db";
import { LOCK_KEYS, lockIsHeld, withDistributedLock } from "./db-locks";
import { newRestoreJournalId, restoreJournalDir, tryAppendRestoreJournal } from "./restore-journal";
import {
  RESTORE_IMMUTABLE_TABLES,
  applyTenantArchive,
  archiveRowCounts,
  parseTenantArchive,
  tenantTableSet,
  type TenantArchive,
} from "./tenant-archive";
import { tenantTablesInDependencyOrder } from "./tenant-tables";
import { buildTenantArchive, serializeTenantArchive } from "./tenant-archive";
import { exportTenantData } from "./tenant-export";
import { installedSchemaVersion, markArtifactStateByRef, resolveOwnedArtifact } from "./tenant-backup-artifacts-service";
import { decryptionSecretFor } from "./tenant-backup-runner";
import { cleanupStagingDir, ensureStagingDir } from "./tenant-backup-storage";
import { fetchCloudArtifact, planArtifactDownload } from "./tenant-backup-transport";
import { decryptFileToFile } from "./backup-streams";
import { guardTenantRestoreApply, type RestorePreview } from "./tenant-restore-preview";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";

/** Tables the engine will never delete from, whatever an archive claims. */
export const RESTORE_PROTECTED_TABLES = new Set(["businesses", "platform_admins", "platform_audit_log", "schema_migrations"]);

export interface TenantRestoreRequest {
  businessId: string;
  /** Opaque artifact reference the browser holds. */
  ref: string;
  deployment: { role: DeploymentRole; profile: DeploymentProfile };
  /** The preview the Owner was shown; the engine re-checks its blockers. */
  preview: RestorePreview;
  typedConfirmation: string;
  minutesSinceReauthentication: number | null;
  approvalRef?: string | null;
  appliesAsPlatformAdmin?: boolean;
  /** Who is applying it, recorded in the journal and never used for scoping. */
  actorId?: string | null;
  actorLabel?: string | null;
  legacyPassphrase?: string;
  /** The journal file this restore writes to (tests pass a temp dir). */
  journalDir?: string;
  now?: Date;
}

export type TenantRestoreOutcome =
  | {
      ok: true;
      journalId: string;
      tables: number;
      deleted: number;
      inserted: number;
      checkpointFile: string | null;
      verified: boolean;
    }
  | { ok: false; error: string; journalId?: string; checkpointFile?: string | null };

/**
 * Why an apply is refused before anything is written. These are the engine's own
 * refusals: the preview's blockers are checked first, so in practice a caller
 * sees the reason it was already shown.
 */
export const APPLY_REFUSALS = [
  "restore_busy",
  "confirmation_required",
  "reauthentication_required",
  "backup_restore_not_permitted",
  "artifact_not_found",
  "artifact_not_owned_by_business",
  "artifact_not_ready",
  "artifact_is_logical_sql",
  "physical_tenant_restore_forbidden_on_central",
  "archive_unreadable",
  "archive_business_mismatch",
  "archive_schema_newer_than_installation",
  "restore_failed",
] as const;

export type ApplyRefusal = (typeof APPLY_REFUSALS)[number];

/** Fail closed: an unknown internal error never reaches a tenant as text. */
export function mapApplyError(error: string): ApplyRefusal {
  return (APPLY_REFUSALS as readonly string[]).includes(error) ? (error as ApplyRefusal) : "restore_failed";
}

/**
 * The order the engine clears and refills tables in. Shared with the export so a
 * restore is the exact inverse of a capture; exposed for tests and for the
 * preview's honesty about which datasets it would touch.
 */
export async function restoreTableOrder(): Promise<string[]> {
  const order = await tenantTablesInDependencyOrder();
  return order.filter((table) => !RESTORE_PROTECTED_TABLES.has(table));
}

export type ProtectedTableCheck =
  | { ok: true }
  | { ok: false; error: "archive_table_not_allowed:businesses" | "archive_table_order_incomplete" };

/**
 * Refuse an archive that names a protected table or one this build cannot order.
 * Pure, so the rule is testable without a database.
 */
export function checkRestorableTables(
  tables: readonly string[],
  order: readonly string[],
): ProtectedTableCheck {
  for (const table of tables) {
    if (RESTORE_PROTECTED_TABLES.has(table)) {
      return { ok: false, error: "archive_table_not_allowed:businesses" };
    }
  }
  const ordered = new Set(order);
  for (const table of tables) {
    if (!ordered.has(table)) return { ok: false, error: "archive_table_order_incomplete" };
  }
  return { ok: true };
}

/**
 * Write the tenant's current state as a typed archive before anything is
 * deleted. This is both the rollback material and the audit record: it is the
 * same format the restore consumes, so re-applying it is the inverse operation
 * rather than a different, less-tested path.
 */
async function writeCheckpoint(businessId: string, journalId: string): Promise<{ path: string; archive: TenantArchive }> {
  const dir = await ensureStagingDir(businessId, `checkpoint-${journalId.slice(0, 8)}`);
  const file = path.join(dir, "checkpoint.archive.json");
  const [tables, schemaVersion] = await Promise.all([exportTenantData(businessId), installedSchemaVersion()]);
  const archive = buildTenantArchive({ businessId, capturedAt: new Date(), schemaVersion, tables });
  await fs.writeFile(file, serializeTenantArchive(archive), { mode: 0o600 });
  return { path: file, archive };
}

/** Read the encrypted artifact into a parsed archive — never into SQL. */
async function loadArchive(
  request: TenantRestoreRequest,
): Promise<{ ok: true; archive: TenantArchive } | { ok: false; error: string }> {
  const row = await resolveOwnedArtifact(request.businessId, request.ref);
  if (!row) return { ok: false, error: "artifact_not_found" };
  if (row.businessId !== request.businessId) return { ok: false, error: "artifact_not_owned_by_business" };
  if (row.state !== "ready") return { ok: false, error: "artifact_not_ready" };
  if (row.manifest?.payloadFormat === "logical_sql_v1") return { ok: false, error: "artifact_is_logical_sql" };
  if (row.format === "physical_dump") {
    // A physical dump is one database; on a central deployment it is never a
    // tenant artifact, and this engine would have to truncate the whole DB.
    return { ok: false, error: "physical_tenant_restore_forbidden_on_central" };
  }

  const dir = await ensureStagingDir(request.businessId, "restore-apply");
  const stagedPath = path.join(dir, row.storageRef);
  let cleanupTarget: (() => Promise<void>) | null = null;
  try {
    if (row.destination === "cloud") {
      const fetched = await fetchCloudArtifact({
        businessId: request.businessId,
        ref: request.ref,
        profile: request.deployment.profile,
        role: request.deployment.role,
        suffix: "restore-apply",
      });
      if (!fetched.ok) return { ok: false, error: fetched.error };
      cleanupTarget = fetched.cleanup;
    } else {
      const plan = await planArtifactDownload({
        businessId: request.businessId,
        ref: request.ref,
        destination: "local",
        profile: request.deployment.profile,
        role: request.deployment.role,
      });
      if (plan.kind !== "stream") return { ok: false, error: plan.kind === "error" ? plan.error : "artifact_not_found" };
      await fs.copyFile(plan.path, stagedPath);
    }

    const secret = await decryptionSecretFor(request.businessId, row, request.legacyPassphrase ?? "");
    if (!secret.ok) return { ok: false, error: secret.error };
    const plainPath = `${stagedPath}.plain`;
    try {
      await decryptFileToFile(stagedPath, plainPath, secret.secret);
    } catch {
      return { ok: false, error: "archive_unreadable" };
    }
    const raw = await fs.readFile(plainPath, "utf8");
    const allowed = await tenantTableSet();
    const parsed = parseTenantArchive(raw, {
      allowedTables: allowed,
      businessId: request.businessId,
      maxSchemaVersion: await installedSchemaVersion(),
    });
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, archive: parsed.archive };
  } finally {
    await cleanupTarget?.().catch(() => {});
  }
}

/**
 * Apply a restore. Every refusal happens before the first write, and the whole
 * write phase is one transaction: either the business holds the archived rows,
 * or it holds exactly what it held before.
 */
export async function applyTenantRestore(request: TenantRestoreRequest): Promise<TenantRestoreOutcome> {
  const journalDir = request.journalDir ?? restoreJournalDir();
  const journalId = newRestoreJournalId();

  // 1. Authorization at the moment of the write.
  const guard = guardTenantRestoreApply({
    preview: request.preview,
    typedConfirmation: request.typedConfirmation,
    approvalRef: request.approvalRef,
    appliesAsPlatformAdmin: request.appliesAsPlatformAdmin,
    minutesSinceReauthentication: request.minutesSinceReauthentication,
  });
  if (!guard.ok) return { ok: false, error: guard.error };

  // 2. One restore per business, enforced by the durable lock rather than by a
  //    flag a crash could leave behind.
  if (await lockIsHeld(LOCK_KEYS.tenantRestore(request.businessId))) {
    return { ok: false, error: "restore_busy" };
  }

  const locked = await withDistributedLock(
    LOCK_KEYS.tenantRestore(request.businessId),
    async (): Promise<TenantRestoreOutcome> => {
      const journalEntry = (
        phase: "verify_started" | "verify_failed" | "verify_succeeded" | "apply_started" | "apply_succeeded" | "apply_failed_before_swap",
        detail?: Record<string, unknown>,
      ) => ({
        id: journalId,
        phase,
        scope: request.businessId,
        source: "managed-artifact",
        artifact: request.ref,
        mode: "apply" as const,
        actorId: request.actorId ?? null,
        actorLabel: request.actorLabel ?? null,
        ...(detail ? { detail } : {}),
      });

      // 5. Verify phase, journalled like the physical restore's: an operator can
      //    see that an attempt was made even when it was refused, and the reason.
      if (!(await tryAppendRestoreJournal(journalEntry("verify_started"), journalDir))) {
        return { ok: false, error: "restore_failed", journalId };
      }
      const loaded = await loadArchive(request);
      if (!loaded.ok) {
        await tryAppendRestoreJournal(journalEntry("verify_failed", { code: loaded.error }), journalDir);
        return { ok: false, error: mapApplyError(loaded.error), journalId };
      }

      const order = await restoreTableOrder();
      const check = checkRestorableTables(
        loaded.archive.tables.map((table) => table.name),
        order,
      );
      if (!check.ok) {
        await tryAppendRestoreJournal(journalEntry("verify_failed", { code: check.error }), journalDir);
        return { ok: false, error: mapApplyError(check.error), journalId };
      }
      await tryAppendRestoreJournal(journalEntry("verify_succeeded"), journalDir);

      let checkpointFile: string | null = null;
      try {
        // 6. Checkpoint the current rows. A checkpoint failure aborts the
        //    restore: a replacement with no recorded previous state is not a
        //    recoverable operation.
        const checkpoint = await writeCheckpoint(request.businessId, journalId);
        checkpointFile = checkpoint.path;
        // The money tables are skipped by the engine (§5: the canonical wallet
        // must be unchanged), so they are not part of what this restore promises
        // — expecting their counts would fail every restore that touches them.
        const expected = Object.fromEntries(
          Object.entries(archiveRowCounts(loaded.archive)).filter(
            ([table]) => !RESTORE_IMMUTABLE_TABLES.has(table),
          ),
        );

        // 7. The line that must exist before the first write. If it cannot be
        //    made durable, nothing is written.
        if (!(await tryAppendRestoreJournal(journalEntry("apply_started"), journalDir))) {
          return { ok: false, error: "restore_failed", journalId, checkpointFile };
        }

        // 8. The write phase, in one transaction pinned to this business.
        const applied = await withTenantTransaction(request.businessId, async (client) => {
          // Re-check inside the transaction that the archive still describes
          // this business, so a swapped row between load and write cannot
          // redirect it.
          if (loaded.archive.businessId !== request.businessId) throw new Error("archive_business_mismatch");
          const written = await applyTenantArchive(client, loaded.archive, {
            tablesInOrder: order,
            // §5: a restore replaces the tenant's business data, never its money.
            skipTables: RESTORE_IMMUTABLE_TABLES,
          });
          // Post-verification *inside* the same transaction: the row counts the
          // archive promised must be the counts the business now holds. A
          // mismatch throws and rolls the whole replacement back, so a
          // half-applied restore can never be committed.
          const counts = await verifyRestoredCounts(client, expected, order);
          if (!counts) throw new Error("restore_verification_failed");
          return written;
        });

        await tryAppendRestoreJournal(
          journalEntry("apply_succeeded", {
            tables: applied.tables,
            inserted: applied.inserted,
            deleted: applied.deleted,
            // The receipt says what it deliberately did not touch, so an auditor
            // reading the journal cannot conclude the wallet was restored.
            untouched: [...RESTORE_IMMUTABLE_TABLES].sort(),
          }),
          journalDir,
        );

        // Bookkeeping after a committed restore: a failure here must not turn a
        // successful restore into a reported failure, because the data is
        // already the restored data.
        try {
          const row = await resolveOwnedArtifact(request.businessId, request.ref);
          await query(
            `UPDATE tenant_backup_artifacts SET last_restore_at = now(), updated_at = now()
              WHERE business_id = $1 AND storage_ref = $2`,
            [request.businessId, row?.storageRef ?? ""],
          );
          await markArtifactStateByRef(request.businessId, request.ref, { state: "ready" });
        } catch {
          console.error(`tenant restore: post-restore bookkeeping failed for ${request.businessId}`);
        }

        return {
          ok: true,
          journalId,
          tables: applied.tables,
          deleted: applied.deleted,
          inserted: applied.inserted,
          checkpointFile,
          verified: true,
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : "restore_failed";
        await tryAppendRestoreJournal(journalEntry("apply_failed_before_swap", { code: code.slice(0, 120) }), journalDir);
        // The transaction rolled back; the checkpoint stays on disk for an
        // operator, but the staging directory is not removed so the failed
        // attempt can be inspected.
        return { ok: false, error: mapApplyError(code), journalId, checkpointFile };
      }
    },
  );

  // Contention is reported by the lock layer; both busy and unavailable mean the
  // restore did not happen.
  if (!locked.ok) return { ok: false, error: "restore_busy" };
  return locked.value;
}

/**
 * Count the rows the archive promised, through the same pinned client (so the
 * counts are the ones this transaction wrote, under the tenant's RLS).
 */
async function verifyRestoredCounts(
  client: import("pg").PoolClient,
  expected: Record<string, number>,
  order: readonly string[],
): Promise<boolean> {
  for (const [table, rows] of Object.entries(expected)) {
    if (!order.includes(table)) return false;
    const result = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM "${table.replace(/"/g, "")}"`,
    );
    if (Number(result.rows[0]?.total ?? -1) !== rows) return false;
  }
  return true;
}

/** Remove a finished checkpoint (an operator may keep one on purpose). */
export async function discardCheckpoint(businessId: string, journalId: string): Promise<void> {
  await cleanupStagingDir(businessId, `checkpoint-${journalId.slice(0, 8)}`).catch(() => {});
}
