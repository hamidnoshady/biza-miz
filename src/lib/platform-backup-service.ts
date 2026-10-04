/**
 * The super-admin console's full-system backup — the half that touches the
 * database, the filesystem, `pg_dump`, and another server.
 *
 * Two abilities live here, and they are two halves of one thing:
 *
 *  1. **A backup of the whole project, owned by the console.** One artifact per
 *     run: `pg_dump --format=custom` of the entire local database — every
 *     business, the platform realm (admins, audit log, billing catalogue,
 *     knowledge base) and the schema/migration state — encrypted with the
 *     console's own passphrase, mirrored to a second directory and to
 *     S3-compatible storage, pruned to a retention count, scheduled on the
 *     console's own schedule. The Owner-side `/settings/backup`
 *     pipeline (Phase 10) is *per business*: its config, its runs, its alert,
 *     its retention. An operator who owns the deployment cannot reasonably be
 *     expected to reason about "the backup of the server" as the union of N
 *     tenant schedules, and a business that has been deleted should not be able
 *     to take the platform's backup history down with it.
 *
 *  2. **A backup and a restore that address one another.** The artifact is
 *     written with a manifest (app, migration count, Postgres major, business
 *     count, core row counts, size, sha256). With serving enabled, this server
 *     exposes those artifacts — and nothing else — over two bearer-authenticated
 *     endpoints (`/api/peer/backup/manifest`, `/api/peer/backup/download`). A
 *     *different* server, whose super-admin has stored this one's address and a
 *     token, can then list the artifacts, verify one into a scratch database,
 *     and restore it as its own production database. That is the whole "new
 *     server, old server's backup" flow, done from the console instead of a
 *     laptop with `npm run db:restore`.
 *
 * The safety rules, all of them enforced in code below:
 *
 *   • A restore always verifies into a scratch database first — including the
 *     apply, which re-verifies rather than trusting an earlier request's answer.
 *   • An apply requires the confirmation phrase, checked by the pure half
 *     (`resolveRestorePlan`) before a single byte is downloaded.
 *   • Nothing a peer publishes is trusted: the manifest is shape-checked
 *     (`parsePeerManifest`), the artifact name has to match this product's own
 *     artifact grammar, and the downloaded bytes must hash to the checksum the
 *     manifest declared.
 *   • A schema *ahead* of this install cannot be restored (the code running
 *     afterwards would not have migrations for the tables it landed).
 *   • Peer tokens are stored hashed. Serve tokens are only ever *compared* to a
 *     hash, so a database dump does not hand out working credentials.
 *   • Download size is capped, and the whole download is written to a private
 *     temp file rather than buffered.
 *
 * Like the other `*-service.ts` files this is not unit-tested directly: the
 * decisions are in `src/lib/platform-backup.ts` (unit) and the pipeline is
 * driven end to end against a real database and a real HTTP peer in
 * `integration/platform-system-backup.integration.test.ts`.
 */
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "./db";
import {
  BACKUP_RUNS_SHOWN,
  CLOUD_RETRY_MS,
  dumpDatabaseUrl,
  isBackupDue,
  isFailedRunRetryDue,
  isPlainArtifactName,
  makeArtifactName,
  parseArtifactTimestamp,
  reserveArtifactName,
  selectPrunable,
  type BackupAlert,
} from "./backup";
import {
  checkPeerManifest,
  DEFAULT_PLATFORM_BACKUP_CONFIG,
  hashPeerToken,
  isServeableArtifactName,
  maskPlatformBackupConfig,
  newestArtifact,
  normalizePeerToken,
  platformBackupAlert,
  parsePeerManifest,
  peerDownloadUrl,
  peerManifestUrl,
  peerTokenHint,
  platformBackupPassphrase,
  platformCloudKeyFor,
  outboundPolicyFor,
  resolveCloudObjectKey,
  resolveMaxDownloadBytes,
  validatePlatformBackupConfig,
  type MaskedPlatformBackupConfig,
  type PeerManifest,
  type PeerArtifactManifest,
  type PlatformBackupConfig,
  type RestorePlan,
} from "./platform-backup";
import {
  cleanupStagedDump,
  errText,
  RestoreApplyError,
  RestoreRefusal,
  restoreDumpFile,
  stageDumpFileFromPath,
  type RestoreJournalContext,
  type RestoreSummary,
} from "./restore-engine";
import { runPgDump } from "./pg-tools";
import { secureUnlink } from "./secure-temp";
import { s3Delete, s3GetToFile, s3List, s3PutFile, type S3Config } from "./s3-lite";
import { encryptFileToFile, fileHasBackupMagic, sha256File } from "./backup-streams";
import { LOCK_KEYS, withDistributedLock } from "./db-locks";
import {
  newRestoreJournalId,
  restoreJournalDir,
  tryAppendRestoreJournal,
  type RestorePhase,
} from "./restore-journal";
import { fetchWithOutboundPolicy, type OutboundPolicy } from "./outbound-policy";

/** The manifest lists at most this many artifacts; retention bounds the real number. */
const SERVE_ARTIFACT_LIMIT = 100;
/** A peer's manifest is a small JSON answer; it either answers or it does not. */
const PEER_MANIFEST_TIMEOUT_MS = 20_000;
/** A whole-database dump over a WAN is slow; five minutes of *no bytes* is the stall limit. */
const PEER_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config (the `platform_backup_config` singleton)
// ---------------------------------------------------------------------------

type ConfigRow = {
  enabled: boolean;
  interval_hours: number;
  anchor_time: string;
  timezone: string;
  directory: string;
  secondary_directory: string;
  local_retention: number;
  encrypt_local: boolean;
  passphrase: string;
  cloud_enabled: boolean;
  cloud_endpoint: string;
  cloud_region: string;
  cloud_bucket: string;
  cloud_prefix: string;
  cloud_access_key_id: string;
  cloud_secret_access_key: string;
  cloud_retention: number;
  serving_enabled: boolean;
  allow_insecure_peers: boolean;
  allow_private_peers: boolean;
};

function rowToConfig(row: ConfigRow): PlatformBackupConfig {
  return {
    enabled: row.enabled,
    intervalHours: row.interval_hours,
    anchorTime: row.anchor_time,
    timezone: row.timezone,
    directory: row.directory ?? "",
    secondaryDirectory: row.secondary_directory ?? "",
    localRetention: row.local_retention,
    encryptLocal: row.encrypt_local,
    passphrase: row.passphrase ?? "",
    cloud: {
      enabled: row.cloud_enabled,
      endpoint: row.cloud_endpoint ?? "",
      region: row.cloud_region || "us-east-1",
      bucket: row.cloud_bucket ?? "",
      prefix: row.cloud_prefix ?? "",
      accessKeyId: row.cloud_access_key_id ?? "",
      secretAccessKey: row.cloud_secret_access_key ?? "",
      retention: row.cloud_retention,
    },
    servingEnabled: row.serving_enabled,
    allowInsecurePeers: row.allow_insecure_peers,
    allowPrivatePeers: row.allow_private_peers,
  };
}

const CONFIG_SELECT = `SELECT enabled, interval_hours, anchor_time, timezone, directory, secondary_directory,
                               local_retention, encrypt_local, passphrase,
                               cloud_enabled, cloud_endpoint, cloud_region, cloud_bucket, cloud_prefix,
                               cloud_access_key_id, cloud_secret_access_key, cloud_retention,
                               serving_enabled, allow_insecure_peers, allow_private_peers
                          FROM platform_backup_config WHERE id = true`;

/** The stored config, or the defaults on an install that has never opened the page. */
export async function getPlatformBackupConfig(): Promise<PlatformBackupConfig> {
  await query(`INSERT INTO platform_backup_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING`);
  const { rows } = await query<ConfigRow>(CONFIG_SELECT);
  return rows[0] ? rowToConfig(rows[0]) : structuredClone(DEFAULT_PLATFORM_BACKUP_CONFIG);
}

export async function writePlatformBackupConfig(
  config: PlatformBackupConfig,
  platformAdminId: string | null,
): Promise<void> {
  await query(
    `UPDATE platform_backup_config
        SET enabled = $1, interval_hours = $2, anchor_time = $3, timezone = $4,
            directory = $5, secondary_directory = $6, local_retention = $7,
            encrypt_local = $8, passphrase = $9,
            cloud_enabled = $10, cloud_endpoint = $11, cloud_region = $12, cloud_bucket = $13,
            cloud_prefix = $14, cloud_access_key_id = $15, cloud_secret_access_key = $16,
            cloud_retention = $17, serving_enabled = $18, allow_insecure_peers = $19,
            allow_private_peers = $20,
            updated_by = $21, updated_at = now()
      WHERE id = true`,
    [
      config.enabled,
      config.intervalHours,
      config.anchorTime,
      config.timezone,
      config.directory,
      config.secondaryDirectory,
      config.localRetention,
      config.encryptLocal,
      config.passphrase,
      config.cloud.enabled,
      config.cloud.endpoint,
      config.cloud.region,
      config.cloud.bucket,
      config.cloud.prefix,
      config.cloud.accessKeyId,
      config.cloud.secretAccessKey,
      config.cloud.retention,
      config.servingEnabled,
      config.allowInsecurePeers,
      config.allowPrivatePeers,
      platformAdminId,
    ],
  );
}

