import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  assertTenantFolderExists,
  dedupeOrStoreMediaAsset,
  getMediaConfig,
  isMediaStorageReady,
  listMediaAssets,
  listMediaFacets,
  listMediaFolders,
  MediaFolderNotFoundError,
  MediaInvalidFolderError,
  mediaUsageFor,
  type DuplicatePolicy,
  type MediaListFilter,
} from "@/lib/media-service";

const STREAM_SPOOL_THRESHOLD_BYTES = 1024 * 1024; // > 1 MiB spools to OS temp file instead of buffering in RAM
const MAX_MULTIPART_ENVELOPE_BYTES = Math.max(...Object.values(MEDIA_MAX_BYTES)) + 2 * 1024 * 1024;
const MIME_TOKEN_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,80}$/i;

function parseExcludeMimes(params: URLSearchParams): string[] {
  const raw = params.getAll("excludeMime");
  const out = new Set<string>();
  for (const item of raw) {
    for (const part of item.split(",")) {
      const cleaned = part.trim().toLowerCase();
      if (cleaned && MIME_TOKEN_RE.test(cleaned)) {
        out.add(cleaned);
      }
    }
  }
  return [...out];
}

interface StreamedUploadPayload {
  byteSize: number;
  sha256: string;
  bytes?: Buffer;
  tempFilePath?: string;
}

/**
 * Stream a multipart `File` chunk-by-chunk, enforcing the per-kind byte ceiling
 * and magic-byte signature while computing `sha256` incrementally. Large files
 * spool directly to a temporary disk file (`0600`) so video uploads do not hold
 * multi-hundred-MB buffers in Node heap memory.
 */
async function consumeBoundedUploadFile(
  file: File,
  kind: MediaKind,
  signal?: AbortSignal,
): Promise<
  | { ok: true; payload: StreamedUploadPayload }
  | { ok: false; status: number; error: string; message: string }
