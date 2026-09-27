import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { MAX_TRANSFORM_DIMENSION, MEDIA_MAX_BYTES, parseMediaTransformInput } from "@/lib/media";
import { MediaTransformError, applyMediaTransform } from "@/lib/media-transform";
import { getMediaConfig, isMediaStorageReady, readMediaObject, storeMediaAsset } from "@/lib/media-service";

/**
 * The lightweight Cloudinary/Canva-style tier (migration 0175): crop, rotate,
 * resize — deterministic, local (sharp), and free. Unlike `/enhance` this is
 * NOT an AI provider call, so there is no wallet debit and no preflight; the
 * only cost is this server's own CPU, bounded by MAX_TRANSFORM_DIMENSION.
 *
 * Non-destructive, same as enhance: the result is a NEW 'transformed' asset
 * row with `source_asset_id` pointing back at the original, which is never
 * modified — an operator can always go back to it, and an item/website keeps
 * pointing at whichever version it already chose until told otherwise.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;
  const { id } = await context.params;

  const config = await getMediaConfig();
  if (!isMediaStorageReady(config)) {
    return NextResponse.json({ error: "storage_not_configured" }, { status: 503 });
  }

  const stored = await readMediaObject(session.businessId, id, config).catch(() => null);
  if (!stored) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  if (stored.asset.kind !== "image" || stored.asset.mimeType === "image/svg+xml") {
    return NextResponse.json(
      { error: "not_an_image", message: "این عملیات فقط برای تصاویر در دسترس است." },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseMediaTransformInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, message: `ورودی نامعتبر است (حداکثر بعد مجاز ${MAX_TRANSFORM_DIMENSION} پیکسل).` },
      { status: 400 },
    );
  }

  let bytes: Buffer;
  try {
    bytes = await applyMediaTransform(stored.bytes, parsed.value);
  } catch (err) {
    if (err instanceof MediaTransformError) {
      const status = err.code === "out_of_bounds" ? 422 : err.code === "unsupported_image" ? 400 : 500;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }

  if (bytes.byteLength > MEDIA_MAX_BYTES.image) {
    return NextResponse.json(
      { error: "file_too_large", message: "حجم تصویر خروجی بیش از سقف مجاز است." },
      { status: 400 },
    );
  }

  const baseName = stored.asset.fileName.replace(/\.[a-z0-9]+$/i, "");
  const asset = await storeMediaAsset({
    businessId: session.businessId,
    userId: session.sub,
    config,
    kind: "image",
    fileName: `${baseName}-${parsed.value.operation}.png`,
    mimeType: "image/png",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    folderId: stored.asset.folderId,
    variant: "transformed",
    sourceAssetId: stored.asset.id,
    transformOps: [parsed.value],
  });

  return NextResponse.json({ ok: true, asset }, { status: 201 });
});
