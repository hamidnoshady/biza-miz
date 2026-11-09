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
import {
  describeTransportFailure,
  s3Delete,
  s3GetToFile,
  s3Head,
  s3List,
  s3PutFile,
  S3RequestError,
  s3UploadTimeoutMs,
  type S3Config,
} from "./s3-lite";
import { encryptFileToFile, fileHasBackupMagic, sha256File } from "./backup-streams";
import { LOCK_KEYS, withDistributedLock } from "./db-locks";
import {
  newRestoreJournalId,
  restoreJournalDir,
  tryAppendRestoreJournal,
  type RestorePhase,
} from "./restore-journal";
import { fetchWithOutboundPolicy, type OutboundPolicy } from "./outbound-policy";
import {
  artifactNameFromKey,
  assessCloudProtection,
  capturedAtFromName,
  cloudLeaseMs,
  CLOUD_RETRY_BASE_MS,
  planCloudUpload,
  type CloudAttempt,
  type CloudConfirmation,
  type CloudObjectRef,
  type CloudProtection,
  type LocalArtifactRef,
} from "./platform-backup-cloud";

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

/** Error recorded when encryption is required but no passphrase is configured. */
export const PASSPHRASE_REQUIRED = "passphrase_required";

type RunKind = "local" | "cloud";
type RunTrigger = "scheduled" | "manual" | "peer";

