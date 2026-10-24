/**
 * «کتابخانهٔ رسانه» — the half that touches the database and the object
 * store. The decisions are all in `media.ts` (pure, unit-tested); this module
 * only executes them, the same split as platform-backup-service.ts.
 *
 * Security & durability invariants enforced here (issue #926):
 *   • Every object read, write or delete validates tenant storage-key ownership
 *     via `keyBelongsToBusiness` and scopes rows under RLS (`business_id`).
 *   • Folder ownership is verified BEFORE touching object storage, and any DB
 *     write failure after object upload compensates via `s3Delete`.
 *   • Concurrent identical uploads within a tenant serialize on a transaction
 *     advisory lock (`pg_advisory_xact_lock`) over `(business_id, sha256)`.
 *   • Soft-delete clears cached mirror files immediately; protected audit
 *     references (approved/versioned/contract/journal/AEC documents, posted
 *     financial transfers) hard-block both soft-delete and destructive purge;
 *     private workspace document titles are redacted for unauthorized viewers.
 *   • Storage location migrations copy, verify count + byte_size + sha256 on
 *     target storage, preserve source objects, keep dual-read fallback during
 *     transition, and support rollback on demand.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, query, withTenant, withoutTenantScope } from "./db";
import {
  buildMediaKey,
  dailyStorageCharge,
  DEFAULT_MEDIA_CONFIG,
  detectStorageLocationChange,
  isValidMediaUuid,
  keyBelongsToBusiness,
  mediaSearchExpression,
  mediaSortOrderBy,
  MEDIA_STORAGE_FEATURE_KEY,
  MEDIA_TRASH_RETENTION_DAYS,
  normalizeKeyPrefix,
  normalizeSearchTerm,
  type MediaAssetSource,
  type MediaAssetVariant,
  type MediaKind,
  type MediaSort,
  type MediaStorageConfig,
  type MediaTariff,
} from "./media";
import { MediaStorageBusyError } from "./media-errors";
import { purgeMirroredMediaObject } from "./media-mirror";
import {
  presignS3Get,
  s3Delete,
  s3Get,
  s3GetStream,
  s3List,
  s3Put,
  s3PutFile,
  S3RequestError,
  type S3Config,
} from "./s3-lite";
import { chargeFeatureUse, WalletInsufficientFundsError } from "./wallet-service";

// ---------------------------------------------------------------------------
// Typed domain errors
// ---------------------------------------------------------------------------

export class MediaInvalidFolderError extends Error {
  constructor() {
    super("invalid_folder");
    this.name = "MediaInvalidFolderError";
  }
}

export class MediaFolderNotFoundError extends Error {
  constructor() {
    super("folder_not_found");
    this.name = "MediaFolderNotFoundError";
  }
}

export class MediaAssetProtectedError extends Error {
  readonly usage: MediaAssetUsage;
  constructor(usage: MediaAssetUsage) {
    super("asset_protected");
    this.name = "MediaAssetProtectedError";
    this.usage = usage;
  }
}

// ---------------------------------------------------------------------------
// Config (the platform_media_config singleton + dual-read fallback)
// ---------------------------------------------------------------------------

export type MigrationState = "idle" | "migrating" | "completed" | "failed" | "rolled_back";

export interface PreviousStorageFallback {
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ExtendedMediaStorageConfig extends MediaStorageConfig {
  migrationState?: MigrationState;
  previousFallback?: PreviousStorageFallback | null;
}

type ConfigRow = {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  key_prefix: string;
  access_key_id: string;
  secret_access_key: string;
  billing_enabled: boolean;
  daily_flat_rial: string;
  daily_per_gb_rial: string;
  free_quota_mb: number;
  enhance_model: string;
  enhance_price_rial: string;
  previous_endpoint?: string;
  previous_region?: string;
  previous_bucket?: string;
  previous_access_key?: string;
  previous_secret_key?: string;
  previous_key_prefix?: string;
  migration_state?: MigrationState;
};

function rowToConfig(row: ConfigRow | undefined): ExtendedMediaStorageConfig {
  if (!row) return { ...DEFAULT_MEDIA_CONFIG };
  const hasPrevious = Boolean(
    row.previous_endpoint?.trim() &&
      row.previous_bucket?.trim() &&
      row.previous_access_key?.trim() &&
      row.previous_secret_key,
  );
  return {
    enabled: row.enabled,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    keyPrefix: row.key_prefix,
    accessKeyId: row.access_key_id,
    secretAccessKey: row.secret_access_key,
    billingEnabled: row.billing_enabled,
    dailyFlatRial: Number(row.daily_flat_rial),
    dailyPerGbRial: Number(row.daily_per_gb_rial),
    freeQuotaMb: row.free_quota_mb,
    enhanceModel: row.enhance_model,
    enhancePriceRial: Number(row.enhance_price_rial),
    migrationState: row.migration_state ?? "idle",
    previousFallback: hasPrevious
      ? {
          endpoint: row.previous_endpoint!,
          region: row.previous_region || "us-east-1",
          bucket: row.previous_bucket!,
          keyPrefix: row.previous_key_prefix ?? "media/",
          accessKeyId: row.previous_access_key!,
          secretAccessKey: row.previous_secret_key!,
        }
      : null,
  };
}

export async function getMediaConfig(): Promise<ExtendedMediaStorageConfig> {
  const { rows } = await query<ConfigRow>(`SELECT * FROM platform_media_config WHERE id = true`);
  return rowToConfig(rows[0]);
}

export async function saveMediaConfig(config: MediaStorageConfig, adminId: string | null): Promise<void> {
  await query(
    `UPDATE platform_media_config SET
        enabled = $1, endpoint = $2, region = $3, bucket = $4, key_prefix = $5,
        access_key_id = $6, secret_access_key = $7,
        billing_enabled = $8, daily_flat_rial = $9, daily_per_gb_rial = $10, free_quota_mb = $11,
        enhance_model = $12, enhance_price_rial = $13,
        updated_by = $14, updated_at = now()
      WHERE id = true`,
    [
      config.enabled,
      config.endpoint,
      config.region,
      config.bucket,
      config.keyPrefix,
      config.accessKeyId,
      config.secretAccessKey,
      config.billingEnabled,
      config.dailyFlatRial,
      config.dailyPerGbRial,
      config.freeQuotaMb,
      config.enhanceModel,
      config.enhancePriceRial,
      adminId,
    ],
  );
  await publishMediaPrices(config, adminId);
}

/**
 * Save ONLY the customer-facing tariff — the Billing rates console's write
 * path (migration 0176). The technical connection (endpoint/bucket/keys) is
 * untouched here; /platform/media's own save no longer accepts these fields.
 */
export async function saveMediaTariff(
  tariff: MediaTariff,
  adminId: string | null,
): Promise<void> {
  await query(
    `UPDATE platform_media_config SET
        billing_enabled = $1, daily_flat_rial = $2, daily_per_gb_rial = $3,
        free_quota_mb = $4, enhance_price_rial = $5,
        updated_by = $6, updated_at = now()
      WHERE id = true`,
    [
      tariff.billingEnabled,
      tariff.dailyFlatRial,
      tariff.dailyPerGbRial,
      tariff.freeQuotaMb,
      tariff.enhancePriceRial,
      adminId,
    ],
  );
  await publishMediaPrices(tariff, adminId);
}

async function publishMediaPrices(
  tariff: Pick<MediaStorageConfig, "billingEnabled" | "dailyFlatRial" | "dailyPerGbRial" | "freeQuotaMb" | "enhancePriceRial">,
  adminId: string | null,
): Promise<void> {
  const { publishPriceVersion } = await import("./billing/runtime");
  await publishPriceVersion({
    targetType: "meter",
    targetKey: "media.storage_byte_hour",
    unit: "byte_hour",
    unitAmountRial: Math.max(0, Math.floor(tariff.dailyFlatRial)),
    metadata: {
      dailyFlatRial: tariff.dailyFlatRial,
      dailyPerGbRial: tariff.dailyPerGbRial,
      freeQuotaMb: tariff.freeQuotaMb,
      billingEnabled: tariff.billingEnabled,
    },
    createdBy: adminId,
  });
  await publishPriceVersion({
    targetType: "meter",
    targetKey: "media.image_enhance",
    unit: "image",
    unitAmountRial: Math.max(0, Math.floor(tariff.enhancePriceRial)),
    createdBy: adminId,
  });
}

function s3ConfigOf(config: Pick<MediaStorageConfig, "endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey">): S3Config {
  return {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
}

function rewriteKeyPrefix(key: string, fromPrefix: string, toPrefix: string): string {
  const fromNorm = normalizeKeyPrefix(fromPrefix);
  const toNorm = normalizeKeyPrefix(toPrefix);
  if (fromNorm === toNorm) return key;
  if (key.startsWith(fromNorm)) return `${toNorm}${key.slice(fromNorm.length)}`;
  return key;
}

/** Ready to store: switched on with a complete connection. */
export function isMediaStorageReady(config: MediaStorageConfig): boolean {
  return config.enabled && Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey);
}

// ---------------------------------------------------------------------------
// Storage Migration & Audit Trail (Issue #926 P1.5)
// ---------------------------------------------------------------------------

export interface StoredMediaCountSummary {
  totalAssets: number;
  activeAssets: number;
  trashedAssets: number;
  totalBytes: number;
}

export async function countAllStoredMediaAssets(): Promise<StoredMediaCountSummary> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      total_assets: string;
      active_assets: string;
      trashed_assets: string;
      total_bytes: string;
    }>(
      `SELECT COUNT(*) AS total_assets,
              COUNT(*) FILTER (WHERE deleted_at IS NULL) AS active_assets,
              COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS trashed_assets,
              COALESCE(SUM(byte_size), 0) AS total_bytes
         FROM media_assets`,
    );
    const r = rows[0];
    return {
      totalAssets: Number(r?.total_assets ?? 0),
      activeAssets: Number(r?.active_assets ?? 0),
      trashedAssets: Number(r?.trashed_assets ?? 0),
      totalBytes: Number(r?.total_bytes ?? 0),
    };
  });
}

export type MediaMigrationAuditAction =
  | "config_saved"
  | "location_change_blocked"
  | "migration_started"
  | "migration_verified"
  | "migration_completed"
  | "migration_failed"
  | "migration_rolled_back";

export interface MediaMigrationAuditRecord {
  id: string;
  actorEmail: string;
  action: MediaMigrationAuditAction;
  status: "running" | "verified" | "completed" | "failed" | "rolled_back" | "blocked";
  sourceSummary: Record<string, unknown>;
  targetSummary: Record<string, unknown>;
  totalAssets: number;
  copiedAssets: number;
  verifiedAssets: number;
  totalBytes: number;
  errorDetail: string | null;
  createdAt: string;
  completedAt: string | null;
}

