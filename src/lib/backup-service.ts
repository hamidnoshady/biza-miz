/**
 * Phase 10 — backup system: the half that touches the database, the
 * filesystem, pg_dump, and the network (like the other *-service.ts files,
 * not unit-tested directly — the decision logic it leans on lives in
 * src/lib/backup.ts and is).
 *
 * Pipeline per run:
 *   1. `pg_dump --format=custom` of the WHOLE local database into
 *      BACKUP_DIR (atomic: dump to *.tmp, fsync, rename). It connects with
 *      `dumpDatabaseUrl()`, not the app's own restricted connection — RLS
 *      makes pg_dump fail outright as `pos_app`.
 *   2. Copy the artifact to BACKUP_SECONDARY_DIR if configured (USB/NAS) —
 *      a failed copy fails the run, because a silently-unplugged drive is
 *      exactly what the Owner wants alerted about.
 *   3. Encrypt (AES-256-GCM, Owner's passphrase) and upload to
 *      S3-compatible storage when cloud backup is enabled. A failed upload
 *      is retried on later ticks until a newer artifact supersedes it, so a
 *      backup taken offline still reaches the cloud when internet returns.
 *   4. Prune local artifacts and cloud objects beyond their retention
 *      counts (never touching files that aren't backup artifacts).
 *
 * Every step is recorded in `backup_runs`; the dashboard's health card and
 * the Owner-dashboard alert read from there.
 */
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { query, withTenant, withoutTenantScope } from "./db";
import {
  cleanupStagedDump,
  RestoreRefusal,
  restoreDumpFile,
  stageDumpFile,
  type RestoreSummary,
} from "./restore-engine";
import { runPgDump as runPgDumpTool } from "./pg-tools";
import { secureUnlink } from "./secure-temp";
import { deploymentRole } from "./deployment-role";
import { discardRestoreUpload, readRestoreUpload, uploadSourceName } from "./restore-upload";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import {
  BACKUP_RUNS_SHOWN,
  CLOUD_RETRY_MS,
  cloudKeyFor,
  computeBackupAlert,
  DEFAULT_BACKUP_CONFIG,
  dumpDatabaseUrl,
  encryptBackup,
  isBackupDue,
  isEncryptedBackup,
  isFailedRunRetryDue,
  isPlainArtifactName,
  makeArtifactName,
  parseArtifactTimestamp,
  selectPrunable,
  backupPassphrase,
  type BackupAlert,
  type BackupConfig,
} from "./backup";
import { s3Delete, s3Get, s3List, s3Put, sha256Hex, type S3Config } from "./s3-lite";
// Phase 35 — queued, never sent inline, and error-swallowing: a backup run's
// outcome must not depend on whether anybody could be told about it.
import { recordNotification } from "./notification-events";
import { notificationDedupeKey } from "./notifications";

// ---------------------------------------------------------------------------
// Config + paths
// ---------------------------------------------------------------------------

/**
 * Where local artifacts go. The Owner-chosen `config.directory` wins when set
 * (the standalone desktop app writes it from an OS folder dialog — often an
 * external drive); otherwise this is exactly what it always was, so no
 * existing deployment moves its backups.
 */
export function backupDir(configuredDirectory?: string): string {
  return (
    configuredDirectory?.trim() || process.env.BACKUP_DIR || path.join(process.cwd(), "backups")
  );
}

export function backupSecondaryDir(): string | null {
  return process.env.BACKUP_SECONDARY_DIR || null;
}

export async function getBackupConfig(businessId: string): Promise<BackupConfig> {
  const stored = await getSetting<BackupConfig>(businessId, SETTING_KEYS.backupConfig);
  if (!stored) return structuredClone(DEFAULT_BACKUP_CONFIG);
  return { ...DEFAULT_BACKUP_CONFIG, ...stored, cloud: { ...DEFAULT_BACKUP_CONFIG.cloud, ...stored.cloud } };
}

export async function setBackupConfig(businessId: string, config: BackupConfig): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.backupConfig, config);
}