async function startRun(
  kind: RunKind,
  trigger: RunTrigger,
  artifact: string | null,
  manifest: Record<string, unknown> | null,
  platformAdminId: string | null,
  attempt: { number?: number; leaseMs?: number } = {},
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO platform_backup_runs (kind, trigger, artifact, manifest, created_by, attempt, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      kind,
      trigger,
      artifact,
      manifest ? JSON.stringify(manifest) : null,
      platformAdminId,
      Math.max(1, Math.min(1000, attempt.number ?? 1)),
      attempt.leaseMs ? new Date(Date.now() + attempt.leaseMs) : null,
    ],
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

async function newestRunOfKind(kind: RunKind): Promise<{
  status: "running" | "success" | "failed";
  at: string;
  error: string | null;
} | null> {
  const { rows } = await query<{ status: "running" | "success" | "failed"; started_at: Date; error: string | null }>(
    `SELECT status, started_at, error FROM platform_backup_runs
      WHERE kind = $1 ORDER BY started_at DESC LIMIT 1`,
    [kind],
  );
  const row = rows[0];
  return row ? { status: row.status, at: row.started_at.toISOString(), error: row.error } : null;
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

/**
 * The most recent cloud attempt for one artifact, with the lease and deadline
 * the classification needs (issue #1296). `attempts` counts the attempts that
 * have finished or were reclaimed — a `running` row is not one of those.
 */
async function latestCloudAttemptFor(
  artifact: string,
  now: Date = new Date(),
): Promise<{ last: CloudAttempt | null; attempts: number; lastError: string | null; lastRetryable: boolean | null }> {
  const { rows } = await query<{
    id: string;
    status: "running" | "success" | "failed";
    started_at: Date;
    finished_at: Date | null;
    lease_expires_at: Date | null;
    error: string | null;
    attempt: number | null;
    diagnostics: unknown;
  }>(
    `SELECT id, status, started_at, finished_at, lease_expires_at, error, attempt, diagnostics
       FROM platform_backup_runs
      WHERE kind = 'cloud' AND artifact = $1
      ORDER BY started_at DESC
      LIMIT 5`,
    [artifact],
  );
  if (rows.length === 0) return { last: null, attempts: 0, lastError: null, lastRetryable: null };
  const newest = rows[0];
  const last: CloudAttempt = {
    id: newest.id,
    status: newest.status,
    startedAt: newest.started_at,
    leaseExpiresAt: newest.lease_expires_at,
    // Rows inserted from migration 0288 on carry a lease that already covers
    // their own transfer budget (`cloudLeaseMs`); the classification falls back
    // to `startedAt + CLOUD_LEASE_MS` for a legacy `running` row, which is what
    // makes the orphan left by an earlier build reclaimable at all.
    hardDeadlineAt: null,
  };
  // Attempts that are evidence of work having *happened*: every row that is no
  // longer running. Counted in SQL rather than over the five rows above — the
  // retry ladder is bounded by this number, and a `LIMIT 5` window would cap it
  // at five forever, so a spent ladder could never be recognised as spent
  // (issue #1296: "retries exhaust and turn terminal", not "retry invisibly").
  const counted = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM platform_backup_runs
      WHERE kind = 'cloud' AND artifact = $1 AND status <> 'running'`,
    [artifact],
  );
  // Whether the last failure was transient: read back from the redacted
  // diagnostics the upload wrote. A row that predates that column has `null`
  // here, and the caller then decides on the attempt count alone.
  const diagnostics =
    newest.diagnostics && typeof newest.diagnostics === "object"
      ? (newest.diagnostics as { retryable?: unknown })
      : null;
  const lastRetryable = typeof diagnostics?.retryable === "boolean" ? diagnostics.retryable : null;
  return { last, attempts: Number(counted.rows[0]?.n ?? 0), lastError: newest.error, lastRetryable };
}

const CLOUD_ATTEMPT_SELECT = `SELECT r.id,
                                    coalesce(r.cloud_key, '') AS cloud_key,
                                    r.cloud_verified_key,
                                    r.cloud_verified_at,
                                    r.cloud_verified_size,
                                    r.cloud_verified_sha256,
                                    r.cloud_verify_mode
                               FROM platform_backup_runs r`;

/**
 * The confirmed remote objects this install knows about, per plain artifact
 * name. A confirmation only counts while the provider still lists the object —
 * `assessCloudProtection` drops the rest — so retention deleting an object
 * cannot keep the console green.
 */
export async function listCloudConfirmations(): Promise<CloudConfirmation[]> {
  const { rows } = await query<{
    artifact: string | null;
    cloud_verified_key: string | null;
    cloud_verified_at: Date | null;
    cloud_verified_size: string | null;
    cloud_verified_sha256: string | null;
    cloud_verify_mode: "size" | "sha256" | null;
  }>(
    `SELECT artifact, cloud_verified_key, cloud_verified_at, cloud_verified_size,
            cloud_verified_sha256, cloud_verify_mode
       FROM platform_backup_runs
      WHERE kind = 'local' AND artifact IS NOT NULL AND cloud_verified_at IS NOT NULL
      ORDER BY cloud_verified_at DESC
      LIMIT 200`,
  );
  return rows
    .filter((row) => row.artifact)
    .map((row) => ({
      artifact: row.artifact!,
      confirmedAt: row.cloud_verified_at ? row.cloud_verified_at.toISOString() : null,
      verifyMode: row.cloud_verify_mode,
      sizeBytes: row.cloud_verified_size === null ? null : Number(row.cloud_verified_size),
      sha256: row.cloud_verified_sha256,
    }));
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
  /**
   * The last time an upload *finished successfully*, for any artifact. Kept for
   * backward compatibility and explicitly NOT what says the newest backup is
   * off-site — `cloud.state`, `cloud.currentConfirmed` and
   * `cloud.latestConfirmedArtifact` are (issue #1296).
   */
  cloudLastSuccessAt: string | null;
  cloudLastError: string | null;
  /**
   * Issue #1296 — the same history field, read the same way, for the *local*
   * half: the newest capture's own failure, or `null` if the newest recorded
   * local run did not fail. `localLastError` above is "the last run that is not
   * running", which is right for the alert but says nothing after a successful
   * capture; the console wants "did the most recent attempt fail?" next to
   * "when did we last succeed?".
   */
  localAttempt: { status: "running" | "success" | "failed"; at: string; error: string | null } | null;
  alert: BackupAlert;
  /** How many restorable artifacts are on disk right now, and the newest one. */
  artifactsOnDisk: number;
  newestArtifact: string | null;
  /** Issue #1296 — does the newest local capture have a confirmed remote copy? */
  cloud: CloudProtection;
  /** Whether the bucket could be listed. `false` means `cloud` could not be proven. */
  cloudReachable: boolean;
}

/**
 * Whole-platform disaster-recovery health.
 *
 * Local and cloud are computed separately and never merged: the local half is
 * the run history on this disk, the cloud half is "the newest artifact we hold
 * has a confirmed object in the bucket" — which is a different question from
 * "some upload succeeded once", and the difference is exactly what #1296 was
 * filed about.
 */
export async function getPlatformBackupHealth(): Promise<PlatformBackupHealth> {
  const config = await getPlatformBackupConfig();
  const [localSuccess, localLast, localAttempt, cloudSuccess, cloudLast, artifacts] = await Promise.all([
    latestRun("local", false),
    latestRun("local", true),
    newestRunOfKind("local"),
    latestRun("cloud", false),
    latestRun("cloud", true),
    listPlatformLocalArtifacts(config),
  ]);

  // Two different "newest" answers, and the difference is the point: the newest
  // capture the *history* records, and the newest artifact whose file is still
  // on disk. A missing file is reported as such rather than silently replaced,
  // and never retried as a transient upload failure.
  const newestRecorded = newestArtifact(artifacts);
  const newestLocal = newestArtifact(artifacts.filter((a) => a.exists));
  const localArtifact: LocalArtifactRef | null = newestLocal
    ? {
        artifact: newestLocal.artifact,
        sizeBytes: newestLocal.sizeBytes,
        capturedAt: newestLocal.createdAt ?? capturedAtFromName(newestLocal.artifact),
      }
    : null;
  const recordedArtifact: LocalArtifactRef | null = newestRecorded
    ? {
        artifact: newestRecorded.artifact,
        sizeBytes: newestRecorded.sizeBytes,
        capturedAt: newestRecorded.createdAt ?? capturedAtFromName(newestRecorded.artifact),
      }
    : null;

  let cloudObjects: CloudObjectRef[] = [];
  let cloudReachable = false;
  if (config.cloud.enabled) {
    const listed = await listCloudObjectsBestEffort(config);
    if (listed) {
      cloudObjects = listed;
      cloudReachable = true;
    }
  }
  const attemptArtifact = localArtifact?.artifact ?? recordedArtifact?.artifact ?? null;
  const [confirmations, attempt] = await Promise.all([
    config.cloud.enabled ? listCloudConfirmations() : Promise.resolve([] as CloudConfirmation[]),
    attemptArtifact
      ? latestCloudAttemptFor(attemptArtifact)
      : Promise.resolve({ last: null, attempts: 0, lastError: null, lastRetryable: null }),
  ]);

  const cloud = assessCloudProtection({
    cloudEnabled: config.cloud.enabled,
    currentArtifact: localArtifact,
    localArtifactExists: newestRecorded?.exists ?? null,
    newestRecorded: recordedArtifact,
    cloudObjects,
    confirmations,
    lastAttempt: attempt.last,
    lastError: attempt.lastError,
    lastRetryable: attempt.lastRetryable,
    attempts: attempt.attempts,
    rpoMs: platformRpoMs(config),
  });

  // The alert's "cloud is fine" answer is only ever the *current* artifact's
  // confirmed copy; the reason code keeps the old vocabulary (a consumer of
  // `alert.reason` must not have to learn new strings), but which code it is
  // now depends on today's artifact, not on September's upload.
  const cloudAlertReason = !config.cloud.enabled
    ? null
    : (cloud.currentConfirmed && !cloud.localArtifactMissing) || cloud.state === "no_local_artifact"
      ? null
      : cloud.state === "failed" || cloud.state === "unavailable"
        ? "cloud_failed"
        : "cloud_stale";

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
    localAttempt,
    cloudLastSuccessAt: cloudSuccess.lastSuccessAt,
    cloudLastError: cloudLast.lastError,
    // #1296: an old successful upload must not keep the line green. The alert
    // gets the *current* artifact's cloud state, so "cloud is stale" means "the
    // newest capture is not off-site", not "we have not uploaded lately".
    alert: platformBackupAlert(config, {
      localLastSuccessAt: localSuccess.lastSuccessAt,
      localLastError: localLast.lastError,
      cloudLastSuccessAt: cloud.currentConfirmed ? (cloud.latestConfirmedAt ?? cloudSuccess.lastSuccessAt) : null,
      cloudLastError: cloudAlertReason === "cloud_stale" ? null : (attempt.lastError ?? cloudLast.lastError),
      // `cloud_stale` when the newest capture has no confirmed copy and the RPO
      // has passed with no failure to blame; `cloud_failed` when the attempt
      // itself has been failing. Both mean "the newest backup is not off-site".
      cloudStaleOverride: cloudAlertReason,
    }),
    artifactsOnDisk: artifacts.filter((a) => a.exists).length,
    newestArtifact: newestLocal?.artifact ?? null,
    cloud,
    cloudReachable,
  };
}

/**
 * The bucket's objects, or `null` when it cannot be listed. Deliberately not the
 * console's list: that one degrades to an empty array for display, which would
 * read as "the bucket is empty" here — the opposite of the truth.
 */
async function listCloudObjectsBestEffort(config: PlatformBackupConfig): Promise<CloudObjectRef[] | null> {
  const s3 = s3ConfigOf(config);
  if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) return null;
  try {
    const objects = await s3List(s3, config.cloud.prefix);
    return objects
      .filter((object) => isServeableArtifactName(artifactNameFromKey(object.key)))
      .map((object) => ({ artifact: artifactNameFromKey(object.key), sizeBytes: object.size }));
  } catch (err) {
    console.error("platform backup: cloud listing failed:", errText(err));
    return null;
  }
}

/**
 * How long a newest-local capture may go without a confirmed remote copy before
 * the console alerts. Tied to the capture cadence (two intervals) with a floor,
 * because a one-hour schedule should not alert about a 59-minute-old upload.
 */
export function platformRpoMs(config: Pick<PlatformBackupConfig, "intervalHours">): number {
  return Math.max(6 * 60 * 60 * 1000, Math.max(1, config.intervalHours) * 2 * 60 * 60 * 1000);
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
    // Fail closed (audit F03). A run that asks for encryption without an
    // effective passphrase is refused and recorded as failed — it never
    // silently becomes a plaintext dump that could then be shared.
    if (config.encryptLocal && passphrase.length === 0) {
      const runId = await startRun("local", trigger, null, null, platformAdminId);
      await finishRun(runId, { status: "failed", error: PASSPHRASE_REQUIRED });
      return { status: "failed", error: PASSPHRASE_REQUIRED };
    }
    const encrypt = config.encryptLocal;
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
  | { status: "ok"; key: string; sizeBytes: number; verifyMode: "size" | "sha256"; attempt: number }
  | { status: "disabled" }
  | { status: "busy"; error: "upload_in_flight"; retryAt: string | null }
  | { status: "failed"; error: string; retryable: boolean; attempt: number; diagnostics: CloudDiagnostics };

/** The redacted, structured answer to "why did it fail?" (issue #1296). */
export interface CloudDiagnostics {
  /** short provider-neutral stage code the attempt reached */
  phase: string | null;
  /** HTTP status from the provider, or null for a transport failure */
  providerStatus: number | null;
  /** provider `<Code>` or transport code (e.g. `SignatureDoesNotMatch`, `ECONNRESET`) */
  code: string | null;
  /** the outermost error class only (`TypeError`, `S3RequestError`, …) */
  errorClass: string | null;
  /** whether the failure was classified as transient when it happened */
  retryable: boolean;
  /** attempts spent on this artifact so far */
  attempts: number;
  /** bytes the upload meant to send */
  expectedBytes: number | null;
  elapsedMs: number;
  /** the classifier's answer for the *next* attempt, when it ran to exhaustion */
  retryAfterMs: number | null;
}

/**
 * Issue #1296 — write the confirmation columns for one local artifact.
 *
 * The confirmation is only ever recorded after the provider *showed us* the
 * object (a listing or a HEAD), never after a `200` on the PUT alone: a `200`
 * on a streamed body is a claim about the request, not about the object that is
 * now readable, and the whole point of this column is to survive that
 * distinction.
 */
async function recordCloudConfirmation(input: {
  artifact: string;
  key: string;
  verifyMode: "size" | "sha256";
  sizeBytes: number;
  sha256: string | null;
  localRunId: string | null;
}): Promise<void> {
  if (input.localRunId) {
    await query(
      `UPDATE platform_backup_runs
          SET cloud_verified_key = $2, cloud_verified_at = now(), cloud_verify_mode = $3,
              cloud_verified_size = $4, cloud_verified_sha256 = $5
        WHERE id = $1`,
      [input.localRunId, input.key, input.verifyMode, input.sizeBytes, input.sha256],
    );
    return;
  }
  // No local run row (an artifact copied into the directory, or one recorded
  // before this install's history): match on the artifact name instead.
  await query(
    `UPDATE platform_backup_runs
        SET cloud_verified_key = $2, cloud_verified_at = now(), cloud_verify_mode = $3,
            cloud_verified_size = $4, cloud_verified_sha256 = $5
      WHERE id = (
        SELECT id FROM platform_backup_runs
         WHERE kind = 'local' AND status = 'success' AND artifact = $1
         ORDER BY started_at DESC LIMIT 1
      )`,
    [input.artifact, input.key, input.verifyMode, input.sizeBytes, input.sha256],
  );
}

/** The local run row an artifact belongs to, for the confirmation write. */
async function localRunIdFor(artifact: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM platform_backup_runs
      WHERE kind = 'local' AND status = 'success' AND artifact = $1
      ORDER BY started_at DESC LIMIT 1`,
    [artifact],
  );
  return rows[0]?.id ?? null;
}

/**
 * Prove the object is really there, and that it is the object we meant to send.
 *
 * A HEAD after the upload is the cheap proof (one signed request, no download):
 * existence plus the exact size. Only when the caller asked for `sha256` — the
 * restore drill's path, or an operator pressing "verify now" — is the object
 * downloaded and hashed, because that costs a full round trip of the artifact's
 * bytes. The ETag is never consulted: providers disagree about what it hashes.
 */
export async function verifyCloudObject(input: {
  config?: PlatformBackupConfig;
  key: string;
  expected: { sizeBytes: number | null; sha256: string | null };
  mode?: "size" | "sha256";
}): Promise<{ ok: true; mode: "size" | "sha256"; sizeBytes: number; sha256: string | null } | { ok: false; error: string }> {
  const config = input.config ?? (await getPlatformBackupConfig());
  const s3 = s3ConfigOf(config);
  const mode = input.mode ?? "size";
  try {
    const head = await s3Head(s3, input.key);
    if (!head) return { ok: false, error: "object_not_found" };
    const expectedSize = input.expected.sizeBytes;
    if (expectedSize !== null && head.size !== expectedSize) {
      return { ok: false, error: `object_size_mismatch:${head.size}/${expectedSize}` };
    }
    if (mode === "size") return { ok: true, mode: "size", sizeBytes: head.size, sha256: null };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-verify-"));
    const target = path.join(dir, "object.bin");
    try {
      const downloaded = await s3GetToFile(s3, input.key, target, { maxBytes: resolveMaxDownloadBytes() });
      if (head.size !== downloaded.sizeBytes) {
        return { ok: false, error: `object_size_changed:${downloaded.sizeBytes}/${head.size}` };
      }
      if (input.expected.sha256 && downloaded.sha256 !== input.expected.sha256) {
        return { ok: false, error: "object_sha256_mismatch" };
      }
      return { ok: true, mode: "sha256", sizeBytes: downloaded.sizeBytes, sha256: downloaded.sha256 };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return { ok: false, error: errText(err).slice(0, 300) };
  }
}

function cloudDiagnosticsOf(
  err: unknown,
  input: { phase: string | null; attempts: number; expectedBytes: number | null; startedAt: number; retryable: boolean; retryAfterMs: number | null },
): CloudDiagnostics {
  const typed = err instanceof S3RequestError ? err : null;
  const transport = typed ? describeTransportFailure(typed.cause ?? err) : describeTransportFailure(err);
  return {
    phase: input.phase,
    providerStatus: typed?.status ?? null,
    code: typed?.providerCode ?? transport.code,
    errorClass: typed?.name ?? transport.name,
    retryable: typed ? typed.retryable : input.retryable,
    attempts: input.attempts,
    expectedBytes: input.expectedBytes,
    elapsedMs: Math.max(0, Date.now() - input.startedAt),
    retryAfterMs: input.retryAfterMs,
  };
}

/** A one-line, secret-free summary for the run row and the audit log. */
function summarizeCloudFailure(err: unknown, diagnostics: CloudDiagnostics): string {
  const message = errText(err).slice(0, 300);
  const extra = [
    diagnostics.code ? `code=${diagnostics.code}` : null,
    diagnostics.providerStatus !== null ? `http=${diagnostics.providerStatus}` : null,
    diagnostics.phase ? `phase=${diagnostics.phase}` : null,
    `attempts=${diagnostics.attempts}`,
  ]
    .filter(Boolean)
    .join(" ");
  return extra ? `${message} [${extra}]` : message;
}

/**
 * Encrypt (if the local copy is not already) and upload one artifact to the
 * bucket, then prove the object is there.
 *
 * Issue #1296 changes four things about this path, and nothing about where the
 * bytes go:
 *
 *   1. **One uploader per artifact, cluster-wide.** A named advisory lock
 *      (`LOCK_KEYS.platformCloudUpload`) is held for the whole transfer, so a
 *      catch-up, a manual click and a second replica cannot race the same key.
 *      `busy` is a first-class answer — it means "someone is doing it", which is
 *      the truth, and the console shows it as "uploading" rather than failed.
 *   2. **A lease.** The run row carries `lease_expires_at` (transfer budget +
 *      grace) from the moment it starts, so a worker that dies mid-upload is
 *      recoverable in bounded time instead of until an operator notices.
 *   3. **Bounded retries with diagnostics.** `s3PutFile`'s own ladder is used
 *      with a bigger budget and an `onAttemptFailed` hook that records the
 *      stage, the classification and the delay — all redacted.
 *   4. **Proof.** After the PUT the object is verified (size by default) and the
 *      confirmation is written onto the local artifact's row, which is what the
 *      console and the MCP contract read as "off-site".
 */
export async function runPlatformCloudUpload(
  artifact: string,
  trigger: RunTrigger,
  platformAdminId: string | null = null,
  options: { verify?: "size" | "sha256" } = {},
): Promise<PlatformCloudResult> {
  const config = await getPlatformBackupConfig();
  if (!config.cloud.enabled) return { status: "disabled" };
  if (!isServeableArtifactName(artifact)) {
    return {
      status: "failed",
      error: "unsafe_artifact_name",
      retryable: false,
      attempt: 1,
      diagnostics: {
        phase: "preparing",
        providerStatus: null,
        code: "unsafe_artifact_name",
        errorClass: "Refusal",
        retryable: false,
        attempts: 1,
        expectedBytes: null,
        elapsedMs: 0,
        retryAfterMs: null,
      },
    };
  }

  const lock = await withDistributedLock(LOCK_KEYS.platformCloudUpload(artifact), () =>
    runPlatformCloudUploadLocked(artifact, trigger, platformAdminId, config, options),
  );
  if (!lock.ok) {
    if (lock.reason === "busy") return { status: "busy", error: "upload_in_flight", retryAt: null };
    return {
      status: "failed",
      error: `cloud_lock_unavailable:${lock.error ?? "database_unreachable"}`,
      retryable: true,
      attempt: 1,
      diagnostics: {
        phase: "lock",
        providerStatus: null,
        code: "cloud_lock_unavailable",
        errorClass: "LockUnavailable",
        retryable: true,
        attempts: 0,
        expectedBytes: null,
        elapsedMs: 0,
        retryAfterMs: CLOUD_RETRY_BASE_MS,
      },
    };
  }
  return lock.value;
}

async function runPlatformCloudUploadLocked(
  artifact: string,
  trigger: RunTrigger,
  platformAdminId: string | null,
  config: PlatformBackupConfig,
  options: { verify?: "size" | "sha256" },
): Promise<PlatformCloudResult> {
  const startedAt = Date.now();
  const before = await latestCloudAttemptFor(artifact);
  const attemptNumber = Math.max(1, before.attempts + 1);
  const key = platformCloudKeyFor(config.cloud.prefix, artifact);
  const transient: string[] = [];
  let phase: string | null = "preparing";
  let expectedBytes: number | null = null;
  let retryable = false;
  let retryAfterMs: number | null = null;
  let lastTransportCode: string | null = null;

  // The lease is taken before the row is inserted: the deadline has to cover the
  // whole attempt (hash + encrypt + transfer + verify) or a live attempt could
  // be reclaimed while it is still working.
  const sourcePath = path.join(platformBackupDir(config.directory), artifact);
  let sourceSize = 0;
  try {
    sourceSize = (await fs.stat(sourcePath)).size;
  } catch {
    sourceSize = 0;
  }
  const leaseMs = cloudLeaseMs(s3UploadTimeoutMs(sourceSize));
  const runId = await startRun("cloud", trigger, artifact, null, platformAdminId, {
    number: attemptNumber,
    leaseMs,
  });

  const finishFailed = async (err: unknown): Promise<PlatformCloudResult> => {
    const diagnostics = cloudDiagnosticsOf(err, {
      phase,
      attempts: attemptNumber,
      expectedBytes,
      startedAt,
      retryable,
      retryAfterMs,
    });
    const summary = summarizeCloudFailure(err, diagnostics);
    await query(
      `UPDATE platform_backup_runs
          SET status = 'failed', error = $2, finished_at = now(),
              attempt_phase = $3, diagnostics = $4, lease_expires_at = NULL
        WHERE id = $1`,
      [runId, summary.slice(0, 1000), phase, JSON.stringify(diagnostics)],
    );
    return {
      status: "failed",
      error: summary,
      retryable: diagnostics.retryable,
      attempt: attemptNumber,
      diagnostics,
    };
  };

  try {
    if (!isPlainArtifactName(artifact)) throw new Error("unsafe_artifact_name");
    let uploadPath = sourcePath;
    // The exact bytes we are about to send, and their hash — computed before the
    // request, so a truncated body cannot even be signed (and a retry re-reads
    // the same file, never a half-consumed stream).
    phase = "hashing";
    let payloadHash = await sha256File(sourcePath);
    let sizeBytes = (await fs.stat(sourcePath)).size;
    if (!(await fileHasBackupMagic(sourcePath))) {
      phase = "encrypting";
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
    expectedBytes = sizeBytes;
    const s3 = s3ConfigOf(config);
    phase = "uploading";
    // Streamed (issue #807) — a full-database artifact is never buffered.
    await s3PutFile(s3, key, uploadPath, {
      payloadHash,
      sizeBytes,
      retry: {
        // More than the default three: a 319 MB upload that fails on a flaky
        // link should not need six scheduled ticks to get through.
        attempts: CLOUD_UPLOAD_ATTEMPTS,
        baseDelayMs: CLOUD_UPLOAD_RETRY_BASE_MS,
        onAttemptFailed: (info) => {
          lastTransportCode = info.code;
          retryable = info.retryable;
          retryAfterMs = info.delayMs;
          // Best-effort, redacted: keeps the lease observable while a slow
          // transfer is retried, and records that the ladder is running.
          void query(
            `UPDATE platform_backup_runs SET diagnostics = $2::jsonb WHERE id = $1`,
            [
              runId,
              JSON.stringify({
                phase: "uploading",
                code: info.code,
                providerStatus: info.status,
                attempt: info.attempt,
                retryable: info.retryable,
                delayMs: info.delayMs,
                expectedBytes,
              }),
            ],
          ).catch(() => undefined);
        },
      },
    });

    // The PUT said 200; the bucket is asked to show us the object. A `200` on a
    // streamed body is a claim about the request, and #1296 exists because that
    // claim was treated as proof.
    phase = "verifying";
    const verify = await verifyCloudObject({
      config,
      key,
      expected: { sizeBytes, sha256: payloadHash },
      mode: options.verify ?? "size",
    });
    if (!verify.ok) throw new Error(`verify_failed:${verify.error}`);

    await recordCloudConfirmation({
      artifact,
      key,
      verifyMode: verify.mode,
      sizeBytes: verify.sizeBytes,
      sha256: verify.sha256 ?? payloadHash,
      localRunId: await localRunIdFor(artifact),
    });
    await query(`UPDATE platform_backup_runs SET cloud_key = $2 WHERE id = $1`, [runId, key]);

    phase = "pruning";
    try {
      const objects = await s3List(s3, config.cloud.prefix);
      for (const stale of selectPrunable(objects.map((o) => o.key), config.cloud.retention)) {
        await s3Delete(s3, stale);
      }
    } catch (err) {
      // Retention is housekeeping: a failed prune must not fail a confirmed
      // upload, and it must not erase the confirmation either.
      console.error("platform backup: cloud prune failed:", errText(err));
    }

    await query(
      `UPDATE platform_backup_runs
          SET status = 'success', size_bytes = $2, sha256 = $3, finished_at = now(),
              attempt_phase = $4, lease_expires_at = NULL
        WHERE id = $1`,
      [runId, verify.sizeBytes, payloadHash, phase],
    );
    return {
      status: "ok",
      key,
      sizeBytes: verify.sizeBytes,
      verifyMode: verify.mode,
      attempt: attemptNumber,
    };
  } catch (err) {
    // A transport failure that the ladder could not get past leaves a code we
    // can report; anything else keeps the classifier's own verdict.
    if (err instanceof S3RequestError) {
      retryable = err.retryable;
      lastTransportCode = err.providerCode;
    }
    void lastTransportCode;
    return await finishFailed(err);
  } finally {
    await Promise.all(transient.map((file) => secureUnlink(file)));
  }
}

/** Upload attempts per artifact, inside one `runPlatformCloudUpload` call. */
const CLOUD_UPLOAD_ATTEMPTS = 5;
/** First delay inside that ladder (250 ms is for a 26-byte probe, not 300 MB). */
const CLOUD_UPLOAD_RETRY_BASE_MS = 2_000;

/**
 * If the newest successful local artifact never made it to the bucket, nudge it
 * again — with bounded backoff, and with stale-lease recovery (issue #1296).
 *
 * The old version returned as soon as the newest cloud row said `running`, with
 * no age check: one worker that died mid-upload disabled catch-up for that
 * artifact permanently, and nothing said so. The decision now comes from
 * `planCloudUpload`, so an expired lease is reclaimed (the row is closed as
 * failed with an honest reason, then a fresh attempt starts under the
 * per-artifact lock) and a spent retry ladder falls back to one slow attempt a
 * day instead of silence.
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

  // Issue #1296 defect 4: a file that is gone is not a transient upload
  // failure. Retrying it every tick produced a tight `ENOENT` loop that blamed
  // the bucket and kept the console red for something no retry can fix. The
  // absence is recorded once, the row stays as history, and the next capture is
  // what gets mirrored.
  const sourcePath = path.join(platformBackupDir(config.directory), artifact);
  const exists = await fs
    .stat(sourcePath)
    .then((stat) => stat.isFile() && stat.size > 0)
    .catch(() => false);
  if (!exists) {
    const marked = await markLocalArtifactMissing(artifact);
    if (marked === "newly_marked") {
      console.error(`platform backup: local artifact ${artifact} is missing; not retrying its upload`);
    }
    return;
  }

  const { last, attempts } = await latestCloudAttemptFor(artifact);
  const plan = planCloudUpload({ lastAttempt: last, attempts });
  if (plan.decision === "wait") return;

  if (plan.reclaimRunId) {
    // Close the abandoned attempt first, so the history says what happened and
    // the new attempt is not recorded as a second concurrent `running` row.
    await query(
      `UPDATE platform_backup_runs
          SET status = 'failed', finished_at = now(), lease_expires_at = NULL,
              error = 'lease_expired: upload abandoned without a heartbeat; reclaimed for a fresh attempt'
        WHERE id = $1 AND status = 'running'`,
      [plan.reclaimRunId],
    );
    // No platform admin exists on this path (it is the scheduler), and
    // `platform_audit_log.platform_admin_id` is NOT NULL by design. The run row
    // *is* the audit trail here: it keeps the original attempt, the reclaimed
    // row and the reason, so the console's history shows the takeover.
    console.info(
      `platform backup: reclaimed abandoned cloud upload ${plan.reclaimRunId} for ${artifact} (attempt ${plan.attempt})`,
    );
  }

  const result = await runPlatformCloudUpload(artifact, "scheduled");
  if (result.status === "failed" && !result.retryable) {
    // A deterministic refusal (bad signature, wrong bucket, missing passphrase)
    // is not something the scheduler can fix by trying again; logging it once
    // per tick would bury the console line in noise. The run row already says
    // what it was.
    console.error(
      `platform backup: cloud upload refused for ${artifact}: ${result.error} (code=${result.diagnostics.code ?? "unknown"})`,
    );
  } else if (result.status === "busy") {
    // Another instance is uploading the same artifact; that is the wanted state.
    console.info(`platform backup: cloud upload for ${artifact} already in flight on another worker`);
  }
}

/**
 * Record — once — that a recorded artifact's file is not on disk any more.
 *
 * Deliberately a one-way note, not a deletion: the run row, its manifest and the
 * confirmed remote copy all stay, so an operator can still restore the object
 * from the bucket. "We had it, then we did not" is the difference between
 * finding a copy and giving up (the same reasoning the status route documents).
 */
export async function markLocalArtifactMissing(artifact: string): Promise<"newly_marked" | "already_marked" | "unknown_artifact"> {
  const { rowCount } = await query(
    `UPDATE platform_backup_runs
        SET local_missing_since = now()
      WHERE kind = 'local' AND status = 'success' AND artifact = $1 AND local_missing_since IS NULL`,
    [artifact],
  );
  if ((rowCount ?? 0) > 0) return "newly_marked";
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM platform_backup_runs
      WHERE kind = 'local' AND status = 'success' AND artifact = $1`,
    [artifact],
  );
  return Number(rows[0]?.n ?? 0) > 0 ? "already_marked" : "unknown_artifact";
}

/** Artifacts whose local file is known to be gone (the console's honest list). */
export async function listMissingLocalArtifacts(): Promise<string[]> {
  const { rows } = await query<{ artifact: string }>(
    `SELECT DISTINCT ON (artifact) artifact
       FROM platform_backup_runs
      WHERE kind = 'local' AND artifact IS NOT NULL AND local_missing_since IS NOT NULL
      ORDER BY artifact, started_at DESC
      LIMIT 100`,
  );
  return rows.map((row) => row.artifact);
}

/**
 * «تلاش دوباره» — upload the newest local artifact now, ignoring the backoff.
 *
 * This is the operator's explicit "upload it again" (issue #1296 P1: "actionable
 * retry without obscuring technical diagnostics"). It still takes the
 * per-artifact lock and still records an attempt, so pressing it twice cannot
 * start two uploads; the only thing it skips is the scheduler's wait.
 */
export async function retryPlatformCloudUpload(
  platformAdminId: string | null = null,
  options: { artifact?: string | null; verify?: "size" | "sha256" } = {},
): Promise<PlatformCloudResult> {
  const config = await getPlatformBackupConfig();
  if (!config.cloud.enabled) return { status: "disabled" };
  const artifact = options.artifact?.trim();
  const targeted = artifact && isServeableArtifactName(artifact) ? artifact : null;
  if (artifact && !targeted) {
    return {
      status: "failed",
      error: "unsafe_artifact_name",
      retryable: false,
      attempt: 1,
      diagnostics: {
        phase: "preparing",
        providerStatus: null,
        code: "unsafe_artifact_name",
        errorClass: "Refusal",
        retryable: false,
        attempts: 1,
        expectedBytes: null,
        elapsedMs: 0,
        retryAfterMs: null,
      },
    };
  }
  if (targeted) return runPlatformCloudUpload(targeted, "manual", platformAdminId, options);
  const newest = newestArtifact((await listPlatformLocalArtifacts(config)).filter((a) => a.exists));
  if (!newest) {
    return {
      status: "failed",
      error: "no_local_artifact",
      retryable: false,
      attempt: 1,
      diagnostics: {
        phase: "preparing",
        providerStatus: null,
        code: "no_local_artifact",
        errorClass: "Refusal",
        retryable: false,
        attempts: 1,
        expectedBytes: null,
        elapsedMs: 0,
        retryAfterMs: null,
      },
    };
  }
  return runPlatformCloudUpload(newest.artifact, "manual", platformAdminId, options);
}

/**
 * "Back up now" from the console: one dump, plus the cloud upload when the
 * bucket is configured.
 */
export async function runPlatformBackupNow(
  platformAdminId: string | null = null,
): Promise<{ local: PlatformBackupResult; cloud: PlatformCloudResult }> {
  const local = await runPlatformLocalBackup("manual", platformAdminId);
  // No successful local run means there is no artifact to mirror: `disabled`
  // is the honest cloud answer for that case (it is also what the route already
  // shows), and the local result carries the actual failure.
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
        const uploaded = await runPlatformCloudUpload(local.artifact, "scheduled");
        if (uploaded.status === "failed" || uploaded.status === "busy") {
          console.error(
            `platform backup: upload of ${local.artifact} did not complete (${uploaded.status}` +
              `${uploaded.status === "failed" ? `, code=${uploaded.diagnostics.code ?? "unknown"}, retryable=${uploaded.retryable}` : ""})`,
          );
        }
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
    // Peers only ever receive ciphertext (audit F03). A plaintext artifact that
    // exists — including a legacy one written before encryption was enforced —
    // stays on disk for an operator, but is never handed to a peer. A name that
    // does not exist is simply not found, plaintext or not.
    if (!artifact.endsWith(".enc")) return { ok: false, status: 403, error: "plaintext_artifact_not_served" };
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
