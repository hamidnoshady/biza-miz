/**
 * «کتابخانهٔ رسانه» — the half that touches the database and the object
 * store. The decisions are all in `media.ts` (pure, unit-tested); this module
 * only executes them, the same split as platform-backup-service.ts.
 *
 * The one rule that matters most here: an object is only ever read, written
 * or deleted through its `media_assets` row, and the row's `storage_key` is
 * re-checked against the owning business with `keyBelongsToBusiness` before
 * s3-lite touches the network — RLS protects the row, this protects the
 * object, and both fail closed.
 *
 * The daily billing tick lives here too (`runMediaBillingTick`), in the shape
 * of `runWebsiteBillingTick`: claim the day's row ON CONFLICT DO NOTHING,
 * then debit through `chargeFeatureUse` — the single wallet every platform
 * feature spends from — and roll the claim back if the wallet cannot cover
 * it, so the business that tops up tomorrow is billed then.
 */
import { query, withTenant, withoutTenantScope } from "./db";
import {
  buildMediaKey,
  dailyStorageCharge,
  DEFAULT_MEDIA_CONFIG,
  keyBelongsToBusiness,
  mediaSearchExpression,
  mediaSortOrderBy,
  MEDIA_STORAGE_FEATURE_KEY,
  MEDIA_TRASH_RETENTION_DAYS,
  normalizeSearchTerm,
  type MediaAssetSource,
  type MediaAssetVariant,
  type MediaKind,
  type MediaSort,
  type MediaStorageConfig,
  type MediaTariff,
} from "./media";
import { presignS3Get, s3Delete, s3Get, s3Put, type S3Config } from "./s3-lite";
import { chargeFeatureUse, WalletInsufficientFundsError } from "./wallet-service";

// ---------------------------------------------------------------------------
// Config (the platform_media_config singleton)
// ---------------------------------------------------------------------------

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
};

function rowToConfig(row: ConfigRow | undefined): MediaStorageConfig {
  if (!row) return { ...DEFAULT_MEDIA_CONFIG };
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
  };
}

