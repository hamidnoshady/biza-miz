/**
 * Issue #903 §7 — the platform-owned destination for managed tenant backups.
 *
 * This is the module that makes "managed storage" real without ever handing a
 * tenant a storage credential. It owns one singleton configuration row
 * (`platform_tenant_backup_service`, migration 0265) that only Superadmin can
 * edit, seals that row's two secrets with the platform key-encryption key, and
 * resolves — per business, per deployment profile — the one destination a run,
 * an upload, a download or a restore may use.
 *
 * Resolution order, and why:
 *
 * ```text
 * profile local          → no cloud destination at all (no outbound call)
 * managed_cloud enabled  → the platform's bucket, under the business's own
 *                          server-derived prefix
 * historic tenant bucket → the self-hosted install's own destination, kept
 *                          working for existing customers; it can no longer be
 *                          edited by a tenant (see tenant-backup-contract.ts)
 * otherwise              → unavailable, described honestly, never "plaintext"
 * ```
 *
 * The adapter is deliberately the ONLY place an S3 credential for tenant
 * artifacts is assembled, so an audit has one file to read rather than a search
 * for `secretAccessKey` across the service layer.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { query, withoutTenantScope } from "./db";
import { getMasterKey } from "./master-key";
import { logicalSnapshotScopeTag } from "./backup-policy";
import { sha256Hex, signS3Request, type S3Config } from "./s3-lite";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";

const SEAL_IV_BYTES = 12;
const SEAL_TAG_BYTES = 16;
const SEAL_MAGIC = "POSTBS1";

export interface TenantBackupServiceConfig {
  managedCloud: boolean;
  hybridEnabled: boolean;
  cloudEnabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  accessKeyHint: string;
  defaultIntervalHours: number;
  defaultRetentionDays: number;
  maxRetentionDays: number;
  cloudKeepCount: number;
  maxArtifactBytes: number;
  uploadChunkBytes: number;
  maxParallelUploads: number;
  protectedRecoveryCopies: number;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastErrorCode: string | null;
}

interface ServiceRow extends Record<string, unknown> {
  managed_cloud: boolean;
  hybrid_enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  key_prefix: string;
  access_key_sealed: string;
  secret_key_sealed: string;
  access_key_hint: string;
  default_interval_hours: number;
  default_retention_days: number;
  max_retention_days: number;
  cloud_keep_count: number;
  max_artifact_bytes: string;
  upload_chunk_bytes: number;
  max_parallel_uploads: number;
  protected_recovery_copies: number;
  last_checked_at: Date | null;
  last_check_ok: boolean | null;
  last_error_code: string | null;
  updated_at: Date;
}

/**
 * Purpose-bound sealing key. The KEK wraps tenant artifact keys elsewhere and
 * signs manifests elsewhere; this derivation keeps a value sealed for one
 * purpose from being opened in another.
 */
function sealingKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("tenant-backup-service-secret-v1").digest();
}

function sealSecret(masterKey: Buffer, field: string, value: string): string {
  const nonce = randomBytes(SEAL_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(masterKey), nonce, { authTagLength: SEAL_TAG_BYTES });
  cipher.setAAD(Buffer.from(`tenant-backup-service-v1|${field}`, "utf8"));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    SEAL_MAGIC,
    nonce.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}

