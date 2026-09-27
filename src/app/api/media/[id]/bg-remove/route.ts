import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import { MediaAiError, runMediaBackgroundRemoval } from "@/lib/ai-media-service";
import { MEDIA_BG_REMOVE_FEATURE_KEY } from "@/lib/media";
import {
  getMediaConfig,
  isMediaStorageReady,
  readMediaObject,
  storeMediaAsset,
} from "@/lib/media-service";
import { chargeFeatureUse, getWalletBalanceRial, WalletInsufficientFundsError } from "@/lib/wallet-service";

/**
 * Background removal (migration 0176) — the second lightweight AI edit
 * beyond the existing product-shot "enhance": subject kept exactly as-is,
 * background made transparent. Same shape as `enhance/route.ts` end to end
 * (same provider endpoint family, same wallet preflight-before-provider-cost
 * pattern, same non-destructive new-asset-row result) — reused verbatim
 * rather than duplicated: `runMediaBackgroundRemoval` is a one-line wrapper
 * over the same `runMediaImageEdit` enhance already used, with a different
 * prompt. Priced with the same console `enhance_price_rial`/`enhance_model`
 * as enhance — one platform-wide edit-model price, not a second config row
 * for what is, cost-wise, the identical provider call shape.
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
      { error: "not_an_image", message: "حذف پس‌زمینه فقط برای تصاویر در دسترس است." },
      { status: 400 },
    );
  }

  const config = await resolveAiConfigFor(session.businessId, null, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, { businessId: session.businessId, locationId: null, surface: "media_bg_remove" });
    return NextResponse.json(
      { error: "ai_unavailable", reason, message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  if (mediaConfig.enhancePriceRial > 0) {
    const balanceRial = await getWalletBalanceRial(session.businessId);
    if (balanceRial < mediaConfig.enhancePriceRial) {
      return NextResponse.json(
        { error: "insufficient_funds", message: "موجودی کیف پول برای حذف پس‌زمینه کافی نیست." },
        { status: 402 },
      );
    }
  }

  let result: Awaited<ReturnType<typeof runMediaBackgroundRemoval>>;
  try {
    result = await runMediaBackgroundRemoval({
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
        featureKey: MEDIA_BG_REMOVE_FEATURE_KEY,
        priceRial: mediaConfig.enhancePriceRial,
        note: `حذف پس‌زمینهٔ تصویر «${stored.asset.fileName}»`,
        userId: session.sub,
        metadata: { assetId: id, metered: true },
      });
    } catch (err) {
      if (err instanceof WalletInsufficientFundsError) {
        return NextResponse.json(
          { error: "insufficient_funds", message: "موجودی کیف پول برای حذف پس‌زمینه کافی نیست." },
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
    fileName: `${baseName}-no-bg.png`,
    mimeType: "image/png",
    bytes: result.bytes,
    sha256: createHash("sha256").update(result.bytes).digest("hex"),
    folderId: stored.asset.folderId,
    variant: "bg_removed",
    sourceAssetId: stored.asset.id,
  });

  return NextResponse.json({ ok: true, asset }, { status: 201 });
});
