/**
 * Phase 10 — backup system: the half that touches the database, the
 * filesystem, pg_dump, and the network (like the other *-service.ts files,
 * not unit-tested directly — the decision logic it leans on lives in
 * src/lib/backup.ts and is).
 *
 * ## Issue #807 — the deployment-role boundary
 *
 * A tenant backup means two different things, and conflating them was the
 * audit's critical finding:
 *
 * ```text
 * site/local (desktop, café laptop)   physical `pg_dump` of the whole local
 *                                     database — the DB *is* this one tenant
 * central/cloud (multi-tenant)        logical, RLS-scoped tenant-only snapshot
 *                                     (exportTenantData) — never pg_dump, which
 *                                     would contain every other tenant
 * ```
 *
 * `backup-policy.ts` states the rule; this module is where it is enforced:
 * `runLocalBackup` refuses to reach `pg_dump` unless the role allows it, and the
 * central path builds a logical snapshot instead. The cloud upload re-checks the
 * *artifact* (a `.sql` snapshot scoped to the business, or a site-local `.dump`)
 * so a tenant-controlled S3 destination can only ever receive that tenant's data.
 * The tenant restore gate refuses on central outright.
 *
 * Pipeline per run (site/physical):
 *   1. `pg_dump --format=custom` of the WHOLE local database into
 *      BACKUP_DIR (atomic: dump to *.tmp, stream-encrypt, fsync, rename). It
 *      connects with `dumpDatabaseUrl()`, not the app's own restricted
 *      connection — RLS makes pg_dump fail outright as `pos_app`.
 *   2. Copy the artifact to BACKUP_SECONDARY_DIR if configured (USB/NAS) —
 *      a failed copy fails the run, because a silently-unplugged drive is
 *      exactly what the Owner wants alerted about.
 *   3. Encrypt (AES-256-GCM, Owner's passphrase) and upload to
 *      S3-compatible storage when cloud backup is enabled. A failed upload
 *      is retried on later ticks until a newer artifact supersedes it, so a
 *      backup taken offline still reaches the cloud when internet returns.
 *   4. Prune local artifacts and cloud objects beyond their retention counts,
 *      scoped to this business so one scope's retention can never delete
 *      another scope's files.
 *
 * Pipeline per run (central/logical):
 *   1'. `exportTenantData(businessId)` reads every tenant table through RLS,
 *       serialized as restorable SQL, encrypted, written to the business's own
 *       snapshot directory, pruned under that scope only.
 *
 * Every step is recorded in `backup_runs` with its `scope`, so the dashboard
 * can say what an artifact actually contains; the health card and the
 * Owner-dashboard alert read from there.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { query, withTenant, withoutTenantScope } from "./db";
import {
  cleanupStagedDump,
  RestoreRefusal,
  restoreDumpFile,
  stageDumpFileFromPath,
  type RestoreJournalContext,
  type RestoreSummary,
} from "./restore-engine";
import { runPgDump as runPgDumpTool } from "./pg-tools";
import { secureUnlink } from "./secure-temp";
import { deploymentRole } from "./deployment-role";
import { LOCK_KEYS, withDistributedLock } from "./db-locks";
import {
  admitTenantArtifact,
  logicalSnapshotScopeTag,
  PHYSICAL_TENANT_RESTORE_FORBIDDEN,
  tenantPhysicalDumpAllowed,
  tenantPhysicalRestoreAllowed,
  type TenantBackupMode,
} from "./backup-policy";
import { newRestoreJournalId, tryAppendRestoreJournal } from "./restore-journal";
import { discardRestoreUpload, readRestoreUpload, uploadSourceName } from "./restore-upload";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import {
  BACKUP_RUNS_SHOWN,
  CLOUD_RETRY_MS,
  cloudKeyFor,
  computeBackupAlert,
  DEFAULT_BACKUP_CONFIG,
  dumpDatabaseUrl,
  isBackupDue,
  isFailedRunRetryDue,
  isLogicalArtifactName,
  isPhysicalArtifactName,
  isPlainArtifactName,
  makeArtifactName,
  parseArtifactName,
  parseArtifactTimestamp,
  reserveArtifactName,
  selectPrunableInScope,
  backupPassphrase,
  type BackupAlert,
  type BackupConfig,
} from "./backup";
import {
  encryptFileToFile,
  fileHasBackupMagic,
  sha256File,
} from "./backup-streams";
import { s3Delete, s3GetToFile, s3List, s3PutFile, type S3Config } from "./s3-lite";
import { exportTenantData, tenantDataToSql } from "./tenant-export";
// Phase 35 — queued, never sent inline, and error-swallowing: a backup run's
// outcome must not depend on whether anybody could be told about it.
import { recordNotification } from "./notification-events";
import { notificationDedupeKey } from "./notifications";

/** How many of a business's rows the retention selector is allowed to check. */
const TENANT_SCOPE_ALIAS = "backup";

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