/** Config for the Owner UI: secrets are never echoed back, only "is set" flags. */
export async function getBackupConfigMasked(businessId: string) {
  const config = await getBackupConfig(businessId);
  const warnings: string[] = [];
  if (!backupPassphrase(config)) {
    warnings.push("No encryption passphrase is set. Backups will be stored in plaintext and cloud upload will fail.");
  }
  return {
    ...config,
    passphrase: "",
    hasPassphrase: Boolean(config.passphrase || config.cloud.passphrase),
    warnings,
    cloud: {
      ...config.cloud,
      secretAccessKey: "",
      passphrase: "",
      hasSecretAccessKey: Boolean(config.cloud.secretAccessKey),
      hasPassphrase: Boolean(config.cloud.passphrase),
    },
  };
}

function s3ConfigOf(config: BackupConfig): S3Config {
  const { endpoint, region, bucket, accessKeyId, secretAccessKey } = config.cloud;
  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

/** The business's local timezone (its primary location's; Tehran fallback). */
async function getBusinessTimezone(businessId: string): Promise<string> {
  const { rows } = await query<{ timezone: string | null }>(
    `SELECT timezone FROM locations
      WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0]?.timezone || "Asia/Tehran";
}

// ---------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------

type RunKind = "local" | "cloud";
type RunTrigger = "scheduled" | "manual";

async function startRun(
  businessId: string,
  kind: RunKind,
  trigger: RunTrigger,
  artifact: string | null,
  cloudKey: string | null,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO backup_runs (business_id, kind, trigger, artifact, cloud_key)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [businessId, kind, trigger, artifact, cloudKey],
  );
  return rows[0].id;
}

async function finishRun(
  runId: string,
  outcome:
    | { status: "success"; artifact?: string; sizeBytes: number; sha256: string }
    | { status: "failed"; error: string },
): Promise<void> {
  if (outcome.status === "success") {
    await query(
      `UPDATE backup_runs
          SET status = 'success', artifact = coalesce($2, artifact),
              size_bytes = $3, sha256 = $4, finished_at = now()
        WHERE id = $1`,
      [runId, outcome.artifact ?? null, outcome.sizeBytes, outcome.sha256],
    );
  } else {
    const { rows } = await query<{ business_id: string; kind: string; artifact: string | null }>(
      `UPDATE backup_runs SET status = 'failed', error = $2, finished_at = now()
        WHERE id = $1 RETURNING business_id, kind, artifact`,
      [runId, outcome.error.slice(0, 1000)],
    );

    // Phase 35 — the one notification whose entire value is arriving at the
    // wrong hour. A backup that has silently failed for a week is discovered
    // exactly when it is too late to matter, which is why this is the
    // catalogue's only `critical` event and why it ignores quiet hours.
    //
    // Keyed on (kind, UTC day) rather than the run id: the scheduler retries a
    // failed backup every LOCAL_RETRY_MS, and every retry gets its own run row
    // (and its own artifact name), so keying on either would re-notify once per
    // attempt. The day bucket collapses all of a day's retries into one alert,
    // while a failure on a later day still re-alerts — the right behaviour for
    // a critical, recurring condition.
    const failed = rows[0];
    if (failed) {
      const artifactDay = failed.artifact ? parseArtifactTimestamp(failed.artifact)?.slice(0, 10) : null;
      await recordNotification({
        businessId: failed.business_id,
        locationId: null,
        eventKey: "backup.failed",
        severity: "critical",
        title: "پشتیبان‌گیری ناموفق بود",
        body: outcome.error.slice(0, 200),
        url: "/settings/backup",
        dedupeKey: notificationDedupeKey("backup.failed", failed.kind, artifactDay ?? runId),
        payload: { runId, kind: failed.kind },
      });
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Local backup (pg_dump)
// ---------------------------------------------------------------------------

/** One in-flight backup per business per process (the tick is 60s; dumps can be slower). */
const inFlight = new Set<string>();

/**
 * pg_dump with this install's privileged connection. The connection is resolved
 * here rather than by the caller so a missing `BACKUP_DATABASE_URL` fails as a
 * run (recorded in `backup_runs`, surfaced as the dashboard alert) instead of
 * before the run exists; the spawn itself lives in ./pg-tools.ts, shared with
 * the console's whole-system backup.
 */
async function runPgDump(outFile: string): Promise<void> {
  await runPgDumpTool(outFile, dumpDatabaseUrl());
}

async function pruneDirectory(dir: string, keep: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of selectPrunable(names, keep)) {
    await fs.unlink(path.join(dir, name)).catch((err) => {
      console.error(`backup: failed to prune ${path.join(dir, name)}:`, errText(err));
    });
  }
}

export type LocalBackupResult =
  | { status: "ok"; runId: string; artifact: string; sizeBytes: number }
  | { status: "busy" }
  | { status: "failed"; error: string };

/**
 * Take one local backup now (scheduled tick and the dashboard's "backup now"
 * share this code path). Never throws — failures land in backup_runs.
 */
export async function runLocalBackup(businessId: string, trigger: RunTrigger): Promise<LocalBackupResult> {
  if (inFlight.has(businessId)) return { status: "busy" };
  inFlight.add(businessId);
  try {
    const config = await getBackupConfig(businessId);
    
    const artifact = makeArtifactName();
    let finalArtifactName = artifact;
    
    const pp = backupPassphrase(config);
    const doEncryptLocal = pp.length > 0 && config.encryptLocal !== false;
    if (doEncryptLocal) {
      finalArtifactName = `${artifact}.enc`;
    }

    const runId = await startRun(businessId, "local", trigger, finalArtifactName, null);
    const transientPaths: string[] = [];
    try {
      const dir = backupDir(config.directory);
      await fs.mkdir(dir, { recursive: true });
      const finalPath = path.join(dir, finalArtifactName);
      const plainTmpPath = path.join(dir, `${artifact}.plaintext.tmp`);
      const artifactTmpPath = doEncryptLocal ? path.join(dir, `${artifact}.encrypted.tmp`) : plainTmpPath;
      transientPaths.push(plainTmpPath);
      if (artifactTmpPath !== plainTmpPath) transientPaths.push(artifactTmpPath);

      await runPgDump(plainTmpPath);
      let data: Buffer = await fs.readFile(plainTmpPath);

      if (doEncryptLocal) {
        data = encryptBackup(data, pp);
        await fs.writeFile(artifactTmpPath, data, { mode: 0o600 });
        await secureUnlink(plainTmpPath);
      }

      // Flush the completed artifact before exposing its final name. Encrypted
      // backups are written to a separate file so the plaintext dump is never
      // rewritten in place and is securely removed on every failure path.
      const tmpFh = await fs.open(artifactTmpPath, "r+");
      try {
        await tmpFh.sync();
      } finally {
        await tmpFh.close();
      }
      await fs.rename(artifactTmpPath, finalPath);
      try {
        const dirFh = await fs.open(dir, "r");
        try {
          await dirFh.sync();
        } finally {
          await dirFh.close();
        }
      } catch {
        // directory fsync unsupported on this platform — the file fsync above
        // already protected the artifact's contents.
      }

      const secondary = backupSecondaryDir();
      if (secondary) {
        await fs.mkdir(secondary, { recursive: true });
        const secondaryPath = path.join(secondary, finalArtifactName);
        await fs.copyFile(finalPath, secondaryPath, fsConstants.COPYFILE_FICLONE).catch(
          (err) => {
            throw new Error(`secondary copy to ${secondary} failed: ${errText(err)}`);
          },
        );
        // A USB/NAS copy is exactly the artifact a power cut or a yanked cable
        // can tear — fsync it too before counting the run as a success.
        const secondaryFh = await fs.open(secondaryPath, "r+");
        try {
          await secondaryFh.sync();
        } finally {
          await secondaryFh.close();
        }
        await pruneDirectory(secondary, config.localRetention);
      }
      await pruneDirectory(dir, config.localRetention);

      await finishRun(runId, { status: "success", sizeBytes: data.length, sha256: sha256Hex(data) });
      return { status: "ok", runId, artifact: finalArtifactName, sizeBytes: data.length };
    } catch (err) {
      await finishRun(runId, { status: "failed", error: errText(err) });
      return { status: "failed", error: errText(err) };
    } finally {
      await Promise.all(transientPaths.map((file) => secureUnlink(file)));
    }
  } catch (err) {
    // couldn't even record the run (DB down &c.) — nothing sensible to persist
    console.error(`backup: local run failed to start for business ${businessId}:`, errText(err));
    return { status: "failed", error: errText(err) };
  } finally {
    inFlight.delete(businessId);
  }
}

// ---------------------------------------------------------------------------
// Cloud upload
// ---------------------------------------------------------------------------

export type CloudBackupResult =
  | { status: "ok"; key: string; sizeBytes: number }
  | { status: "disabled" }
  | { status: "failed"; error: string };

/** Encrypt a local artifact and upload it, then prune the bucket prefix. */
export async function runCloudUpload(
  businessId: string,
  artifact: string,
  trigger: RunTrigger,
): Promise<CloudBackupResult> {
  const config = await getBackupConfig(businessId);
  if (!config.cloud.enabled) return { status: "disabled" };

  const key = cloudKeyFor(config.cloud.prefix, artifact);
  const runId = await startRun(businessId, "cloud", trigger, artifact, key);
  try {
    let data: Buffer = await fs.readFile(path.join(backupDir(config.directory), artifact));
    if (!isEncryptedBackup(data)) {
      const pp = backupPassphrase(config);
      // `validateBackupConfig` refuses to enable cloud without a passphrase,
      // but a config stored before that check — or one whose passphrase came
      // only from a since-removed BACKUP_PASSPHRASE — could still land here.
      // Failing the run is the only safe answer: encrypting with "" derives
      // the key from a publicly known input, so the artifact would be
      // plaintext to anyone who fetches it from the bucket.
      if (!pp) throw new Error("passphrase_required");
      data = encryptBackup(data, pp);
    }
    const s3 = s3ConfigOf(config);
    await s3Put(s3, key, data);

    try {
      const objects = await s3List(s3, config.cloud.prefix);
      for (const stale of selectPrunable(objects.map((o) => o.key), config.cloud.retention)) {
        await s3Delete(s3, stale);
      }
    } catch (err) {
      // pruning is best-effort — the upload itself succeeded
      console.error(`backup: cloud prune failed for business ${businessId}:`, errText(err));
    }

    await finishRun(runId, {
      status: "success",
      sizeBytes: data.length,
      sha256: sha256Hex(data),
    });
    return { status: "ok", key, sizeBytes: data.length };
  } catch (err) {
    await finishRun(runId, { status: "failed", error: errText(err) });
    return { status: "failed", error: errText(err) };
  }
}

/**
 * If the newest successful local artifact never made it to the cloud, try
 * again — but back off CLOUD_RETRY_MS between attempts so an offline café
 * isn't hammering its (dead) uplink every tick.
 */
async function maybeCatchUpCloud(businessId: string, config: BackupConfig): Promise<void> {
  if (!config.cloud.enabled) return;
  const { rows } = await query<{ artifact: string }>(
    `SELECT artifact FROM backup_runs
      WHERE business_id = $1 AND kind = 'local' AND status = 'success'
      ORDER BY started_at DESC LIMIT 1`,
    [businessId],
  );
  const artifact = rows[0]?.artifact;
  if (!artifact) return;

  const { rows: cloudRows } = await query<{ status: string; started_at: Date }>(
    `SELECT status, started_at FROM backup_runs
      WHERE business_id = $1 AND kind = 'cloud' AND artifact = $2
      ORDER BY started_at DESC LIMIT 1`,
    [businessId, artifact],
  );
  const last = cloudRows[0];
  if (last?.status === "success" || last?.status === "running") return;
  if (last && Date.now() - last.started_at.getTime() < CLOUD_RETRY_MS) return;

  await runCloudUpload(businessId, artifact, "scheduled");
}

// ---------------------------------------------------------------------------
// Scheduler tick + manual trigger
// ---------------------------------------------------------------------------

/**
 * Timer entry point (server.ts, every BACKUP_TICK_INTERVAL_MS): for each
 * business, take a backup if a schedule slot has passed uncovered, retry a
 * slot whose run failed (with backoff), and keep nudging any not-yet-uploaded
 * artifact toward the cloud.
 */
export async function runBackupTick(): Promise<void> {
  // Enumerating businesses spans tenants; each business's backup then runs
  // scoped to it, so a backup can only ever read its own rows (Phase 12).
  const rows = await withoutTenantScope("platform", async () => {
    const result = await query<{ id: string }>(`SELECT id FROM businesses`, []);
    return result.rows;
  });

  for (const { id: businessId } of rows) {
    try {
      await withTenant(businessId, async () => {
        const config = await getBackupConfig(businessId);
        if (!config.enabled) return;

        const { rows: lastRows } = await query<{ started_at: Date; status: string }>(
          `SELECT started_at, status FROM backup_runs
            WHERE business_id = $1 AND kind = 'local'
            ORDER BY started_at DESC LIMIT 1`,
          [businessId],
        );
        const last = lastRows[0] ?? null;
        const timeZone = await getBusinessTimezone(businessId);
        const now = new Date();
        if (
          isBackupDue(last?.started_at ?? null, now, config, timeZone) ||
          isFailedRunRetryDue(last?.started_at ?? null, last?.status ?? null, now, config, timeZone)
        ) {
          const local = await runLocalBackup(businessId, "scheduled");
          if (local.status === "ok" && config.cloud.enabled) {
            await runCloudUpload(businessId, local.artifact, "scheduled");
          }
        } else {
          await maybeCatchUpCloud(businessId, config);
        }
      });
    } catch (err) {
      // never let one business's failure stop the tick
      console.error(`backup tick failed for business ${businessId}:`, errText(err));
    }
  }
}

/** The dashboard's «پشتیبان‌گیری هم‌اکنون»: local backup + cloud upload, one call. */
export async function runBackupNow(
  businessId: string,
): Promise<{ local: LocalBackupResult; cloud: CloudBackupResult }> {
  const local = await runLocalBackup(businessId, "manual");
  const cloud: CloudBackupResult =
    local.status === "ok"
      ? await runCloudUpload(businessId, local.artifact, "manual")
      : { status: "disabled" };
  return { local, cloud };
}

// ---------------------------------------------------------------------------
// Status / health for the dashboard
// ---------------------------------------------------------------------------

export interface BackupRunRow {
  id: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: "running" | "success" | "failed";
  artifact: string | null;
  cloudKey: string | null;
  sizeBytes: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BackupHealth {
  enabled: boolean;
  cloudEnabled: boolean;
  intervalHours: number;
  localLastSuccessAt: string | null;
  localLastError: string | null;
  cloudLastSuccessAt: string | null;
  cloudLastError: string | null;
  alert: BackupAlert;
}

async function latestRuns(businessId: string, kind: RunKind) {
  const [{ rows: successRows }, { rows: lastRows }] = await Promise.all([
    query<{ finished_at: Date }>(
      `SELECT finished_at FROM backup_runs
        WHERE business_id = $1 AND kind = $2 AND status = 'success'
        ORDER BY started_at DESC LIMIT 1`,
      [businessId, kind],
    ),
    query<{ status: string; error: string | null }>(
      `SELECT status, error FROM backup_runs
        WHERE business_id = $1 AND kind = $2 AND status <> 'running'
        ORDER BY started_at DESC LIMIT 1`,
      [businessId, kind],
    ),
  ]);
  return {
    lastSuccessAt: successRows[0]?.finished_at?.toISOString() ?? null,
    lastError: lastRows[0]?.status === "failed" ? lastRows[0].error : null,
  };
}

export async function getBackupHealth(businessId: string): Promise<BackupHealth> {
  const config = await getBackupConfig(businessId);
  const [local, cloud] = await Promise.all([
    latestRuns(businessId, "local"),
    latestRuns(businessId, "cloud"),
  ]);
  const input = {
    enabled: config.enabled,
    cloudEnabled: config.cloud.enabled,
    intervalHours: config.intervalHours,
    localLastSuccessAt: local.lastSuccessAt,
    localLastError: local.lastError,
    cloudLastSuccessAt: cloud.lastSuccessAt,
    cloudLastError: cloud.lastError,
  };
  return { ...input, alert: computeBackupAlert(input) };
}

export async function listBackupRuns(businessId: string): Promise<BackupRunRow[]> {
  const { rows } = await query<{
    id: string;
    kind: RunKind;
    trigger: RunTrigger;
    status: "running" | "success" | "failed";
    artifact: string | null;
    cloud_key: string | null;
    size_bytes: string | null;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id, kind, trigger, status, artifact, cloud_key, size_bytes, error,
            started_at, finished_at
       FROM backup_runs WHERE business_id = $1
      ORDER BY started_at DESC LIMIT ${BACKUP_RUNS_SHOWN}`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    trigger: r.trigger,
    status: r.status,
    artifact: r.artifact,
    cloudKey: r.cloud_key,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    error: r.error,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  }));
}