function summarizeLocationPublic(cfg: Pick<MediaStorageConfig, "endpoint" | "region" | "bucket" | "keyPrefix" | "enabled">) {
  // Never store access/secret credentials inside audit rows.
  return {
    enabled: cfg.enabled,
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    keyPrefix: normalizeKeyPrefix(cfg.keyPrefix),
  };
}

export async function recordMediaMigrationAudit(input: {
  actorEmail: string;
  action: MediaMigrationAuditAction;
  status: MediaMigrationAuditRecord["status"];
  sourceSummary?: Record<string, unknown>;
  targetSummary?: Record<string, unknown>;
  totalAssets?: number;
  copiedAssets?: number;
  verifiedAssets?: number;
  totalBytes?: number;
  errorDetail?: string | null;
  completed?: boolean;
}): Promise<string | null> {
  try {
    const { rows } = await withoutTenantScope("platform", () =>
      query<{ id: string }>(
        `INSERT INTO platform_media_migrations
           (actor_email, action, status, source_summary, target_summary,
            total_assets, copied_assets, verified_assets, total_bytes, error_detail, completed_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, CASE WHEN $11::boolean THEN now() ELSE NULL END)
         RETURNING id`,
        [
          input.actorEmail || "superadmin",
          input.action,
          input.status,
          JSON.stringify(input.sourceSummary ?? {}),
          JSON.stringify(input.targetSummary ?? {}),
          input.totalAssets ?? 0,
          input.copiedAssets ?? 0,
          input.verifiedAssets ?? 0,
          input.totalBytes ?? 0,
          input.errorDetail ?? null,
          Boolean(input.completed),
        ],
      ),
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function listMediaMigrationAudits(limit = 15): Promise<MediaMigrationAuditRecord[]> {
  try {
    const { rows } = await withoutTenantScope("platform", () =>
      query<{
        id: string;
        actor_email: string;
        action: MediaMigrationAuditAction;
        status: MediaMigrationAuditRecord["status"];
        source_summary: Record<string, unknown>;
        target_summary: Record<string, unknown>;
        total_assets: number;
        copied_assets: number;
        verified_assets: number;
        total_bytes: string;
        error_detail: string | null;
        created_at: string;
        completed_at: string | null;
      }>(
        `SELECT id, actor_email, action, status, source_summary, target_summary,
                total_assets, copied_assets, verified_assets, total_bytes::text,
                error_detail, created_at, completed_at
           FROM platform_media_migrations
          ORDER BY created_at DESC
          LIMIT $1`,
        [Math.min(Math.max(1, limit), 100)],
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      actorEmail: r.actor_email,
      action: r.action,
      status: r.status,
      sourceSummary: r.source_summary ?? {},
      targetSummary: r.target_summary ?? {},
      totalAssets: r.total_assets,
      copiedAssets: r.copied_assets,
      verifiedAssets: r.verified_assets,
      totalBytes: Number(r.total_bytes),
      errorDetail: r.error_detail,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }));
  } catch {
    return [];
  }
}

export type StorageMigrationOutcome =
  | {
      ok: true;
      totalAssets: number;
      copiedAssets: number;
      verifiedAssets: number;
      totalBytes: number;
    }
  | {
      ok: false;
      error: string;
      detail: string;
      totalAssets: number;
      copiedAssets: number;
      verifiedAssets: number;
    };

/**
 * Safe, verified storage location migration workflow:
 *   1. Probes target connectivity with write + delete self-check.
 *   2. Copies every `media_assets` object from active source to target storage.
 *   3. Independently reads back EVERY copied object from target storage and
 *      verifies object count, exact `byte_size`, and cryptographic `sha256`.
 *   4. Only after 100% target verification succeeds does it atomically switch
 *      `platform_media_config` while retaining source credentials in
 *      `previous_*` columns for dual-read fallback and instant rollback.
 *   5. Source objects are NEVER deleted automatically during or after migration.
 */
/**
 * Issue #1080 (P1.7): serialize the destructive-ish storage workflows.
 *
 * Two concurrent migrations (a double-clicked button, two operators, a retry
 * while the first is still copying) each read the asset list, copy, verify and
 * then cut the configuration over — the second would rewrite `storage_key`s to
 * a prefix the first never verified. A session-level advisory lock makes the
 * second request an explicit, cheap "already running" answer instead.
 */
const MEDIA_MIGRATION_LOCK = "biza-miz:media-storage-migration";

async function acquireMediaMigrationLock(): Promise<{ release: () => Promise<void> } | null> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked`,
      [MEDIA_MIGRATION_LOCK],
    );
    if (!rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }
  return {
    release: async () => {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [MEDIA_MIGRATION_LOCK]).catch(() => {});
      client.release();
    },
  };
}

export async function migrateMediaStorage(input: {
  actorEmail: string;
  adminId: string | null;
  target: MediaStorageConfig;
}): Promise<StorageMigrationOutcome> {
  const lock = await acquireMediaMigrationLock();
  if (!lock) {
    return {
      ok: false,
      error: "migration_in_progress",
      detail: "یک فرایند مهاجرت دیگر در حال اجراست؛ تا پایان آن دوباره تلاش نکنید.",
      totalAssets: 0,
      copiedAssets: 0,
      verifiedAssets: 0,
    };
  }
  try {
    return await migrateMediaStorageLocked(input);
  } finally {
    await lock.release();
  }
}

async function migrateMediaStorageLocked(input: {
  actorEmail: string;
  adminId: string | null;
  target: MediaStorageConfig;
}): Promise<StorageMigrationOutcome> {
  const source = await withoutTenantScope("platform", () => getMediaConfig());
  const sourceS3 = s3ConfigOf(source);
  const targetS3 = s3ConfigOf(input.target);
  const sourceSummary = summarizeLocationPublic(source);
  const targetSummary = summarizeLocationPublic(input.target);

  // 1. Target connectivity probe before touching any object.
  const probeKey = `${normalizeKeyPrefix(input.target.keyPrefix)}.migration-probe-${Date.now()}`;
  const probeBody = Buffer.from("biza-miz-media-migration-probe", "utf8");
  try {
    await s3Put(targetS3, probeKey, probeBody);
    const probeRead = await s3Get(targetS3, probeKey);
    await s3Delete(targetS3, probeKey).catch(() => {});
    if (!probeRead.equals(probeBody)) {
      return {
        ok: false,
        error: "target_probe_mismatch",
        detail: "بررسی یکپارچگی اتصال مقصد ناموفق بود.",
        totalAssets: 0,
        copiedAssets: 0,
        verifiedAssets: 0,
      };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await recordMediaMigrationAudit({
      actorEmail: input.actorEmail,
      action: "migration_failed",
      status: "failed",
      sourceSummary,
      targetSummary,
      errorDetail: `target_unreachable: ${detail}`,
      completed: true,
    });
    return {
      ok: false,
      error: "target_unreachable",
      detail,
      totalAssets: 0,
      copiedAssets: 0,
      verifiedAssets: 0,
    };
  }

  const assetRows = await withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      id: string;
      business_id: string;
      storage_key: string;
      byte_size: string;
      sha256: string;
    }>(`SELECT id, business_id, storage_key, byte_size::text, sha256 FROM media_assets ORDER BY created_at ASC`);
    return rows;
  });

  const totalAssets = assetRows.length;
  const totalBytes = assetRows.reduce((sum, r) => sum + Number(r.byte_size), 0);

  await withoutTenantScope("platform", () =>
    query(`UPDATE platform_media_config SET migration_state = 'migrating', updated_at = now() WHERE id = true`),
  );
  await recordMediaMigrationAudit({
    actorEmail: input.actorEmail,
    action: "migration_started",
    status: "running",
    sourceSummary,
    targetSummary,
    totalAssets,
    totalBytes,
  });

  const newlyWrittenTargetKeys: string[] = [];
  const plannedKeyRewrites: { id: string; nextKey: string; expectedBytes: number; expectedSha256: string }[] = [];
  let copiedAssets = 0;
  let verifiedAssets = 0;

  const samePhysicalBucket =
    source.endpoint.trim().replace(/\/+$/, "") === input.target.endpoint.trim().replace(/\/+$/, "") &&
    source.bucket.trim() === input.target.bucket.trim();

  try {
    // 2. Copy all existing objects to target storage (never deleting source objects).
    for (const row of assetRows) {
      if (!keyBelongsToBusiness(row.storage_key, source.keyPrefix, row.business_id)) {
        throw new Error(`invalid_source_key:${row.id}`);
      }
      const nextKey = rewriteKeyPrefix(row.storage_key, source.keyPrefix, input.target.keyPrefix);
      const sourceBytes = await s3Get(sourceS3, row.storage_key);
      const sourceSha = createHash("sha256").update(sourceBytes).digest("hex");
      if (sourceBytes.byteLength !== Number(row.byte_size) || sourceSha !== row.sha256) {
        throw new Error(`source_integrity_mismatch:${row.id}`);
      }
      if (!(samePhysicalBucket && nextKey === row.storage_key)) {
        await s3Put(targetS3, nextKey, sourceBytes);
        newlyWrittenTargetKeys.push(nextKey);
      }
      plannedKeyRewrites.push({
        id: row.id,
        nextKey,
        expectedBytes: Number(row.byte_size),
        expectedSha256: row.sha256,
      });
      copiedAssets += 1;
    }

    // 3. Verify EVERY object on target storage (count, byte_size, sha256).
    for (const item of plannedKeyRewrites) {
      const targetBytes = await s3Get(targetS3, item.nextKey);
      const targetSha = createHash("sha256").update(targetBytes).digest("hex");
      if (targetBytes.byteLength !== item.expectedBytes || targetSha !== item.expectedSha256) {
        throw new Error(`target_verification_failed:${item.id}`);
      }
      verifiedAssets += 1;
    }

    if (verifiedAssets !== totalAssets) {
      throw new Error(`count_verification_failed:${verifiedAssets}/${totalAssets}`);
    }

    // 4. Atomic DB cutover preserving source credentials for dual-read + rollback.
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.rls_bypass', 'on', true)");
      for (const item of plannedKeyRewrites) {
        await client.query(
          `UPDATE media_assets SET storage_key = $2 WHERE id = $1 AND storage_key IS DISTINCT FROM $2`,
          [item.id, item.nextKey],
        );
      }
      await client.query(
        `UPDATE platform_media_config SET
            previous_endpoint = $1,
            previous_region = $2,
            previous_bucket = $3,
            previous_access_key = $4,
            previous_secret_key = $5,
            previous_key_prefix = $6,
            enabled = $7,
            endpoint = $8,
            region = $9,
            bucket = $10,
            key_prefix = $11,
            access_key_id = $12,
            secret_access_key = $13,
            enhance_model = $14,
            migration_state = 'completed',
            updated_by = $15,
            updated_at = now()
          WHERE id = true`,
        [
          source.endpoint,
          source.region,
          source.bucket,
          source.accessKeyId,
          source.secretAccessKey,
          source.keyPrefix,
          input.target.enabled,
          input.target.endpoint,
          input.target.region,
          input.target.bucket,
          input.target.keyPrefix,
          input.target.accessKeyId,
          input.target.secretAccessKey,
          input.target.enhanceModel,
          input.adminId,
        ],
      );
      await client.query("COMMIT");
    } catch (dbErr) {
      await client.query("ROLLBACK").catch(() => {});
      throw dbErr;
    } finally {
      client.release();
    }

    await withoutTenantScope("platform", () => publishMediaPrices(input.target, input.adminId));
    await recordMediaMigrationAudit({
      actorEmail: input.actorEmail,
      action: "migration_completed",
      status: "completed",
      sourceSummary,
      targetSummary,
      totalAssets,
      copiedAssets,
      verifiedAssets,
      totalBytes,
      completed: true,
    });

    return { ok: true, totalAssets, copiedAssets, verifiedAssets, totalBytes };
  } catch (err) {
    // Clean up ONLY newly written objects on target — NEVER delete anything in source!
    for (const targetKey of newlyWrittenTargetKeys) {
      await s3Delete(targetS3, targetKey).catch(() => {});
    }
    const detail = err instanceof Error ? err.message : String(err);
    await withoutTenantScope("platform", () =>
      query(`UPDATE platform_media_config SET migration_state = 'failed', updated_at = now() WHERE id = true`),
    ).catch(() => {});
    await recordMediaMigrationAudit({
      actorEmail: input.actorEmail,
      action: "migration_failed",
      status: "failed",
      sourceSummary,
      targetSummary,
      totalAssets,
      copiedAssets,
      verifiedAssets,
      totalBytes,
      errorDetail: detail,
      completed: true,
    });
    return {
      ok: false,
      error: "migration_verification_failed",
      detail,
      totalAssets,
      copiedAssets,
      verifiedAssets,
    };
  }
}

/**
 * Roll back active storage config to the preserved pre-migration source after
 * re-verifying every stored asset on the previous storage location.
 */
export async function rollbackMediaStorage(input: {
  actorEmail: string;
  adminId: string | null;
}): Promise<{ ok: true; verifiedAssets: number } | { ok: false; error: string; detail: string }> {
  const lock = await acquireMediaMigrationLock();
  if (!lock) {
    return {
      ok: false,
      error: "migration_in_progress",
      detail: "یک فرایند مهاجرت دیگر در حال اجراست؛ تا پایان آن دوباره تلاش نکنید.",
    };
  }
  try {
    return await rollbackMediaStorageLocked(input);
  } finally {
    await lock.release();
  }
}

async function rollbackMediaStorageLocked(input: {
  actorEmail: string;
  adminId: string | null;
}): Promise<{ ok: true; verifiedAssets: number } | { ok: false; error: string; detail: string }> {
  const current = await withoutTenantScope("platform", () => getMediaConfig());
  const prev = current.previousFallback;
  if (!prev) {
    return { ok: false, error: "no_previous_storage", detail: "پیکربندی قبلی برای بازگشت ثبت نشده است." };
  }
  const prevS3: S3Config = {
    endpoint: prev.endpoint,
    region: prev.region,
    bucket: prev.bucket,
    accessKeyId: prev.accessKeyId,
    secretAccessKey: prev.secretAccessKey,
  };
  const assetRows = await withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      id: string;
      storage_key: string;
      byte_size: string;
      sha256: string;
    }>(`SELECT id, storage_key, byte_size::text, sha256 FROM media_assets`);
    return rows;
  });

  const restoredKeys: { id: string; prevKey: string }[] = [];
  try {
    for (const row of assetRows) {
      const prevKey = rewriteKeyPrefix(row.storage_key, current.keyPrefix, prev.keyPrefix);
      const bytes = await s3Get(prevS3, prevKey);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== Number(row.byte_size) || sha !== row.sha256) {
        throw new Error(`rollback_source_missing_or_corrupt:${row.id}`);
      }
      restoredKeys.push({ id: row.id, prevKey });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "rollback_verification_failed", detail };
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");
    for (const item of restoredKeys) {
      await client.query(
        `UPDATE media_assets SET storage_key = $2 WHERE id = $1 AND storage_key IS DISTINCT FROM $2`,
        [item.id, item.prevKey],
      );
    }
    await client.query(
      `UPDATE platform_media_config SET
          endpoint = $1,
          region = $2,
          bucket = $3,
          key_prefix = $4,
          access_key_id = $5,
          secret_access_key = $6,
          migration_state = 'rolled_back',
          updated_by = $7,
          updated_at = now()
        WHERE id = true`,
      [
        prev.endpoint,
        prev.region,
        prev.bucket,
        prev.keyPrefix,
        prev.accessKeyId,
        prev.secretAccessKey,
        input.adminId,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await recordMediaMigrationAudit({
    actorEmail: input.actorEmail,
    action: "migration_rolled_back",
    status: "rolled_back",
    sourceSummary: summarizeLocationPublic(current),
    targetSummary: {
      enabled: current.enabled,
      endpoint: prev.endpoint,
      region: prev.region,
      bucket: prev.bucket,
      keyPrefix: normalizeKeyPrefix(prev.keyPrefix),
    },
    totalAssets: assetRows.length,
    copiedAssets: 0,
    verifiedAssets: assetRows.length,
    completed: true,
  });

  return { ok: true, verifiedAssets: assetRows.length };
}

export { detectStorageLocationChange };

// ---------------------------------------------------------------------------
// Assets — upload / read / organize / delete
// ---------------------------------------------------------------------------

export type MediaAssetRecord = {
  id: string;
  folderId: string | null;
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  byteSize: number;
  category: string | null;
  tags: string[];
  aiStatus: "none" | "pending_review" | "confirmed" | "rejected";
  aiLabels: Record<string, unknown>;
  variant: MediaAssetVariant;
  sourceAssetId: string | null;
  /** Phase G — how the asset entered the library. */
  source: MediaAssetSource;
  /** Phase G — true when the assistant, not a person, authored the bytes. */
  createdByAi: boolean;
  /** Phase G — the chat this asset came from, if any. */
  conversationId: string | null;
  /** Phase G — the project workspace this asset belongs to, if any. */
  projectId: string | null;
  createdAt: string;
  /** Phase 2 — soft delete: set when the asset is in the trash, else null. */
  deletedAt: string | null;
  /** Migration 0175 — the deterministic transform(s) that produced this asset. */
  transformOps: unknown[];
};

type AssetRow = {
  id: string;
  folder_id: string | null;
  kind: MediaKind;
  file_name: string;
  mime_type: string;
  byte_size: string;
  category: string | null;
  tags: string[];
  ai_status: MediaAssetRecord["aiStatus"];
  ai_labels: Record<string, unknown>;
  variant: MediaAssetRecord["variant"];
  source_asset_id: string | null;
  source: MediaAssetRecord["source"];
  created_by_ai: boolean;
  conversation_id: string | null;
  project_id: string | null;
  created_at: string;
  deleted_at: string | null;
  transform_ops: unknown[];
};

const ASSET_COLUMNS =
  "id, folder_id, kind, file_name, mime_type, byte_size, category, tags, ai_status, ai_labels, variant, source_asset_id, source, created_by_ai, conversation_id, project_id, created_at, deleted_at, transform_ops";

function rowToAsset(row: AssetRow): MediaAssetRecord {
  return {
    id: row.id,
    folderId: row.folder_id,
    kind: row.kind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    category: row.category,
    tags: row.tags ?? [],
    aiStatus: row.ai_status,
    aiLabels: row.ai_labels ?? {},
    variant: row.variant,
    sourceAssetId: row.source_asset_id,
    source: row.source,
    createdByAi: row.created_by_ai,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    transformOps: row.transform_ops ?? [],
  };
}

export interface MediaListFilter {
  folderId?: string | null | "any";
  kind?: MediaKind;
  excludeMime?: string[];
  category?: string;
  tag?: string;
  search?: string;
  aiStatus?: MediaAssetRecord["aiStatus"];
  /** Phase G — the workspace reads: a conversation's / a project's files. */
  conversationId?: string;
  projectId?: string;
  /** How the asset entered the library — upload / ai_attachment / ai_generated. */
  source?: MediaAssetRecord["source"];
  /**
   * Trash visibility. Default `false` — the library view never shows a
   * soft-deleted asset. `true` flips it around for the trash view: only
   * soft-deleted assets, so an operator can restore or purge them.
   */
  trashed?: boolean;
  /** Only assets belonging to this collection (media_collection_items). */
  collectionId?: string;
  /** Newest first by default; see `MEDIA_SORTS` for the full set. */
  sort?: MediaSort;
  limit?: number;
  offset?: number;
}

/** The business's assets, filtered. RLS scopes the rows; this only narrows. */
export async function listMediaAssets(businessId: string, filter: MediaListFilter = {}) {
  const where: string[] = ["business_id = $1"];
  const params: unknown[] = [businessId];
  let i = 1;
  where.push(filter.trashed ? "deleted_at IS NOT NULL" : "deleted_at IS NULL");
  if (filter.collectionId) {
    params.push(filter.collectionId);
    where.push(`id IN (SELECT asset_id FROM media_collection_items WHERE collection_id = $${++i})`);
  }
  if (filter.folderId !== "any" && filter.folderId !== undefined) {
    if (filter.folderId === null) where.push("folder_id IS NULL");
    else {
      params.push(filter.folderId);
      where.push(`folder_id = $${++i}`);
    }
  }
  if (filter.kind) {
    params.push(filter.kind);
    where.push(`kind = $${++i}`);
  }
  if (filter.excludeMime && filter.excludeMime.length > 0) {
    params.push(filter.excludeMime);
    where.push(`NOT (mime_type = ANY($${++i}::text[]))`);
  }
  if (filter.category) {
    params.push(filter.category);
    where.push(`category = $${++i}`);
  }
  if (filter.tag) {
    params.push(filter.tag);
    where.push(`$${++i} = ANY(tags)`);
  }
  if (filter.aiStatus) {
    params.push(filter.aiStatus);
    where.push(`ai_status = $${++i}`);
  }
  if (filter.conversationId) {
    params.push(filter.conversationId);
    where.push(`conversation_id = $${++i}`);
  }
  if (filter.projectId) {
    params.push(filter.projectId);
    where.push(`project_id = $${++i}`);
  }
  if (filter.source) {
    params.push(filter.source);
    where.push(`source = $${++i}`);
  }
  if (filter.search) {
    const normalized = normalizeSearchTerm(filter.search);
    if (normalized) {
      params.push(`%${normalized}%`);
      const fileExpr = mediaSearchExpression("file_name");
      const categoryExpr = mediaSearchExpression("category");
      const tagExpr = mediaSearchExpression("t");
      where.push(
        `(${fileExpr} ILIKE $${++i} OR ${categoryExpr} ILIKE $${i} OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE ${tagExpr} ILIKE $${i}))`,
      );
    }
  }
  const limit = Math.min(Math.max(1, filter.limit ?? 60), 200);
  const offset = Math.max(0, filter.offset ?? 0);
  params.push(limit, offset);
  const { rows } = await query<AssetRow & { total: string }>(
    `SELECT ${ASSET_COLUMNS}, COUNT(*) OVER() AS total
       FROM media_assets
      WHERE ${where.join(" AND ")}
      ORDER BY ${mediaSortOrderBy(filter.sort)}, id DESC
      LIMIT $${++i} OFFSET $${++i}`,
    params,
  );
  return { assets: rows.map(rowToAsset), total: rows.length ? Number(rows[0].total) : 0 };
}

// ---------------------------------------------------------------------------
// Duplicate detection — tenant-scoped, by the bytes' own sha256
// ---------------------------------------------------------------------------

export async function findMediaAssetByHash(businessId: string, sha256: string): Promise<MediaAssetRecord | null> {
  const { rows } = await query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM media_assets
      WHERE business_id = $1 AND sha256 = $2 AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1`,
    [businessId, sha256],
  );
  return rows[0] ? rowToAsset(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Usage references — complete cross-module consumer & audit protection check
// ---------------------------------------------------------------------------

export interface MediaAssetUsageRef {
  id: string;
  name: string;
  slot?: string;
  protected?: boolean;
  protectedReason?: string;
  protectedMessage?: string;
  redacted?: boolean;
  [key: string]: unknown;
}

export interface ProtectedMediaUsageItem {
  kind: "workspace_document" | "financial_transfer";
  id: string;
  name: string;
  reason: string;
  message: string;
  redacted?: boolean;
}

export interface MediaAssetUsage {
  menuItems: MediaAssetUsageRef[];
  inventoryItems: MediaAssetUsageRef[];
  products?: MediaAssetUsageRef[];
  expenses: MediaAssetUsageRef[];
  purchases: MediaAssetUsageRef[];
  parties: MediaAssetUsageRef[];
  vehicles: MediaAssetUsageRef[];
  workspaceDocuments?: MediaAssetUsageRef[];
  transfers?: MediaAssetUsageRef[];
  protectedItems?: ProtectedMediaUsageItem[];
  hasProtected?: boolean;
  replaceableCount?: number;
  total?: number;
}

export interface MediaAssetUsageOptions {
  /** Authenticated viewer user ID; used to redact private Workspace document titles. */
  viewerUserId?: string | null;
  /** True when viewer holds workspace override (`workspaceAdmin` / owner override). */
  viewerOverride?: boolean;
}

export async function mediaAssetUsedByVehicleInLocations(
  assetId: string,
  businessId: string,
  locationIds: readonly string[],
): Promise<boolean> {
  if (locationIds.length === 0) return false;
  const { rows } = await query<{ linked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM automotive_vehicle_media vm
         JOIN automotive_vehicle_attributes v
           ON v.business_id = vm.business_id AND v.serial_id = vm.serial_id
        WHERE vm.business_id = $1 AND vm.media_asset_id = $2
          AND v.location_id = ANY($3::uuid[])
     ) AS linked`,
    [businessId, assetId, [...locationIds]],
  );
  return rows[0]?.linked === true;
}

function classifyProtectedWorkspaceDoc(row: {
  status: string;
  version: number;
  is_superseded: boolean;
  contract_id: string | null;
  journal_entry_id: string | null;
  has_aec_link: boolean;
  has_aec_revision: boolean;
}): { protected: boolean; reason?: string; message?: string } {
  if (row.has_aec_revision || row.has_aec_link) {
    return {
      protected: true,
      reason: "aec_record",
      message: "این فایل به مدارک مهندسی، بازنگری نقشه یا گزارش کارگاهی متصل است و قابل حذف نیست.",
    };
  }
  if (row.journal_entry_id) {
    return {
      protected: true,
      reason: "journal_attachment",
      message: "این فایل پیوست سند حسابداری است و برای حفظ زنجیرهٔ حسابرسی قابل حذف نیست.",
    };
  }
  if (row.contract_id) {
    return {
      protected: true,
      reason: "contract_attachment",
      message: "این فایل به قرارداد ثبت‌شده در فضای کار متصل است و قابل حذف نیست.",
    };
  }
  if (row.status !== "draft") {
    return {
      protected: true,
      reason: "controlled_document",
      message: "این فایل متعلق به سند در جریان بررسی، تأییدشده یا بایگانی‌شده است و قابل حذف نیست.",
    };
  }
  if (row.version > 1 || row.is_superseded) {
    return {
      protected: true,
      reason: "version_history",
      message: "این فایل بخشی از تاریخچهٔ نسخه‌های سند است و قابل حذف نیست.",
    };
  }
  return { protected: false };
}

export async function getMediaAssetUsage(
  assetId: string,
  options?: MediaAssetUsageOptions,
): Promise<MediaAssetUsage> {
  const enforceViewerPrivacy = Boolean(options && "viewerUserId" in options);
  const viewerUserId = options?.viewerUserId ?? null;
  const viewerOverride = Boolean(options?.viewerOverride);

  const [
    { rows: menuItems },
    { rows: inventoryItems },
    { rows: productRows },
    { rows: expenses },
    { rows: purchases },
    { rows: parties },
    { rows: vehicles },
    { rows: rawWorkspaceDocs },
    { rows: rawTransfers },
  ] = await Promise.all([
    query<MediaAssetUsageRef>(`SELECT id, name FROM menu_items WHERE image_media_id = $1 ORDER BY name`, [assetId]),
    query<MediaAssetUsageRef>(`SELECT id, name FROM inventory_items WHERE image_media_id = $1 ORDER BY name`, [
      assetId,
    ]),
    query<{ id: string; name: string; slot: string }>(
      `SELECT it.id,
              CASE
                WHEN it.parent_item_id IS NOT NULL THEN COALESCE(parent.name || ' — ' || it.name, it.name)
                ELSE it.name
              END AS name,
              CASE
                WHEN it.parent_item_id IS NOT NULL THEN 'variant'
                ELSE 'cover'
              END AS slot
         FROM items it
         LEFT JOIN items parent ON parent.id = it.parent_item_id
        WHERE it.image_media_id = $1
       UNION ALL
       SELECT it.id,
              it.name,
              'gallery' AS slot
         FROM item_media im
         JOIN items it ON it.id = im.item_id
        WHERE im.media_asset_id = $1
        ORDER BY name`,
      [assetId],
    ).catch(() => ({ rows: [] as { id: string; name: string; slot: string }[] })),
    query<MediaAssetUsageRef>(
      `SELECT id, memo AS name FROM expenses WHERE receipt_asset_id = $1 ORDER BY expense_date DESC`,
      [assetId],
    ),
    query<MediaAssetUsageRef>(
      `SELECT id, COALESCE(NULLIF(note, ''), id::text) AS name FROM purchases WHERE invoice_asset_id = $1
        ORDER BY purchase_date DESC`,
      [assetId],
    ),
    query<MediaAssetUsageRef>(`SELECT id, name FROM parties WHERE profile_image_asset_id = $1 ORDER BY name`, [
      assetId,
    ]),
    query<MediaAssetUsageRef>(
      `SELECT v.serial_id AS id, v.stock_number || ' — ' || v.make || ' ' || v.model AS name
         FROM automotive_vehicle_media vm
         JOIN automotive_vehicle_attributes v
           ON v.business_id = vm.business_id AND v.serial_id = vm.serial_id
        WHERE vm.media_asset_id = $1 ORDER BY v.stock_number`,
      [assetId],
    ),
    query<{
      id: string;
      title: string;
      status: string;
      version: number;
      project_id: string | null;
      created_by: string | null;
      contract_id: string | null;
      journal_entry_id: string | null;
      is_superseded: boolean;
      has_aec_link: boolean;
      has_aec_revision: boolean;
      viewer_is_member: boolean;
    }>(
      `SELECT wd.id,
              wd.title,
              wd.status,
              wd.version,
              wd.project_id,
              wd.created_by,
              wd.contract_id,
              wd.journal_entry_id,
              EXISTS (
                SELECT 1 FROM workspace_documents newer
                 WHERE newer.supersedes_id = wd.id
              ) AS is_superseded,
              (
                wd.rfi_id IS NOT NULL
                OR wd.submittal_id IS NOT NULL
                OR wd.site_log_id IS NOT NULL
                OR wd.site_issue_id IS NOT NULL
                OR wd.variation_id IS NOT NULL
                OR wd.payment_certificate_id IS NOT NULL
                OR wd.commitment_id IS NOT NULL
              ) AS has_aec_link,
              EXISTS (
                SELECT 1 FROM aec_document_revisions adr
                 WHERE adr.workspace_document_id = wd.id
              ) AS has_aec_revision,
              CASE
                WHEN $2::uuid IS NULL OR wd.project_id IS NULL THEN false
                ELSE EXISTS (
                  SELECT 1 FROM workspace_members wm
                   WHERE wm.project_id = wd.project_id AND wm.user_id = $2::uuid
                )
              END AS viewer_is_member
         FROM workspace_documents wd
        WHERE wd.media_asset_id = $1
        ORDER BY wd.created_at DESC`,
      [assetId, viewerUserId && isValidMediaUuid(viewerUserId) ? viewerUserId : null],
    ).catch(() => ({ rows: [] })),
    query<{ id: string; transfer_number: string; status: string }>(
      `SELECT id, transfer_number, status
         FROM financial_transfers
        WHERE attachment_asset_id = $1
        ORDER BY transfer_date DESC`,
      [assetId],
    ).catch(() => ({ rows: [] })),
  ]);

  const protectedItems: ProtectedMediaUsageItem[] = [];

  const workspaceDocuments: MediaAssetUsageRef[] = rawWorkspaceDocs.map((doc) => {
    const canSeeTitle =
      !enforceViewerPrivacy ||
      viewerOverride ||
      (doc.project_id !== null
        ? doc.viewer_is_member
        : Boolean(viewerUserId && doc.created_by === viewerUserId));
    const displayName = canSeeTitle ? doc.title : "سند خصوصی فضای کار";
    const redacted = !canSeeTitle;
    const protection = classifyProtectedWorkspaceDoc(doc);
    if (protection.protected) {
      protectedItems.push({
        kind: "workspace_document",
        id: doc.id,
        name: displayName,
        reason: protection.reason!,
        message: protection.message!,
        redacted,
      });
    }
    return {
      id: doc.id,
      name: displayName,
      status: doc.status,
      version: doc.version,
      protected: protection.protected,
      protectedReason: protection.reason,
      protectedMessage: protection.message,
      redacted,
    };
  });

  const transfers: MediaAssetUsageRef[] = rawTransfers.map((tr) => {
    const message = "این فایل پیوست انتقال مالی ثبت‌شده در دفاتر حسابداری است و قابل حذف نیست.";
    protectedItems.push({
      kind: "financial_transfer",
      id: tr.id,
      name: tr.transfer_number,
      reason: "posted_financial_transfer",
      message,
    });
    return {
      id: tr.id,
      name: tr.transfer_number,
      status: tr.status,
      protected: true,
      protectedReason: "posted_financial_transfer",
      protectedMessage: message,
    };
  });

  const products: MediaAssetUsageRef[] = productRows.map((p) => ({
    id: p.id,
    name: p.name,
    slot: p.slot,
  }));

  const total =
    menuItems.length +
    inventoryItems.length +
    products.length +
    expenses.length +
    purchases.length +
    parties.length +
    vehicles.length +
    workspaceDocuments.length +
    transfers.length;

  return {
    menuItems,
    inventoryItems,
    products,
    expenses,
    purchases,
    parties,
    vehicles,
    workspaceDocuments,
    transfers,
    protectedItems,
    hasProtected: protectedItems.length > 0,
    replaceableCount: Math.max(0, total - protectedItems.length),
    total,
  };
}

export function mediaAssetUsageIsProtected(usage: MediaAssetUsage): boolean {
  if (usage.hasProtected) return true;
  if ((usage.protectedItems?.length ?? 0) > 0) return true;
  if ((usage.workspaceDocuments ?? []).some((d) => Boolean(d.protected))) return true;
  if ((usage.transfers ?? []).some((t) => Boolean(t.protected))) return true;
  return false;
}

export function mediaAssetUsageIsEmpty(usage: MediaAssetUsage): boolean {
  return (
    usage.menuItems.length === 0 &&
    usage.inventoryItems.length === 0 &&
    (usage.products?.length ?? 0) === 0 &&
    usage.expenses.length === 0 &&
    usage.purchases.length === 0 &&
    usage.parties.length === 0 &&
    (usage.vehicles?.length ?? 0) === 0 &&
    (usage.workspaceDocuments?.length ?? 0) === 0 &&
    (usage.transfers?.length ?? 0) === 0
  );
}

/** The distinct categories and tags in use — the filter dropdowns. */
export async function listMediaFacets(businessId: string) {
  const [{ rows: categories }, { rows: tags }] = await Promise.all([
    query<{ category: string }>(
      `SELECT DISTINCT category FROM media_assets WHERE business_id = $1 AND category IS NOT NULL AND deleted_at IS NULL ORDER BY category`,
      [businessId],
    ),
    query<{ tag: string }>(
      `SELECT DISTINCT unnest(tags) AS tag FROM media_assets WHERE business_id = $1 AND deleted_at IS NULL ORDER BY tag`,
      [businessId],
    ),
  ]);
  return { categories: categories.map((r) => r.category), tags: tags.map((r) => r.tag) };
}

export async function getMediaAsset(businessId: string, id: string): Promise<MediaAssetRecord | null> {
  if (!isValidMediaUuid(id)) return null;
  const { rows } = await query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM media_assets WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );
  return rows[0] ? rowToAsset(rows[0]) : null;
}

export async function getActiveMediaAssetWithStorageKey(
  businessId: string,
  id: string,
): Promise<{ asset: MediaAssetRecord; storageKey: string; sha256: string } | null> {
  if (!isValidMediaUuid(id)) return null;
  const { rows } = await query<AssetRow & { storage_key: string; sha256: string }>(
    `SELECT ${ASSET_COLUMNS}, storage_key, sha256
       FROM media_assets
      WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
    [id, businessId],
  );
  if (!rows[0]) return null;
  return {
    asset: rowToAsset(rows[0]),
    storageKey: rows[0].storage_key,
    sha256: rows[0].sha256,
  };
}

