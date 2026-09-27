/**
 * «کتابخانهٔ رسانه» — the pure contract of the platform-wide media section
 * (migration 0149). No DB, no network, no framework: every rule the routes
 * and the console enforce lives here so `media.test.ts` can pin it — the same
 * split as `platform-backup.ts` / `business-logo.ts`.
 *
 * What this module decides:
 *
 *   • what counts as an image / video / document, and the byte-signature
 *     check that keeps an attacker-controlled MIME string from becoming an
 *     `<img src>` (mirrors business-logo.ts, extended to the library's types);
 *   • the object-key grammar and the tenant-isolation rule over it: a key is
 *     always `{prefix}{businessId}/{assetId}/{safe-file-name}`, always built
 *     from the caller's tenant scope, and `keyBelongsToBusiness` is the
 *     fail-closed check every read/delete goes through before s3-lite is
 *     allowed to touch the object;
 *   • validation + masking of the console's S3/pricing config, in the shape
 *     `platform-backup.ts` established (omitted secret keeps the stored one,
 *     empty string clears it, reads only ever see a masked hint);
 *   • the daily storage-charge arithmetic: flat base + per-GB above the free
 *     quota, integer Rial, pro-rated to actual bytes — pure so the billing
 *     tick's money math is testable to the Rial.
 */

// ---------------------------------------------------------------------------
// Kinds and MIME rules
// ---------------------------------------------------------------------------

export type MediaKind = "image" | "video" | "document";

export const MEDIA_KINDS = ["image", "video", "document"] as const;

/** Hard per-file ceilings, by kind. Uploads above these are refused at the route. */
export const MEDIA_MAX_BYTES: Record<MediaKind, number> = {
  image: 10 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  document: 25 * 1024 * 1024,
};

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "text/plain",
]);

/** Which library shelf a MIME type belongs on, or null when it is not accepted at all. */
export function mediaKindForMime(mimeType: string): MediaKind | null {
  if (IMAGE_MIMES.has(mimeType)) return "image";
  if (VIDEO_MIMES.has(mimeType)) return "video";
  if (DOCUMENT_MIMES.has(mimeType)) return "document";
  return null;
}

/**
 * Byte-signature check — the multipart MIME type is attacker-controlled, so a
 * "photo" that is really a script must never be stored as one. Extends
 * business-logo.ts's rule to the library's types. Text formats (CSV/plain)
 * have no signature; they are accepted as-is but always served with a
 * download disposition, never inline.
 */
