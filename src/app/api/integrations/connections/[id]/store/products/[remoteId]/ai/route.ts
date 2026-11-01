import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { wooProductContentFor, PRODUCT_CONTENT_LIMITS } from "@/lib/integrations/woo-product-content";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import { AiWalletInsufficientError, gateAiTurn, newAiRequestId, settleAiTurn } from "@/lib/ai-wallet-billing";
import { ProductDescriptionError, runProductDescriptionDraft } from "@/lib/ai-product-description-service";
import type { ProductDescriptionFacts } from "@/lib/product-description-ai";

/**
 * «تولید با هوش مصنوعی» for a storefront product's text (issue #1215, P1-2).
 *
 * Deliberately **not** a call to `/api/products/items/describe`, even though
 * that route owns the same one-shot draft. That route guards on
 * `inventory.adjust` / `menu.edit` and on the Accounting product workspace: a
 * store owner maintaining what their shopfront says has neither necessarily,
 * and a website-only business has no product workspace at all. So this route
 * re-uses the conventions — permission → connection → AI-config guard →
 * wallet reserve → provider call → settle on success only — behind the
 * storefront's own ability, `woocommerce.manage`.
 *
 * It **returns text and saves nothing**. The draft is rendered beside the
 * field, the human decides, and the result reaches the store only through the
 * ordinary outbox write. There is no path from this route to a live product.
 */
const MAX_INSTRUCTION = 200;

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string; remoteId: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.woocommerceManage);
    if (error) return error;
    const { id, remoteId } = await context.params;

    const connection = await getAccessibleConnection(session, id);
    if (!connection || connection.provider !== "woocommerce") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // A paused connection is read-only by definition: spending AI credit to
    // draft text that cannot be sent anywhere is not a favour to anyone.
    if (connection.status === "paused") return NextResponse.json({ error: "connection_paused" }, { status: 409 });
    if (!/^\d{1,20}$/.test(remoteId)) {
      return NextResponse.json({ error: "invalid_remote_id" }, { status: 400 });
    }

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // An empty body is a legitimate "draft it from what the store says".
      body = {};
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
    const raw = body as Record<string, unknown>;

    let content;
    try {
      content = await wooProductContentFor(session.businessId, id, remoteId);
    } catch (err) {
      console.error("woo_product_ai_read_failed", { connectionId: id, remoteId, error: (err as Error).message });
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
    if (!content) return NextResponse.json({ error: "product_not_mapped" }, { status: 404 });

    // The model is told facts and nothing else (see product-description-ai.ts).
    // The text it is asked to improve is the *editor's current* text when the
    // screen sends one — that is what the human is looking at — falling back to
    // the store's copy on a first open.
    // A field the editor sent is what the human is looking at — including an
    // empty one, which means «this box is blank», not «use the store's copy».
    // Only an absent key falls back to what the store says.
    const existingShort =
      typeof raw.shortDescription === "string"
        ? bounded(raw.shortDescription, PRODUCT_CONTENT_LIMITS.short_description)
        : content.shortDescription;
    const existingLong =
      typeof raw.description === "string"
        ? bounded(raw.description, PRODUCT_CONTENT_LIMITS.description)
        : content.description;

    const facts: ProductDescriptionFacts = {
      name: content.name ?? bounded(raw.name, 200) ?? "",
      sku: content.sku,
      category: bounded(raw.category, 100),
      attributes: [],
      existingShort: existingShort ?? null,
      existingLong: existingLong ?? null,
      instruction: bounded(raw.instruction, MAX_INSTRUCTION),
    };
    if (!facts.name) {
      // Without a name the draft would be invented copy about an unnamed
      // product; say so instead.
      return NextResponse.json({ error: "product_name_unavailable" }, { status: 409 });
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
        surface: "woo_product_content",
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
          // Whatever this store's product is called, the ledger says which
          // WooCommerce connection the credit was spent on.
          metadata: { kind: "woo_product_content", connectionId: id, remoteId },
        },
      });
      return NextResponse.json({
        ok: true,
        draft: { shortDescription: result.shortDescription, longDescription: result.longDescription },
        costRial: settlement.chargedRial,
      });
    } catch (err) {
      // A failed turn settles nothing (nothing was reserved to refund).
      if (err instanceof ProductDescriptionError) {
        return NextResponse.json({ error: "ai_failed", message: "تولید متن ناموفق بود. دوباره تلاش کنید." }, { status: 502 });
      }
      console.error("woo_product_ai_failed", { connectionId: id, remoteId, error: (err as Error).message });
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
  },
);