export interface MediaAssetLineageEntry {
  id: string;
  fileName: string;
  variant: MediaAssetVariant;
  transformOps: unknown[];
  deletedAt: string | null;
}

export interface MediaAssetLineage {
  ancestors: MediaAssetLineageEntry[];
  descendants: MediaAssetLineageEntry[];
}

const MAX_LINEAGE_HOPS = 20;

function toLineageEntry(asset: MediaAssetRecord): MediaAssetLineageEntry {
  return {
    id: asset.id,
    fileName: asset.fileName,
    variant: asset.variant,
    transformOps: asset.transformOps,
    deletedAt: asset.deletedAt,
  };
}

export async function getMediaAssetLineage(businessId: string, id: string): Promise<MediaAssetLineage> {
  const ancestorsUp: MediaAssetLineageEntry[] = [];
  const seen = new Set<string>([id]);
  let cursor = await getMediaAsset(businessId, id);
  let hops = 0;
  while (cursor?.sourceAssetId && hops < MAX_LINEAGE_HOPS) {
    if (seen.has(cursor.sourceAssetId)) break;
    const parent = await getMediaAsset(businessId, cursor.sourceAssetId);
    if (!parent) break;
    ancestorsUp.push(toLineageEntry(parent));
    seen.add(parent.id);
    cursor = parent;
    hops += 1;
  }

  const { rows } = await query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM media_assets WHERE business_id = $1 AND source_asset_id = $2 ORDER BY created_at ASC`,
    [businessId, id],
  );

  return {
    ancestors: ancestorsUp.reverse(),
    descendants: rows.map(rowToAsset).map(toLineageEntry),
  };
}

/**
 * Verify `folderId` syntax and ownership against `media_folders` BEFORE any
 * bytes are uploaded to object storage (issue #926 P0.3).
 */
export async function assertTenantFolderExists(
  businessId: string,
  folderId: string | null | undefined,
  client?: PoolClient,
): Promise<string | null> {
  if (folderId === undefined || folderId === null || folderId === "") return null;
  if (!isValidMediaUuid(folderId)) throw new MediaInvalidFolderError();
  const sql = `SELECT id FROM media_folders WHERE id = $1 AND business_id = $2`;
  const { rows } = client
    ? await client.query<{ id: string }>(sql, [folderId, businessId])
    : await query<{ id: string }>(sql, [folderId, businessId]);
  if (!rows[0]) throw new MediaFolderNotFoundError();
  return rows[0].id;
}

export type StoreMediaAssetInput = {
  businessId: string;
  userId: string | null;
  config: MediaStorageConfig;
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  /**
   * Sent as the object's `Content-Type`. Optional for callers that predate it;
   * tenant uploads pass the validated MIME type so a provider that inspects it
   * (or a bucket policy that requires it) sees the same type the library shows.
   */
  contentType?: string;
  bytes?: Buffer;
  filePath?: string;
  byteSize?: number;
  sha256: string;
  folderId?: string | null;
  variant?: MediaAssetVariant;
  sourceAssetId?: string | null;
  transformOps?: unknown[];
  source?: MediaAssetSource;
  createdByAi?: boolean;
  conversationId?: string | null;
  projectId?: string | null;
};

async function storeMediaAssetInternal(
  input: StoreMediaAssetInput,
  client?: PoolClient,
): Promise<MediaAssetRecord> {
  const validatedFolderId = await assertTenantFolderExists(input.businessId, input.folderId, client);
  const runQuery = <R extends Record<string, unknown>>(text: string, values?: unknown[]) =>
    client ? client.query<R>(text, values) : query<R>(text, values);

  // Issue #1080 (P1.7): a verified storage migration copies the assets it saw
  // when it started and then switches the configuration atomically. An upload
  // that begins mid-migration would land in the *source* bucket while the row it
  // writes is read through the *target* configuration — an object nobody can
  // reach. Refusing with a retryable, localized 503 is far safer than silently
  // accepting a file that disappears; the migration itself is untouched.
  if ((input.config as ExtendedMediaStorageConfig).migrationState === "migrating") {
    throw new MediaStorageBusyError();
  }

  const { rows: idRows } = await runQuery<{ id: string }>(`SELECT gen_random_uuid() AS id`);
  const assetId = idRows[0].id;
  const key = buildMediaKey(input.config.keyPrefix, input.businessId, assetId, input.fileName);
  const s3Cfg = s3ConfigOf(input.config);

  let actualByteSize: number;
  if (input.filePath) {
    if (typeof input.byteSize !== "number" || !Number.isFinite(input.byteSize) || input.byteSize < 0) {
      throw new Error("missing_byte_size_for_streamed_upload");
    }
    actualByteSize = input.byteSize;
    await s3PutFile(s3Cfg, key, input.filePath, {
      payloadHash: input.sha256,
      sizeBytes: actualByteSize,
      contentType: input.contentType,
    });
  } else if (input.bytes) {
    actualByteSize = input.bytes.byteLength;
    await s3Put(s3Cfg, key, input.bytes, { contentType: input.contentType });
  } else {
    throw new Error("missing_upload_payload");
  }

  const source = input.source ?? "upload";
  const createdByAi = input.createdByAi ?? source === "ai_generated";

  try {
    const { rows } = await runQuery<AssetRow>(
      `INSERT INTO media_assets
         (id, business_id, folder_id, kind, file_name, mime_type, byte_size, storage_key, sha256,
          variant, source_asset_id, created_by, source, created_by_ai, conversation_id, project_id, transform_ops)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
       RETURNING ${ASSET_COLUMNS}`,
      [
        assetId,
        input.businessId,
        validatedFolderId,
        input.kind,
        input.fileName.slice(0, 200),
        input.mimeType,
        actualByteSize,
        key,
        input.sha256,
        input.variant ?? "original",
        input.sourceAssetId ?? null,
        input.userId,
        source,
        createdByAi,
        input.conversationId ?? null,
        input.projectId ?? null,
        JSON.stringify(input.transformOps ?? []),
      ],
    );
    return rowToAsset(rows[0]);
  } catch (dbErr) {
    // Compensating cleanup: never leave orphaned S3 bytes behind when DB INSERT fails.
    await s3Delete(s3Cfg, key).catch((cleanupErr) => {
      console.error("[media] failed to clean up object after DB failure:", key, cleanupErr);
    });
    throw dbErr;
  }
}

export async function storeMediaAsset(input: StoreMediaAssetInput): Promise<MediaAssetRecord> {
  return storeMediaAssetInternal(input);
}

export type DuplicatePolicy = "reuse" | "move" | "duplicate";

export interface DedupeOrStoreMediaResult {
  asset: MediaAssetRecord;
  reused: boolean;
  action: "created" | "reused" | "reused_moved";
  requestedFolderId: string | null;
  folderMismatch: boolean;
}

/**
 * Atomic duplicate-aware upload helper (issue #926 P2.10):
 *   • Validates `folderId` upfront before locking or touching S3.
 *   • Serializes concurrent uploads of the identical `(businessId, sha256)` via
 *     `pg_advisory_xact_lock(hashtextextended(...))` so simultaneous requests
 *     cannot write duplicate rows when duplicates were not requested.
 *   • Makes folder placement explicit (`reuse` keeps original folder and sets
 *     `folderMismatch = true`; `move` moves existing row into `folderId`;
 *     `duplicate` creates an independent row in `folderId`).
 */
export async function dedupeOrStoreMediaAsset(
  input: StoreMediaAssetInput & { onDuplicate?: DuplicatePolicy },
): Promise<DedupeOrStoreMediaResult> {
  const validatedFolderId = await assertTenantFolderExists(input.businessId, input.folderId);
  // Fail before taking a connection and an advisory lock for an upload that
  // cannot be stored consistently (see `storeMediaAssetInternal`).
  if ((input.config as ExtendedMediaStorageConfig).migrationState === "migrating") {
    throw new MediaStorageBusyError();
  }
  const policy: DuplicatePolicy = input.onDuplicate ?? "reuse";

  if (policy === "duplicate") {
    const asset = await storeMediaAssetInternal({ ...input, folderId: validatedFolderId });
    return {
      asset,
      reused: false,
      action: "created",
      requestedFolderId: validatedFolderId,
      folderMismatch: false,
    };
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.current_business_id', $1, true)`, [input.businessId]);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':media_sha256:' || $2::text, 0))`,
      [input.businessId, input.sha256],
    );

    const { rows: existingRows } = await client.query<AssetRow>(
      `SELECT ${ASSET_COLUMNS}
         FROM media_assets
        WHERE business_id = $1 AND sha256 = $2 AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1`,
      [input.businessId, input.sha256],
    );

    if (existingRows[0]) {
      let existing = rowToAsset(existingRows[0]);
      const currentFolder = existing.folderId ?? null;
      if (policy === "move" && currentFolder !== validatedFolderId) {
        const { rows: movedRows } = await client.query<AssetRow>(
          `UPDATE media_assets
              SET folder_id = $3, updated_at = now()
            WHERE id = $1 AND business_id = $2
            RETURNING ${ASSET_COLUMNS}`,
          [existing.id, input.businessId, validatedFolderId],
        );
        if (movedRows[0]) existing = rowToAsset(movedRows[0]);
        await client.query("COMMIT");
        return {
          asset: existing,
          reused: true,
          action: "reused_moved",
          requestedFolderId: validatedFolderId,
          folderMismatch: false,
        };
      }
      await client.query("COMMIT");
      return {
        asset: existing,
        reused: true,
        action: "reused",
        requestedFolderId: validatedFolderId,
        folderMismatch: currentFolder !== validatedFolderId,
      };
    }

    const created = await storeMediaAssetInternal({ ...input, folderId: validatedFolderId }, client);
    try {
      await client.query("COMMIT");
    } catch (commitError) {
      // The object is already in the bucket but the row will be rolled back: the
      // compensating delete inside `storeMediaAssetInternal` does not run here
      // because the INSERT itself succeeded. Without this, every commit-time
      // failure (a dropped connection, a cancelled transaction, a failover)
      // leaves an unreferenced object behind that only an orphan scan can find.
      const orphanKey = buildMediaKey(input.config.keyPrefix, input.businessId, created.id, input.fileName);
      await s3Delete(s3ConfigOf(input.config), orphanKey).catch((cleanupError) => {
        console.error(
          "[media] failed to clean up object after COMMIT failure:",
          JSON.stringify({
            businessId: input.businessId,
            assetId: created.id,
            cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          }),
        );
      });
      throw commitError;
    }
    return {
      asset: created,
      reused: false,
      action: "created",
      requestedFolderId: validatedFolderId,
      folderMismatch: false,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Read full object bytes from primary S3 config, falling back transparently to
 * `previousFallback` during/after storage migrations if primary reports 404.
 */
async function readStorageBytesWithFallback(
  config: ExtendedMediaStorageConfig,
  storageKey: string,
): Promise<Buffer> {
  try {
    return await s3Get(s3ConfigOf(config), storageKey);
  } catch (err) {
    const prev = config.previousFallback;
    // Key off the typed status when we have it; the message regex remains for
    // errors surfaced by injected fakes that predate `S3RequestError`.
    const missingFromPrimary =
      err instanceof S3RequestError ? err.status === 404 : err instanceof Error && /HTTP 404\b/.test(err.message);
    if (prev && missingFromPrimary) {
      const prevKey = rewriteKeyPrefix(storageKey, config.keyPrefix, prev.keyPrefix);
      return await s3Get(
        {
          endpoint: prev.endpoint,
          region: prev.region,
          bucket: prev.bucket,
          accessKeyId: prev.accessKeyId,
          secretAccessKey: prev.secretAccessKey,
        },
        prevKey,
      );
    }
    throw err;
  }
}

export async function readMediaObject(
  businessId: string,
  assetId: string,
  config: ExtendedMediaStorageConfig,
): Promise<{ asset: MediaAssetRecord; bytes: Buffer } | null> {
  if (!isValidMediaUuid(assetId)) return null;
  const { rows } = await query<AssetRow & { storage_key: string }>(
    `SELECT ${ASSET_COLUMNS}, storage_key FROM media_assets WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
    [assetId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!keyBelongsToBusiness(row.storage_key, config.keyPrefix, businessId)) return null;
  const bytes = await readStorageBytesWithFallback(config, row.storage_key);
  return { asset: rowToAsset(row), bytes };
}