// ---------------------------------------------------------------------------
// Restore (whole database) — the dashboard's counterpart of scripts/restore.ts
// ---------------------------------------------------------------------------
//
// The backup artifacts are `pg_dump --format=custom` dumps of the WHOLE
// database, so restoring one replaces every table — every business on the
// install. That is safe exactly when the database holds a single business (a
// desktop/single-tenant install), so `restoreAvailable` gates on that, and the
// UI is hidden anywhere else.
//
// The flow mirrors scripts/restore.ts and its runbook (docs/backup-restore.md):
// the artifact is always restored into a scratch database first and validated
// (migrations + core tables) BEFORE anything destructive; only an explicit
// `apply` then drops and recreates the production database from the same
// already-verified dump. Cloud artifacts are decrypted with the Owner's stored
// passphrase (unlike the CLI, which needs it as an env var because after a
// total machine loss there is no database left to read it from).
//
// The physical sequence — stage, verify into a scratch database, apply, re-grant,
// clean up — is ./restore-engine.ts, the same code the super-admin console's
// whole-system restore runs. `scripts/restore.ts` is the CLI twin for operators
// working on a machine whose app is not running at all.

/**
 * A whole-database restore replaces every business on the install, so it is
 * only offered when the database holds exactly one business. Anything else
 * (a central server hosting several tenants) hides the restore UI entirely.
 */