/**
 * Validate a console PUT against what is stored (so an omitted secret keeps its
 * value) and persist it. Returns the same refusal codes the tenant-side config
 * route uses, so the console can translate them.
 */
export async function savePlatformBackupConfig(
  body: unknown,
  platformAdminId: string | null,
): Promise<{ ok: true; config: MaskedPlatformBackupConfig } | { ok: false; error: string }> {
  const existing = await getPlatformBackupConfig();
  const validation = validatePlatformBackupConfig(body, existing);
  if (!validation.ok) return { ok: false, error: validation.error };
  await writePlatformBackupConfig(validation.config, platformAdminId);
  return { ok: true, config: maskPlatformBackupConfig(validation.config) };
}

export async function getPlatformBackupConfigMasked(): Promise<MaskedPlatformBackupConfig> {
  return maskPlatformBackupConfig(await getPlatformBackupConfig());
}

/**
 * Where platform artifacts go: the console's own directory when set, else
 * `PLATFORM_BACKUP_DIR`, else a `platform/` subdirectory *inside* the tenant
 * backup directory.
 *
 * The subdirectory matters. Both halves name artifacts identically
 * (`pos-backup-<stamp>.dump`), so sharing one flat folder would let either
 * side's retention prune the other's artifacts. One volume, two namespaces.
 */
export function platformBackupDir(configuredDirectory?: string): string {
  const explicit = configuredDirectory?.trim() || process.env.PLATFORM_BACKUP_DIR?.trim();
  if (explicit) return explicit;
  const tenantDir =
    process.env.BACKUP_DIR?.trim() || path.join(process.cwd(), "backups");
  return path.join(tenantDir, "platform");
}

export function platformBackupSecondaryDir(config: PlatformBackupConfig): string | null {
  return config.secondaryDirectory.trim() || process.env.PLATFORM_BACKUP_SECONDARY_DIR?.trim() || null;
}