export function hasMatchingMediaSignature(mimeType: string, bytes: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((v, i) => bytes[i] === v);
  const ftypAt4 = () => bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  switch (mimeType) {
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/webp":
      return starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    case "image/svg+xml": {
      const head = new TextDecoder().decode(bytes.slice(0, 1024)).toLowerCase();
      if (!head.includes("<svg")) return false;
      const whole = new TextDecoder().decode(bytes).toLowerCase();
      return !whole.includes("<script") && !whole.includes("onload=") && !whole.includes("<foreignobject");
    }
    case "video/mp4":
    case "video/quicktime":
      // ISO BMFF: size (4 bytes) then 'ftyp'.
      return ftypAt4();
    case "video/webm":
      // EBML header.
      return starts(0x1a, 0x45, 0xdf, 0xa3);
    case "application/pdf":
      return starts(0x25, 0x50, 0x44, 0x46); // %PDF
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return starts(0x50, 0x4b, 0x03, 0x04); // ZIP local file header
    case "text/csv":
    case "text/plain":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Object keys — the tenant-isolation grammar
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A stored file name: the original, flattened to characters that are safe in
 * an S3 key and a Content-Disposition header. Persian is kept (it is the
 * user's own file name); path separators, control characters and the S3
 * troublemakers are replaced. Never empty — a name that flattens to nothing
 * becomes "file".
 */
export function safeFileName(original: string): string {
  const trimmed = original.trim().slice(0, 120);
  const flattened = trimmed
    .replace(/[/\\]/g, "-")

    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/["'`<>#%{}|^~[\]?&+=:;,\s]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return flattened || "file";
}

/** `{prefix}{businessId}/{assetId}/{fileName}` — the only key shape ever written. */
export function buildMediaKey(prefix: string, businessId: string, assetId: string, fileName: string): string {
  return `${normalizeKeyPrefix(prefix)}${businessId}/${assetId}/${safeFileName(fileName)}`;
}

/**
 * The fail-closed read/delete check: does this stored key sit under the
 * owning business's own prefix? A row that somehow carries another tenant's
 * key (or a key outside the configured prefix entirely) is refused before
 * s3-lite is allowed near it — RLS protects the row, this protects the object.
 */
export function keyBelongsToBusiness(key: string, prefix: string, businessId: string): boolean {
  const p = normalizeKeyPrefix(prefix);
  if (!key.startsWith(p)) return false;
  const rest = key.slice(p.length);
  const [owner, assetId, ...file] = rest.split("/");
  if (owner !== businessId || !UUID_RE.test(owner)) return false;
  if (!assetId || !UUID_RE.test(assetId)) return false;
  if (file.length !== 1 || !file[0]) return false;
  if (file[0].includes("..")) return false;
  return true;
}

/** Key prefixes end with exactly one '/' (or are empty = bucket root). */
export function normalizeKeyPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

// ---------------------------------------------------------------------------
// Console config — validation and masking (the platform_media_config row)
// ---------------------------------------------------------------------------

export interface MediaStorageConfig {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  billingEnabled: boolean;
  dailyFlatRial: number;
  dailyPerGbRial: number;
  freeQuotaMb: number;
  enhanceModel: string;
  enhancePriceRial: number;
}

export const DEFAULT_MEDIA_CONFIG: MediaStorageConfig = {
  enabled: false,
  endpoint: "",
  region: "us-east-1",
  bucket: "",
  keyPrefix: "media/",
  accessKeyId: "",
  secretAccessKey: "",
  billingEnabled: false,
  dailyFlatRial: 0,
  dailyPerGbRial: 0,
  freeQuotaMb: 0,
  enhanceModel: "gpt-image-1",
  enhancePriceRial: 0,
};

export interface MaskedMediaConfig extends Omit<MediaStorageConfig, "secretAccessKey"> {
  /** Never the secret — only whether one is stored. */
  secretAccessKeySet: boolean;
}

export function maskMediaConfig(config: MediaStorageConfig): MaskedMediaConfig {
  const { secretAccessKey, ...rest } = config;
  return { ...rest, secretAccessKeySet: secretAccessKey.length > 0 };
}

export type MediaConfigResult =
  | { ok: true; config: MediaStorageConfig }
  | { ok: false; error: string };

/**
 * Validate a console PUT against the stored config. Secrets follow the
 * platform convention exactly: an omitted `secretAccessKey` keeps what is
 * stored, an empty string clears it.
 *
 * Migration 0176 ownership split: this validator accepts the TECHNICAL
 * connection only (endpoint/bucket/credentials/enabled). The customer-facing
 * tariff (billingEnabled, dailyFlatRial, dailyPerGbRial, freeQuotaMb,
 * enhancePriceRial) is Billing-owned and validated by
 * `validateMediaTariffInput` — /platform/media's save keeps the stored values.
 */
export function validateMediaConfigInput(input: unknown, existing: MediaStorageConfig): MediaConfigResult {
  if (!input || typeof input !== "object") return { ok: false, error: "bad_request" };
  const body = input as Record<string, unknown>;

  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim() : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

  const enabled = bool(body.enabled, existing.enabled);
  const endpoint = str(body.endpoint, existing.endpoint);
  const region = str(body.region, existing.region) || "us-east-1";
  const bucket = str(body.bucket, existing.bucket);
  const keyPrefix = normalizeKeyPrefix(str(body.keyPrefix, existing.keyPrefix));
  const accessKeyId = str(body.accessKeyId, existing.accessKeyId);
  const secretAccessKey =
    body.secretAccessKey === undefined ? existing.secretAccessKey : String(body.secretAccessKey);

  // Tariff: Billing-owned (kept untouched by this technical save).
  const billingEnabled = existing.billingEnabled;
  const dailyFlatRial = existing.dailyFlatRial;
  const dailyPerGbRial = existing.dailyPerGbRial;
  const freeQuotaMb = existing.freeQuotaMb;
  const enhanceModel = str(body.enhanceModel, existing.enhanceModel) || "gpt-image-1";
  const enhancePriceRial = existing.enhancePriceRial;

  if (enabled) {
    if (!endpoint) return { ok: false, error: "endpoint_required" };
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return { ok: false, error: "endpoint_invalid" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "endpoint_invalid" };
    if (!bucket) return { ok: false, error: "bucket_required" };
    if (!accessKeyId || !secretAccessKey) return { ok: false, error: "credentials_required" };
  }

  return {
    ok: true,
    config: {
      enabled,
      endpoint: endpoint.replace(/\/+$/, ""),
      region,
      bucket,
      keyPrefix,
      accessKeyId,
      secretAccessKey,
      billingEnabled,
      dailyFlatRial,
      dailyPerGbRial,
      freeQuotaMb,
      enhanceModel,
      enhancePriceRial,
    },
  };
}

export interface MediaTariff {
  billingEnabled: boolean;
  dailyFlatRial: number;
  dailyPerGbRial: number;
  freeQuotaMb: number;
  enhancePriceRial: number;
}

export type MediaTariffResult =
  | { ok: true; tariff: MediaTariff }
  | { ok: false; error: string };

/**
 * Validate the customer-facing storage/media tariff — the Billing rates
 * console's write path (migration 0176 moved this ownership from
 * /platform/media to /platform/billing). The enhance *model* stays technical
 * (media console); its *price* is commercial (here).
 */
export function validateMediaTariffInput(input: unknown, existing: MediaTariff): MediaTariffResult {
  if (!input || typeof input !== "object") return { ok: false, error: "bad_request" };
  const body = input as Record<string, unknown>;

  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const money = (v: unknown, fallback: number) => {
    if (v === undefined || v === null || v === "") return fallback;
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
  };

  const billingEnabled = bool(body.billingEnabled, existing.billingEnabled);
  const dailyFlatRial = money(body.dailyFlatRial, existing.dailyFlatRial);
  const dailyPerGbRial = money(body.dailyPerGbRial, existing.dailyPerGbRial);
  const freeQuotaMb = money(body.freeQuotaMb, existing.freeQuotaMb);
  const enhancePriceRial = money(body.enhancePriceRial, existing.enhancePriceRial);

  if ([dailyFlatRial, dailyPerGbRial, freeQuotaMb, enhancePriceRial].some((n) => Number.isNaN(n))) {
    return { ok: false, error: "invalid_price" };
  }

  return {
    ok: true,
    tariff: { billingEnabled, dailyFlatRial, dailyPerGbRial, freeQuotaMb, enhancePriceRial },
  };
}

// ---------------------------------------------------------------------------
// Daily storage charge arithmetic
// ---------------------------------------------------------------------------

export interface DailyChargeBreakdown {
  flatRial: number;
  perGbRial: number;
  totalRial: number;
  /** Bytes billed at the per-GB rate (stored minus the free quota, floored at 0). */
  billableBytes: number;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/**
 * What one local day of storing `storedBytes` costs: the flat base (charged
 * whenever anything at all is stored) plus the per-GB rate pro-rated to the
 * bytes above the free quota. Integer Rial, rounded up — a fraction of a Rial
 * never rounds a paid byte to free.
 */
export function dailyStorageCharge(storedBytes: number, config: MediaStorageConfig): DailyChargeBreakdown {
  const bytes = Math.max(0, Math.floor(storedBytes));
  if (!config.billingEnabled || bytes === 0) {
    return { flatRial: 0, perGbRial: 0, totalRial: 0, billableBytes: 0 };
  }
  const flatRial = Math.max(0, Math.floor(config.dailyFlatRial));
  const billableBytes = Math.max(0, bytes - Math.max(0, config.freeQuotaMb) * MB);
  const perGbRial =
    billableBytes > 0 && config.dailyPerGbRial > 0
      ? Math.ceil((billableBytes / GB) * config.dailyPerGbRial)
      : 0;
  return { flatRial, perGbRial, totalRial: flatRial + perGbRial, billableBytes };
}

/** wallet_ledger/feature_usage key for the daily storage charge. */
export const MEDIA_STORAGE_FEATURE_KEY = "media_storage";
/** wallet_ledger/feature_usage key for one AI product-image refine. */
export const MEDIA_ENHANCE_FEATURE_KEY = "media_enhance";
/** wallet_ledger/feature_usage key for one AI background-removal edit. */
export const MEDIA_BG_REMOVE_FEATURE_KEY = "media_bg_remove";
/** wallet_ledger/feature_usage key for one AI upscale edit. */
export const MEDIA_UPSCALE_FEATURE_KEY = "media_upscale";
/** wallet_ledger/feature_usage key for one AI variations batch (charged per image produced). */
export const MEDIA_VARIATIONS_FEATURE_KEY = "media_variations";
/** How many alternates one "variations" request produces — fixed, not caller-supplied, so the cost is bounded. */
export const MEDIA_VARIATIONS_COUNT = 3;

/**
 * Every distinct value `media_assets.variant` can hold (migrations 0149,
 * 0175, 0176): the two AI-generated derived kinds this file's editing
 * operations produce (`enhanced`, plus `bg_removed`/`upscaled`/`variation`
 * from the lightweight edit operations below), the free local
 * crop/rotate/resize tier (`transformed`), and `original` for everything
 * else. All four AI/edit variants share the same shape — a new row with
 * `source_asset_id` pointing back at what it was derived from; the source is
 * never overwritten.
 */
export type MediaAssetVariant = "original" | "enhanced" | "transformed" | "bg_removed" | "upscaled" | "variation";

/**
 * How an asset entered the library (migrations 0161, 0178, 0180): a human
 * upload, a photo dropped into an AI Chat turn, an image the assistant
 * generated from scratch, a receipt photo submitted for metered OCR
 * extraction (`POST /api/ai/receipt-ocr`, 0178), or — as of 0180 — a
 * supplier-invoice photo submitted the same way (`POST /api/ai/invoice-ocr`).
 * Both `ocr_*` values are deliberately distinct from `ai_attachment` (no chat
 * turn is involved) and from each other (an accountant's receipt is not a
 * purchaser's invoice), so reporting either as "از گفت‌وگو" (from a
 * conversation) or conflating the two would be wrong.
 */
export type MediaAssetSource = "upload" | "ai_attachment" | "ai_generated" | "ocr_receipt" | "ocr_invoice";


// ---------------------------------------------------------------------------
// Folder / asset input rules shared by the routes and the client
// ---------------------------------------------------------------------------

export const MAX_FOLDER_DEPTH = 6;
export const MAX_TAGS_PER_ASSET = 20;
export const MAX_TAG_LENGTH = 60;
export const MAX_CATEGORY_LENGTH = 80;

/**
 * How long a soft-deleted ("trashed") asset stays recoverable before the
 * retention sweep (`runMediaTrashPurgeTick`, media-service.ts) removes it and
 * its stored object for good. An operator can always purge sooner by hand.
 */
export const MEDIA_TRASH_RETENTION_DAYS = 30;

/** A collection's name — same shape as a folder's (media_collections.name). */
export const MAX_COLLECTION_NAME_LENGTH = 120;
export const MAX_COLLECTION_DESCRIPTION_LENGTH = 500;

/** A cleaned tag list: trimmed, deduplicated, capped — or null when invalid. */
export function parseTags(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) return null;
    seen.add(tag);
    if (seen.size > MAX_TAGS_PER_ASSET) return null;
  }
  return [...seen];
}

/** A cleaned category, null (no category) or undefined-as-invalid. */
export function parseCategory(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const category = value.trim();
  if (!category) return null;
  if (category.length > MAX_CATEGORY_LENGTH) return undefined;
  return category;
}

/** Persian label for a media kind — the filter chips and the list column. */
export const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  image: "تصویر",
  video: "ویدیو",
  document: "سند",
};

// ---------------------------------------------------------------------------
// Sorting — the grid's "newest / oldest / name / size" order
// ---------------------------------------------------------------------------

export const MEDIA_SORTS = [
  "newest",
  "oldest",
  "name_asc",
  "name_desc",
  "largest",
  "smallest",
  "updated",
] as const;
export type MediaSort = (typeof MEDIA_SORTS)[number];

export function isMediaSort(value: unknown): value is MediaSort {
  return typeof value === "string" && (MEDIA_SORTS as readonly string[]).includes(value);
}

/** The `ORDER BY` column + direction for a sort key — one place, so the SQL and the UI agree. */
export function mediaSortOrderBy(sort: MediaSort | undefined): string {
  switch (sort) {
    case "oldest":
      return "created_at ASC";
    case "name_asc":
      return "file_name ASC";
    case "name_desc":
      return "file_name DESC";
    case "largest":
      return "byte_size DESC";
    case "smallest":
      return "byte_size ASC";
    case "updated":
      return "updated_at DESC";
    case "newest":
    default:
      return "created_at DESC";
  }
}

export const MEDIA_SORT_LABELS: Record<MediaSort, string> = {
  newest: "جدیدترین",
  oldest: "قدیمی‌ترین",
  name_asc: "نام (الف تا ی)",
  name_desc: "نام (ی تا الف)",
  largest: "بزرگ‌ترین حجم",
  smallest: "کوچک‌ترین حجم",
  updated: "به‌روزرسانی اخیر",
};

// ---------------------------------------------------------------------------
// Search normalization — mixed Persian/Arabic input, never mutating storage
// ---------------------------------------------------------------------------

/**
 * A search term, cleaned for matching: trimmed, internal whitespace
 * collapsed, capped at a sane length, and the common Arabic/Persian
 * character variants folded together (ي→ی, ك→ک, ۀ→ه, ة→ه) so a term typed on
 * an Arabic keyboard still finds a tag written with Persian letters. The
 * ORIGINAL value stored on the asset is never touched — this only shapes the
 * pattern the query matches against (see `mediaSearchExpression`).
 */
export function normalizeSearchTerm(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ةۀ]/g, "ه");
}

