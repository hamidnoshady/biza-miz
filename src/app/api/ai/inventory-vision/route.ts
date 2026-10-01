import { NextRequest, NextResponse } from "next/server";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import {
  AiWalletInsufficientError,
  gateAiTurn,
  newAiRequestId,
  settleAiTurn,
} from "@/lib/ai-wallet-billing";
import { parseReceiptImageDataUrl } from "@/lib/ai-receipt";
import { InventoryVisionError, runInventoryVisionCount } from "@/lib/ai-inventory-vision-service";
import { requireManager, resolveActiveLocation } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { withTenantScope } from "@/lib/auth";

/**
 * Metered AI tagging/counting for the visual stock counter — the same shape
 * as /api/ai/invoice-ocr. Owner/manager only. The image is a one-shot data
 * URL and is never persisted here: saving an AI-proposed reference profile is
 * a separate, explicit POST to /api/inventory/visual-profiles the operator
 * confirms in the UI. Credits are reserved up front at maxTurnRial and
 * settled against actual usage.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireManager(PERMISSIONS.inventoryAdjust);
  if (guard.error) return guard.error;
  const session = guard.session;

  let body: { image?: unknown; dataUrl?: unknown; inventoryItemId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const rawImage = body.image ?? body.dataUrl;
  const dataUrl = typeof rawImage === "string" ? rawImage : null;
  const parsed = parseReceiptImageDataUrl(dataUrl);
  if (!parsed) {
    return NextResponse.json(
      { error: "attachment_invalid", message: "فرمت یا حجم تصویر پشتیبانی نمی‌شود." },
      { status: 400 },
    );
  }

  if (typeof body.inventoryItemId !== "string" || !body.inventoryItemId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({ error: "no_location", message: "شعبه‌ای ثبت نشده است." }, { status: 409 });
  }

  const { rows: items } = await query<{ id: string; name: string; unit: string }>(
    "SELECT id, name, unit FROM inventory_items WHERE id = $1 AND location_id = $2 AND is_active",
    [body.inventoryItemId, location.id],
  );
  const item = items[0];
  if (!item) {
    return NextResponse.json({ error: "item_not_found", message: "این قلم در این شعبه پیدا نشد." }, { status: 404 });
  }

  const config = await resolveAiConfigFor(session.businessId, location.id, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, { businessId: session.businessId, locationId: location.id, surface: "inventory_vision" });
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
    const result = await runInventoryVisionCount({
      config,
      dataUrl: parsed.dataUrl,
      itemName: item.name,
      unit: item.unit,
    });

    const settlement = await settleAiTurn({
      businessId: session.businessId,
      requestId,
      config,
      usage: result.usage,
      costUsd: result.costUsd,
      attribution: {
        requestType: "vision",
        model: config.model,
        locationId: location.id,
        userId: session.sub,
        metadata: { kind: "inventory_vision" },
      },
    });

    return NextResponse.json({
      ok: true,
      count: result.count,
      confidence: result.confidence,
      box: result.box,
      comment: result.comment,
      usage: result.usage,
      costRial: settlement.chargedRial,
    });
  } catch (err) {
    // Phase B — no reservation to refund. A failed turn that never reached the
    // provider costs nothing and settles nothing.
    if (err instanceof InventoryVisionError) {
      const status =
        err.code === "ai_auth" ? 502 : err.code === "ai_timeout" || err.code === "ai_network" ? 504 : 422;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }
});