function s3ConfigOf(config: PlatformBackupConfig): S3Config {
  const { endpoint, region, bucket, accessKeyId, secretAccessKey } = config.cloud;
  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

// ---------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------

type RunKind = "local" | "cloud";
type RunTrigger = "scheduled" | "manual" | "peer";

async function startRun(
  kind: RunKind,
  trigger: RunTrigger,
  artifact: string | null,
  manifest: Record<string, unknown> | null,
  platformAdminId: string | null,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO platform_backup_runs (kind, trigger, artifact, manifest, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [kind, trigger, artifact, manifest ? JSON.stringify(manifest) : null, platformAdminId],
  );
  return rows[0].id;
}

async function finishRun(
  runId: string,
  outcome:
    | { status: "success"; artifact?: string; sizeBytes: number; sha256: string; manifest?: Record<string, unknown> }
    | { status: "failed"; error: string },
): Promise<void> {
  if (outcome.status === "success") {
    await query(
      `UPDATE platform_backup_runs
          SET status = 'success', artifact = coalesce($2, artifact),
              size_bytes = $3, sha256 = $4,
              manifest = coalesce($5::jsonb, manifest), finished_at = now()
        WHERE id = $1`,
      [
        runId,
        outcome.artifact ?? null,
        outcome.sizeBytes,
        outcome.sha256,
        outcome.manifest ? JSON.stringify(outcome.manifest) : null,
      ],
    );
  } else {
    await query(
      `UPDATE platform_backup_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [runId, outcome.error.slice(0, 1000)],
    );
  }
}

export interface PlatformBackupRunRow {
  id: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: "running" | "success" | "failed";
  artifact: string | null;
  cloudKey: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
  manifest: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
}

function rowToRun(row: {
  id: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: "running" | "success" | "failed";
  artifact: string | null;
  cloud_key: string | null;
  size_bytes: string | null;
  sha256: string | null;
  error: string | null;
  manifest: unknown;
  started_at: Date;
  finished_at: Date | null;
}): PlatformBackupRunRow {
  return {
    id: row.id,
    kind: row.kind,
    trigger: row.trigger,
    status: row.status,
    artifact: row.artifact,
    cloudKey: row.cloud_key,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: row.sha256,
    error: row.error,
    manifest:
      row.manifest && typeof row.manifest === "object" ? (row.manifest as Record<string, unknown>) : null,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

export async function listPlatformBackupRuns(limit = BACKUP_RUNS_SHOWN): Promise<PlatformBackupRunRow[]> {
  const { rows } = await query<Parameters<typeof rowToRun>[0]>(
    `SELECT id, kind, trigger, status, artifact, cloud_key, size_bytes, sha256, error, manifest,
            started_at, finished_at
       FROM platform_backup_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [Math.min(Math.max(1, Math.floor(limit)), 200)],
  );
  return rows.map(rowToRun);
}

async function latestRun(kind: RunKind, onlyErrors: boolean) {
  const { rows } = await query<{ status: string; error: string | null; finished_at: Date | null; started_at: Date }>(
    onlyErrors
      ? `SELECT status, error, finished_at, started_at FROM platform_backup_runs
          WHERE kind = $1 AND status <> 'running'
          ORDER BY started_at DESC LIMIT 1`
      : `SELECT status, error, finished_at, started_at FROM platform_backup_runs
          WHERE kind = $1 AND status = 'success'
          ORDER BY started_at DESC LIMIT 1`,
    [kind],
  );
  const row = rows[0];
  return {
    lastSuccessAt: onlyErrors ? null : (row?.finished_at?.toISOString() ?? null),
    lastError: onlyErrors && row?.status === "failed" ? row.error : null,
    startedAt: row?.started_at ?? null,
  };
}

export interface PlatformBackupHealth {
  enabled: boolean;
  cloudEnabled: boolean;
  servingEnabled: boolean;
  /** issue #807 — whether LAN/private restore targets are permitted */
  allowPrivatePeers: boolean;
  intervalHours: number;
  anchorTime: string;
  timezone: string;
  localLastSuccessAt: string | null;
  localLastError: string | null;
  cloudLastSuccessAt: string | null;
  cloudLastError: string | null;
  alert: BackupAlert;
  /** How many restorable artifacts are on disk right now, and the newest one. */
  artifactsOnDisk: number;
  newestArtifact: string | null;
}

/** The console's health line for the whole-system backup. */
export async function getPlatformBackupHealth(): Promise<PlatformBackupHealth> {
  const config = await getPlatformBackupConfig();
  const [localSuccess, localLast, cloudSuccess, cloudLast] = await Promise.all([
    latestRun("local", false),
    latestRun("local", true),
    latestRun("cloud", false),
    latestRun("cloud", true),
  ]);
  const artifacts = await listPlatformLocalArtifacts(config);
  const restorable = artifacts.filter((a) => a.exists);
  return {
    enabled: config.enabled,
    cloudEnabled: config.cloud.enabled,
    servingEnabled: config.servingEnabled,
    allowPrivatePeers: config.allowPrivatePeers,
    intervalHours: config.intervalHours,
    anchorTime: config.anchorTime,
    timezone: config.timezone,
    localLastSuccessAt: localSuccess.lastSuccessAt,
    localLastError: localLast.lastError,
    cloudLastSuccessAt: cloudSuccess.lastSuccessAt,
    cloudLastError: cloudLast.lastError,
    alert: platformBackupAlert(config, {
      localLastSuccessAt: localSuccess.lastSuccessAt,
      localLastError: localLast.lastError,
      cloudLastSuccessAt: cloudSuccess.lastSuccessAt,
      cloudLastError: cloudLast.lastError,
    }),
    artifactsOnDisk: restorable.length,
    newestArtifact: newestArtifact(restorable)?.artifact ?? null,
  };
}

// ---------------------------------------------------------------------------
// The dump itself
// ---------------------------------------------------------------------------

/** One whole-system backup per process at a time — a dump is minutes, a tick is 60s. */
let backupInFlight = false;

export type PlatformBackupResult =
  | { status: "ok"; runId: string; artifact: string; sizeBytes: number }
  | { status: "busy" }
  | { status: "failed"; error: string };

/**
 * Take one full-system backup now (the console's button and the scheduler tick
 * share this path). Never throws: a failure is recorded and returned.
 */
export async function runPlatformLocalBackup(
  trigger: RunTrigger,
  platformAdminId: string | null = null,
): Promise<PlatformBackupResult> {
  if (backupInFlight) return { status: "busy" };
  // Issue #807: a cross-process lock, so two app instances on one database
  // cannot both be dumping (and pruning) platform artifacts at the same time.
  const lock = await withDistributedLock(LOCK_KEYS.platformBackup, () =>
    runPlatformLocalBackupLocked(trigger, platformAdminId),
  );
  if (!lock.ok) {
    if (lock.reason === "busy") return { status: "busy" };
    return { status: "failed", error: `backup_lock_unavailable:${lock.error ?? "database_unreachable"}` };
  }
  return lock.value;
}

async function runPlatformLocalBackupLocked(
  trigger: RunTrigger,
  platformAdminId: string | null,
): Promise<PlatformBackupResult> {
  backupInFlight = true;
  try {
    const config = await getPlatformBackupConfig();
    const passphrase = platformBackupPassphrase(config);
    const encrypt = passphrase.length > 0 && config.encryptLocal;
    const dir = platformBackupDir(config.directory);
    await fs.mkdir(dir, { recursive: true });

    // Issue #807 — the run token is part of the artifact name, so two runs in
    // the same second (a tick racing a manual click) cannot collide, and the
    // name is reserved against what is already on disk.
    const finalName = await reserveArtifactName(
      dir,
      () =>
        makeArtifactName(new Date(), {
          runId: randomUUID(),
          format: "dump",
          encrypted: encrypt,
        }),
      async (candidate) => {
        try {
          await fs.stat(candidate);
          return true;
        } catch {
          return false;
        }
      },
    );
    const baseName = finalName.replace(/\.enc$/, "");

    const runId = await startRun("local", trigger, finalName, null, platformAdminId);
    const transientPaths: string[] = [];
    try {
      const finalPath = path.join(dir, finalName);
      const plainTmpPath = path.join(dir, `${baseName}.plaintext.tmp`);
      const artifactTmpPath = encrypt ? path.join(dir, `${baseName}.encrypted.tmp`) : plainTmpPath;
      transientPaths.push(plainTmpPath);
      if (artifactTmpPath !== plainTmpPath) transientPaths.push(artifactTmpPath);

      await runPgDump(plainTmpPath, dumpDatabaseUrl());
      let sizeBytes: number;
      let sha256: string;
      let artifactPath: string;
      if (encrypt) {
        // Streamed (issue #807): a multi-GB dump is never held in memory.
        const streamed = await encryptFileToFile(plainTmpPath, artifactTmpPath, passphrase);
        sizeBytes = streamed.sizeBytes;
        sha256 = streamed.sha256;
        await secureUnlink(plainTmpPath);
        artifactPath = artifactTmpPath;
      } else {
        sizeBytes = (await fs.stat(plainTmpPath)).size;
        sha256 = await sha256File(plainTmpPath);
        artifactPath = plainTmpPath;
      }

      // Same durability contract as the tenant pipeline. Ciphertext is written
      // separately and plaintext is scrubbed rather than rewritten in place.
      if (artifactPath !== finalPath) await fs.rename(artifactPath, finalPath);
      try {
        const dirFh = await fs.open(dir, "r");
        try {
          await dirFh.sync();
        } finally {
          await dirFh.close();
        }
      } catch {
        /* directory fsync unsupported (Windows) — the streaming writer already fsynced the file */
      }

      // The manifest is taken from the live database immediately after the dump,
      // so it describes what the artifact contains rather than what the server
      // looks like months later when a peer asks.
      const manifest = await buildArtifactManifest({ sizeBytes, sha256 }, finalName);


      const secondary = platformBackupSecondaryDir(config);
      if (secondary) {
        await fs.mkdir(secondary, { recursive: true });
        const secondaryPath = path.join(secondary, finalName);
        await fs
          .copyFile(finalPath, secondaryPath, fsConstants.COPYFILE_FICLONE)
          .catch((err) => {
            throw new Error(`secondary copy to ${secondary} failed: ${errText(err)}`);
          });
        const secondaryFh = await fs.open(secondaryPath, "r+");
        try {
          await secondaryFh.sync();
        } finally {
          await secondaryFh.close();
        }
      }
      // A copy of that manifest goes next to the file it describes. The run row
      // is the authority the console and the peer endpoints read, but the case a
      // sidecar exists for is the one where the database is *gone*: a machine
      // rebuilt from this folder has no rows to consult, and `scripts/restore.ts`
      // (and an operator with a laptop) can then still see which app version and
      // which migration count produced this artifact, and verify the bytes.
      // Written after both copies are in place, and never allowed to fail the run
      // — a backup without its description is still a backup.
      try {
        const sidecar = `${finalPath}.manifest.json`;
        await fs.writeFile(sidecar, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        if (secondary) await fs.copyFile(sidecar, path.join(secondary, `${finalName}.manifest.json`));
      } catch (err) {
        console.error("platform backup: sidecar manifest write failed:", errText(err));
      }
      await pruneDirectory(dir, config.localRetention);
      if (secondary) await pruneDirectory(secondary, config.localRetention);

      await finishRun(runId, { status: "success", sizeBytes, sha256, manifest });
      return { status: "ok", runId, artifact: finalName, sizeBytes };
    } catch (err) {
      await finishRun(runId, { status: "failed", error: errText(err) });
      return { status: "failed", error: errText(err) };
    } finally {
      await Promise.all(transientPaths.map((file) => secureUnlink(file)));
    }
  } catch (err) {
    console.error("platform backup: local run failed to start:", errText(err));
    return { status: "failed", error: errText(err) };
  } finally {
    backupInFlight = false;
  }
}

/**
 * What travels with an artifact: the numbers a *different* server checks before
 * it restores, plus the local path's own integrity data.
 *
 * `checksum` is over the bytes as written on disk — for an encrypted artifact
 * that is the ciphertext, which is what a peer streams, so the download's
 * verification is against exactly what it received.
 */
async function buildArtifactManifest(
  artifact: { sizeBytes: number; sha256: string },
  artifactName: string,
): Promise<Record<string, unknown>> {
  const base = {
    artifact: artifactName,
    createdAt: new Date().toISOString(),
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    encrypted: artifactName.endsWith(".enc"),
    app: "cafe-restaurant-pos",
    version: deploymentVersion(),
  };
  try {
    const schema = await localSchemaSnapshot();
    return { ...base, ...schema };
  } catch (err) {
    // A manifest is informative, not load-bearing for the backup's own safety —
    // losing it must not fail the dump that already succeeded.
    console.error("platform backup: manifest snapshot failed:", errText(err));
    return { ...base, schemaUnavailable: true, schemaError: errText(err).slice(0, 200) };
  }
}

/** The running build's identity, for the manifest (see app-update.ts for the same source). */
export function deploymentVersion(): string {
  return process.env.APP_IMAGE_SHA?.trim() || process.env.APP_VERSION?.trim() || "unknown";
}

export interface LocalSchemaSnapshot {
  schemaMigrations: number;
  latestMigration: string;
  pgServerMajor: number;
  businessCount: number;
  coreTables: { name: string; rows: number }[];
}

let snapshotCache: { at: number; value: LocalSchemaSnapshot } | null = null;
const SNAPSHOT_CACHE_MS = 15_000;

/**
 * This install's schema + row-count snapshot — the numbers a restore is checked
 * against in both directions (what a peer publishes, and what *we* would be
 * restoring into). Short-cached because the console polls health every minute
 * and the restore dialog asks for it three times in one round-trip.
 */
export async function localSchemaSnapshot(force = false): Promise<LocalSchemaSnapshot> {
  if (!force && snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_CACHE_MS) return snapshotCache.value;
  const { rows } = await query<{
    migrations: string;
    latest: string | null;
    version_num: string;
    businesses: string;
  }>(
    `SELECT (SELECT count(*) FROM schema_migrations)::text AS migrations,
            (SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1) AS latest,
            current_setting('server_version_num') AS version_num,
            (SELECT count(*) FROM businesses)::text AS businesses`,
  );
  const core: { name: string; rows: number }[] = [];
  for (const table of ["businesses", "locations", "users", "orders", "journal_entries", "settings"]) {
    try {
      const { rows: c } = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      core.push({ name: table, rows: Number(c[0].n) });
    } catch {
      /* table absent in this build */
    }
  }
  // server_version_num is 180400 for 18.4 and 90624 for 9.6.24 — the major is
  // the leading part above 10000 for modern versions, and n/100 before that.
  const versionNum = Number(rows[0]?.version_num ?? "0");
  const pgServerMajor = versionNum >= 100000 ? Math.floor(versionNum / 10000) : Math.floor(versionNum / 10000);
  const value: LocalSchemaSnapshot = {
    schemaMigrations: Number(rows[0]?.migrations ?? 0),
    latestMigration: rows[0]?.latest ?? "",
    pgServerMajor,
    businessCount: Number(rows[0]?.businesses ?? 0),
    coreTables: core,
  };
  snapshotCache = { at: Date.now(), value };
  return value;
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
      console.error(`platform backup: failed to prune ${path.join(dir, name)}:`, errText(err));
    });
    // The sidecar is not an artifact (`ARTIFACT_RE` is anchored, so
    // `<name>.manifest.json` is never listed for pruning), and `selectPrunable`
    // is the tenant flow's shared pure selector and must not learn about it.
    // Deleting it here keeps the folder honest: no description left behind for a
    // file that no longer exists, which would otherwise look like a restorable
    // artifact to anyone reading the directory by eye.
    await fs.unlink(`${path.join(dir, name)}.manifest.json`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Cloud mirror
// ---------------------------------------------------------------------------

export type PlatformCloudResult =
  | { status: "ok"; key: string; sizeBytes: number }
  | { status: "disabled" }
  | { status: "failed"; error: string };

/** Encrypt (if the local copy is not already) and upload one artifact to the bucket. */
export async function runPlatformCloudUpload(
  artifact: string,
  trigger: RunTrigger,
  platformAdminId: string | null = null,
): Promise<PlatformCloudResult> {
  const config = await getPlatformBackupConfig();
  if (!config.cloud.enabled) return { status: "disabled" };
  if (!isServeableArtifactName(artifact)) return { status: "failed", error: "unsafe_artifact_name" };

  const key = platformCloudKeyFor(config.cloud.prefix, artifact);
  const runId = await startRun("cloud", trigger, artifact, null, platformAdminId);
  const transient: string[] = [];
  try {
    const sourcePath = path.join(platformBackupDir(config.directory), artifact);
    if (!isPlainArtifactName(artifact)) throw new Error("unsafe_artifact_name");
    let uploadPath = sourcePath;
    let payloadHash = await sha256File(sourcePath);
    let sizeBytes = (await fs.stat(sourcePath)).size;
    if (!(await fileHasBackupMagic(sourcePath))) {
      const passphrase = platformBackupPassphrase(config);
      // An artifact written in plaintext must never reach the bucket in that
      // state: the provider would hold the whole ledger behind a key of "".
      if (!passphrase) throw new Error("passphrase_required");
      const encryptedPath = `${sourcePath}.uploading.tmp`;
      transient.push(encryptedPath);
      const streamed = await encryptFileToFile(sourcePath, encryptedPath, passphrase);
      uploadPath = encryptedPath;
      payloadHash = streamed.sha256;
      sizeBytes = streamed.sizeBytes;
    }
    const s3 = s3ConfigOf(config);
    // Streamed (issue #807) — a full-database artifact is never buffered.
    await s3PutFile(s3, key, uploadPath, { payloadHash, sizeBytes });

    try {
      const objects = await s3List(s3, config.cloud.prefix);
      for (const stale of selectPrunable(objects.map((o) => o.key), config.cloud.retention)) {
        await s3Delete(s3, stale);
      }
    } catch (err) {
      console.error("platform backup: cloud prune failed:", errText(err));
    }

    await finishRun(runId, { status: "success", sizeBytes, sha256: payloadHash });
    return { status: "ok", key, sizeBytes };
  } catch (err) {
    await finishRun(runId, { status: "failed", error: errText(err) });
    return { status: "failed", error: errText(err) };
  } finally {
    await Promise.all(transient.map((file) => secureUnlink(file)));
  }
}

/**
 * If the newest successful local artifact never made it to the bucket, nudge it
 * again — with the same backoff the tenant pipeline uses, so an offline server
 * is not hammering a dead uplink every tick.
 */
async function maybeCatchUpCloud(config: PlatformBackupConfig): Promise<void> {
  if (!config.cloud.enabled) return;
  const { rows } = await query<{ artifact: string }>(
    `SELECT artifact FROM platform_backup_runs
      WHERE kind = 'local' AND status = 'success' AND artifact IS NOT NULL
      ORDER BY started_at DESC LIMIT 1`,
  );
  const artifact = rows[0]?.artifact;
  if (!artifact) return;

  const { rows: cloudRows } = await query<{ status: string; started_at: Date }>(
    `SELECT status, started_at FROM platform_backup_runs
      WHERE kind = 'cloud' AND artifact = $1
      ORDER BY started_at DESC LIMIT 1`,
    [artifact],
  );
  const last = cloudRows[0];
  if (last?.status === "success" || last?.status === "running") return;
  if (last && Date.now() - last.started_at.getTime() < CLOUD_RETRY_MS) return;

  await runPlatformCloudUpload(artifact, "scheduled");
}

/**
 * "Back up now" from the console: one dump, plus the cloud upload when the
 * bucket is configured.
 */
export async function runPlatformBackupNow(
  platformAdminId: string | null = null,
): Promise<{ local: PlatformBackupResult; cloud: PlatformCloudResult }> {
  const local = await runPlatformLocalBackup("manual", platformAdminId);
  const cloud: PlatformCloudResult =
    local.status === "ok"
      ? await runPlatformCloudUpload(local.artifact, "manual", platformAdminId)
      : { status: "disabled" };
  return { local, cloud };
}

/**
 * The server.ts tick: back up when a schedule slot has passed uncovered, retry a
 * slot whose run failed, and keep nudging any un-uploaded artifact to the cloud.
 *
 * Unlike the tenant tick this has no businesses to iterate — a full-system
 * backup is one job for the whole deployment — so it is a single schedule check
 * against the platform config's own timezone.
 */
export async function runPlatformBackupTick(): Promise<void> {
  try {
    const config = await getPlatformBackupConfig();
    if (!config.enabled) return;

    const { rows } = await query<{ started_at: Date; status: string }>(
      `SELECT started_at, status FROM platform_backup_runs
        WHERE kind = 'local'
        ORDER BY started_at DESC LIMIT 1`,
    );
    const last = rows[0] ?? null;
    const now = new Date();
    const due = isBackupDue(last?.started_at ?? null, now, config, config.timezone);
    const retry = isFailedRunRetryDue(last?.started_at ?? null, last?.status ?? null, now, config, config.timezone);
    if (due || retry) {
      const local = await runPlatformLocalBackup("scheduled");
      if (local.status === "ok" && config.cloud.enabled) {
        await runPlatformCloudUpload(local.artifact, "scheduled");
      }
      return;
    }
    await maybeCatchUpCloud(config);
  } catch (err) {
    console.error("platform backup tick failed:", errText(err));
  }
}

// ---------------------------------------------------------------------------
// Artifacts on disk (what this server has, and what a peer may pull)
// ---------------------------------------------------------------------------

export interface PlatformArtifactRow {
  artifact: string;
  kind: "local" | "cloud";
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string | null;
  encrypted: boolean;
  /** false once retention has pruned the file — listed for history, not restorable */
  exists: boolean;
  manifest: Record<string, unknown> | null;
}

/**
 * Successful local artifacts, newest first, from the run history — with `exists`
 * settled against the filesystem, because retention deletes files without
 * deleting the runs that describe them.
 */
export async function listPlatformLocalArtifacts(config?: PlatformBackupConfig): Promise<PlatformArtifactRow[]> {
  const cfg = config ?? (await getPlatformBackupConfig());
  const dir = platformBackupDir(cfg.directory);
  let onDisk = new Set<string>();
  try {
    onDisk = new Set((await fs.readdir(dir)).filter((n) => isServeableArtifactName(n)));
  } catch {
    /* no directory yet = no artifacts */
  }

  const { rows } = await query<{
    artifact: string;
    size_bytes: string | null;
    sha256: string | null;
    manifest: unknown;
    started_at: Date;
  }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (artifact) artifact, size_bytes, sha256, manifest, started_at
         FROM platform_backup_runs
        WHERE kind = 'local' AND status = 'success' AND artifact IS NOT NULL
        ORDER BY artifact, started_at DESC
     ) t
      ORDER BY started_at DESC
      LIMIT $1`,
    [SERVE_ARTIFACT_LIMIT],
  );

  const out: PlatformArtifactRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const artifact = row.artifact!;
    if (seen.has(artifact)) continue;
    seen.add(artifact);
    const manifest = (row.manifest && typeof row.manifest === "object" ? row.manifest : null) as Record<
      string,
      unknown
    > | null;
    out.push({
      artifact,
      kind: "local",
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      sha256: row.sha256,
      createdAt: parseArtifactTimestamp(artifact) ?? row.started_at.toISOString(),
      encrypted: artifact.endsWith(".enc"),
      exists: onDisk.has(artifact),
      manifest,
    });
  }
  // A file on disk with no successful run behind it (a manual copy into the
  // directory, a run recorded before this table existed) is still a real backup.
  for (const name of [...onDisk].sort((a, b) => (a < b ? 1 : -1))) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      artifact: name,
      kind: "local",
      sizeBytes: null,
      sha256: null,
      createdAt: parseArtifactTimestamp(name),
      encrypted: name.endsWith(".enc"),
      exists: true,
      manifest: null,
    });
  }
  return out;
}

/** Cloud objects, for the console's list (best-effort: an unreachable bucket is not an error). */
export async function listPlatformCloudArtifacts(): Promise<PlatformArtifactRow[]> {
  const config = await getPlatformBackupConfig();
  const s3 = s3ConfigOf(config);
  if (!config.cloud.enabled || !s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) return [];
  try {
    const objects = await s3List(s3, config.cloud.prefix);
    return objects
      .filter((o) => isServeableArtifactName(o.key.split("/").pop() ?? ""))
      .map((o) => ({
        artifact: o.key,
        kind: "cloud" as const,
        sizeBytes: o.size,
        sha256: null,
        createdAt: parseArtifactTimestamp(o.key),
        encrypted: o.key.endsWith(".enc"),
        exists: true,
        manifest: null,
      }))
      .sort((a, b) => (a.artifact < b.artifact ? 1 : -1));
  } catch (err) {
    console.error("platform backup: listing cloud artifacts failed:", errText(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Serving a peer (the OLD server runs this half)
// ---------------------------------------------------------------------------

/**
 * The document `/api/peer/backup/manifest` returns.
 *
 * Deliberately built from the run history rather than by asking the database
 * again at request time: the numbers a peer is told must be the numbers that
 * were true *when the artifact was taken*, or a check on the far end is
 * comparing a backup against a moving target.
 */
export async function buildServeManifest(): Promise<PeerManifest> {
  const config = await getPlatformBackupConfig();
  const artifacts = await listPlatformLocalArtifacts(config);
  const restorable = artifacts.filter((a) => a.exists);
  const reference = restorable[0]?.manifest ?? null;
  const local = await localSchemaSnapshot();

  const listed: PeerArtifactManifest[] = restorable.map((a) => ({
    artifact: a.artifact,
    sizeBytes: a.sizeBytes ?? 0,
    sha256: a.sha256 ?? "",
    createdAt: a.createdAt ?? "",
    encrypted: a.encrypted,
  }));

  return {
    app: "cafe-restaurant-pos",
    version: deploymentVersion(),
    databaseName: safeDatabaseName(),
    pgServerMajor: numberOrZero(reference?.pgServerMajor ?? local.pgServerMajor),
    schemaMigrations: numberOrZero(reference?.schemaMigrations ?? local.schemaMigrations),
    latestMigration: String(reference?.latestMigration ?? local.latestMigration ?? "").slice(0, 256),
    businessCount: numberOrZero(reference?.businessCount ?? local.businessCount),
    artifacts: listed,
  };
}

function numberOrZero(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** The database name, for the peer's operator to recognise — never the credentials. */
export function safeDatabaseName(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) return "";
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

/**
 * Resolve one requested artifact to a real file, or refuse.
 *
 * The refusal is silent-by-status (404) for anything that is not exactly one of
 * our artifact names: a probe should not learn whether the directory exists, and
 * a name carrying a separator has already been rejected by
 * `isServeableArtifactName`, so nothing here reaches `path.join` with attacker
 * structure in it.
 */
export async function resolveServeableArtifact(
  artifact: string,
): Promise<{ ok: true; filePath: string; sizeBytes: number; sha256: string | null } | { ok: false; status: number; error: string }> {
  if (!isServeableArtifactName(artifact)) return { ok: false, status: 404, error: "not_found" };
  const config = await getPlatformBackupConfig();
  if (!config.servingEnabled) return { ok: false, status: 404, error: "not_found" };
  const filePath = path.join(platformBackupDir(config.directory), artifact);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { ok: false, status: 404, error: "not_found" };
    const maxBytes = resolveMaxDownloadBytes();
    if (stat.size > maxBytes) {
      return { ok: false, status: 413, error: "artifact_too_large" };
    }
    // Which run does this file belong to? Its recorded checksum lets the client
    // verify what it streamed; a file with no run behind it has nothing to claim.
    const runs = await listPlatformLocalArtifacts(config);
    const row = runs.find((r) => r.artifact === artifact);
    return { ok: true, filePath, sizeBytes: stat.size, sha256: row?.sha256 ?? null };
  } catch {
    return { ok: false, status: 404, error: "not_found" };
  }
}

// ---------------------------------------------------------------------------
// Serve-side credentials
// ---------------------------------------------------------------------------

export interface PlatformBackupTokenRow {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
}

function rowToToken(row: {
  id: string;
  label: string;
  token_hint: string;
  created_at: Date;
  last_used_at: Date | null;
  uses: number;
  expires_at: Date | null;
  revoked_at: Date | null;
}): PlatformBackupTokenRow {
  return {
    id: row.id,
    label: row.label,
    hint: row.token_hint,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    uses: row.uses,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

export async function listPlatformBackupTokens(): Promise<PlatformBackupTokenRow[]> {
  const { rows } = await query<Parameters<typeof rowToToken>[0]>(
    `SELECT id, label, token_hint, created_at, last_used_at, uses, expires_at, revoked_at
       FROM platform_backup_tokens
      ORDER BY revoked_at NULLS LAST, created_at DESC`,
  );
  return rows.map(rowToToken);
}

export async function createPlatformBackupToken(input: {
  label: string;
  token: string;
  /** days from now; null = never expires */
  expiresInDays: number | null;
  platformAdminId: string | null;
}): Promise<{ ok: true; id: string; hint: string; token: string } | { ok: false; error: string }> {
  const normalized = normalizePeerToken(input.token);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const label = input.label.trim();
  if (!label) return { ok: false, error: "missing_label" };
  const expiresAt =
    input.expiresInDays && input.expiresInDays > 0
      ? new Date(Date.now() + Math.floor(input.expiresInDays) * 86_400_000).toISOString()
      : null;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO platform_backup_tokens (label, token_hash, token_hint, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [label.slice(0, 120), hashPeerToken(normalized.token), peerTokenHint(normalized.token), input.platformAdminId, expiresAt],
  );
  // The plaintext is returned exactly once, by this call, and stored nowhere.
  return { ok: true, id: rows[0].id, hint: peerTokenHint(normalized.token), token: normalized.token };
}

export async function revokePlatformBackupToken(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE platform_backup_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Does a bearer token a peer presented authorize it here?
 *
 * The lookup is by hash of the *canonical* token, so a peer that re-typed it
 * with different spacing still authenticates (both sides canonicalize first),
 * and a revoked or expired row never matches. On success the row's use counter
 * moves — the console's "was this token the one that pulled the backup?" answer.
 */
export async function resolvePeerToken(raw: string): Promise<{ id: string; label: string } | null> {
  const normalized = normalizePeerToken(raw);
  if (!normalized.ok) return null;
  const { rows } = await query<{ id: string; label: string }>(
    `UPDATE platform_backup_tokens
        SET uses = uses + 1, last_used_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      RETURNING id, label`,
    [hashPeerToken(normalized.token)],
  );
  const row = rows[0];
  return row ? { id: row.id, label: row.label } : null;
}

// ---------------------------------------------------------------------------
// Peers: the servers this install may pull from (the NEW server runs this half)
// ---------------------------------------------------------------------------

export interface PlatformBackupPeer {
  id: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  hasToken: boolean;
  tokenHint: string;
  lastCheckAt: string | null;
  lastCheckStatus: string | null;
  lastError: string | null;
  /** whether the address is https (a plain-http peer is the operator's own choice, but it must be visible) */
  secure: boolean;
}

type PeerRow = {
  id: string;
  label: string;
  base_url: string;
  token: string;
  enabled: boolean;
  last_check_at: Date | null;
  last_check_status: string | null;
  last_error: string | null;
};

function rowToPeer(row: PeerRow & { token: string }): PlatformBackupPeer {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.base_url,
    enabled: row.enabled,
    hasToken: Boolean(row.token),
    tokenHint: row.token ? peerTokenHint(row.token) : "",
    lastCheckAt: row.last_check_at ? row.last_check_at.toISOString() : null,
    lastCheckStatus: row.last_check_status,
    lastError: row.last_error,
    secure: row.base_url.startsWith("https://"),
  };
}

/** The row the pull path needs, including the secret — server-side use only. */
async function peerWithSecret(id: string): Promise<(PeerRow & { token: string }) | null> {
  const { rows } = await query<PeerRow & { token: string }>(
    `SELECT id, label, base_url, token, enabled, last_check_at, last_check_status, last_error
       FROM platform_backup_peers WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listPlatformBackupPeers(): Promise<PlatformBackupPeer[]> {
  const { rows } = await query<PeerRow & { token: string }>(
    `SELECT id, label, base_url, token, enabled, last_check_at, last_check_status, last_error
       FROM platform_backup_peers
      ORDER BY created_at DESC`,
  );
  return rows.map(rowToPeer);
}

/** The ids the restore resolver will accept in `peerId`, for the route's check. */
export async function knownPeerIds(): Promise<Set<string>> {
  const { rows } = await query<{ id: string }>(`SELECT id FROM platform_backup_peers`);
  return new Set(rows.map((r) => r.id));
}


/**
 * The bearer check both `/api/peer/backup/*` endpoints run, before they answer
 * anything else. Lives here rather than in one of the route files because
 * Next's route module may export handlers and config only, and because both
 * endpoints must not be able to drift apart on who is let in.
 *
 * Returns the resolved token row (so a caller can log which credential pulled)
 * or an already-built 401 — the two endpoints share the same answer shape,
 * including "no header at all" and "unknown/revoked/expired token" being
 * indistinguishable.
 */
export async function authorizePeerRequest(
  headers: Headers,
): Promise<{ id: string; label: string } | { unauthorized: true }> {
  const auth = headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return { unauthorized: true };
  const token = await resolvePeerToken(bearer);
  return token ?? { unauthorized: true };
}

export async function upsertPlatformBackupPeer(
  input: { id?: string | null; label: string; baseUrl: string; token?: string | null; enabled?: boolean },
  platformAdminId: string | null,
): Promise<{ ok: true; peer: PlatformBackupPeer } | { ok: false; error: string }> {
  const label = input.label.trim().slice(0, 120);
  if (!label) return { ok: false, error: "missing_label" };
  const tokenInput = input.token === undefined || input.token === null ? null : normalizePeerToken(input.token);
  if (tokenInput && !tokenInput.ok) return { ok: false, error: tokenInput.error };

  // Re-saving by label updates the existing row rather than failing on the
  // unique index: the console's form is "the peer called «سرور قدیم»", and an
  // operator correcting its address must not have to delete and re-add it.
  const tokenValue = tokenInput?.ok ? tokenInput.token : null;
  if (input.id) {
    const existing = await peerWithSecret(input.id);
    if (!existing) return { ok: false, error: "peer_not_found" };
    const { rows } = await query<{ id: string }>(
      `UPDATE platform_backup_peers
          SET label = $2, base_url = $3, enabled = $4,
              token = CASE WHEN $5::text IS NULL THEN token ELSE $5 END,
              updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [
        input.id,
        label,
        input.baseUrl,
        input.enabled ?? existing.enabled,
        tokenValue,
      ],
    );
    if (!rows[0]) return { ok: false, error: "peer_not_found" };
    const row = await peerWithSecret(rows[0].id);
    if (!row) return { ok: false, error: "peer_not_found" };
    return { ok: true, peer: rowToPeer(row) };
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO platform_backup_peers (label, base_url, token, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (lower(label)) DO UPDATE
        SET base_url = EXCLUDED.base_url,
            token = CASE WHEN EXCLUDED.token = '' THEN platform_backup_peers.token ELSE EXCLUDED.token END,
            enabled = EXCLUDED.enabled,
            updated_at = now()
     RETURNING id`,
    [label, input.baseUrl, tokenValue ?? "", input.enabled ?? true, platformAdminId],
  );
  const row = await peerWithSecret(rows[0].id);
  if (!row) return { ok: false, error: "peer_not_found" };
  return { ok: true, peer: rowToPeer(row) };
}

export async function deletePlatformBackupPeer(id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM platform_backup_peers WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

async function recordPeerCheck(id: string, status: string, error: string | null): Promise<void> {
  await query(
    `UPDATE platform_backup_peers
        SET last_check_at = now(), last_check_status = $2, last_error = $3
      WHERE id = $1`,
    [id, status, error ? error.slice(0, 500) : null],
  );
}

// ---------------------------------------------------------------------------
// Talking to a peer
// ---------------------------------------------------------------------------

export type PeerFetchResult =
  | { ok: true; manifest: PeerManifest }
  | { ok: false; error: string };

/**
 * Ask a peer what it has. The response is parsed by the pure, distrustful
 * `parsePeerManifest`, so a hostile or stale answer becomes a refusal here
 * rather than data flowing into the restore path.
 */
export async function fetchPeerManifestFor(peerId: string): Promise<PeerFetchResult> {
  const peer = await peerWithSecret(peerId);
  if (!peer) return { ok: false, error: "peer_not_found" };
  if (!peer.enabled) return { ok: false, error: "peer_disabled" };
  if (!peer.token) return { ok: false, error: "missing_token" };

  const policy = outboundPolicyFor(await getPlatformBackupConfig());
  const result = await requestPeerJson(peerManifestUrl(peer.base_url), peer.token, PEER_MANIFEST_TIMEOUT_MS, policy);
  if (!result.ok) {
    await recordPeerCheck(peerId, "failed", result.error);
    return result;
  }
  const parsed = parsePeerManifest(result.value);
  if (!parsed.ok) {
    await recordPeerCheck(peerId, "failed", "bad_manifest");
    return { ok: false, error: "bad_manifest" };
  }
  await recordPeerCheck(peerId, "ok", null);
  return { ok: true, manifest: parsed.manifest };
}

/**
 * Ask a peer a JSON question, under the outbound policy (issue #807): manual
 * redirects (re-validated each hop, credentials never forwarded across
 * origins), address classification before connecting, and a bounded timeout.
 */
async function requestPeerJson(
  url: string,
  token: string,
  timeoutMs: number,
  policy: OutboundPolicy,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const fetched = await fetchWithOutboundPolicy(
    url,
    {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    },
    { ...policy, timeoutMs },
  );
  if ("error" in fetched) {
    return { ok: false, error: `peer_unreachable:${fetched.error.slice(0, 200)}` };
  }
  const res = fetched.response;
  if (res.status === 401 || res.status === 403) return { ok: false, error: "peer_auth_failed" };
  if (!res.ok) return { ok: false, error: `peer_http_${res.status}` };
  try {
    return { ok: true, value: await res.json() };
  } catch {
    return { ok: false, error: "bad_manifest" };
  }
}

export interface StagedDownload {
  workDir: string;
  filePath: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Stream a peer's artifact to a private temp file.
 *
 * Three things this has to get right, and does: the size cap is enforced *while
 * streaming* (a peer that lies about content-length, or sends no header at all,
 * still cannot fill this disk), the sha256 is computed over the bytes actually
 * received rather than trusted from the response, and the file is written under
 * `fs.mkdtemp`'s private directory with the artifact's own name never used as a
 * path component.
 */
export async function downloadPeerArtifact(opts: {
  url: string;
  token: string;
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * The outbound-network policy to apply. Defaults to this install's configured
   * policy (issue #807) — a peer address is not trusted just because somebody
   * stored it: metadata, link-local and, unless allowed, private targets are
   * refused, and every redirect hop is re-checked.
   */
  policy?: OutboundPolicy;
}): Promise<{ ok: true; file: StagedDownload } | { ok: false; error: string }> {
  const maxBytes = opts.maxBytes ?? resolveMaxDownloadBytes();
  let policy = opts.policy;
  if (!policy) {
    try {
      policy = outboundPolicyFor(await getPlatformBackupConfig());
    } catch {
      policy = outboundPolicyFor({ allowInsecurePeers: false, allowPrivatePeers: false });
    }
  }
  const fetched = await fetchWithOutboundPolicy(
    opts.url,
    {
      headers: {
        authorization: opts.token ? `Bearer ${opts.token}` : "",
        accept: "application/octet-stream",
      },
      cache: "no-store",
    },
    { ...policy, timeoutMs: opts.timeoutMs ?? PEER_DOWNLOAD_TIMEOUT_MS },
  );
  if ("error" in fetched) return { ok: false, error: `peer_unreachable:${fetched.error.slice(0, 200)}` };
  const res = fetched.response;
  if (res.status === 401 || res.status === 403) return { ok: false, error: "peer_auth_failed" };
  if (!res.ok) return { ok: false, error: `peer_http_${res.status}` };

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, error: "artifact_too_large" };
  if (!res.body) return { ok: false, error: "peer_empty_body" };

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-peer-"));
  const filePath = path.join(workDir, "download.bin");
  const hash = createHash("sha256");
  let total = 0;
  try {
    const handle = await fs.open(filePath, "w");
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
          return { ok: false, error: "artifact_too_large" };
        }
        hash.update(value);
        await handle.writeFile(value);
      }
    } finally {
      await handle.sync().catch(() => {});
      await handle.close();
    }
  } catch (err) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: `download_failed:${errText(err).slice(0, 200)}` };
  }
  if (total === 0) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: "peer_empty_body" };
  }
  // A peer that published no manifest (a bare URL to a file on a NAS) can still
  // vouch for its bytes, and the serve endpoint does send this header; when it
  // is present it is checked, because "downloaded something" is not "downloaded
  // the backup".
  const declaredHash = (res.headers.get("x-backup-sha256") ?? "").trim().toLowerCase();
  if (declaredHash && !/^[0-9a-f]{64}$/.test(declaredHash)) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: "bad_checksum_declaration" };
  }
  // `digest()` finalizes the hash and can only be called once — so the received
  // checksum is computed here, once, and both the comparison and the value
  // handed to the caller read from it. (Calling it twice threw "Digest already
  // called" on the *success* path, which is the one path that must never fail.)
  const received = hash.digest("hex");
  if (declaredHash && declaredHash !== received) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: "checksum_mismatch" };
  }
  return { ok: true, file: { workDir, filePath, sizeBytes: total, sha256: received } };
}