/**
 * Where *this business's* artifacts go (issue #807). On a site that is still
 * the flat backup directory every existing install already uses — one business
 * per install, nothing to separate. On central each tenant gets its own
 * subdirectory, so retention for tenant A cannot walk tenant B's files even
 * before the scope filter in `selectPrunableInScope` is applied.
 */
export function tenantBackupDir(businessId: string, configuredDirectory?: string): string {
  const base = backupDir(configuredDirectory);
  if (tenantPhysicalDumpAllowed(deploymentRole())) return base;
  return path.join(base, "tenants", logicalSnapshotScopeTag(businessId));
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
  const mode = tenantBackupMode();
  return {
    ...config,
    passphrase: "",
    hasPassphrase: Boolean(config.passphrase || config.cloud.passphrase),
    warnings,
    // Issue #807: the UI must say what a backup actually *contains*. These two
    // fields are that answer, server-derived so the copy can never drift from
    // the deployment's real behaviour.
    scope: mode,
    scopeNote:
      mode === "logical"
        ? "This deployment hosts several businesses, so each backup is a logical snapshot of this business only (never a whole-database dump)."
        : "This install's database holds a single business, so a backup is a complete physical dump of the local database.",
    cloud: {
      ...config.cloud,
      secretAccessKey: "",
      passphrase: "",
      hasSecretAccessKey: Boolean(config.cloud.secretAccessKey),
      hasPassphrase: Boolean(config.cloud.passphrase),
    },
  };
}