export async function getMediaConfig(): Promise<MediaStorageConfig> {
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

function s3ConfigOf(config: MediaStorageConfig): S3Config {
  return {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
}

/** Ready to store: switched on with a complete connection. */
export function isMediaStorageReady(config: MediaStorageConfig): boolean {
  return config.enabled && Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey);
}

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
    // Character-variant folding runs on BOTH sides (translate(...)), so a
    // term typed with Arabic ي/ك still finds a tag written with Persian ی/ک
    // — the stored value itself is never rewritten (src/lib/media.ts).
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

/**
 * An existing asset with the exact same bytes, in this business's own
 * library (sha256 is never compared across tenants). Callers use this before
 * storing a fresh upload so a picker can offer "use the existing file"
 * instead of writing a second identical object.
 */
export async function findMediaAssetByHash(businessId: string, sha256: string): Promise<MediaAssetRecord | null> {
  // A trashed asset is not offered as "the existing file" — its object may be
  // purged at any moment by the retention sweep, so a fresh upload gets a
  // fresh, non-trashed row rather than resurrecting one on the way out.
  const { rows } = await query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM media_assets
      WHERE business_id = $1 AND sha256 = $2 AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1`,
    [businessId, sha256],
  );
  return rows[0] ? rowToAsset(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Usage references — "where is this used?" / the safe-delete check
// ---------------------------------------------------------------------------

export interface MediaAssetUsageRef {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface MediaAssetUsage {
  menuItems: MediaAssetUsageRef[];
  inventoryItems: MediaAssetUsageRef[];
  /** Migration 0177 — expenses recorded from this asset's receipt photo
   * (`expenses.receipt_asset_id`). `name` is the expense's own memo, since
   * expenses have no separate title field. */
  expenses: MediaAssetUsageRef[];
  /** Migration 0179 — draft purchases scanned from this asset's supplier-
   * invoice photo (`purchases.invoice_asset_id`). `name` is the purchase's
   * own note when set, else its id, since a purchase has no title either. */
  purchases: MediaAssetUsageRef[];
  /** Migration 0181 — parties whose avatar this asset is
   * (`parties.profile_image_asset_id`). `name` is the party's own
   * display name. */
  parties: MediaAssetUsageRef[];
}

/**
 * Every catalogue row pointing at this asset through `image_media_id`, plus
 * every expense recorded from it as a receipt (`receipt_asset_id`), every
 * draft purchase scanned from it as a supplier invoice (`invoice_asset_id`),
 * and every party whose avatar it is (`profile_image_asset_id`).
 * `menu_items`/`inventory_items`/`purchases` carry no `business_id` column of
 * their own (they scope through `location_id` → `locations.business_id`), so
 * this relies on RLS — already true of every other read of these tables
 * (see branch-service.ts, ai-tools.ts) — rather than filtering twice.
 * `expenses` and `parties` do carry `business_id` directly but are scoped the
 * same way for symmetry with their siblings — the caller already resolved
 * this asset against the tenant before ever calling this function.
 *
 * This is also the authorization primitive behind `/api/media/[id]/file`:
 * an operational role that cannot browse the library may still render a
 * photo already referenced by a record their own permission (menu.view,
 * inventory.view, ledger.view, parties.view) already lets them see.
 * Purchases reuse inventory.view — the same permission that already gates
 * GET /api/inventory/purchases — rather than a fourth permission just for
 * this.
 */
export async function getMediaAssetUsage(assetId: string): Promise<MediaAssetUsage> {
  const [
    { rows: menuItems },
    { rows: inventoryItems },
    { rows: expenses },
    { rows: purchases },
    { rows: parties },
  ] = await Promise.all([
    query<MediaAssetUsageRef>(`SELECT id, name FROM menu_items WHERE image_media_id = $1 ORDER BY name`, [assetId]),
    query<MediaAssetUsageRef>(`SELECT id, name FROM inventory_items WHERE image_media_id = $1 ORDER BY name`, [
      assetId,
    ]),
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
  ]);
  return { menuItems, inventoryItems, expenses, purchases, parties };
}

export function mediaAssetUsageIsEmpty(usage: MediaAssetUsage): boolean {
  return (
    usage.menuItems.length === 0 &&
    usage.inventoryItems.length === 0 &&
    usage.expenses.length === 0 &&
    usage.purchases.length === 0 &&
    usage.parties.length === 0
  );
}

/** The distinct categories and tags in use — the filter dropdowns. */
export async function listMediaFacets(businessId: string) {
  const [{ rows: categories }, { rows: tags }] = await Promise.all([
    query<{ category: string }>(
      `SELECT DISTINCT category FROM media_assets WHERE business_id = $1 AND category IS NOT NULL ORDER BY category`,
      [businessId],
    ),
    query<{ tag: string }>(
      `SELECT DISTINCT unnest(tags) AS tag FROM media_assets WHERE business_id = $1 ORDER BY tag`,
      [businessId],
    ),
  ]);
  return { categories: categories.map((r) => r.category), tags: tags.map((r) => r.tag) };
}

export async function getMediaAsset(businessId: string, id: string): Promise<MediaAssetRecord | null> {
  const { rows } = await query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM media_assets WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );
  return rows[0] ? rowToAsset(rows[0]) : null;
}

export interface MediaAssetLineageEntry {
  id: string;
  fileName: string;
  variant: MediaAssetVariant;
  transformOps: unknown[];
  /** A trashed ancestor/descendant is still shown — the chain is history, not a live listing. */
  deletedAt: string | null;
}

export interface MediaAssetLineage {
  /**
   * Root-first: the asset this one (transitively) derives from, down to its
   * immediate parent. Empty when the asset is itself an `original` with no
   * `sourceAssetId` — most assets in the library.
   */
  ancestors: MediaAssetLineageEntry[];
  /**
   * Assets whose own `sourceAssetId` points directly at this one — one level,
   * not the whole subtree. A crop of an enhance and an upscale of the same
   * enhance are siblings here, each with its own (possibly longer) chain of
   * its own descendants that this call does not walk into.
   */
  descendants: MediaAssetLineageEntry[];
}

/** `getMediaAssetLineage` never trusts a chain to terminate on its own. */
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

/**
 * The version-history walk the asset drawer's "lineage" panel renders: every
 * deterministic transform (crop/rotate/resize) and every AI edit
 * (enhance/bg-remove/upscale/variation) creates a new, separate asset with
 * `source_asset_id` pointing at the one it was made from — never an in-place
 * mutation, so the original is always still there. Nothing before this
 * function ever walked that chain more than one hop; a crop of an enhance of
 * the original upload had no way to show its full history, only its
 * immediate parent.
 *
 * Tenant-scoped at every hop, not only at the start: `getMediaAsset` re-checks
 * `business_id` on each step, so a `source_asset_id` that somehow pointed
 * across a tenant boundary (never expected, never trusted) simply ends the
 * chain there rather than leaking a foreign row.
 */
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
 * Store bytes + row. The key is BUILT here from the caller's businessId —
 * never accepted from a request — which together with `keyBelongsToBusiness`
 * on every read is the whole tenant-isolation story inside the one bucket.
 * The S3 put happens before the row insert; a failed put leaves no row, a
 * failed insert leaves an unreferenced object the next delete sweep may
 * ignore (S3 storage is idempotent per assetId, so re-upload overwrites).
 */
export async function storeMediaAsset(input: {
  businessId: string;
  userId: string | null;
  config: MediaStorageConfig;
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  sha256: string;
  folderId?: string | null;
  variant?: MediaAssetVariant;
  sourceAssetId?: string | null;
  /** Migration 0175 — which deterministic transform(s) produced this asset. */
  transformOps?: unknown[];
  /** Phase G — provenance. Defaults preserve the historic "human upload". */
  source?: MediaAssetSource;
  createdByAi?: boolean;
  conversationId?: string | null;
  projectId?: string | null;
}): Promise<MediaAssetRecord> {
  const { rows: idRows } = await query<{ id: string }>(`SELECT gen_random_uuid() AS id`);
  const assetId = idRows[0].id;
  const key = buildMediaKey(input.config.keyPrefix, input.businessId, assetId, input.fileName);

  await s3Put(s3ConfigOf(input.config), key, input.bytes);

  // The bytes are the assistant's own only for a generated image; an
  // ai_attachment is a user's file the assistant merely handled, so it is not
  // AI-authored. Derive the flag from source unless the caller overrides it.
  const source = input.source ?? "upload";
  const createdByAi = input.createdByAi ?? source === "ai_generated";

  const { rows } = await query<AssetRow>(
    `INSERT INTO media_assets
       (id, business_id, folder_id, kind, file_name, mime_type, byte_size, storage_key, sha256,
        variant, source_asset_id, created_by, source, created_by_ai, conversation_id, project_id, transform_ops)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
     RETURNING ${ASSET_COLUMNS}`,
    [
      assetId,
      input.businessId,
      input.folderId ?? null,
      input.kind,
      input.fileName.slice(0, 200),
      input.mimeType,
      input.bytes.byteLength,
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
}

/**
 * The object's bytes, for serving/enhancing — after the fail-closed key check.
 */
export async function readMediaObject(
  businessId: string,
  assetId: string,
  config: MediaStorageConfig,
): Promise<{ asset: MediaAssetRecord; bytes: Buffer } | null> {
  // A trashed asset is not servable through the normal read path — it is on
  // its way out (recoverable only through restore, not through "someone
  // still has the link"). Menu/inventory items that pointed at it may show a
  // broken image until restored or repointed; that is the same trade-off a
  // hard delete already made, just reversible now.
  const { rows } = await query<AssetRow & { storage_key: string }>(
    `SELECT ${ASSET_COLUMNS}, storage_key FROM media_assets WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
    [assetId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!keyBelongsToBusiness(row.storage_key, config.keyPrefix, businessId)) return null;
  const bytes = await s3Get(s3ConfigOf(config), row.storage_key);
  return { asset: rowToAsset(row), bytes };
}

/**
 * A short-lived URL straight to the object in the bucket — for the one case
 * `readMediaObject` cannot serve: a fetch that has to come from outside this
 * app entirely (a WordPress site's own `media_sideload_image`, not a browser
 * with a session cookie). Same fail-closed tenant check as every other read
 * path; the difference is what happens after it passes — a signature good
 * for `expiresSeconds`, not a proxied response.
 *
 * This hands the bucket's bytes to whoever holds the URL for that window,
 * unauthenticated — acceptable only because the caller already required its
 * own authorization (owner/manager pushing a specific asset they can already
 * browse) before minting one, and the window is minutes, not hours.
 */
export async function readMediaObjectDownloadUrl(
  businessId: string,
  assetId: string,
  config: MediaStorageConfig,
  expiresSeconds: number,
): Promise<{ asset: MediaAssetRecord; url: string } | null> {
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

/**
 * Move to the trash — the default outcome of a library delete. The row and
 * the stored object are both left exactly as they are; only `deleted_at` is
 * stamped, so `restoreMediaAsset` can undo this at any point up to the
 * retention sweep (`runMediaTrashPurgeTick`). Returns false when the asset
 * does not exist or is already trashed (idempotent — a repeated request is
 * not an error).
 */
export async function softDeleteMediaAsset(businessId: string, assetId: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `UPDATE media_assets SET deleted_at = now()
      WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [assetId, businessId],
  );
  return rows.length > 0;
}

/** Undo a trash: clears `deleted_at` so the asset is a normal library item again. */
export async function restoreMediaAsset(businessId: string, assetId: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `UPDATE media_assets SET deleted_at = NULL, updated_at = now()
      WHERE id = $1 AND business_id = $2 AND deleted_at IS NOT NULL
      RETURNING id`,
    [assetId, businessId],
  );
  return rows.length > 0;
}

/**
 * Permanent delete — the row AND the stored object are gone for good. The
 * catalogue FK (`image_media_id`) is `ON DELETE SET NULL`, so the database
 * itself never ends up with a dangling reference. Callers (the DELETE route's
 * `?purge=1`, and the retention sweep) are responsible for only reaching this
 * once an asset is already in the trash — this function itself does not
 * re-check that, so it also serves the historic "delete right now" callers
 * inside tests and scripts that intentionally skip the trash.
 */
export async function deleteMediaAsset(
  businessId: string,
  assetId: string,
  config: MediaStorageConfig,
): Promise<boolean> {
  const { rows } = await query<{ storage_key: string }>(
    `DELETE FROM media_assets WHERE id = $1 AND business_id = $2 RETURNING storage_key`,
    [assetId, businessId],
  );
  const key = rows[0]?.storage_key;
  if (!key) return false;
  if (keyBelongsToBusiness(key, config.keyPrefix, businessId)) {
    await s3Delete(s3ConfigOf(config), key).catch(() => {
      // The row is gone, so the asset is gone for every user; a stranded
      // object costs storage until the operator prunes, never data exposure.
    });
  }
  return true;
}

/**
 * The retention sweep: purge every asset that has been in the trash longer
 * than `retentionDays`. Same shape as `runMediaBillingTick` — enumerate under
 * the platform bypass (no tenant session drives a background tick), then do
 * each business's actual work inside `withTenant` so RLS still applies to
 * every statement.
 */
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
// Collections — a named ad hoc set, distinct from a folder's single tree slot
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

/** Deleting a collection only disbands the grouping — its assets are untouched. */
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

/** Which collections a given asset currently belongs to — for the asset drawer. */
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

/**
 * Record that this canonical asset has been queued to push out to this
 * connection — called at enqueue time, before the plugin confirms anything.
 * `ON CONFLICT` re-uses the existing mapping row for a re-push instead of
 * creating a second one, matching the schema's one-mapping-per-(asset,
 * connection) rule.
 */
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
     DO UPDATE SET operation_id = EXCLUDED.operation_id, status = 'pending', last_error = NULL
     RETURNING ${WP_MAPPING_COLUMNS}`,
    [input.businessId, input.mediaAssetId, input.connectionId, input.operationId],
  );
  return rowToWpMapping(rows[0]);
}

/** The plugin confirmed the attachment landed — fill in its remote identity. */
export async function confirmWordPressMediaSync(
  operationId: string,
  wpMediaId: string,
  wpUrl: string,
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `UPDATE wordpress_media_mapping
        SET status = 'synced', wp_media_id = $2, wp_url = $3, synced_at = now(), last_error = NULL
      WHERE operation_id = $1
      RETURNING id`,
    [operationId, wpMediaId, wpUrl],
  );
  return rows.length > 0;
}