/**
 * Stream an already-authorized media asset (full body or RFC 9110 byte range)
 * from S3 with zero full-file RAM buffering, dual-read fallback, and client
 * abort propagation (issue #926 P0.1 + P1.6).
 */
export async function streamMediaObject(
  businessId: string,
  storageKey: string,
  config: ExtendedMediaStorageConfig,
  options: { range?: { start: number; end: number }; signal?: AbortSignal } = {},
): Promise<{ stream: ReadableStream<Uint8Array>; contentLength: number | null; status: number } | null> {
  if (!keyBelongsToBusiness(storageKey, config.keyPrefix, businessId)) return null;
  const primary = await s3GetStream(s3ConfigOf(config), storageKey, options);
  if (primary) return primary;
  const prev = config.previousFallback;
  if (!prev) return null;
  const prevKey = rewriteKeyPrefix(storageKey, config.keyPrefix, prev.keyPrefix);
  return s3GetStream(
    {
      endpoint: prev.endpoint,
      region: prev.region,
      bucket: prev.bucket,
      accessKeyId: prev.accessKeyId,
      secretAccessKey: prev.secretAccessKey,
    },
    prevKey,
    options,
  );
}

export async function readMediaObjectDownloadUrl(
  businessId: string,
  assetId: string,
  config: MediaStorageConfig,
  expiresSeconds: number,
): Promise<{ asset: MediaAssetRecord; url: string } | null> {
  if (!isValidMediaUuid(assetId)) return null;
  const { rows } = await query<AssetRow & { storage_key: string }>(
    `SELECT ${ASSET_COLUMNS}, storage_key FROM media_assets WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
    [assetId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!keyBelongsToBusiness(row.storage_key, config.keyPrefix, businessId)) return null;
  const url = presignS3Get(s3ConfigOf(config), row.storage_key, expiresSeconds);
  return { asset: rowToAsset(row), url };
}

export async function softDeleteMediaAsset(businessId: string, assetId: string): Promise<boolean> {
  if (!isValidMediaUuid(assetId)) return false;
  const { rows } = await query<{ id: string }>(
    `UPDATE media_assets SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [assetId, businessId],
  );
  if (rows.length > 0) {
    await purgeMirroredMediaObject(businessId, assetId);
    return true;
  }
  return false;
}

