import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import { MediaAiError, runMediaUpscale } from "@/lib/ai-media-service";
import { MEDIA_UPSCALE_FEATURE_KEY } from "@/lib/media";
import {
  getMediaConfig,
  isMediaStorageReady,
  readMediaObject,
  storeMediaAsset,
} from "@/lib/media-service";
import { chargeFeatureUse, getWalletBalanceRial, WalletInsufficientFundsError } from "@/lib/wallet-service";

/**
 * "Upscale" (migration 0176) — the third lightweight AI edit. Honest framing
 * matters here: this is a prompted call over the same generic
 * OpenAI-compatible `/images/edits` endpoint as enhance/background-removal,
 * not a dedicated super-resolution model, so it cannot promise a guaranteed
 * pixel multiplier — see `MEDIA_UPSCALE_PROMPT`'s own comment. It asks the
 * configured edit model to sharpen/de-noise/increase resolution while
 * preserving composition, which is what a "lightweight, Cloudinary-style"
 * upscale reasonably means without inventing a capability this platform's
 * provider contract does not actually offer.
 */
export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;
  const { id } = await context.params;

  const mediaConfig = await getMediaConfig();
  if (!isMediaStorageReady(mediaConfig)) {
    return NextResponse.json({ error: "storage_not_configured" }, { status: 503 });
  }

  const stored = await readMediaObject(session.businessId, id, mediaConfig).catch(() => null);
  if (!stored) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  if (stored.asset.kind !== "image" || stored.asset.mimeType === "image/svg+xml") {
    return NextResponse.json(
      { error: "not_an_image", message: "بزرگ‌نمایی فقط برای تصاویر در دسترس است." },
      { status: 400 },
    );
  }

  const config = await resolveAiConfigFor(session.businessId, null, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, { businessId: session.businessId, locationId: null, surface: "media_upscale" });
    return NextResponse.json(
      { error: "ai_unavailable", reason, message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  if (mediaConfig.enhancePriceRial > 0) {
    const balanceRial = await getWalletBalanceRial(session.businessId);
    if (balanceRial < mediaConfig.enhancePriceRial) {
      return NextResponse.json(
        { error: "insufficient_funds", message: "موجودی کیف پول برای بزرگ‌نمایی تصویر کافی نیست." },
        { status: 402 },
      );
    }
  }

  let result: Awaited<ReturnType<typeof runMediaUpscale>>;
  try {
    result = await runMediaUpscale({
      config,
      model: mediaConfig.enhanceModel,
      imageBytes: stored.bytes,
      mimeType: stored.asset.mimeType,
      fileName: stored.asset.fileName,
    });
  } catch (err) {
    if (err instanceof MediaAiError) {
      const status =
        err.code === "ai_auth" ? 502
        : err.code === "ai_timeout" || err.code === "ai_network" ? 504
        : err.code === "enhance_unsupported" ? 501
        : 422;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }

  if (mediaConfig.enhancePriceRial > 0) {
    try {
      await chargeFeatureUse({
        businessId: session.businessId,
        featureKey: MEDIA_UPSCALE_FEATURE_KEY,
        priceRial: mediaConfig.enhancePriceRial,
        note: `بزرگ‌نمایی تصویر «${stored.asset.fileName}»`,
        userId: session.sub,
        metadata: { assetId: id, metered: true },
      });
    } catch (err) {
      if (err instanceof WalletInsufficientFundsError) {
        return NextResponse.json(
          { error: "insufficient_funds", message: "موجودی کیف پول برای بزرگ‌نمایی تصویر کافی نیست." },
          { status: 402 },
        );
      }
      throw err;
    }
  }

  const baseName = stored.asset.fileName.replace(/\.[a-z0-9]+$/i, "");
  const asset = await storeMediaAsset({
    businessId: session.businessId,
    userId: session.sub,
    config: mediaConfig,
    kind: "image",
    fileName: `${baseName}-upscaled.png`,
    mimeType: "image/png",
    bytes: result.bytes,
    sha256: createHash("sha256").update(result.bytes).digest("hex"),
    folderId: stored.asset.folderId,
    variant: "upscaled",
    sourceAssetId: stored.asset.id,
  });

  return NextResponse.json({ ok: true, asset }, { status: 201 });
});