/** How this deployment backs tenants up right now — read from the process, not from config. */
export function tenantBackupMode(): TenantBackupMode {
  return tenantPhysicalDumpAllowed(deploymentRole()) ? "physical" : "logical";
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

export type RunScope = TenantBackupMode;

async function startRun(
  businessId: string,
  kind: RunKind,
  trigger: RunTrigger,
  artifact: string | null,
  cloudKey: string | null,
  scope: RunScope,
  runToken: string,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO backup_runs (business_id, kind, trigger, artifact, cloud_key, scope, run_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [businessId, kind, trigger, artifact, cloudKey, scope, runToken],
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
// Local backup (pg_dump on a site; logical snapshot on central)
// ---------------------------------------------------------------------------

/** One in-flight backup per business per process (the tick is 60s; dumps can be slower). */
const inFlight = new Set<string>();

/**
 * pg_dump with this install's privileged connection. The connection is resolved
 * here rather than by the caller so a missing `BACKUP_DATABASE_URL` fails as a
 * run (recorded in `backup_runs`, surfaced as the dashboard alert) instead of
 * before the run exists; the spawn itself lives in ./pg-tools.ts, shared with
 * the console's whole-system backup.
 *
 * Only ever reached on a site deployment — `runLocalBackup` checks the role
 * first, and the API routes check it again (issue #807).
 */
async function runPgDump(outFile: string): Promise<void> {
  await runPgDumpTool(outFile, dumpDatabaseUrl());
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pruneDirectory(dir: string, keep: number, scope: string, adoptUnscoped: boolean): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of selectPrunableInScope(names, keep, scope, { adoptUnscoped })) {
    await fs.unlink(path.join(dir, name)).catch((err) => {
      console.error(`backup: failed to prune ${path.join(dir, name)}:`, errText(err));
    });
  }
}

export type LocalBackupResult =
  | { status: "ok"; runId: string; artifact: string; sizeBytes: number; mode: TenantBackupMode }
  | { status: "busy" }
  | { status: "failed"; error: string };

/**
 * Take one local backup now — the scheduled tick and the dashboard's «هم‌اکنون»
 * share this code path. Never throws: failures land in backup_runs.
 *
 * Issue #807: on a **central** deployment this no longer means "dump the
 * database". It delegates to the logical tenant snapshot, so the privileged
 * whole-database dump is unreachable from a tenant-facing call by construction.
 */
export async function runLocalBackup(businessId: string, trigger: RunTrigger): Promise<LocalBackupResult> {
  if (!tenantPhysicalDumpAllowed(deploymentRole())) {
    return runTenantLogicalBackup(businessId, trigger);
  }
  return runTenantPhysicalBackup(businessId, trigger);
}

/**
 * The site path: a whole-local-database `pg_dump`, streamed through encryption
 * onto disk, in this business's scope.
 */
async function runTenantPhysicalBackup(businessId: string, trigger: RunTrigger): Promise<LocalBackupResult> {
  if (inFlight.has(businessId)) return { status: "busy" };
  inFlight.add(businessId);
  const lock = await withDistributedLock(LOCK_KEYS.tenantPhysicalBackup(businessId), async () => {
    // The whole run happens under the cross-process lock: a second app instance
    // on the same volume must not be able to dump (or prune) at the same time.
    return runTenantPhysicalBackupLocked(businessId, trigger);
  });
  inFlight.delete(businessId);
  if (!lock.ok) {
    if (lock.reason === "busy") return { status: "busy" };
    return { status: "failed", error: `backup_lock_unavailable:${lock.error ?? "database_unreachable"}` };
  }
  return lock.value;
}

async function runTenantPhysicalBackupLocked(
  businessId: string,
  trigger: RunTrigger,
): Promise<LocalBackupResult> {
  const scope = logicalSnapshotScopeTag(businessId);
  try {
    const config = await getBackupConfig(businessId);
    const dir = backupDir(config.directory);
    await fs.mkdir(dir, { recursive: true });

    const passphrase = backupPassphrase(config);
    const doEncryptLocal = passphrase.length > 0 && config.encryptLocal !== false;
    const artifact = await reserveArtifactName(
      dir,
      () =>
        makeArtifactName(new Date(), {
          scope,
          runId: randomUUID(),
          format: "dump",
          encrypted: doEncryptLocal,
        }),
      pathExists,
    );
    const runToken = parseArtifactName(artifact)?.runId ?? "00000000";
    const baseName = artifact.replace(/\.enc$/, "");

    const runId = await startRun(businessId, "local", trigger, artifact, null, "physical", runToken);
    const transientPaths: string[] = [];
    try {
      const finalPath = path.join(dir, artifact);
      const plainTmpPath = path.join(dir, `${baseName}.plaintext.tmp`);
      const artifactTmpPath = doEncryptLocal ? path.join(dir, `${baseName}.encrypted.tmp`) : plainTmpPath;
      transientPaths.push(plainTmpPath);
      if (artifactTmpPath !== plainTmpPath) transientPaths.push(artifactTmpPath);

      await runPgDump(plainTmpPath);
      let sizeBytes: number;
      let sha256: string;
      if (doEncryptLocal) {
        // Streamed: the plaintext dump is never held in memory.
        const streamed = await encryptFileToFile(plainTmpPath, artifactTmpPath, passphrase);
        sizeBytes = streamed.sizeBytes;
        sha256 = streamed.sha256;
        await secureUnlink(plainTmpPath);
      } else {
        sizeBytes = (await fs.stat(plainTmpPath)).size;
        sha256 = await sha256File(plainTmpPath);
      }

      if (artifactTmpPath !== finalPath) {
        await fs.rename(artifactTmpPath, finalPath);
      }
      try {
        const dirFh = await fs.open(dir, "r");
        try {
          await dirFh.sync();
        } finally {
          await dirFh.close();
        }
      } catch {
        // directory fsync unsupported on this platform — the file fsync inside
        // the streaming encryption already protected the artifact's contents.
      }

      const secondary = backupSecondaryDir();
      if (secondary) {
        await fs.mkdir(secondary, { recursive: true });
        const secondaryPath = path.join(secondary, artifact);
        await fs.copyFile(finalPath, secondaryPath, fsConstants.COPYFILE_FICLONE).catch((err) => {
          throw new Error(`secondary copy to ${secondary} failed: ${errText(err)}`);
        });
        // A USB/NAS copy is exactly the artifact a power cut or a yanked cable
        // can tear — fsync it too before counting the run as a success.
        const secondaryFh = await fs.open(secondaryPath, "r+");
        try {
          await secondaryFh.sync();
        } finally {
          await secondaryFh.close();
        }
        await pruneDirectory(secondary, config.localRetention, businessId, true);
      }
      await pruneDirectory(dir, config.localRetention, businessId, true);

      await finishRun(runId, { status: "success", sizeBytes, sha256 });
      return { status: "ok", runId, artifact, sizeBytes, mode: "physical" };
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
  }
}

/**
 * The central path (issue #807): a **logical, tenant-only** snapshot.
 *
 * `exportTenantData` reads every tenant table inside `withTenant(businessId)`,
 * so RLS itself restricts each SELECT; the artifact therefore cannot contain
 * another business's rows no matter what the request asked for. The snapshot is
 * serialized as restorable SQL (`scripts/restore-tenant.ts` knows the format),
 * encrypted with the business's own passphrase, and written under the business's
 * own directory and scope tag.
 */
export async function runTenantLogicalBackup(
  businessId: string,
  trigger: RunTrigger,
): Promise<LocalBackupResult> {
  if (inFlight.has(businessId)) return { status: "busy" };
  inFlight.add(businessId);
  const lock = await withDistributedLock(LOCK_KEYS.tenantSnapshot(businessId), () =>
    runTenantLogicalBackupLocked(businessId, trigger),
  );
  inFlight.delete(businessId);
  if (!lock.ok) {
    if (lock.reason === "busy") return { status: "busy" };
    return { status: "failed", error: `backup_lock_unavailable:${lock.error ?? "database_unreachable"}` };
  }
  return lock.value;
}

async function runTenantLogicalBackupLocked(
  businessId: string,
  trigger: RunTrigger,
): Promise<LocalBackupResult> {
  const scopeTag = logicalSnapshotScopeTag(businessId);
  try {
    const config = await getBackupConfig(businessId);
    const dir = tenantBackupDir(businessId, config.directory);
    await fs.mkdir(dir, { recursive: true });

    const passphrase = backupPassphrase(config);
    const encrypt = passphrase.length > 0 && config.encryptLocal !== false;
    const artifact = await reserveArtifactName(
      dir,
      () =>
        makeArtifactName(new Date(), {
          scope: scopeTag,
          runId: randomUUID(),
          format: "sql",
          encrypted: encrypt,
        }),
      pathExists,
    );
    const runToken = parseArtifactName(artifact)?.runId ?? "00000000";
    const runId = await startRun(businessId, "local", trigger, artifact, null, "logical", runToken);
    const transientPaths: string[] = [];
    try {
      const plainTmpPath = path.join(dir, `${artifact.replace(/\.enc$/, "")}.plaintext.tmp`);
      transientPaths.push(plainTmpPath);
      const tables = await exportTenantData(businessId);
      await fs.writeFile(plainTmpPath, tenantDataToSql(tables), { mode: 0o600 });

      let sizeBytes: number;
      let sha256: string;
      const finalPath = path.join(dir, artifact);
      if (encrypt) {
        const streamed = await encryptFileToFile(plainTmpPath, path.join(dir, `${artifact}.tmp`), passphrase);
        await secureUnlink(plainTmpPath);
        await fs.rename(path.join(dir, `${artifact}.tmp`), finalPath);
        sizeBytes = streamed.sizeBytes;
        sha256 = streamed.sha256;
      } else {
        await fs.rename(plainTmpPath, finalPath);
        sizeBytes = (await fs.stat(finalPath)).size;
        sha256 = await sha256File(finalPath);
      }

      await pruneDirectory(dir, config.localRetention, businessId, false);

      await finishRun(runId, { status: "success", sizeBytes, sha256 });
      return { status: "ok", runId, artifact, sizeBytes, mode: "logical" };
    } catch (err) {
      await finishRun(runId, { status: "failed", error: errText(err) });
      return { status: "failed", error: errText(err) };
    } finally {
      await Promise.all(transientPaths.map((file) => secureUnlink(file)));
    }
  } catch (err) {
    console.error(`backup: logical snapshot failed for business ${businessId}:`, errText(err));
    return { status: "failed", error: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// Cloud upload
// ---------------------------------------------------------------------------

export type CloudBackupResult =
  | { status: "ok"; key: string; sizeBytes: number; mode: TenantBackupMode }
  | { status: "disabled" }
  | { status: "failed"; error: string };

/**
 * Upload one artifact to the tenant's bucket, streaming it, then prune the
 * prefix within this business's scope.
 *
 * Issue #807: this is the second half of the isolation fix. A tenant controls
 * their S3 destination, so what may be sent there is admitted by
 * `admitTenantArtifact`: on central only a logical (`.sql`) snapshot whose scope
 * tag is this business's, on a site only this install's own `.dump`. A physical
 * whole-database dump can therefore never reach a tenant's bucket on central,
 * and retention only ever deletes objects carrying this business's scope tag.
 */
export async function runCloudUpload(
  businessId: string,
  artifact: string,
  trigger: RunTrigger,
): Promise<CloudBackupResult> {
  const config = await getBackupConfig(businessId);
  if (!config.cloud.enabled) return { status: "disabled" };

  const role = deploymentRole();
  const scopeTag = parseArtifactName(artifact)?.scope ?? logicalSnapshotScopeTag(businessId);
  const admission = admitTenantArtifact(role, businessId, artifact, scopeTag);
  if (!admission.ok) {
    // Recorded, not thrown: an attempt is exactly what an operator needs to see.
    const runId = await startRun(
      businessId,
      "cloud",
      trigger,
      artifact,
      null,
      tenantBackupMode(),
      parseArtifactName(artifact)?.runId ?? "00000000",
    ).catch(() => "");
    if (runId) await finishRun(runId, { status: "failed", error: admission.error });
    return { status: "failed", error: admission.error };
  }

  const key = cloudKeyFor(config.cloud.prefix, artifact);
  const runId = await startRun(
    businessId,
    "cloud",
    trigger,
    artifact,
    key,
    admission.mode,
    parseArtifactName(artifact)?.runId ?? "00000000",
  );
  const transient: string[] = [];
  try {
    const sourcePath = path.join(tenantBackupDir(businessId, config.directory), artifact);
    if (!isPlainArtifactName(artifact)) throw new Error("unsafe_artifact_name");
    let uploadPath = sourcePath;
    let payloadHash = await sha256File(sourcePath);
    let sizeBytes = (await fs.stat(sourcePath)).size;
    if (!(await fileHasBackupMagic(sourcePath))) {
      const passphrase = backupPassphrase(config);
      // An artifact written in plaintext must never reach the bucket in that
      // state: the provider would hold the ledger behind a key of "".
      if (!passphrase) throw new Error("passphrase_required");
      const encryptedPath = `${sourcePath}.uploading.tmp`;
      transient.push(encryptedPath);
      const streamed = await encryptFileToFile(sourcePath, encryptedPath, passphrase);
      uploadPath = encryptedPath;
      payloadHash = streamed.sha256;
      sizeBytes = streamed.sizeBytes;
    }
    const s3 = s3ConfigOf(config);
    await s3PutFile(s3, key, uploadPath, { payloadHash, sizeBytes });

    try {
      const objects = await s3List(s3, config.cloud.prefix);
      // Scope-exact on purpose: a bucket may be shared, so an unscoped legacy
      // object is never assumed to be ours (a pruned object cannot be restored).
      for (const stale of selectPrunableInScope(objects.map((o) => o.key), config.cloud.retention, businessId, {
        adoptUnscoped: role === "site",
      })) {
        await s3Delete(s3, stale);
      }
    } catch (err) {
      // pruning is best-effort — the upload itself succeeded
      console.error(`backup: cloud prune failed for business ${businessId}:`, errText(err));
    }

    await finishRun(runId, { status: "success", sizeBytes, sha256: payloadHash });
    return { status: "ok", key, sizeBytes, mode: admission.mode };
  } catch (err) {
    await finishRun(runId, { status: "failed", error: errText(err) });
    return { status: "failed", error: errText(err) };
  } finally {
    await Promise.all(transient.map((file) => secureUnlink(file)));
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
      WHERE business_id = $1 AND kind = 'local' AND status = 'success' AND artifact IS NOT NULL
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
// Scheduler ticks
// ---------------------------------------------------------------------------

/** One schedule check for one business, shared by both deployment roles. */
async function tickBusiness(businessId: string): Promise<void> {
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
}

/** Every business id on this install — the one query that spans tenants. */
async function listBusinessIds(): Promise<string[]> {
  const rows = await withoutTenantScope("backup", async () => {
    const result = await query<{ id: string }>(`SELECT id FROM businesses`, []);
    return result.rows;
  });
  return rows.map((r) => r.id);
}

/**
 * The **site** physical backup worker (server.ts, every BACKUP_TICK_INTERVAL_MS):
 * for each business, take a physical backup if a schedule slot has passed
 * uncovered, retry a slot whose run failed (with backoff), and keep nudging any
 * not-yet-uploaded artifact toward the cloud.
 *
 * Issue #807: this physically cannot run on central. The role check is first,
 * before any business is enumerated, and `runLocalBackup` carries the same gate
 * so a caller that reaches the physical path directly still cannot dump a
 * multi-tenant database.
 */
export async function runBackupTick(): Promise<void> {
  if (!tenantPhysicalDumpAllowed(deploymentRole())) {
    // Central: the site worker must not even be *initialized* (server.ts gates
    // it too). Returning quietly — rather than throwing — keeps a
    // misconfiguration from spamming logs, while the log line states the fact.
    console.warn("backup: site physical worker refused on a central deployment (issue #807)");
    return;
  }
  const ids = await listBusinessIds();
  for (const businessId of ids) {
    try {
      await tickBusiness(businessId);
    } catch (err) {
      // never let one business's failure stop the tick
      console.error(`backup tick failed for business ${businessId}:`, errText(err));
    }
  }
}

/**
 * The **central** logical snapshot worker: same schedule semantics, but every
 * artifact is a tenant-only logical snapshot. This is what server.ts starts when
 * `deploymentRole() === "central"`, so the architecture's two halves are two
 * different workers rather than one worker with a conditional inside.
 */
export async function runTenantSnapshotTick(): Promise<void> {
  if (tenantPhysicalDumpAllowed(deploymentRole())) {
    // A site runs the physical worker; the logical one is central-only.
    return;
  }
  const ids = await listBusinessIds();
  for (const businessId of ids) {
    try {
      await tickBusiness(businessId);
    } catch (err) {
      console.error(`tenant snapshot tick failed for business ${businessId}:`, errText(err));
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
  scope: RunScope;
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
  scope: TenantBackupMode;
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
  return { ...input, scope: tenantBackupMode(), alert: computeBackupAlert(input) };
}

export async function listBackupRuns(businessId: string): Promise<BackupRunRow[]> {
  const { rows } = await query<{
    id: string;
    kind: RunKind;
    trigger: RunTrigger;
    status: "running" | "success" | "failed";
    scope: RunScope;
    artifact: string | null;
    cloud_key: string | null;
    size_bytes: string | null;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id, kind, trigger, status, coalesce(scope, 'physical') AS scope, artifact, cloud_key,
            size_bytes, error, started_at, finished_at
       FROM backup_runs WHERE business_id = $1
      ORDER BY started_at DESC LIMIT ${BACKUP_RUNS_SHOWN}`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    trigger: r.trigger,
    status: r.status,
    scope: r.scope,
    artifact: r.artifact,
    cloudKey: r.cloud_key,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    error: r.error,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  }));
}

// ---------------------------------------------------------------------------
// Restore (site only) — the dashboard's counterpart of scripts/restore.ts
// ---------------------------------------------------------------------------
//
// The backup artifacts are `pg_dump --format=custom` dumps of the WHOLE
// database, so restoring one replaces every table — every business on the
// install. That is safe exactly when the database holds a single business (a
// desktop/single-tenant install), so `restoreAvailable` gates on that *and* on
// the deployment role, and the UI is hidden anywhere else.
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
// validate the runtime role, clean up — is ./restore-engine.ts, the same code
// the super-admin console's whole-system restore runs; every phase is written to
// the durable journal (./restore-journal.ts) so a restore survives its own
// database swap.

/**
 * A whole-database restore replaces every business on the install, so it is
 * only offered when this is a **site** install (issue #807 — on central the
 * database belongs to the platform, not to a tenant) *and* the database holds
 * exactly one business.
 */
export async function restoreAvailable(): Promise<boolean> {
  if (!tenantPhysicalRestoreAllowed(deploymentRole())) return false;
  const { rows } = await withoutTenantScope("single-tenant-check", () =>
    query<{ n: string }>(`SELECT count(*)::text AS n FROM businesses`, []),
  );
  return Number(rows[0]?.n ?? 0) === 1;
}

export interface RestoreArtifactRow {
  /** local file name, or the object key in the bucket */
  key: string;
  kind: "local" | "cloud";
  /** what the artifact holds; only a physical dump can be restored in-app */
  scope: TenantBackupMode;
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
  const dir = tenantBackupDir(businessId, config.directory);
  const { rows } = await query<{
    kind: RunKind;
    scope: RunScope;
    artifact: string | null;
    cloud_key: string | null;
    size_bytes: string | null;
    started_at: Date;
  }>(
    `SELECT kind, coalesce(scope, 'physical') AS scope, artifact, cloud_key, size_bytes, started_at
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
        scope: row.scope,
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
        scope: row.scope,
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
  // Issue #807 — the server-side boundary, before anything else happens: a
  // central deployment must never drop and recreate its database from a
  // tenant-facing request. The UI already hides it; this is what makes it true.
  if (!tenantPhysicalRestoreAllowed(deploymentRole())) {
    return { status: "failed", error: PHYSICAL_TENANT_RESTORE_FORBIDDEN };
  }
  if (restoreInFlight.has(businessId)) return { status: "failed", error: "restore_busy" };
  if (!(await restoreAvailable())) return { status: "failed", error: "restore_not_available" };

  const lock = await withDistributedLock(LOCK_KEYS.tenantRestore(businessId), () =>
    restoreFromArtifactLocked(businessId, opts),
  );
  if (!lock.ok) {
    return {
      status: "failed",
      error: lock.reason === "busy" ? "restore_busy" : `restore_lock_unavailable:${lock.error ?? "database_unreachable"}`,
    };
  }
  return lock.value;
}

async function restoreFromArtifactLocked(
  businessId: string,
  opts: RestoreSource & { apply: boolean },
): Promise<RestoreOutcome> {
  restoreInFlight.add(businessId);
  let cleanupPath: string | null = null;
  try {
    const config = await getBackupConfig(businessId);
    const dir = tenantBackupDir(businessId, config.directory);

    // 1. The artifact bytes — a local file, a cloud download, or an upload.
    let sourcePath: string;
    let sourceName: string;
    let passphrase = backupPassphrase(config);
    let journalSource = opts.source;

    if (opts.source === "upload") {
      const staged = await readRestoreUpload(businessId, opts.uploadId);
      if (!staged) return { status: "failed", error: "upload_not_found" };
      const workDir = await fs.mkdtemp(path.join(await import("node:os").then((m) => m.tmpdir()), "pos-upload-"));
      sourcePath = path.join(workDir, "upload.bin");
      await fs.writeFile(sourcePath, staged, { mode: 0o600 });
      cleanupPath = workDir;
      sourceName = uploadSourceName(opts.fileName);
      if (opts.passphrase) passphrase = opts.passphrase;
      journalSource = "upload";
    } else if (opts.source === "local") {
      // The artifact name arrives in the request body — reject a path before it
      // reaches the filesystem.
      if (!isPlainArtifactName(opts.artifact)) {
        return { status: "failed", error: "artifact_not_found" };
      }
      sourcePath = path.join(dir, opts.artifact);
      if (!(await pathExists(sourcePath))) return { status: "failed", error: "artifact_not_found" };
      sourceName = opts.artifact;
    } else {
      const s3 = s3ConfigOf(config);
      if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
        return { status: "failed", error: "cloud_not_configured" };
      }
      const workDir = await fs.mkdtemp(path.join(await import("node:os").then((m) => m.tmpdir()), "pos-cloud-"));
      sourcePath = path.join(workDir, "download.bin");
      cleanupPath = workDir;
      try {
        await s3GetToFile(s3, opts.artifact, sourcePath);
      } catch (err) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        return { status: "failed", error: `download_failed:${errText(err)}` };
      }
      sourceName = opts.artifact.split("/").at(-1) ?? opts.artifact;
    }

    // Issue #807 — only a physical dump can be restored by this path. A logical
    // snapshot (`npm run db:restore-tenant` territory) is refused with a code
    // that says so, instead of handing pg_restore a file of SQL text.
    if (isLogicalArtifactName(sourceName) || !isPhysicalArtifactName(sourceName)) {
      if (cleanupPath) await fs.rm(cleanupPath, { recursive: true, force: true }).catch(() => {});
      return { status: "failed", error: "artifact_is_logical_snapshot" };
    }

    // 2 + 3. Decrypt/stage, verify into a scratch database, and only then apply.
    const outcome = await stageAndRestore(sourcePath, {
      passphrase,
      sourceName,
      apply: opts.apply,
      emergencyDir: path.join(dir, "emergency"),
      scope: businessId,
      journalSource,
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
    if (typeof cleanupPath === "string") {
      await fs.rm(cleanupPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Steps 2 and 3 of every tenant-side restore: decrypt when the file carries the
 * POSBKP1 envelope (streaming), verify into a scratch database, and — only when
 * asked and only after that passes — apply it, journalling each phase.
 */
async function stageAndRestore(
  sourcePath: string,
  opts: {
    passphrase: string;
    sourceName: string;
    apply: boolean;
    emergencyDir: string;
    scope: string;
    journalSource: string;
  },
): Promise<RestoreOutcome> {
  let staged: { workDir: string; dumpPath: string; sourceName: string };
  try {
    staged = await stageDumpFileFromPath(sourcePath, opts.passphrase, opts.sourceName);
  } catch (err) {
    if (err instanceof RestoreRefusal) return { status: "failed", error: err.refusalCode };
    return { status: "failed", error: errText(err) };
  }
  const journal: RestoreJournalContext = {
    id: newRestoreJournalId(),
    scope: opts.scope,
    source: opts.journalSource,
    artifact: opts.sourceName,
    mode: opts.apply ? "apply" : "verify",
    actorId: null,
    actorLabel: `tenant:${opts.scope}`,
  };
  try {
    const { verified, applied } = await restoreDumpFile({
      databaseUrl: dumpDatabaseUrl(),
      dumpPath: staged.dumpPath,
      source: opts.sourceName,
      apply: opts.apply,
      emergencyDir: opts.emergencyDir,
      journal,
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
  const lock = await withDistributedLock(LOCK_KEYS.setupRestore, async () => {
    setupRestoreInFlight = true;
    let workDir: string | null = null;
    try {
      const data = await readRestoreUpload(SETUP_RESTORE_SCOPE, opts.uploadId);
      if (!data) return { status: "failed", error: "upload_not_found" } as RestoreOutcome;
      const os = await import("node:os");
      workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-setup-"));
      const sourcePath = path.join(workDir, "upload.bin");
      await fs.writeFile(sourcePath, data, { mode: 0o600 });
      const outcome = await stageAndRestore(sourcePath, {
        passphrase: opts.passphrase || process.env.BACKUP_PASSPHRASE || "",
        sourceName: uploadSourceName(opts.fileName),
        apply: opts.apply,
        emergencyDir: path.join(backupDir(), "emergency"),
        scope: SETUP_RESTORE_SCOPE,
        journalSource: "setup-upload",
      });
      if (outcome.status === "applied") {
        await discardRestoreUpload(SETUP_RESTORE_SCOPE, opts.uploadId).catch(() => {});
      }
      return outcome;
    } catch (err) {
      console.error("first-run restore failed:", errText(err));
      return { status: "failed", error: errText(err) } as RestoreOutcome;
    } finally {
      setupRestoreInFlight = false;
      if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  if (!lock.ok) {
    return {
      status: "failed",
      error: lock.reason === "busy" ? "restore_busy" : `restore_lock_unavailable:${lock.error ?? "database_unreachable"}`,
    };
  }
  return lock.value;
}

/** Re-exported so the setup routes/tests can name the phase writer without another import. */
export { tryAppendRestoreJournal };