export async function restoreMediaAsset(businessId: string, assetId: string): Promise<boolean> {
  if (!isValidMediaUuid(assetId)) return false;
  const { rows } = await query<{ id: string }>(
    `UPDATE media_assets SET deleted_at = NULL, updated_at = now()
      WHERE id = $1 AND business_id = $2 AND deleted_at IS NOT NULL
      RETURNING id`,
    [assetId, businessId],
  );
  return rows.length > 0;
}

export async function deleteMediaAsset(
  businessId: string,
  assetId: string,
  config: MediaStorageConfig,
): Promise<boolean> {
  if (!isValidMediaUuid(assetId)) return false;
  const usage = await getMediaAssetUsage(assetId);
  if (mediaAssetUsageIsProtected(usage)) {
    throw new MediaAssetProtectedError(usage);
  }
  const { rows } = await query<{ storage_key: string }>(
    `DELETE FROM media_assets WHERE id = $1 AND business_id = $2 RETURNING storage_key`,
    [assetId, businessId],
  );
  const key = rows[0]?.storage_key;
  if (!key) return false;
  await purgeMirroredMediaObject(businessId, assetId);
  if (keyBelongsToBusiness(key, config.keyPrefix, businessId)) {
    await s3Delete(s3ConfigOf(config), key).catch(() => {});
  }
  return true;
}