export async function failWordPressMediaSync(operationId: string, errorMessage: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `UPDATE wordpress_media_mapping SET status = 'failed', last_error = $2 WHERE operation_id = $1 RETURNING id`,
    [operationId, errorMessage],
  );
  return rows.length > 0;
}

/** Every connection a canonical asset has already been pushed to — the "already on your site" badge. */
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

/**
 * The zero usage, with every key present. Callers that need a fallback shape
 * (a billing read that must not fail when the media tables are unreachable)
 * use this rather than hand-writing `{ byKind: {} }` — a partial shape is what
 * made `usage.byKind.image.count` throw in the UI's recovery path.
 */
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

/** Today's local (Asia/Tehran) calendar day as YYYY-MM-DD — the charge key. */
export function localBillingDay(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

/**
 * The media billing tick: for every business storing anything, claim today's
 * charge row and debit the wallet. Idempotent per (business, local day) —
 * the UNIQUE claim means a second tick the same day does nothing — and an
 * empty wallet rolls the claim back so tomorrow's tick retries.
 */
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
        if (!claimed[0]) return; // already billed today
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
            dimensions: { day, storedBytes: bytes, flatRial: breakdown.flatRial, perGbRial: breakdown.perGbRial },
          }).catch((error) => {
            console.error("media usage event failed:", holder.business_id, error);
          });
          charged += 1;
        } catch (error) {
          // A wallet that cannot cover today must be billable tomorrow.
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
