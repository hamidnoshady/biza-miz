import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import {
  AiWalletInsufficientError,
  gateAiTurn,
  newAiRequestId,
  settleAiTurn,
} from "@/lib/ai-wallet-billing";
import { ProductDescriptionError, runProductDescriptionDraft } from "@/lib/ai-product-description-service";
import { PRODUCT_LONG_DESCRIPTION_MAX, PRODUCT_SHORT_DESCRIPTION_MAX } from "@/lib/product-content";
import type { ProductDescriptionFacts } from "@/lib/product-description-ai";

/**
 * Metered AI draft of a product's short and long description.
 *
 * Same shape as the other one-shot AI routes (`/api/media/[id]/detect`,
 * `/api/ai/invoice-ocr`): permission → industry → branch → AI-config guard →
 * wallet reserve → the provider call → settle (success only). It **returns
 * text and saves nothing**: the form shows the draft, the owner edits it, and
 * it is stored only through the ordinary product write path. The facts come
 * from the request and are bounded here — the model is told to use nothing
 * else (see `product-description-ai.ts`).
 */
const MAX_ATTRIBUTES = 20;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function parseFacts(body: unknown): ProductDescriptionFacts | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const name = boundedText(raw.name, 200);
  if (!name) return null;
  const attributes: { name: string; value: string }[] = [];
  if (Array.isArray(raw.attributes)) {
    for (const entry of raw.attributes.slice(0, MAX_ATTRIBUTES)) {
      if (!entry || typeof entry !== "object") continue;
      const attributeName = boundedText((entry as Record<string, unknown>).name, 100);
      const attributeValue = boundedText((entry as Record<string, unknown>).value, 200);
      if (attributeName && attributeValue) attributes.push({ name: attributeName, value: attributeValue });
    }
  }
  return {
    name,
    sku: boundedText(raw.sku, 100),
    brand: boundedText(raw.brand, 100),
    category: boundedText(raw.category, 100),
    unit: boundedText(raw.unit, 50),
    attributes,
    existingShort: boundedText(raw.existingShort, PRODUCT_SHORT_DESCRIPTION_MAX),
    existingLong: boundedText(raw.existingLong, PRODUCT_LONG_DESCRIPTION_MAX),
    instruction: boundedText(raw.instruction, 200),
  };
}

export const POST = withTenantScope(async (request: NextRequest) => {
  // Whoever can create a product or edit one may ask for a draft of its text.
  const guard = await requireAnyPermission(PERMISSIONS.inventoryAdjust, PERMISSIONS.menuEdit);
  if (guard.error) return guard.error;
  const session = guard.session;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const facts = parseFacts(body);
  if (!facts) {
    return NextResponse.json(
      { error: "name_required", message: "برای ساخت توضیح، ابتدا نام محصول را وارد کنید." },
      { status: 400 },
    );
  }

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({ error: "no_location", message: "شعبه‌ای ثبت نشده است." }, { status: 409 });
  }

  const config = await resolveAiConfigFor(session.businessId, location.id, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, {
      businessId: session.businessId,
      locationId: location.id,
      surface: "product_description",
    });
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
    const result = await runProductDescriptionDraft({ config, facts });
    const settlement = await settleAiTurn({
      businessId: session.businessId,
      requestId,
      config,
      usage: result.usage,
      costUsd: result.costUsd,
      attribution: {
        requestType: "product_description",
        model: config.model,
        locationId: location.id,
        userId: session.sub,
        metadata: { kind: "product_description" },
      },
    });
    return NextResponse.json({
      ok: true,
      draft: { shortDescription: result.shortDescription, longDescription: result.longDescription },
      costRial: settlement.chargedRial,
    });
  } catch (err) {
    // A failed turn settles nothing (no reservation to refund).
    if (err instanceof ProductDescriptionError) {
      const status =
        err.code === "ai_auth" ? 502 : err.code === "ai_timeout" || err.code === "ai_network" ? 504 : 422;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }
});