export async function restoreAvailable(): Promise<boolean> {
  const { rows } = await withoutTenantScope("single-tenant-check", () =>
    query<{ n: string }>(`SELECT count(*)::text AS n FROM businesses`, []),
  );
  return Number(rows[0]?.n ?? 0) === 1;
}

export interface RestoreArtifactRow {
  /** local file name, or the object key in the bucket */
  key: string;
  kind: "local" | "cloud";
  sizeBytes: number | null;
  startedAt: string;
  /** false when retention already pruned the artifact — it can no longer be restored */
  exists: boolean;
}

/** Restorable artifacts, one row per successful run, newest first. */
export async function listRestorableArtifacts(
  businessId: string,
): Promise<{ local: RestoreArtifactRow[]; cloud: RestoreArtifactRow[] }> {
  const config = await getBackupConfig(businessId);
  const dir = backupDir(config.directory);
  const { rows } = await query<{
    kind: RunKind;
    artifact: string | null;
    cloud_key: string | null;
    size_bytes: string | null;
    started_at: Date;
  }>(
    `SELECT kind, artifact, cloud_key, size_bytes, started_at
       FROM backup_runs
      WHERE business_id = $1 AND status = 'success'
        AND ((kind = 'local' AND artifact IS NOT NULL) OR (kind = 'cloud' AND cloud_key IS NOT NULL))
      ORDER BY started_at DESC
      LIMIT 100`,
    [businessId],
  );

  // Which cloud objects still exist (retention prunes beyond the keep count).
  // Best-effort: if the bucket is unreachable the run rows still list, and a
  // restore attempt surfaces the real download error.
  const cloudObjects = new Map<string, number>();
  const { endpoint, bucket, accessKeyId, secretAccessKey } = config.cloud;
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    try {
      for (const object of await s3List(s3ConfigOf(config), config.cloud.prefix)) {
        cloudObjects.set(object.key, object.size);
      }
    } catch (err) {
      console.error(`backup: listing cloud artifacts failed for business ${businessId}:`, errText(err));
    }
  }

  const local: RestoreArtifactRow[] = [];
  const cloud: RestoreArtifactRow[] = [];
  const seenLocal = new Set<string>();
  const seenCloud = new Set<string>();
  for (const row of rows) {
    if (row.kind === "local" && row.artifact && !seenLocal.has(row.artifact)) {
      seenLocal.add(row.artifact);
      let sizeBytes = row.size_bytes === null ? null : Number(row.size_bytes);
      let exists = false;
      try {
        const stat = await fs.stat(path.join(dir, row.artifact));
        exists = true;
        sizeBytes = stat.size;
      } catch {
        // already pruned — keep the row visible so the Owner sees the history,
        // but it cannot be restored anymore
      }
      local.push({
        key: row.artifact,
        kind: "local",
        sizeBytes,
        startedAt: row.started_at.toISOString(),
        exists,
      });
    } else if (row.kind === "cloud" && row.cloud_key && !seenCloud.has(row.cloud_key)) {
      seenCloud.add(row.cloud_key);
      const sizeBytes = cloudObjects.has(row.cloud_key)
        ? cloudObjects.get(row.cloud_key)!
        : row.size_bytes === null
          ? null
          : Number(row.size_bytes);
      cloud.push({
        key: row.cloud_key,
        kind: "cloud",
        sizeBytes,
        startedAt: row.started_at.toISOString(),
        exists: cloudObjects.has(row.cloud_key),
      });
    }
  }
  return { local, cloud };
}

