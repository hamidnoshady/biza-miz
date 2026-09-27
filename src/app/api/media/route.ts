import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  hasMatchingMediaSignature,
  isMediaSort,
  MEDIA_MAX_BYTES,
  mediaKindForMime,
  type MediaKind,
} from "@/lib/media";
import {
  findMediaAssetByHash,
  getMediaConfig,
  isMediaStorageReady,
  listMediaAssets,
  listMediaFacets,
  listMediaFolders,
  mediaUsageFor,
  storeMediaAsset,
  type MediaListFilter,
} from "@/lib/media-service";

/**
 * «کتابخانهٔ رسانه» (migration 0149) — list and upload.
 *
 * GET  — the library page's one read: assets (filtered), folders, facets
 *        (categories/tags in use) and the storage usage strip.
 * POST — multipart upload. The MIME type is verified against the file's own
 *        byte signature before anything is stored, the object key is built
 *        from the session's businessId (never the request), and the response
 *        carries the fresh asset row.
 *
 * Owner/manager only: the library holds the business's brand and document
 * files, which is back-office custody like the menu and the inventory.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const filter: MediaListFilter = {};
  const folder = params.get("folderId");
  if (folder === "root") filter.folderId = null;
  else if (folder) filter.folderId = folder;
  else filter.folderId = "any";
  const kind = params.get("kind");
  if (kind === "image" || kind === "video" || kind === "document") filter.kind = kind as MediaKind;
  const category = params.get("category");
  if (category) filter.category = category;
  const tag = params.get("tag");
  if (tag) filter.tag = tag;
  const search = params.get("search");
  if (search) filter.search = search.slice(0, 120);
  const aiStatus = params.get("aiStatus");
  if (aiStatus === "pending_review") filter.aiStatus = "pending_review";
  const source = params.get("source");
  if (
    source === "upload" ||
    source === "ai_attachment" ||
    source === "ai_generated" ||
    source === "ocr_receipt" ||
    source === "ocr_invoice"
  )
    filter.source = source;
  if (params.get("trashed") === "1") filter.trashed = true;
  const collectionId = params.get("collectionId");
  if (collectionId) filter.collectionId = collectionId;
  const sort = params.get("sort");
  if (isMediaSort(sort)) filter.sort = sort;
  const limit = Number(params.get("limit"));
  if (Number.isFinite(limit) && limit > 0) filter.limit = Math.floor(limit);
  const offset = Number(params.get("offset"));
  if (Number.isFinite(offset) && offset > 0) filter.offset = Math.floor(offset);

  const config = await getMediaConfig();
  const [listed, folders, facets, usage] = await Promise.all([
    listMediaAssets(session.businessId, filter),
    listMediaFolders(session.businessId),
    listMediaFacets(session.businessId),
    mediaUsageFor(session.businessId),
  ]);

  return NextResponse.json({
    ...listed,
    folders,
    facets,
    usage,
    storage: {
      ready: isMediaStorageReady(config),
      billingEnabled: config.billingEnabled,
      dailyFlatRial: config.dailyFlatRial,
      dailyPerGbRial: config.dailyPerGbRial,
      freeQuotaMb: config.freeQuotaMb,
      enhancePriceRial: config.enhancePriceRial,
    },
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;

  const config = await getMediaConfig();
  if (!isMediaStorageReady(config)) {
    return NextResponse.json(
      { error: "storage_not_configured", message: "فضای ذخیره‌سازی رسانه هنوز توسط مدیر پلتفرم پیکربندی نشده است." },
      { status: 503 },
    );
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing_file" }, { status: 400 });

  const kind = mediaKindForMime(file.type);
  if (!kind) {
    return NextResponse.json(
      { error: "unsupported_type", message: "این نوع فایل پشتیبانی نمی‌شود." },
      { status: 400 },
    );
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_MAX_BYTES[kind]) {
    return NextResponse.json(
      { error: "file_too_large", message: "حجم فایل بیش از سقف مجاز این نوع رسانه است." },
      { status: 400 },
    );
  }
  if (!hasMatchingMediaSignature(file.type, new Uint8Array(bytes))) {
    return NextResponse.json(
      { error: "signature_mismatch", message: "محتوای فایل با نوع اعلام‌شدهٔ آن نمی‌خواند." },
      { status: 400 },
    );
  }

  const folderIdRaw = form?.get("folderId");
  const folderId = typeof folderIdRaw === "string" && folderIdRaw ? folderIdRaw : null;
  // "Upload another copy anyway" — the picker/library UI sets this once the
  // operator has seen the duplicate notice and still wants a second object.
  const allowDuplicate = form?.get("allowDuplicate") === "1" || form?.get("allowDuplicate") === "true";

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // Tenant-scoped duplicate detection: identical bytes already in THIS
  // business's library are reused rather than written a second time, unless
  // the caller explicitly asked for another copy.
  if (!allowDuplicate) {
    const existing = await findMediaAssetByHash(session.businessId, sha256).catch(() => null);
    if (existing) {
      return NextResponse.json(
        {
          duplicate: true,
          asset: existing,
          message: "این فایل قبلاً در کتابخانهٔ رسانه وجود دارد.",
        },
        { status: 200 },
      );
    }
  }

  try {
    const asset = await storeMediaAsset({
      businessId: session.businessId,
      userId: session.sub,
      config,
      kind,
      fileName: file.name || "file",
      mimeType: file.type,
      bytes,
      sha256,
      folderId,
    });
    return NextResponse.json({ asset, duplicate: false }, { status: 201 });
  } catch (err) {
    console.error("media upload failed:", err);
    return NextResponse.json(
      { error: "storage_error", message: "ذخیره در فضای ابری ناموفق بود. تنظیمات اتصال را بررسی کنید." },
      { status: 502 },
    );
  }
});