/** Wraps a SQL column reference with the same character-variant folding, so
 * both sides of an ILIKE compare on equal footing without rewriting the
 * stored value. */
export function mediaSearchExpression(column: string): string {
  return `translate(${column}, 'يىكةۀ', 'ییکهه')`;
}

// ---------------------------------------------------------------------------
// Folder tree safety — cycle and depth checks shared by create/move
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deterministic transforms — the lightweight Cloudinary/Canva-style tier
// (crop / rotate / resize), explicitly NOT a full image editor. Pure
// validation only; the actual pixel work (sharp) lives in media-transform.ts
// because it needs a native binding, which this dependency-free module never
// takes on.
// ---------------------------------------------------------------------------

export const MEDIA_TRANSFORM_OPERATIONS = ["crop", "rotate", "resize"] as const;
export type MediaTransformOperation = (typeof MEDIA_TRANSFORM_OPERATIONS)[number];

/** A generous but real ceiling — this is a crop/resize tool, not a canvas. */
export const MAX_TRANSFORM_DIMENSION = 4000;

export interface CropTransformParams {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface RotateTransformParams {
  degrees: number;
}
export type ResizeFit = "cover" | "contain" | "inside" | "fill";
export interface ResizeTransformParams {
  width?: number;
  height?: number;
  fit: ResizeFit;
}

export type MediaTransformInput =
  | { operation: "crop"; params: CropTransformParams }
  | { operation: "rotate"; params: RotateTransformParams }
  | { operation: "resize"; params: ResizeTransformParams };

export type MediaTransformParseResult = { ok: true; value: MediaTransformInput } | { ok: false; error: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate a transform request body with no I/O: every rule the route
 * enforces about what a legal crop/rotate/resize even looks like lives here,
 * so it is testable without an image, a database, or sharp.
 */
export function parseMediaTransformInput(input: unknown): MediaTransformParseResult {
  if (typeof input !== "object" || input === null) return { ok: false, error: "bad_request" };
  const body = input as { operation?: unknown; params?: unknown };
  const params = typeof body.params === "object" && body.params !== null ? (body.params as Record<string, unknown>) : {};

  if (body.operation === "crop") {
    const { x, y, width, height } = params;
    if (
      !isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height) ||
      !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height)
    ) {
      return { ok: false, error: "invalid_crop" };
    }
    if (x < 0 || y < 0 || width < 1 || height < 1) return { ok: false, error: "invalid_crop" };
    if (width > MAX_TRANSFORM_DIMENSION || height > MAX_TRANSFORM_DIMENSION) return { ok: false, error: "invalid_crop" };
    return { ok: true, value: { operation: "crop", params: { x, y, width, height } } };
  }