export async function runMediaTrashPurgeTick(
  now: Date = new Date(),
  retentionDays: number = MEDIA_TRASH_RETENTION_DAYS,
): Promise<number> {
  const config = await withoutTenantScope("platform", () => getMediaConfig());
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const expired = await withoutTenantScope("platform", async () => {
    const { rows } = await query<{ id: string; business_id: string }>(
      `SELECT id, business_id FROM media_assets WHERE deleted_at IS NOT NULL AND deleted_at < $1`,
      [cutoff.toISOString()],
    );
    return rows;
  });

  let purged = 0;
  for (const row of expired) {
    try {
      await withTenant(row.business_id, async () => {
        const usage = await getMediaAssetUsage(row.id);
        if (mediaAssetUsageIsProtected(usage)) {
          console.warn("[media] skipping retention purge of protected asset:", row.id);
          return;
        }
        const ok = await deleteMediaAsset(row.business_id, row.id, config);
        if (ok) purged += 1;
      });
    } catch (error) {
      console.error("media trash purge failed for asset:", row.id, error);
    }
  }
  return purged;
}

// ---------------------------------------------------------------------------
// Orphan Reconciliation — scheduled read-only checks + gated cleanup (P1.7)
// ---------------------------------------------------------------------------

export const MEDIA_ORPHAN_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ORPHAN_GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