// The physical restore (scratch verify, drop+recreate apply, re-grants,
// validation) lives in ./restore-engine.ts, shared with the super-admin
// console's full-system restore so the dangerous procedure has exactly one
// copy. What is left here is the tenant half: which artifact this business may
// restore, from where, with which passphrase, and the single-business gate.

/** Re-exported: the route types and the dashboard both name this shape. */
export type { RestoreSummary };

export type RestoreOutcome =
  | { status: "verified"; summary: RestoreSummary }
  | { status: "applied"; summary: RestoreSummary }
  | { status: "failed"; error: string };

/** One restore in flight per business per process — the same shape as backups. */
const restoreInFlight = new Set<string>();

/** Where the bytes of a restore come from. */
export type RestoreSource =
  | { source: "local" | "cloud"; artifact: string }
  /**
   * A file the Owner uploaded in pieces (./restore-upload.ts). This is the
   * only way to restore on an install whose `backup_runs` never saw the file —
   * a reinstalled desktop, or a dump carried over on a USB stick. A typed
   * passphrase wins over the stored one, because the stored one belongs to
   * *this* install and the file may come from the previous one.
   */
  | { source: "upload"; uploadId: string; fileName?: string; passphrase?: string };

/**
 * The dashboard's restore: `apply: false` verifies the artifact into a scratch
 * database and reports the validation summary; `apply: true` replaces the
 * production database — after the same verification — and re-provisions the
 * app role's grants on the fresh database. Owner-only at the route.
 *
 * Steps 1 and 2 (where the bytes come from, and decrypting + staging them) are
 * the tenant-specific half; step 3 is the shared engine in ./restore-engine.ts,
 * which is also what the super-admin console runs.
 */