  if (body.operation === "rotate") {
    const { degrees } = params;
    if (!isFiniteNumber(degrees) || degrees === 0) return { ok: false, error: "invalid_rotate" };
    if (degrees < -360 || degrees > 360) return { ok: false, error: "invalid_rotate" };
    return { ok: true, value: { operation: "rotate", params: { degrees } } };
  }

  if (body.operation === "resize") {
    const { width, height } = params;
    const fitRaw = params.fit;
    const fit: ResizeFit = fitRaw === "cover" || fitRaw === "contain" || fitRaw === "fill" ? fitRaw : "inside";
    const hasWidth = width !== undefined;
    const hasHeight = height !== undefined;
    if (!hasWidth && !hasHeight) return { ok: false, error: "invalid_resize" };
    if (hasWidth && (!isFiniteNumber(width) || !Number.isInteger(width) || width < 1 || width > MAX_TRANSFORM_DIMENSION)) {
      return { ok: false, error: "invalid_resize" };
    }
    if (hasHeight && (!isFiniteNumber(height) || !Number.isInteger(height) || height < 1 || height > MAX_TRANSFORM_DIMENSION)) {
      return { ok: false, error: "invalid_resize" };
    }
    return {
      ok: true,
      value: {
        operation: "resize",
        params: { width: hasWidth ? (width as number) : undefined, height: hasHeight ? (height as number) : undefined, fit },
      },
    };
  }