export interface MediaOrphanScanRecord {
  id: string;
  mode: "scheduled_scan" | "manual_scan" | "manual_cleanup";
  status: "ok" | "alert" | "skipped" | "error";
  scannedObjects: number;
  dbKeysCount: number;
  orphanCount: number;
  orphanBytes: number;
  youngSkipped: number;
  prefixSkipped: number;
  deletedCount: number;
  oldestOrphanAt: string | null;
  sampleKeys: string[];
  actorEmail: string | null;
  backupConfirmed: boolean;
  errorDetail: string | null;
  createdAt: string;
}

export async function runMediaOrphanReconcileScan(options: {
  mode?: "scheduled_scan" | "manual_scan" | "manual_cleanup";
  apply?: boolean;
  backupConfirmed?: boolean;
  actorEmail?: string | null;
  gracePeriodMs?: number;
} = {}): Promise<MediaOrphanScanRecord> {
  const apply = Boolean(options.apply);
  const backupConfirmed = Boolean(options.backupConfirmed);
  const mode = apply ? "manual_cleanup" : options.mode ?? "manual_scan";
  const graceMs = options.gracePeriodMs ?? ORPHAN_GRACE_PERIOD_MS;

  if (apply && !backupConfirmed) {
    throw new Error("backup_confirmation_required");
  }
  if (apply && graceMs < ORPHAN_GRACE_PERIOD_MS) {
    throw new Error("grace_period_too_short");
  }

  return withoutTenantScope("platform", async () => {
    const config = await getMediaConfig();
    if (!isMediaStorageReady(config)) {
      const skipped: Omit<MediaOrphanScanRecord, "id" | "createdAt"> = {
        mode,
        status: "skipped",
        scannedObjects: 0,
        dbKeysCount: 0,
        orphanCount: 0,
        orphanBytes: 0,
        youngSkipped: 0,
        prefixSkipped: 0,
        deletedCount: 0,
        oldestOrphanAt: null,
        sampleKeys: [],
        actorEmail: options.actorEmail ?? null,
        backupConfirmed,
        errorDetail: "storage_not_configured",
      };
      return persistOrphanScan(skipped);
    }

    try {
      const prefix = normalizeKeyPrefix(config.keyPrefix);
      const s3Cfg = s3ConfigOf(config);
      const objects = await s3List(s3Cfg, prefix);
      const { rows: assetRows } = await query<{ storage_key: string }>(`SELECT storage_key FROM media_assets`);
      const claimedKeys = new Set(assetRows.map((r) => r.storage_key));

      const now = Date.now();
      let youngSkipped = 0;
      let prefixSkipped = 0;
      const safeOrphans: typeof objects = [];

      for (const obj of objects) {
        if (claimedKeys.has(obj.key)) continue;
        // Skip internal probe keys if one is mid-flight.
        if (obj.key.slice(prefix.length).startsWith(".")) continue;
        const modified = Date.parse(obj.lastModified);
        if (Number.isFinite(modified) && now - modified < graceMs) {
          youngSkipped += 1;
          continue;
        }
        const ownerCandidate = obj.key.slice(prefix.length).split("/")[0] ?? "";
        if (!keyBelongsToBusiness(obj.key, prefix, ownerCandidate)) {
          prefixSkipped += 1;
          continue;
        }
        safeOrphans.push(obj);
      }

      const orphanBytes = safeOrphans.reduce((sum, o) => sum + o.size, 0);
      let oldestMs: number | null = null;
      for (const o of safeOrphans) {
        const ts = Date.parse(o.lastModified);
        if (Number.isFinite(ts) && (oldestMs === null || ts < oldestMs)) {
          oldestMs = ts;
        }
      }

      let deletedCount = 0;
      if (apply && backupConfirmed && safeOrphans.length > 0) {
        for (const orphan of safeOrphans) {
          await s3Delete(s3Cfg, orphan.key);
          deletedCount += 1;
        }
      }

      const remainingOrphans = apply ? Math.max(0, safeOrphans.length - deletedCount) : safeOrphans.length;
      return persistOrphanScan({
        mode,
        status: remainingOrphans > 0 || prefixSkipped > 0 ? "alert" : "ok",
        scannedObjects: objects.length,
        dbKeysCount: claimedKeys.size,
        orphanCount: safeOrphans.length,
        orphanBytes,
        youngSkipped,
        prefixSkipped,
        deletedCount,
        oldestOrphanAt: oldestMs !== null ? new Date(oldestMs).toISOString() : null,
        sampleKeys: safeOrphans.slice(0, 20).map((o) => o.key),
        actorEmail: options.actorEmail ?? null,
        backupConfirmed,
        errorDetail: null,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return persistOrphanScan({
        mode,
        status: "error",
        scannedObjects: 0,
        dbKeysCount: 0,
        orphanCount: 0,
        orphanBytes: 0,
        youngSkipped: 0,
        prefixSkipped: 0,
        deletedCount: 0,
        oldestOrphanAt: null,
        sampleKeys: [],
        actorEmail: options.actorEmail ?? null,
        backupConfirmed,
        errorDetail: detail,
      });
    }
  });
}

async function persistOrphanScan(
  record: Omit<MediaOrphanScanRecord, "id" | "createdAt">,
): Promise<MediaOrphanScanRecord> {
  const { rows } = await query<{ id: string; created_at: string }>(
    `INSERT INTO platform_media_orphan_scans
       (mode, status, scanned_objects, db_keys_count, orphan_count, orphan_bytes,
        young_skipped, prefix_skipped, deleted_count, oldest_orphan_at, sample_keys,
        actor_email, backup_confirmed, error_detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
     RETURNING id, created_at`,
    [
      record.mode,
      record.status,
      record.scannedObjects,
      record.dbKeysCount,
      record.orphanCount,
      record.orphanBytes,
      record.youngSkipped,
      record.prefixSkipped,
      record.deletedCount,
      record.oldestOrphanAt,
      JSON.stringify(record.sampleKeys),
      record.actorEmail,
      record.backupConfirmed,
      record.errorDetail,
    ],
  );
  return {
    ...record,
    id: rows[0]?.id ?? "",
    createdAt: rows[0]?.created_at ?? new Date().toISOString(),
  };
}

export async function runMediaOrphanReconcileTick(): Promise<MediaOrphanScanRecord> {
  return runMediaOrphanReconcileScan({ mode: "scheduled_scan", apply: false });
}

export async function listMediaOrphanScans(limit = 10): Promise<MediaOrphanScanRecord[]> {
  try {
    const { rows } = await withoutTenantScope("platform", () =>
      query<{
        id: string;
        mode: MediaOrphanScanRecord["mode"];
        status: MediaOrphanScanRecord["status"];
        scanned_objects: number;
        db_keys_count: number;
        orphan_count: number;
        orphan_bytes: string;
        young_skipped: number;
        prefix_skipped: number;
        deleted_count: number;
        oldest_orphan_at: string | null;
        sample_keys: string[];
        actor_email: string | null;
        backup_confirmed: boolean;
        error_detail: string | null;
        created_at: string;
      }>(
        `SELECT id, mode, status, scanned_objects, db_keys_count, orphan_count,
                orphan_bytes::text, young_skipped, prefix_skipped, deleted_count,
                oldest_orphan_at, sample_keys, actor_email, backup_confirmed,
                error_detail, created_at
           FROM platform_media_orphan_scans
          ORDER BY created_at DESC
          LIMIT $1`,
        [Math.min(Math.max(1, limit), 100)],
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      mode: r.mode,
      status: r.status,
      scannedObjects: r.scanned_objects,
      dbKeysCount: r.db_keys_count,
      orphanCount: r.orphan_count,
      orphanBytes: Number(r.orphan_bytes),
      youngSkipped: r.young_skipped,
      prefixSkipped: r.prefix_skipped,
      deletedCount: r.deleted_count,
      oldestOrphanAt: r.oldest_orphan_at,
      sampleKeys: Array.isArray(r.sample_keys) ? r.sample_keys : [],
      actorEmail: r.actor_email,
      backupConfirmed: r.backup_confirmed,
      errorDetail: r.error_detail,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export type MediaFolderRecord = {
  id: string;
  parentId: string | null;
  name: string;
  assetCount: number;
};

export async function listMediaFolders(businessId: string): Promise<MediaFolderRecord[]> {
  const { rows } = await query<{ id: string; parent_id: string | null; name: string; asset_count: string }>(
    `SELECT f.id, f.parent_id, f.name,
            (SELECT COUNT(*) FROM media_assets a WHERE a.folder_id = f.id AND a.deleted_at IS NULL) AS asset_count
       FROM media_folders f
      WHERE f.business_id = $1
      ORDER BY f.name`,
    [businessId],
  );
  return rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, assetCount: Number(r.asset_count) }));
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export type MediaCollectionRecord = {
  id: string;
  name: string;
  description: string | null;
  assetCount: number;
  createdAt: string;
};

export async function listMediaCollections(businessId: string): Promise<MediaCollectionRecord[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    description: string | null;
    asset_count: string;
    created_at: string;
  }>(
    `SELECT c.id, c.name, c.description, c.created_at,
            (SELECT COUNT(*) FROM media_collection_items i
               JOIN media_assets a ON a.id = i.asset_id AND a.deleted_at IS NULL
              WHERE i.collection_id = c.id) AS asset_count
       FROM media_collections c
      WHERE c.business_id = $1
      ORDER BY c.name`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    assetCount: Number(r.asset_count),
    createdAt: r.created_at,
  }));
}

export async function createMediaCollection(
  businessId: string,
  userId: string | null,
  name: string,
  description: string | null,
): Promise<MediaCollectionRecord> {
  const { rows } = await query<{ id: string; name: string; description: string | null; created_at: string }>(
    `INSERT INTO media_collections (business_id, name, description, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, description, created_at`,
    [businessId, name, description, userId],
  );
  return { id: rows[0].id, name: rows[0].name, description: rows[0].description, assetCount: 0, createdAt: rows[0].created_at };
}

export async function renameMediaCollection(
  businessId: string,
  id: string,
  name: string,
  description: string | null | undefined,
): Promise<boolean> {
  const fields = ["name = $3", "updated_at = now()"];
  const values: unknown[] = [id, businessId, name];
  if (description !== undefined) {
    fields.push(`description = $${values.length + 1}`);
    values.push(description);
  }
  const { rows } = await query<{ id: string }>(
    `UPDATE media_collections SET ${fields.join(", ")} WHERE id = $1 AND business_id = $2 RETURNING id`,
    values,
  );
  return rows.length > 0;
}

export async function deleteMediaCollection(businessId: string, id: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `DELETE FROM media_collections WHERE id = $1 AND business_id = $2 RETURNING id`,
    [id, businessId],
  );
  return rows.length > 0;
}