export async function restoreFromArtifact(
  businessId: string,
  opts: RestoreSource & { apply: boolean },
): Promise<RestoreOutcome> {
  if (restoreInFlight.has(businessId)) return { status: "failed", error: "restore_busy" };
  if (!(await restoreAvailable())) return { status: "failed", error: "restore_not_available" };
  restoreInFlight.add(businessId);
  try {
    const config = await getBackupConfig(businessId);

    // 1. The artifact bytes — a local file, a cloud download, or an upload.
    let data: Buffer;
    let sourceName: string;
    let passphrase = backupPassphrase(config);
    if (opts.source === "upload") {
      const staged = await readRestoreUpload(businessId, opts.uploadId);
      if (!staged) return { status: "failed", error: "upload_not_found" };
      data = staged;
      sourceName = uploadSourceName(opts.fileName);
      if (opts.passphrase) passphrase = opts.passphrase;
    } else if (opts.source === "local") {
      // The artifact name arrives in the request body — reject a path before it
      // reaches the filesystem. (The cloud branch takes an object key, where a
      // `/` is the configured prefix and legitimate.)
      if (!isPlainArtifactName(opts.artifact)) {
        return { status: "failed", error: "artifact_not_found" };
      }
      try {
        data = await fs.readFile(path.join(backupDir(config.directory), opts.artifact));
      } catch {
        return { status: "failed", error: "artifact_not_found" };
      }
      sourceName = opts.artifact;
    } else {
      const s3 = s3ConfigOf(config);
      if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
        return { status: "failed", error: "cloud_not_configured" };
      }
      try {
        data = await s3Get(s3, opts.artifact);
      } catch (err) {
        return { status: "failed", error: `download_failed:${errText(err)}` };
      }
      sourceName = opts.artifact.split("/").at(-1) ?? opts.artifact;
    }

    // 2 + 3. Decrypt/stage, verify into a scratch database, and only then apply.
    const outcome = await stageAndRestore(data, {
      passphrase,
      sourceName,
      apply: opts.apply,
      emergencyDir: path.join(backupDir(config.directory), "emergency"),
    });
    // An applied upload has done its job; a verified one stays staged so the
    // Owner can apply the very same bytes without uploading them twice.
    if (opts.source === "upload" && outcome.status === "applied") {
      await discardRestoreUpload(businessId, opts.uploadId).catch(() => {});
    }
    return outcome;
  } catch (err) {
    console.error(`restore failed for business ${businessId}:`, errText(err));
    return { status: "failed", error: errText(err) };
  } finally {
    restoreInFlight.delete(businessId);
  }
}