/** Returns null for anything unreadable — a wrong/absent KEK is not a crash. */
function openSecret(masterKey: Buffer, field: string, sealed: string): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== SEAL_MAGIC) return null;
  try {
    const nonce = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const body = Buffer.from(parts[3], "base64");
    if (nonce.length !== SEAL_IV_BYTES || tag.length !== SEAL_TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(masterKey), nonce, { authTagLength: SEAL_TAG_BYTES });
    decipher.setAAD(Buffer.from(`tenant-backup-service-v1|${field}`, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

async function readRow(): Promise<ServiceRow> {
  return withoutTenantScope("tenant-backup-service", async () => {
    const { rows } = await query<ServiceRow>(
      `SELECT managed_cloud, hybrid_enabled, endpoint, region, bucket, key_prefix,
              access_key_sealed, secret_key_sealed, access_key_hint,
              default_interval_hours, default_retention_days, max_retention_days,
              cloud_keep_count, max_artifact_bytes, upload_chunk_bytes,
              max_parallel_uploads, protected_recovery_copies,
              last_checked_at, last_check_ok, last_error_code, updated_at
         FROM platform_tenant_backup_service WHERE id = true`,
    );
    const row = rows[0];
    if (row) return row;
    // A database migrated before the row existed still answer coherently.
    return {
      managed_cloud: false, hybrid_enabled: false, endpoint: "", region: "us-east-1",
      bucket: "", key_prefix: "managed-tenant-backups/", access_key_sealed: "",
      secret_key_sealed: "", access_key_hint: "", default_interval_hours: 24,
      default_retention_days: 30, max_retention_days: 365, cloud_keep_count: 30,
      max_artifact_bytes: "5368709120", upload_chunk_bytes: 8388608,
      max_parallel_uploads: 2, protected_recovery_copies: 1,
      last_checked_at: null, last_check_ok: null, last_error_code: null, updated_at: new Date(0),
    };
  });
}

/** Normalize a prefix to `…/` and refuse traversal, so a key can never escape it. */
export function normalizeKeyPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "");
  if (!trimmed) return "";
  if (trimmed.includes("..") || /[\\]/.test(trimmed)) throw new Error("invalid_key_prefix");
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** The platform's full configuration, secrets included. Server-only. */
export async function readTenantBackupService(): Promise<TenantBackupServiceConfig> {
  const row = await readRow();
  const masterKey = getMasterKey();
  const accessKeyId =
    (masterKey && openSecret(masterKey, "access_key", row.access_key_sealed)) || "";
  const secretAccessKey =
    (masterKey && openSecret(masterKey, "secret_key", row.secret_key_sealed)) || "";
  return {
    managedCloud: row.managed_cloud,
    hybridEnabled: row.hybrid_enabled,
    cloudEnabled: row.managed_cloud && Boolean(row.endpoint && row.bucket && accessKeyId && secretAccessKey),
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    keyPrefix: row.key_prefix,
    accessKeyId,
    secretAccessKey,
    accessKeyHint: row.access_key_hint,
    defaultIntervalHours: row.default_interval_hours,
    defaultRetentionDays: row.default_retention_days,
    maxRetentionDays: row.max_retention_days,
    cloudKeepCount: row.cloud_keep_count,
    maxArtifactBytes: Number(row.max_artifact_bytes),
    uploadChunkBytes: row.upload_chunk_bytes,
    maxParallelUploads: row.max_parallel_uploads,
    protectedRecoveryCopies: row.protected_recovery_copies,
    lastCheckedAt: row.last_checked_at ? row.last_checked_at.toISOString() : null,
    lastCheckOk: row.last_check_ok,
    lastErrorCode: row.last_error_code,
  };
}

/**
 * The operator-facing view. Details are *not* tenant copy: this DTO is what the
 * Superadmin console shows, and even here the secrets are absent and the access
 * key is a hint. `secretFingerprint` matches a projected credential to its hint
 * without ever returning it.
 */
export function serviceConfigView(config: TenantBackupServiceConfig) {
  return {
    managedCloud: config.managedCloud,
    hybridEnabled: config.hybridEnabled,
    // "configured" means the destination is complete AND openable.
    configured: config.cloudEnabled,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    keyPrefix: config.keyPrefix,
    accessKeyHint: config.accessKeyHint,
    hasSecretKey: Boolean(config.secretAccessKey),
    defaultIntervalHours: config.defaultIntervalHours,
    defaultRetentionDays: config.defaultRetentionDays,
    maxRetentionDays: config.maxRetentionDays,
    cloudKeepCount: config.cloudKeepCount,
    maxArtifactBytes: config.maxArtifactBytes,
    uploadChunkBytes: config.uploadChunkBytes,
    maxParallelUploads: config.maxParallelUploads,
    protectedRecoveryCopies: config.protectedRecoveryCopies,
    lastCheckedAt: config.lastCheckedAt,
    lastCheckOk: config.lastCheckOk,
    lastErrorCode: config.lastErrorCode,
    /** Diagnostics only: the custody that can open the sealed secrets. */
    kekAvailable: getMasterKey() !== null,
  };
}

/** What a *tenant* may know: availability and the plan-shaped defaults. */
export async function tenantFacingStorageStatus(profile: DeploymentProfile) {
  const config = await readTenantBackupService();
  return {
    profile,
    // Never a provider name, endpoint, bucket, region or prefix.
    cloudAvailable: profile !== "local" && config.cloudEnabled,
    managed: profile !== "local" && config.cloudEnabled,
    localCopyAllowed: profile !== "cloud",
    maxArtifactBytes: config.maxArtifactBytes,
    retentionDays: Math.min(config.defaultRetentionDays, config.maxRetentionDays),
    reason:
      profile === "local"
        ? "local_profile"
        : config.cloudEnabled
          ? "managed_storage"
          : config.managedCloud
            ? "managed_storage_incomplete"
            : "managed_storage_disabled",
  };
}

export type TenantStorageTarget =
  | { mode: "managed"; s3: S3Config; prefix: string; maxArtifactBytes: number; keepCount: number }
  | { mode: "legacy"; s3: S3Config; prefix: string; maxArtifactBytes: number; keepCount: number }
  | { mode: "unavailable"; reason: "local_profile" | "managed_storage_incomplete" | "managed_storage_disabled" | "managed_storage_unreadable" };

export interface ResolveStorageInput {
  businessId: string;
  profile: DeploymentProfile;
  role: DeploymentRole;
  /** The install's own (historic) cloud config, for the compatibility fallback. */
  legacyCloud?: {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    retention: number;
  };
}

/**
 * The single decision every network-touching path must go through. `local`
 * returns a refusal *before* any configuration is read, so a Local-only install
 * cannot be talked into an outbound call by a stale stored flag.
 */
export async function resolveTenantStorage(input: ResolveStorageInput): Promise<TenantStorageTarget> {
  if (input.profile === "local") return { mode: "unavailable", reason: "local_profile" };

  const config = await readTenantBackupService();
  if (config.cloudEnabled) {
    return {
      mode: "managed",
      s3: {
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      prefix: config.keyPrefix,
      maxArtifactBytes: config.maxArtifactBytes,
      keepCount: config.cloudKeepCount,
    };
  }

  // Compatibility: a self-hosted install that already had its own bucket before
  // #903 keeps uploading to it. Its configuration is no longer tenant-editable
  // (tenant-backup-contract.ts rejects every cloud field), so this is a
  // preserved state, not a new capability.
  const legacy = input.legacyCloud;
  if (
    input.role === "site" &&
    legacy?.enabled &&
    legacy.endpoint &&
    legacy.bucket &&
    legacy.accessKeyId &&
    legacy.secretAccessKey
  ) {
    return {
      mode: "legacy",
      s3: {
        endpoint: legacy.endpoint,
        region: legacy.region || "us-east-1",
        bucket: legacy.bucket,
        accessKeyId: legacy.accessKeyId,
        secretAccessKey: legacy.secretAccessKey,
      },
      prefix: normalizeKeyPrefix(legacy.prefix),
      maxArtifactBytes: config.maxArtifactBytes,
      keepCount: legacy.retention || config.cloudKeepCount,
    };
  }

  if (config.managedCloud) {
    // Enabled but incomplete/unreadable — reported as operator error, not as a
    // reason to fall back to an unencrypted or tenant-owned destination.
    return {
      mode: "unavailable",
      reason: getMasterKey() && config.bucket ? "managed_storage_incomplete" : "managed_storage_unreadable",
    };
  }
  return { mode: "unavailable", reason: "managed_storage_disabled" };
}

/**
 * Issue #903 §3 (owner decision 2026-10-28) — **the schedule is the fleet's**.
 *
 * The epic's supersession removes scheduling, retention and run-now from the
 * tenant surface: a business user does not manage backup creation. What is left
 * is a read-only policy the scheduler obeys and the tenant merely sees, so this
 * resolver is the single place a schedule number comes from. It reads
 * `platform_tenant_backup_service` (platform-only, never tenant-writable) and
 * falls back to safe defaults only when that row cannot be read at all — a
 * pre-migration database, or a database whose platform configuration is
 * unavailable. It deliberately does **not** read the tenant's stored
 * `BackupConfig` for the interval: that field is former tenant input, kept only
 * so an on-device install that has never seen a fleet row keeps its historic
 * cadence.
 */
export interface TenantBackupPolicy {
  /** Scheduled run spacing, from the fleet row. */
  intervalHours: number;
  /** Default retention for a new artifact. */
  retentionDays: number;
  /** Ceiling retention may never exceed. */
  maxRetentionDays: number;
  /** Cloud copies kept per business. */
  keepCount: number;
  /**
   * Restorable backups retention may never prune — the floor a delete request
   * cannot cross (issue #903 §3, "retention/delete with protected recovery
   * copies").
   */
  protectedCopies: number;
  /**
   * `managed` — the platform answered, so this policy is authoritative.
   * `default` — the row was unreadable and these are the safe on-device
   * defaults.
   */
  source: "managed" | "default";
  /** Whether the fleet has a *usable* managed destination configured. */
  managedCloud: boolean;
}

/** What a device without a reachable fleet row protects itself with. */
export const SAFE_TENANT_BACKUP_POLICY: TenantBackupPolicy = {
  intervalHours: 24,
  retentionDays: 30,
  maxRetentionDays: 365,
  keepCount: 30,
  protectedCopies: 1,
  source: "default",
  managedCloud: false,
};

/** The allowed cadences, mirrored from the migration's CHECK constraint. */
const SCHEDULE_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

function scheduleHours(value: number): number {
  if ((SCHEDULE_HOURS as readonly number[]).includes(value)) return value;
  // A corrupted/older value snaps to the nearest allowed cadence rather than
  // producing a schedule the rest of the system cannot express.
  return SCHEDULE_HOURS.reduce((best, option) =>
    Math.abs(option - value) < Math.abs(best - value) ? option : best,
  );
}

export async function resolveTenantBackupPolicy(): Promise<TenantBackupPolicy> {
  try {
    const config = await readTenantBackupService();
    return {
      intervalHours: scheduleHours(config.defaultIntervalHours),
      retentionDays: Math.max(1, config.defaultRetentionDays),
      maxRetentionDays: Math.max(1, config.maxRetentionDays),
      keepCount: Math.max(1, config.cloudKeepCount),
      protectedCopies: Math.max(0, config.protectedRecoveryCopies),
      source: "managed",
      managedCloud: config.cloudEnabled,
    };
  } catch {
    return { ...SAFE_TENANT_BACKUP_POLICY };
  }
}

/** `tenants/<scope tag>/<artifact>` — derived, never supplied by a request. */
export function tenantObjectPrefix(basePrefix: string, businessId: string): string {
  return `${normalizeKeyPrefix(basePrefix)}tenants/${logicalSnapshotScopeTag(businessId)}/`;
}

export function tenantObjectKey(basePrefix: string, businessId: string, artifactName: string): string {
  const safe = artifactName.replace(/^\/+/, "");
  if (safe.includes("..") || safe.includes("/")) throw new Error("invalid_artifact_name");
  return `${tenantObjectPrefix(basePrefix, businessId)}${safe}`;
}

/**
 * Temporary staging root for uploads, downloads and checkpoints. Everything
 * written here is transient: callers remove their own directory in a `finally`,
 * and `sweepStaging()` clears anything an interrupted process left behind.
 */
export function tenantStagingRoot(): string {
  return process.env.TENANT_BACKUP_STAGING_DIR?.trim() || path.join(process.cwd(), "backups", ".staging");
}

export function tenantStagingDir(businessId: string, suffix: string): string {
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "session";
  return path.join(tenantStagingRoot(), logicalSnapshotScopeTag(businessId), safeSuffix);
}

export async function ensureStagingDir(businessId: string, suffix: string): Promise<string> {
  const dir = tenantStagingDir(businessId, suffix);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Best-effort removal; never throws, because a failed cleanup must not fail a run. */
export async function cleanupStagingDir(businessId: string, suffix: string): Promise<void> {
  await fs.rm(tenantStagingDir(businessId, suffix), { recursive: true, force: true }).catch(() => {});
}

export type ServiceUpdate =
  | {
      ok: true;
      config: TenantBackupServiceConfig;
    }
  | { ok: false; error: string };

export interface ServiceUpdateInput {
  managedCloud?: unknown;
  hybridEnabled?: unknown;
  endpoint?: unknown;
  region?: unknown;
  bucket?: unknown;
  keyPrefix?: unknown;
  accessKeyId?: unknown;
  secretAccessKey?: unknown;
  defaultIntervalHours?: unknown;
  defaultRetentionDays?: unknown;
  maxRetentionDays?: unknown;
  cloudKeepCount?: unknown;
  maxArtifactBytes?: unknown;
  uploadChunkBytes?: unknown;
  maxParallelUploads?: unknown;
  protectedRecoveryCopies?: unknown;
  updatedBy?: string | null;
}

const ALLOWED_INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value ?? "").trim();
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

/**
 * Apply a Superadmin edit. Enabling managed cloud without a complete
 * destination, or without a key-encryption key to seal the credential, is
 * refused: "enabled but unusable" is the state that produces silent failures in
 * the field.
 */
export async function updateTenantBackupService(input: ServiceUpdateInput): Promise<ServiceUpdate> {
  const current = await readTenantBackupService();
  const masterKey = getMasterKey();

  const managedCloud = typeof input.managedCloud === "boolean" ? input.managedCloud : current.managedCloud;
  const hybridEnabled = typeof input.hybridEnabled === "boolean" ? input.hybridEnabled : current.hybridEnabled;
  const endpoint = optionalString(input.endpoint) ?? current.endpoint;
  const region = optionalString(input.region) ?? current.region;
  const bucket = optionalString(input.bucket) ?? current.bucket;
  const accessKeyId = optionalString(input.accessKeyId) ?? current.accessKeyId;
  const secretAccessKey =
    input.secretAccessKey === undefined || input.secretAccessKey === ""
      ? current.secretAccessKey
      : optionalString(input.secretAccessKey) ?? current.secretAccessKey;

  let keyPrefix: string;
  try {
    keyPrefix = normalizeKeyPrefix(optionalString(input.keyPrefix) ?? current.keyPrefix);
  } catch {
    return { ok: false, error: "invalid_key_prefix" };
  }

  const defaultIntervalHours =
    input.defaultIntervalHours === undefined
      ? current.defaultIntervalHours
      : boundedInt(input.defaultIntervalHours, 1, 24);
  if (defaultIntervalHours === null || !ALLOWED_INTERVALS.includes(defaultIntervalHours)) {
    return { ok: false, error: "invalid_interval" };
  }

  const defaultRetentionDays =
    input.defaultRetentionDays === undefined
      ? current.defaultRetentionDays
      : boundedInt(input.defaultRetentionDays, 1, 3650);
  const maxRetentionDays =
    input.maxRetentionDays === undefined
      ? current.maxRetentionDays
      : boundedInt(input.maxRetentionDays, 1, 3650);
  const cloudKeepCount =
    input.cloudKeepCount === undefined ? current.cloudKeepCount : boundedInt(input.cloudKeepCount, 1, 500);
  const maxArtifactBytes =
    input.maxArtifactBytes === undefined
      ? current.maxArtifactBytes
      : boundedInt(input.maxArtifactBytes, 1024, 1_099_511_627_776);
  const uploadChunkBytes =
    input.uploadChunkBytes === undefined
      ? current.uploadChunkBytes
      : boundedInt(input.uploadChunkBytes, 65_536, 268_435_456);
  const maxParallelUploads =
    input.maxParallelUploads === undefined
      ? current.maxParallelUploads
      : boundedInt(input.maxParallelUploads, 1, 16);
  const protectedRecoveryCopies =
    input.protectedRecoveryCopies === undefined
      ? current.protectedRecoveryCopies
      : boundedInt(input.protectedRecoveryCopies, 0, 10);

  if (
    defaultRetentionDays === null ||
    maxRetentionDays === null ||
    cloudKeepCount === null ||
    maxArtifactBytes === null ||
    uploadChunkBytes === null ||
    maxParallelUploads === null ||
    protectedRecoveryCopies === null
  ) {
    return { ok: false, error: "invalid_service_limit" };
  }
  if (defaultRetentionDays > maxRetentionDays) {
    return { ok: false, error: "retention_above_maximum" };
  }

  const complete = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
  if (managedCloud && !complete) return { ok: false, error: "storage_destination_incomplete" };
  if (managedCloud && !masterKey) return { ok: false, error: "key_encryption_unconfigured" };
  if (managedCloud && !/^https?:\/\//i.test(endpoint)) return { ok: false, error: "invalid_endpoint" };

  const sealedAccess = masterKey
    ? sealSecret(masterKey, "access_key", accessKeyId)
    : "";
  const sealedSecret = masterKey
    ? sealSecret(masterKey, "secret_key", secretAccessKey)
    : "";
  // Only the last four characters: enough to answer "is this the key I think it
  // is", never enough to use.
  const hint = accessKeyId ? accessKeyId.slice(-4) : "";

  await withoutTenantScope("tenant-backup-service", async () => {
    await query(
      `INSERT INTO platform_tenant_backup_service
         (id, managed_cloud, hybrid_enabled, endpoint, region, bucket, key_prefix,
          access_key_sealed, secret_key_sealed, access_key_hint,
          default_interval_hours, default_retention_days, max_retention_days,
          cloud_keep_count, max_artifact_bytes, upload_chunk_bytes,
          max_parallel_uploads, protected_recovery_copies, updated_by, updated_at)
       VALUES (true,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())
       ON CONFLICT (id) DO UPDATE SET
         managed_cloud = EXCLUDED.managed_cloud,
         hybrid_enabled = EXCLUDED.hybrid_enabled,
         endpoint = EXCLUDED.endpoint,
         region = EXCLUDED.region,
         bucket = EXCLUDED.bucket,
         key_prefix = EXCLUDED.key_prefix,
         access_key_sealed = EXCLUDED.access_key_sealed,
         secret_key_sealed = EXCLUDED.secret_key_sealed,
         access_key_hint = EXCLUDED.access_key_hint,
         default_interval_hours = EXCLUDED.default_interval_hours,
         default_retention_days = EXCLUDED.default_retention_days,
         max_retention_days = EXCLUDED.max_retention_days,
         cloud_keep_count = EXCLUDED.cloud_keep_count,
         max_artifact_bytes = EXCLUDED.max_artifact_bytes,
         upload_chunk_bytes = EXCLUDED.upload_chunk_bytes,
         max_parallel_uploads = EXCLUDED.max_parallel_uploads,
         protected_recovery_copies = EXCLUDED.protected_recovery_copies,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        managedCloud,
        hybridEnabled,
        endpoint,
        region,
        bucket,
        keyPrefix,
        sealedAccess,
        sealedSecret,
        hint,
        defaultIntervalHours,
        defaultRetentionDays,
        maxRetentionDays,
        cloudKeepCount,
        maxArtifactBytes,
        uploadChunkBytes,
        maxParallelUploads,
        protectedRecoveryCopies,
        input.updatedBy ?? null,
      ],
    );
  });

  return { ok: true, config: await readTenantBackupService() };
}

/**
 * Connectivity check for the console. It lists the managed prefix with a tiny
 * page: an authenticated read proves endpoint + region + key + bucket + prefix
 * together, which is the only check that matters before an operator flips
 * `managedCloud` on.
 */
export async function checkTenantBackupService(): Promise<{
  ok: boolean;
  code: string;
}> {
  const config = await readTenantBackupService();
  const result = await (async (): Promise<{ ok: boolean; code: string }> => {
    if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      return { ok: false, code: "storage_destination_incomplete" };
    }
    try {
      // A single-key list proves endpoint + region + key + bucket + prefix
      // together, and stays O(1) on a bucket with thousands of objects.
      const signed = signS3Request(
        {
          endpoint: config.endpoint,
          region: config.region,
          bucket: config.bucket,
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        {
          method: "GET",
          key: "",
          query: { "list-type": "2", prefix: config.keyPrefix, "max-keys": "1" },
          payloadHash: sha256Hex(""),
        },
      );
      const response = await fetch(signed.url, {
        method: "GET",
        headers: signed.headers,
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        return { ok: false, code: response.status === 403 ? "storage_access_denied" : "storage_unreachable" };
      }
      return { ok: true, code: "ok" };
    } catch (error) {
      // Provider text (endpoint, bucket, request id) never leaves this function.
      const status = (error as { status?: number }).status;
      return { ok: false, code: status === 403 ? "storage_access_denied" : "storage_unreachable" };
    }
  })();

  await withoutTenantScope("tenant-backup-service", async () => {
    await query(
      `UPDATE platform_tenant_backup_service
          SET last_checked_at = now(), last_check_ok = $1, last_error_code = $2
        WHERE id = true`,
      [result.ok, result.ok ? null : result.code],
    );
  });
  return result;
}