  return { ok: false, error: "unsupported_operation" };
}

export const MEDIA_TRANSFORM_LABELS: Record<MediaTransformOperation, string> = {
  crop: "برش",
  rotate: "چرخش",
  resize: "تغییر اندازه",
};

export interface FolderNode {
  id: string;
  parentId: string | null;
}

/**
 * True when re-parenting `folderId` under `newParentId` would create a cycle:
 * moving a folder into itself, or into one of its own descendants. Pure and
 * total over any folder set — callers pass the business's own folders (RLS
 * already guarantees they belong to one tenant), so cross-tenant parents are
 * never representable here in the first place.
 */
export function folderMoveCreatesCycle(
  folders: readonly FolderNode[],
  folderId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === folderId) return true;
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cursor: string | null = newParentId;
  let hops = 0;
  const ceiling = folders.length + 1;
  while (cursor !== null && hops <= ceiling) {
    if (cursor === folderId) return true;
    cursor = byId.get(cursor)?.parentId ?? null;
    hops += 1;
  }
  return false;
}

/** 1-based depth of `folderId` in the tree (a root folder is depth 1). Guards
 * against a corrupt cycle instead of looping forever. */
export function folderDepthOf(folders: readonly FolderNode[], folderId: string | null): number {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let depth = 0;
  let cursor = folderId;
  const ceiling = folders.length + 2;
  while (cursor !== null && depth <= ceiling) {
    depth += 1;
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return depth;
}
