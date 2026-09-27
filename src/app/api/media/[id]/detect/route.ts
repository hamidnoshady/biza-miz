import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import {
  AiWalletInsufficientError,
  gateAiTurn,
  newAiRequestId,
  settleAiTurn,
} from "@/lib/ai-wallet-billing";
import { MediaAiError, runMediaLabelDetection } from "@/lib/ai-media-service";
import { getMediaAsset, getMediaConfig, isMediaStorageReady, readMediaObject } from "@/lib/media-service";

/**
 * Metered AI auto-tagging for a stored image (migration 0149) — the same
 * shape as /api/ai/inventory-vision: credits are reserved up front and
 * settled against actual usage. The model's proposal lands in `ai_labels`
 * with status 'pending_review'; NOTHING is applied to the real category/tags
 * until the operator confirms through PATCH /api/media/[id] — auto-tagging
 * with user confirmation, per the product rule.
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
      { error: "not_an_image", message: "برچسب‌گذاری خودکار فقط برای تصاویر در دسترس است." },
      { status: 400 },
    );
  }

  const config = await resolveAiConfigFor(session.businessId, null, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, { businessId: session.businessId, locationId: null, surface: "media_detect" });
    return NextResponse.json(
      { error: "ai_unavailable", reason, message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  const requestId = newAiRequestId();
  try {
    await gateAiTurn(session.businessId, config);
  } catch (err) {
    if (err instanceof AiWalletInsufficientError) {
      return NextResponse.json(
        { error: "ai_credit_required", message: "اعتبار هوش مصنوعی کافی نیست. کیف پول کسب‌وکار را شارژ کنید." },
        { status: 402 },
      );
    }
    throw err;
  }

  try {
    const dataUrl = `data:${stored.asset.mimeType};base64,${stored.bytes.toString("base64")}`;
    const result = await runMediaLabelDetection({
      config,
      dataUrl,
      fileName: stored.asset.fileName,
    });

    await settleAiTurn({
      businessId: session.businessId,
      requestId,
      config,
      usage: result.usage,
      costUsd: result.costUsd,
      attribution: {
        requestType: "media_detect",
        model: config.model,
        userId: session.sub,
        metadata: { kind: "media_label", assetId: id },
      },
    });

    // The proposal, pending the operator's decision.
    await query(
      `UPDATE media_assets
          SET ai_labels = $3::jsonb, ai_status = 'pending_review', updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [id, session.businessId, JSON.stringify({ category: result.category, tags: result.tags, description: result.description })],
    );

    const updated = await getMediaAsset(session.businessId, id);
    return NextResponse.json({
      ok: true,
      proposal: { category: result.category, tags: result.tags, description: result.description },
      asset: updated,
    });
  } catch (err) {
    // Phase B — no reservation to refund; a failed turn settles nothing.
    if (err instanceof MediaAiError) {
      const status =
        err.code === "ai_auth" ? 502 : err.code === "ai_timeout" || err.code === "ai_network" ? 504 : 422;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }
});
