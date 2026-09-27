import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import { MediaAiError, runMediaVariations } from "@/lib/ai-media-service";
import { MEDIA_VARIATIONS_COUNT, MEDIA_VARIATIONS_FEATURE_KEY } from "@/lib/media";
import {
  getMediaConfig,
  isMediaStorageReady,
  readMediaObject,
  storeMediaAsset,
  type MediaAssetRecord,
} from "@/lib/media-service";
import { chargeFeatureUse, getWalletBalanceRial, WalletInsufficientFundsError } from "@/lib/wallet-service";

/**
 * Variations (migration 0176) — the one AI edit that is not a prompted
 * `/images/edits` call: the provider's `/images/variations` endpoint takes no
 * instruction and returns several different renditions of the same subject
 * from a single request. `MEDIA_VARIATIONS_COUNT` (fixed at 3, not
 * caller-supplied) bounds the provider cost of one request; the wallet is
 * preflighted and charged for that many images' worth of the same
 * platform-wide edit price `enhance`/`bg-remove`/`upscale` already use — this
 * is still "one edit-class operation", not a new pricing tier.
 *
 * Non-destructive like every other derived asset in this library: `count`
 * new `variation` rows, each with `source_asset_id` pointing back at the
 * original, which is never touched.
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
      { error: "not_an_image", message: "تنوع‌سازی فقط برای تصاویر در دسترس است." },
      { status: 400 },
    );
  }

  const config = await resolveAiConfigFor(session.businessId, null, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, { businessId: session.businessId, locationId: null, surface: "media_variations" });
    return NextResponse.json(
      { error: "ai_unavailable", reason, message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  const priceForBatchRial = mediaConfig.enhancePriceRial * MEDIA_VARIATIONS_COUNT;
  if (priceForBatchRial > 0) {
    const balanceRial = await getWalletBalanceRial(session.businessId);
    if (balanceRial < priceForBatchRial) {
      return NextResponse.json(
        { error: "insufficient_funds", message: "موجودی کیف پول برای ساخت تنوع‌های تصویر کافی نیست." },
        { status: 402 },
      );
    }
  }

  let result: Awaited<ReturnType<typeof runMediaVariations>>;
  try {
    result = await runMediaVariations({
      config,
      model: mediaConfig.enhanceModel,
      imageBytes: stored.bytes,
      mimeType: stored.asset.mimeType,
      fileName: stored.asset.fileName,
      count: MEDIA_VARIATIONS_COUNT,
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

  const actualPriceRial = mediaConfig.enhancePriceRial * result.images.length;
  if (actualPriceRial > 0) {
    try {
      await chargeFeatureUse({
        businessId: session.businessId,
        featureKey: MEDIA_VARIATIONS_FEATURE_KEY,
        priceRial: actualPriceRial,
        note: `${result.images.length} تنوع از تصویر «${stored.asset.fileName}»`,
        userId: session.sub,
        metadata: { assetId: id, count: result.images.length, metered: true },
      });
    } catch (err) {
      if (err instanceof WalletInsufficientFundsError) {
        return NextResponse.json(
          { error: "insufficient_funds", message: "موجودی کیف پول برای ساخت تنوع‌های تصویر کافی نیست." },
          { status: 402 },
        );
      }
      throw err;
    }
  }

  const baseName = stored.asset.fileName.replace(/\.[a-z0-9]+$/i, "");
  const assets: MediaAssetRecord[] = [];
  for (let i = 0; i < result.images.length; i++) {
    const bytes = result.images[i];
    const asset = await storeMediaAsset({
      businessId: session.businessId,
      userId: session.sub,
      config: mediaConfig,
      kind: "image",
      fileName: `${baseName}-variation-${i + 1}.png`,
      mimeType: "image/png",
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      folderId: stored.asset.folderId,
      variant: "variation",
      sourceAssetId: stored.asset.id,
    });
    assets.push(asset);
  }

  return NextResponse.json({ ok: true, assets }, { status: 201 });
});