export async function addAssetToCollection(
  businessId: string,
  collectionId: string,
  assetId: string,
  userId: string | null,
): Promise<boolean> {
  const { rows: collectionRows } = await query<{ id: string }>(
    `SELECT id FROM media_collections WHERE id = $1 AND business_id = $2`,
    [collectionId, businessId],
  );
  if (!collectionRows[0]) return false;
  const { rows: assetRows } = await query<{ id: string }>(
    `SELECT id FROM media_assets WHERE id = $1 AND business_id = $2`,
    [assetId, businessId],
  );
  if (!assetRows[0]) return false;
  await query(
    `INSERT INTO media_collection_items (collection_id, asset_id, business_id, added_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (collection_id, asset_id) DO NOTHING`,
    [collectionId, assetId, businessId, userId],
  );
  return true;
}

export async function removeAssetFromCollection(
  businessId: string,
  collectionId: string,
  assetId: string,
): Promise<boolean> {
  const { rows } = await query<{ collection_id: string }>(
    `DELETE FROM media_collection_items
      WHERE collection_id = $1 AND asset_id = $2 AND business_id = $3
      RETURNING collection_id`,
    [collectionId, assetId, businessId],
  );
  return rows.length > 0;
}

export async function listCollectionsForAsset(
  businessId: string,
  assetId: string,
): Promise<{ id: string; name: string }[]> {
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT c.id, c.name
       FROM media_collection_items i
       JOIN media_collections c ON c.id = i.collection_id
      WHERE i.asset_id = $1 AND i.business_id = $2
      ORDER BY c.name`,
    [assetId, businessId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// WordPress mapping — canonical asset ↔ one connection's remote attachment
// ---------------------------------------------------------------------------

export type WordPressMediaMappingRecord = {
  id: string;
  mediaAssetId: string;
  connectionId: string;
  operationId: string;
  wpMediaId: string | null;
  wpUrl: string | null;
  status: "pending" | "synced" | "failed";
  lastError: string | null;
  createdAt: string;
  syncedAt: string | null;
};

type WpMappingRow = {
  id: string;
  media_asset_id: string;
  connection_id: string;
  operation_id: string;
  wp_media_id: string | null;
  wp_url: string | null;
  status: WordPressMediaMappingRecord["status"];
  last_error: string | null;
  created_at: string;
  synced_at: string | null;
};

function rowToWpMapping(row: WpMappingRow): WordPressMediaMappingRecord {
  return {
    id: row.id,
    mediaAssetId: row.media_asset_id,
    connectionId: row.connection_id,
    operationId: row.operation_id,
    wpMediaId: row.wp_media_id,
    wpUrl: row.wp_url,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    syncedAt: row.synced_at,
  };
}

const WP_MAPPING_COLUMNS =
  "id, media_asset_id, connection_id, operation_id, wp_media_id, wp_url, status, last_error, created_at, synced_at";

export async function recordWordPressMediaPush(input: {
  businessId: string;
  mediaAssetId: string;
  connectionId: string;
  operationId: string;
}): Promise<WordPressMediaMappingRecord> {
  const { rows } = await query<WpMappingRow>(
    `INSERT INTO wordpress_media_mapping (business_id, media_asset_id, connection_id, operation_id, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (connection_id, media_asset_id)
     DO UPDATE SET operation_id = EXCLUDED.operation_id, status = 'pending', last_error = NULL,
                   wp_media_id = NULL, wp_url = NULL, synced_at = NULL
     RETURNING ${WP_MAPPING_COLUMNS}`,
    [input.businessId, input.mediaAssetId, input.connectionId, input.operationId],
  );
  return rowToWpMapping(rows[0]);
}

export async function confirmWordPressMediaSync(
  operationId: string,
  wpMediaId: string,
  wpUrl: string,
  scope: { businessId: string; connectionId: string },
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `UPDATE wordpress_media_mapping
        SET status = 'synced', wp_media_id = $2, wp_url = $3, synced_at = now(), last_error = NULL
      WHERE operation_id = $1 AND business_id = $4 AND connection_id = $5
        AND (last_error IS NULL OR last_error NOT IN ('remote_attachment_deleted', 'remote_attachment_trashed'))
        AND (wp_media_id IS NULL OR wp_media_id = $2)
      RETURNING id`,
    [operationId, wpMediaId, wpUrl, scope.businessId, scope.connectionId],
  );
  return rows.length > 0;
}

/** Remote lifecycle never deletes canonical bytes. Keep the remote identity for
 * history and guard against a delayed creation event resurrecting a deletion.
 */
export async function reconcileWordPressMediaLifecycle(
  businessId: string,
  connectionId: string,
  wpMediaId: string,
  state: "deleted" | "trash" | "active",
): Promise<void> {
  if (state === "active") {
    await query(
      `UPDATE wordpress_media_mapping SET status = 'synced', last_error = NULL
        WHERE business_id = $1 AND connection_id = $2 AND wp_media_id = $3
          AND last_error = 'remote_attachment_trashed'`,
      [businessId, connectionId, wpMediaId],
    );
    return;
  }
  await query(
    `UPDATE wordpress_media_mapping SET status = 'failed', last_error = $4,
            wp_url = CASE WHEN $4 = 'remote_attachment_deleted' THEN NULL ELSE wp_url END
      WHERE business_id = $1 AND connection_id = $2 AND wp_media_id = $3
        AND (last_error IS NULL OR last_error <> 'remote_attachment_deleted')`,
    [businessId, connectionId, wpMediaId, state === "deleted" ? "remote_attachment_deleted" : "remote_attachment_trashed"],
  );
}

export async function failWordPressMediaSync(operationId: string, errorMessage: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `UPDATE wordpress_media_mapping SET status = 'failed', last_error = $2 WHERE operation_id = $1 AND status = 'pending' RETURNING id`,
    [operationId, errorMessage],
  );
  return rows.length > 0;
}

export async function listWordPressMappingsForAsset(
  businessId: string,
  mediaAssetId: string,
): Promise<WordPressMediaMappingRecord[]> {
  const { rows } = await query<WpMappingRow>(
    `SELECT ${WP_MAPPING_COLUMNS} FROM wordpress_media_mapping WHERE business_id = $1 AND media_asset_id = $2 ORDER BY created_at`,
    [businessId, mediaAssetId],
  );
  return rows.map(rowToWpMapping);
}

export async function getWordPressMediaMapping(
  businessId: string,
  connectionId: string,
  mediaAssetId: string,
): Promise<WordPressMediaMappingRecord | null> {
  const { rows } = await query<WpMappingRow>(
    `SELECT ${WP_MAPPING_COLUMNS} FROM wordpress_media_mapping
      WHERE business_id = $1 AND connection_id = $2 AND media_asset_id = $3`,
    [businessId, connectionId, mediaAssetId],
  );
  return rows[0] ? rowToWpMapping(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Usage + the daily billing tick
// ---------------------------------------------------------------------------

export interface MediaUsageSummary {
  totalBytes: number;
  assetCount: number;
  byKind: Record<MediaKind, { count: number; bytes: number }>;
}

export function emptyMediaUsage(): MediaUsageSummary {
  return {
    totalBytes: 0,
    assetCount: 0,
    byKind: {
      image: { count: 0, bytes: 0 },
      video: { count: 0, bytes: 0 },
      document: { count: 0, bytes: 0 },
    },
  };
}

export async function mediaUsageFor(businessId: string): Promise<MediaUsageSummary> {
  const { rows } = await query<{ kind: MediaKind; count: string; bytes: string }>(
    `SELECT kind, COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes
       FROM media_assets WHERE business_id = $1 GROUP BY kind`,
    [businessId],
  );
  const { byKind } = emptyMediaUsage();
  let totalBytes = 0;
  let assetCount = 0;
  for (const row of rows) {
    byKind[row.kind] = { count: Number(row.count), bytes: Number(row.bytes) };
    totalBytes += Number(row.bytes);
    assetCount += Number(row.count);
  }
  return { totalBytes, assetCount, byKind };
}

export function localBillingDay(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}

export async function runMediaBillingTick(now: Date = new Date()): Promise<number> {
  const config = await withoutTenantScope("platform", () => getMediaConfig());
  if (!config.billingEnabled || (!config.dailyFlatRial && !config.dailyPerGbRial)) return 0;

  const day = localBillingDay(now);
  const holders = await withoutTenantScope("platform", async () => {
    const { rows } = await query<{ business_id: string; bytes: string }>(
      `SELECT a.business_id, SUM(a.byte_size) AS bytes
         FROM media_assets a
         JOIN businesses b ON b.id = a.business_id AND b.status = 'active'
        GROUP BY a.business_id
       HAVING SUM(a.byte_size) > 0`,
    );
    return rows;
  });

  let charged = 0;
  for (const holder of holders) {
    const breakdown = dailyStorageCharge(Number(holder.bytes), config);
    if (breakdown.totalRial <= 0) continue;
    try {
      await withTenant(holder.business_id, async () => {
        const { rows: claimed } = await query<{ id: string }>(
          `INSERT INTO media_usage_charges
             (business_id, day, stored_bytes, flat_rial, per_gb_rial, amount_rial)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (business_id, day) DO NOTHING
           RETURNING id`,
          [holder.business_id, day, Number(holder.bytes), breakdown.flatRial, breakdown.perGbRial, breakdown.totalRial],
        );
        if (!claimed[0]) return;
        try {
          await chargeFeatureUse({
            businessId: holder.business_id,
            featureKey: MEDIA_STORAGE_FEATURE_KEY,
            priceRial: breakdown.totalRial,
            note: `هزینهٔ روزانهٔ فضای رسانه (${day})`,
            metadata: { day, storedBytes: Number(holder.bytes), metered: true },
          });
          const bytes = Number(holder.bytes);
          const { appendUsageEvent } = await import("./billing/runtime");
          await appendUsageEvent({
            eventId: `media-storage:${holder.business_id}:${day}`,
            businessId: holder.business_id,
            meterKey: "media.storage_byte_hour",
            source: "media",
            quantity: bytes * 24,
            unit: "byte_hour",
            resource: "media_library",
            resourceId: holder.business_id,
            ratedAmountRial: breakdown.totalRial,
            dimensions: {
              walletBacked: true,
              day,
              storedBytes: bytes,
              flatRial: breakdown.flatRial,
              perGbRial: breakdown.perGbRial,
            },
          }).catch((error) => {
            console.error("media usage event failed:", holder.business_id, error);
          });
          charged += 1;
        } catch (error) {
          await query(`DELETE FROM media_usage_charges WHERE id = $1`, [claimed[0].id]);
          if (!(error instanceof WalletInsufficientFundsError)) throw error;
        }
      });
    } catch (error) {
      console.error("media billing tick failed for business:", holder.business_id, error);
    }
  }
  return charged;
}