// ---------------------------------------------------------------------------
// Restoring from an address (the NEW server runs this half)
// ---------------------------------------------------------------------------

/** One restore at a time, platform-wide — this replaces the whole database. */
let restoreInFlight = false;

export type PlatformRestoreOutcome =
  | { status: "verified"; summary: RestoreSummary; warnings: string[] }
  | { status: "applied"; summary: RestoreSummary; warnings: string[]; notice: string }
  | { status: "failed"; error: string };

export interface PlatformRestoreRunRow {
  id: string;
  source: string;
  peerId: string | null;
  artifact: string;
  /** issue #807 — the S3 object key, when the source was the cloud */
  objectKey: string | null;
  mode: "verify" | "apply";
  status: "running" | "success" | "failed";
  /** the state machine phase this row reached (see restore-journal.ts) */
  phase: RestorePhase;
  /** the durable journal entry that recorded this restore end to end */
  journalId: string | null;
  /** the operator as a plain label — survives the restored snapshot not having their row */
  actorLabel: string;
  summary: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export async function listPlatformRestoreRuns(limit = 20): Promise<PlatformRestoreRunRow[]> {
  const { rows } = await query<{
    id: string;
    source: string;
    peer_id: string | null;
    artifact: string;
    object_key: string | null;
    mode: "verify" | "apply";
    status: "running" | "success" | "failed";
    phase: RestorePhase | null;
    journal_id: string | null;
    actor_label: string | null;
    summary: unknown;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id, source, peer_id, artifact, object_key, mode, status,
            coalesce(phase, 'verify_started') AS phase, journal_id, actor_label,
            summary, error, started_at, finished_at
       FROM platform_restore_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [Math.min(Math.max(1, Math.floor(limit)), 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    peerId: r.peer_id,
    artifact: r.artifact,
    objectKey: r.object_key,
    mode: r.mode,
    status: r.status,
    phase: r.phase ?? "verify_started",
    journalId: r.journal_id,
    actorLabel: r.actor_label ?? "",
    summary: r.summary && typeof r.summary === "object" ? (r.summary as Record<string, unknown>) : null,
    error: r.error,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  }));
}

async function startRestoreRun(
  plan: Extract<RestorePlan, { ok: true }>,
  adminId: string | null,
  journalId: string,
  actorLabel: string,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO platform_restore_runs
       (source, peer_id, artifact, object_key, mode, created_by, journal_id, actor_label, phase)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'verify_started') RETURNING id`,
    [plan.source, plan.peerId, plan.artifact, plan.objectKey, plan.mode, adminId, journalId, actorLabel],
  );
  return rows[0].id;
}

async function finishRestoreRun(
  runId: string,
  outcome: { status: "success" | "failed"; summary?: RestoreSummary; error?: string; phase: RestorePhase },
): Promise<void> {
  if (outcome.status === "success") {
    await query(
      `UPDATE platform_restore_runs
          SET status = 'success', summary = $2, phase = $3, finished_at = now()
        WHERE id = $1`,
      [runId, JSON.stringify(outcome.summary ?? {}), outcome.phase],
    );
  } else {
    await query(
      `UPDATE platform_restore_runs
          SET status = 'failed', error = $2, phase = $3, finished_at = now()
        WHERE id = $1`,
      [runId, (outcome.error ?? "").slice(0, 1000), outcome.phase],
    );
  }
}

/**
 * The operator's label as it was *before* the swap. It is stored beside the
 * restore row so a successful restore's record still names who ran it even when
 * the restored snapshot no longer contains that admin (issue #807).
 */
async function platformAdminLabel(adminId: string | null): Promise<string> {
  if (!adminId) return "";
  try {
    const { rows } = await query<{ full_name: string; email: string }>(
      `SELECT full_name, email FROM platform_admins WHERE id = $1`,
      [adminId],
    );
    const row = rows[0];
    if (!row) return "";
    return `${row.full_name} <${row.email}>`.slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * The **post-restore receipt** (issue #807): after the database has been
 * replaced and re-connected, write a fresh row describing the restore into the
 * *restored* database. The pre-swap row may not exist any more (the snapshot
 * predates it), so this is a new row — never an update — and it deliberately
 * carries `created_by = NULL`: the restored snapshot may not contain the
 * pre-restore admin, and a foreign-key failure is exactly the "API fails after
 * the restore already completed" bug the audit found.
 */
async function appendRestoreReceipt(
  plan: Extract<RestorePlan, { ok: true }>,
  opts: { journalId: string; actorLabel: string; summary: RestoreSummary },
): Promise<boolean> {
  try {
    await query(
      `INSERT INTO platform_restore_runs
         (source, peer_id, artifact, object_key, mode, status, phase, journal_id, actor_label,
          summary, created_by, finished_at)
       VALUES ($1, $2, $3, $4, 'apply', 'success', 'apply_succeeded', $5, $6, $7, NULL, now())`,
      [
        plan.source,
        plan.peerId,
        plan.artifact,
        plan.objectKey,
        opts.journalId,
        opts.actorLabel,
        JSON.stringify({ ...opts.summary, receipt: true }),
      ],
    );
    return true;
  } catch (error) {
    console.error("platform restore: post-restore receipt write failed:", errText(error));
    return false;
  }
}

/**
 * Restore the whole system from a peer's artifact (or a local/cloud artifact, or
 * a bare URL), given an already-resolved plan.
 *
 * The sequence is fixed: resolve the source → check the manifest against this
 * install → download (capped, hashed, SSRF-checked) → stream-decrypt + stage →
 * **verify into a scratch database** → apply only if the plan says so → re-grant
 * the app role → validate the runtime role → write the receipt. A failure at any
 * point leaves this install's production database untouched, which is the one
 * property that has to hold absolutely: an operator presses this on a *new*
 * server, where there is nothing to go back to.
 *
 * Issue #807 additions, all of them audit requirements:
 *   • one **cross-process** lock, so two app instances can never both restore;
 *   • every phase written to the **durable journal** outside the target DB,
 *     with the pre-apply write required to succeed before a destructive step;
 *   • the post-restore reconnect is *proved* and recorded, and a fresh receipt
 *     row is appended into the restored database afterwards;
 *   • outbound fetches go through the explicit network policy (metadata,
 *     link-local and, unless the operator opted in, private addresses refused);
 *   • artifacts are staged through files, never a whole-file `Buffer`.
 */
export async function restorePlatformFromPlan(
  plan: Extract<RestorePlan, { ok: true }>,
  platformAdminId: string | null = null,
): Promise<PlatformRestoreOutcome> {
  if (restoreInFlight) return { status: "failed", error: "restore_busy" };
  // Cross-process first, in-process flag second: the DB lock is the real
  // boundary, and the flag only short-circuits the common same-process case.
  const lock = await withDistributedLock(LOCK_KEYS.platformRestore, () =>
    restorePlatformFromPlanLocked(plan, platformAdminId),
  );
  if (!lock.ok) {
    return {
      status: "failed",
      error: lock.reason === "busy" ? "restore_busy" : `restore_lock_unavailable:${lock.error ?? "database_unreachable"}`,
    };
  }
  return lock.value;
}

async function restorePlatformFromPlanLocked(
  plan: Extract<RestorePlan, { ok: true }>,
  platformAdminId: string | null,
): Promise<PlatformRestoreOutcome> {
  restoreInFlight = true;
  const journalId = newRestoreJournalId();
  const actorLabel = await platformAdminLabel(platformAdminId).catch(() => "");
  const journalBase = {
    id: journalId,
    scope: "platform",
    source: plan.source,
    artifact: plan.artifact,
    mode: plan.mode,
    actorId: platformAdminId,
    actorLabel,
  } as const;
  const runId = await startRestoreRun(plan, platformAdminId, journalId, actorLabel).catch(() => "");
  let downloadDir: string | null = null;
  /**
   * Every refusal on the way down goes through here, because a row was already
   * inserted with status `running`. Leaving it open is not cosmetic: the console
   * lists the run as in progress forever, and it is the one entry that would
   * explain to an operator why nothing changed after they clicked restore.
   */
  const fail = async (error: string, phase: RestorePhase = "verify_failed"): Promise<PlatformRestoreOutcome> => {
    await tryAppendRestoreJournal({ ...journalBase, phase, detail: { error: error.slice(0, 500) } });
    if (runId) await finishRestoreRun(runId, { status: "failed", error, phase }).catch(() => {});
    return { status: "failed", error };
  };
  try {
    const config = await getPlatformBackupConfig();
    const policy = outboundPolicyFor(config);

    // 1. Where the bytes come from, and what the source says about them.
    let manifest: PeerManifest | null = null;
    let peer: (PeerRow & { token: string }) | null = null;
    if (plan.source === "peer") {
      peer = await peerWithSecret(plan.peerId!);
      if (!peer) return await fail("peer_not_found");
      if (!peer.enabled) return await fail("peer_disabled");
      const fetched = await fetchPeerManifestFor(peer.id);
      if (!fetched.ok) return await fail(fetched.error);
      manifest = fetched.manifest;
    }

    // 2. The gate that must pass before a single byte is transferred. The local
    //    snapshot is forced rather than cached: this is the decision that decides
    //    whether a production database gets dropped, and a 15-second-old answer
    //    is not good enough for that.
    const local = await localSchemaSnapshot(true);
    const warnings: string[] = [];
    if (manifest) {
      const check = checkPeerManifest(manifest, {
        schemaMigrations: local.schemaMigrations,
        pgServerMajor: local.pgServerMajor,
        hasPassphrase: Boolean(platformBackupPassphrase(config) || plan.passphrase),
        allowInsecurePeers: config.allowInsecurePeers,
        secureTransport: (peer?.base_url ?? "").startsWith("https://"),
      }, plan.artifact);
      if (!check.ok) return await fail(check.error);
      warnings.push(...check.warnings);
    }

    // 3. The bytes, always as a file on disk — never a whole-file Buffer.
    let sourcePath: string;
    let sourceName = plan.artifact;
    if (plan.source === "peer" || plan.source === "url") {
      // A peer answers the two /api/peer endpoints, so its artifact is named and
      // addressed by that contract. A bare `url` is the file address itself — a
      // link to a share, a NAS, a presigned bucket object — and is fetched
      // exactly as given, with no token and no path joining. Both go through the
      // outbound policy: a peer address is not trusted just because an operator
      // stored it once (issue #807).
      const url = plan.source === "peer" ? peerDownloadUrl(peer!.base_url, plan.artifact) : plan.url!;
      const token = plan.source === "peer" ? peer!.token : "";
      const expected = manifest?.artifacts.find((a) => a.artifact === plan.artifact) ?? null;
      const downloaded = await downloadPeerArtifact({ url, token, policy });
      if (!downloaded.ok) return await fail(downloaded.error);
      downloadDir = downloaded.file.workDir;
      sourcePath = downloaded.file.filePath;
      if (expected?.sha256 && downloaded.file.sha256 !== expected.sha256) {
        return await fail("checksum_mismatch");
      }
      // An encrypted artifact needs a passphrase from *somewhere*: the stored
      // config or the one field in this request. Saying so here is much kinder
      // than the engine's "decryption failed" for an empty key.
      if (expected?.encrypted && !plan.passphrase && !platformBackupPassphrase(config)) {
        return await fail("passphrase_required");
      }
    } else {
      // `local` and `cloud` are this server's own artifacts. The cloud branch
      // uses the plan's server-validated object key, never a raw request value.
      const own = await readOwnArtifactToFile(config, plan);
      if (!own.ok) return await fail(own.error);
      sourcePath = own.filePath;
      if (own.workDir) downloadDir = downloadDir ?? own.workDir;
      sourceName = own.sourceName;
    }

    let staged: { workDir: string; dumpPath: string; sourceName: string };
    try {
      staged = await stageDumpFileFromPath(sourcePath, plan.passphrase || platformBackupPassphrase(config), sourceName);
    } catch (err) {
      if (err instanceof RestoreRefusal) return await fail(err.refusalCode);
      throw err;
    }

    // 4. Verify, then (only if asked) apply — every phase journalled.
    const journal: RestoreJournalContext = {
      id: journalId,
      scope: "platform",
      source: plan.source,
      artifact: plan.artifact,
      mode: plan.mode,
      actorId: platformAdminId,
      actorLabel,
      dir: restoreJournalDir(),
    };
    try {
      const { verified, applied } = await restoreDumpFile({
        databaseUrl: dumpDatabaseUrl(),
        dumpPath: staged.dumpPath,
        source: plan.artifact,
        apply: plan.mode === "apply",
        emergencyDir: path.join(platformBackupDir(config.directory), "emergency"),
        journal,
      });
      const summary = applied ?? verified;
      if (summary.warnings?.length) warnings.push(...summary.warnings);
      if (applied) {
        // The database was replaced. Prove the app can reach the *restored*
        // database before claiming success, then leave a receipt inside it.
        const reconnected = await provePostRestoreReconnect();
        await tryAppendRestoreJournal({
          ...journalBase,
          phase: reconnected.ok ? "post_restore_reconnect_succeeded" : "post_restore_reconnect_failed",
          detail: reconnected.ok ? undefined : { error: reconnected.error.slice(0, 500) },
        });
        const receipt = await appendRestoreReceipt(plan, { journalId, actorLabel, summary });
        if (runId) {
          await finishRestoreRun(runId, {
            status: "success",
            summary,
            phase: reconnected.ok ? "post_restore_reconnect_succeeded" : "post_restore_reconnect_failed",
          }).catch(() => {});
        }
        return {
          status: "applied",
          summary,
          warnings,
          notice:
            "The restore replaced this database — including the platform's own settings, admins, backup config and peer list, which now come from the restored backup. " +
            "Restart the app so every connection and cache is rebuilt on the new database. " +
            (reconnected.ok
              ? `Post-restore reconnect verified${receipt ? " and a durable receipt written" : ""}. Journal: ${journalId}.`
              : `WARNING: the app could not reconnect to the restored database (${reconnected.error}). Journal: ${journalId}.`),
        };
      }
      if (runId) {
        await finishRestoreRun(runId, { status: "success", summary, phase: "verify_succeeded" }).catch(() => {});
      }
      return { status: "verified", summary, warnings };
    } catch (err) {
      const message = errText(err);
      const phase: RestorePhase = err instanceof RestoreApplyError ? err.phase : "verify_failed";
      await tryAppendRestoreJournal({ ...journalBase, phase, detail: { error: message.slice(0, 500) } });
      if (runId) await finishRestoreRun(runId, { status: "failed", error: message, phase }).catch(() => {});
      return { status: "failed", error: message };
    } finally {
      await cleanupStagedDump(staged.workDir).catch(() => {});
    }
  } catch (err) {
    const message = errText(err);
    await fail(message);
    console.error("platform restore failed:", message);
    return { status: "failed", error: message };
  } finally {
    if (downloadDir) await fs.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
    restoreInFlight = false;
  }
}

/**
 * Proof that the app can reach the database it just restored. Read-only and
 * tiny; a failure here is reported to the operator rather than silently
 * swallowed, because "the restore worked but nothing can connect to it" is the
 * one outcome that must never be described as success.
 */
async function provePostRestoreReconnect(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const runtimeUrl = process.env.DATABASE_URL;
    if (!runtimeUrl) return { ok: false, error: "DATABASE_URL is not set" };
    const client = new Client({ connectionString: runtimeUrl });
    try {
      await client.connect();
      await client.query("SELECT count(*)::text FROM schema_migrations");
      await client.query("SELECT 1 FROM businesses LIMIT 1");
    } finally {
      await client.end().catch(() => {});
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errText(error) };
  }
}

/**
 * One of this install's own artifacts, streamed to a file (issue #807).
 *
 * The cloud branch is where the object-key model lands: the plan carries the
 * key the *server* resolved and validated against the configured prefix
 * (`resolveCloudObjectKey`), so a browser cannot name an arbitrary object, and a
 * prefixed key restores correctly instead of failing the "no `/` allowed"
 * check. Downloads are size-capped while streaming.
 */
async function readOwnArtifactToFile(
  config: PlatformBackupConfig,
  plan: Extract<RestorePlan, { ok: true }>,
): Promise<
  | { ok: true; filePath: string; sourceName: string; workDir: string | null }
  | { ok: false; error: string }
> {
  if (plan.source === "local") {
    if (!isPlainArtifactName(plan.artifact)) return { ok: false, error: "artifact_not_found" };
    const filePath = path.join(platformBackupDir(config.directory), plan.artifact);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return { ok: false, error: "artifact_not_found" };
    } catch {
      return { ok: false, error: "artifact_not_found" };
    }
    return { ok: true, filePath, sourceName: plan.artifact, workDir: null };
  }
  const s3 = s3ConfigOf(config);
  if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
    return { ok: false, error: "cloud_not_configured" };
  }
  // Re-derive the key here as well: the plan was already validated, but this
  // function is also reachable from tests and future callers, and the prefix
  // check is the boundary.
  const resolved = resolveCloudObjectKey(
    { objectKey: plan.objectKey, artifact: plan.artifact },
    config.cloud.prefix,
  );
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-platform-cloud-"));
  const filePath = path.join(workDir, "download.bin");
  try {
    await s3GetToFile(s3, resolved.objectKey, filePath, { maxBytes: resolveMaxDownloadBytes() });
    return { ok: true, filePath, sourceName: resolved.artifact, workDir };
  } catch (err) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: `download_failed:${errText(err)}` };
  }
}

/**
 * The "check this address" button: does the peer answer, and could this install
 * restore what it offers? Returns the artifact list and the warnings so the
 * dialog can render them before anything is downloaded.
 */
export async function checkPeer(peerId: string): Promise<
  | { ok: true; manifest: PeerManifest; warnings: string[]; local: LocalSchemaSnapshot }
  | { ok: false; error: string }
> {
  const fetched = await fetchPeerManifestFor(peerId);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const config = await getPlatformBackupConfig();
  const peer = await peerWithSecret(peerId);
  const local = await localSchemaSnapshot();
  const chosen = newestArtifact(fetched.manifest.artifacts);
  const check = checkPeerManifest(
    fetched.manifest,
    {
      schemaMigrations: local.schemaMigrations,
      pgServerMajor: local.pgServerMajor,
      hasPassphrase: Boolean(platformBackupPassphrase(config)),
      allowInsecurePeers: config.allowInsecurePeers,
      secureTransport: (peer?.base_url ?? "").startsWith("https://"),
    },
    chosen?.artifact,
  );
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, manifest: fetched.manifest, warnings: check.warnings, local };
}