/**
 * Steps 2 and 3 of every tenant-side restore: decrypt when the bytes carry the
 * POSBKP1 envelope, stage a plaintext dump, verify it into a scratch database,
 * and — only when asked and only after that passes — apply it.
 */
async function stageAndRestore(
  data: Buffer,
  opts: { passphrase: string; sourceName: string; apply: boolean; emergencyDir: string },
): Promise<RestoreOutcome> {
  let staged: { workDir: string; dumpPath: string; sourceName: string };
  try {
    staged = await stageDumpFile(data, opts.passphrase, opts.sourceName);
  } catch (err) {
    if (err instanceof RestoreRefusal) return { status: "failed", error: err.refusalCode };
    return { status: "failed", error: errText(err) };
  }
  try {
    const { verified, applied } = await restoreDumpFile({
      databaseUrl: dumpDatabaseUrl(),
      dumpPath: staged.dumpPath,
      source: staged.sourceName,
      apply: opts.apply,
      emergencyDir: opts.emergencyDir,
    });
    return { status: applied ? "applied" : "verified", summary: applied ?? verified };
  } catch (err) {
    return { status: "failed", error: errText(err) };
  } finally {
    await cleanupStagedDump(staged.workDir).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// First-run restore — a reinstalled desktop bringing its old database back
// ---------------------------------------------------------------------------

/** The upload scope of the first-run screen, where no business exists yet. */
export const SETUP_RESTORE_SCOPE = "setup";

/**
 * Whether the first-run screen may offer «بازگردانی از فایل پشتیبان».
 *
 * Only on a *site* install (the desktop, never the central server) whose
 * database is still completely empty — no business and no user. That is the
 * exact state in which /api/setup/bootstrap and /api/setup/pair also run
 * without a session: whoever is at the machine is about to decide what this
 * install is, and choosing "the database I backed up before reinstalling" is
 * the same decision as "a new business" or "pair with my cloud account".
 * The moment a user exists, this closes, and the Owner-gated dashboard
 * restore is the only way in.
 */
export async function freshInstallRestoreAvailable(): Promise<boolean> {
  if (deploymentRole() !== "site") return false;
  const { rows } = await withoutTenantScope("first-run", () =>
    query<{ businesses: string; users: string }>(
      `SELECT (SELECT count(*) FROM businesses)::text AS businesses,
              (SELECT count(*) FROM users)::text AS users`,
      [],
    ),
  );
  return Number(rows[0]?.businesses ?? 1) === 0 && Number(rows[0]?.users ?? 1) === 0;
}

let setupRestoreInFlight = false;

/** Verify (and on request apply) an uploaded dump onto an empty install. */
export async function restoreFreshInstall(opts: {
  uploadId: string;
  fileName?: string;
  passphrase?: string;
  apply: boolean;
}): Promise<RestoreOutcome> {
  if (setupRestoreInFlight) return { status: "failed", error: "restore_busy" };
  if (!(await freshInstallRestoreAvailable())) return { status: "failed", error: "restore_not_available" };
  setupRestoreInFlight = true;
  try {
    const data = await readRestoreUpload(SETUP_RESTORE_SCOPE, opts.uploadId);
    if (!data) return { status: "failed", error: "upload_not_found" };
    const outcome = await stageAndRestore(data, {
      passphrase: opts.passphrase || process.env.BACKUP_PASSPHRASE || "",
      sourceName: uploadSourceName(opts.fileName),
      apply: opts.apply,
      emergencyDir: path.join(backupDir(), "emergency"),
    });
    if (outcome.status === "applied") {
      await discardRestoreUpload(SETUP_RESTORE_SCOPE, opts.uploadId).catch(() => {});
    }
    return outcome;
  } catch (err) {
    console.error("first-run restore failed:", errText(err));
    return { status: "failed", error: errText(err) };
  } finally {
    setupRestoreInFlight = false;
  }
}