> {
  const maxBytes = MEDIA_MAX_BYTES[kind];
  if (file.size === 0 || file.size > maxBytes) {
    return {
      ok: false,
      status: file.size > maxBytes ? 413 : 400,
      error: "file_too_large",
      message: "حجم فایل بیش از سقف مجاز این نوع رسانه است.",
    };
  }

  // SVG security scan inspects markup across the small SVG text buffer; all
  // binary formats validate magic header bytes and spool cleanly to disk when large.
  const mustBufferWholeForSvg = file.type === "image/svg+xml";
  const reader = file.stream().getReader();
  const hash = createHash("sha256");

  let totalBytes = 0;
  let headerBytes = new Uint8Array(0);
  let headerChecked = false;
  let memoryChunks: Buffer[] | null = [];
  let tempFilePath: string | undefined;
  let writeStream: ReturnType<typeof createWriteStream> | null = null;

  const writeChunkToDisk = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (!writeStream) {
        reject(new Error("missing_write_stream"));
        return;
      }
      if (writeStream.write(buf)) {
        resolve();
      } else {
        writeStream.once("drain", resolve);
        writeStream.once("error", reject);
      }
    });

  const closeWriteStream = () =>
    new Promise<void>((resolve, reject) => {
      if (!writeStream) {
        resolve();
        return;
      }
      const ws = writeStream;
      writeStream = null;
      ws.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

  const cleanupTemp = async () => {
    if (writeStream) {
      writeStream.destroy();
      writeStream = null;
    }
    if (tempFilePath) {
      const p = tempFilePath;
      tempFilePath = undefined;
      await unlink(p).catch(() => {});
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        await cleanupTemp();
        throw new Error("upload_aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        await cleanupTemp();
        return {
          ok: false,
          status: 413,
          error: "file_too_large",
          message: "حجم فایل بیش از سقف مجاز این نوع رسانه است.",
        };
      }

      if (!headerChecked && !mustBufferWholeForSvg) {
        const merged = new Uint8Array(headerBytes.byteLength + value.byteLength);
        merged.set(headerBytes, 0);
        merged.set(value, headerBytes.byteLength);
        headerBytes = merged.slice(0, 64);
        if (headerBytes.byteLength >= 16) {
          headerChecked = true;
          if (!hasMatchingMediaSignature(file.type, headerBytes)) {
            await reader.cancel().catch(() => {});
            await cleanupTemp();
            return {
              ok: false,
              status: 400,
              error: "signature_mismatch",
              message: "محتوای فایل با نوع اعلام‌شدهٔ آن نمی‌خواند.",
            };
          }
        }
      }

      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      hash.update(buf);

      if (!mustBufferWholeForSvg && memoryChunks !== null && totalBytes > STREAM_SPOOL_THRESHOLD_BYTES) {
        tempFilePath = path.join(os.tmpdir(), `bizamiz-media-${process.pid}-${randomUUID()}.upload`);
        writeStream = createWriteStream(tempFilePath, { mode: 0o600 });
        for (const prev of memoryChunks) {
          await writeChunkToDisk(prev);
        }
        memoryChunks = null;
      }

      if (writeStream) {
        await writeChunkToDisk(buf);
      } else if (memoryChunks !== null) {
        memoryChunks.push(buf);
      }
    }

    await closeWriteStream();

    if (totalBytes === 0) {
      await cleanupTemp();
      return {
        ok: false,
        status: 400,
        error: "file_too_large",
        message: "حجم فایل بیش از سقف مجاز این نوع رسانه است.",
      };
    }

    if (mustBufferWholeForSvg) {
      const fullBuffer = Buffer.concat(memoryChunks ?? []);
      if (!hasMatchingMediaSignature(file.type, new Uint8Array(fullBuffer))) {
        return {
          ok: false,
          status: 400,
          error: "signature_mismatch",
          message: "محتوای فایل با نوع اعلام‌شدهٔ آن نمی‌خواند.",
        };
      }
      return {
        ok: true,
        payload: {
          byteSize: totalBytes,
          sha256: hash.digest("hex"),
          bytes: fullBuffer,
        },
      };
    }

    if (!headerChecked && !hasMatchingMediaSignature(file.type, headerBytes)) {
      await cleanupTemp();
      return {
        ok: false,
        status: 400,
        error: "signature_mismatch",
        message: "محتوای فایل با نوع اعلام‌شدهٔ آن نمی‌خواند.",
      };
    }

    return {
      ok: true,
      payload: tempFilePath
        ? { byteSize: totalBytes, sha256: hash.digest("hex"), tempFilePath }
        : { byteSize: totalBytes, sha256: hash.digest("hex"), bytes: Buffer.concat(memoryChunks ?? []) },
    };
  } catch (err) {
    await cleanupTemp();
    throw err;
  }
}

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
  const excludeMime = parseExcludeMimes(params);
  if (excludeMime.length > 0) filter.excludeMime = excludeMime;
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
  if (Number.isFinite(offset) && offset >= 0) filter.offset = Math.floor(offset);

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

  // Reject plainly oversized requests immediately from Content-Length before
  // parsing the multipart envelope into memory.
  const declaredContentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredContentLength) && declaredContentLength > MAX_MULTIPART_ENVELOPE_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", message: "حجم فایل بیش از سقف مجاز این نوع رسانه است." },
      { status: 413 },
    );
  }

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

  // Validate folder syntax AND tenant ownership BEFORE reading or uploading
  // any bytes into object storage (issue #926 P0.3).
  const folderIdRaw = form?.get("folderId");
  const rawFolderId = typeof folderIdRaw === "string" && folderIdRaw.trim() ? folderIdRaw.trim() : null;
  let folderId: string | null = null;
  try {
    folderId = await assertTenantFolderExists(session.businessId, rawFolderId);
  } catch (err) {
    if (err instanceof MediaInvalidFolderError) {
      return NextResponse.json(
        { error: "invalid_folder", message: "شناسهٔ پوشهٔ انتخاب‌شده معتبر نیست." },
        { status: 400 },
      );
    }
    if (err instanceof MediaFolderNotFoundError) {
      return NextResponse.json(
        { error: "folder_not_found", message: "پوشهٔ مورد نظر در این کسب‌وکار یافت نشد." },
        { status: 404 },
      );
    }
    throw err;
  }

  const kind = mediaKindForMime(file.type);
  if (!kind) {
    return NextResponse.json(
      { error: "unsupported_type", message: "این نوع فایل پشتیبانی نمی‌شود." },
      { status: 400 },
    );
  }

  const allowDuplicate = form?.get("allowDuplicate") === "1" || form?.get("allowDuplicate") === "true";
  const onDuplicateRaw = form?.get("onDuplicate");
  const duplicatePolicy: DuplicatePolicy = allowDuplicate
    ? "duplicate"
    : onDuplicateRaw === "move"
      ? "move"
      : onDuplicateRaw === "duplicate"
        ? "duplicate"
        : "reuse";

  let spooledTempPath: string | undefined;
  try {
    const consumed = await consumeBoundedUploadFile(file, kind, request.signal);
    if (!consumed.ok) {
      return NextResponse.json(
        { error: consumed.error, message: consumed.message },
        { status: consumed.status },
      );
    }
    spooledTempPath = consumed.payload.tempFilePath;

    const outcome = await dedupeOrStoreMediaAsset({
      businessId: session.businessId,
      userId: session.sub,
      config,
      kind,
      fileName: file.name || "file",
      mimeType: file.type,
      bytes: consumed.payload.bytes,
      filePath: consumed.payload.tempFilePath,
      byteSize: consumed.payload.byteSize,
      sha256: consumed.payload.sha256,
      folderId,
      onDuplicate: duplicatePolicy,
    });

    if (outcome.reused) {
      return NextResponse.json(
        {
          duplicate: true,
          reused: true,
          action: outcome.action,
          requestedFolderId: outcome.requestedFolderId,
          folderMismatch: outcome.folderMismatch,
          asset: outcome.asset,
          message: outcome.folderMismatch
            ? "این فایل قبلاً در پوشهٔ دیگری از کتابخانهٔ رسانه ثبت شده و نسخهٔ موجود بازاستفاده شد."
            : "این فایل قبلاً در کتابخانهٔ رسانه وجود دارد.",
        },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        asset: outcome.asset,
        duplicate: false,
        reused: false,
        action: outcome.action,
        requestedFolderId: outcome.requestedFolderId,
        folderMismatch: false,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof MediaInvalidFolderError) {
      return NextResponse.json({ error: "invalid_folder" }, { status: 400 });
    }
    if (err instanceof MediaFolderNotFoundError) {
      return NextResponse.json({ error: "folder_not_found" }, { status: 404 });
    }
    console.error("media upload failed:", err);
    return NextResponse.json(
      { error: "storage_error", message: "ذخیره در فضای ابری ناموفق بود. تنظیمات اتصال را بررسی کنید." },
      { status: 502 },
    );
  } finally {
    if (spooledTempPath) {
      await unlink(spooledTempPath).catch(() => {});
    }
  }
});
