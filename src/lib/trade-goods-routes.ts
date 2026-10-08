/**
 * Phase 38 — shared Next.js route handlers for wholesale / tools & fittings /
 * haberdashery.
 *
 * Each industry gets its own URL namespace (`/api/wholesale`,
 * `/api/tools-fittings`, `/api/haberdashery`) and its own stricter industry
 * guard (`requireIndustryForApi`). The route *logic* is identical across the
 * three, so it is written once here and each route file binds it to its
 * industry. This keeps the per-trade modules thin while the ledger still gets
 * a trade-specific sale event.
 */
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, type SessionPayload } from "./auth";
import { getPool } from "./db";
import { createItem, createVariantChild, getItem } from "./items-service";
import { validateVariantAttributes, type VariantAttributeInput } from "./items";
import { recordItemEvent } from "./item-audit-service";
import { setInitialUnitCost } from "./accessories-service";
import { resolveActiveLocation } from "./setup-state";
import { requireIndustryForApi } from "./industry-guard";
import { MissingLedgerAccountError } from "./ledger-service";
import { variantSalesAnalysis } from "./industry-reports-service";
import type { SettlementMethod } from "./ledger";
import {
  listVariantBoard,
  receiveTradeGoodsStock,
  sellTradeGoodsUnits,
  setTradeGoodsUnitPrice,
} from "./trade-goods-service";
import { tradeGoodsEventPrefix, type TradeGoodsIndustry } from "./trade-goods";

export type RoleGuard = () => Promise<{ session: SessionPayload; error: null } | { session: null; error: NextResponse }>;

const PAYMENT_METHODS: SettlementMethod[] = ["cash", "bank", "credit"];

/** The trade-goods board: every family and variant at this branch, with attributes, stock and pricing. */
export function tradeGoodsItemsGet(industry: TradeGoodsIndustry, roleGuard: RoleGuard) {
  return withTenantScope(async () => {
    const { session, error } = await roleGuard();
    if (error) return error;
    const industryError = await requireIndustryForApi(session, industry);
    if (industryError) return industryError;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ items: [] });

    const items = await listVariantBoard(location.id);
    return NextResponse.json({ items });
  });
}

export function tradeGoodsItemsPost(industry: TradeGoodsIndustry, roleGuard: RoleGuard) {
  return withTenantScope(async (request: NextRequest) => {
    const { session, error } = await roleGuard();
    if (error) return error;
    const industryError = await requireIndustryForApi(session, industry);
    if (industryError) return industryError;

    let body: { name?: string; sku?: string | null; parentItemId?: string | null; attributes?: VariantAttributeInput[] };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const name = body.name?.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    if (!body.parentItemId) {
      const item = await createItem({
        locationId: location.id,
        name,
        sku: body.sku?.trim() || null,
        kind: "variant_parent",
      });
      return NextResponse.json({ ok: true, item });
    }

    const parent = await getItem(body.parentItemId);
    if (!parent || parent.locationId !== location.id || parent.kind !== "variant_parent") {
      return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    }

    const attributes = body.attributes ?? [];
    const attributeErrors = validateVariantAttributes(attributes);
    if (attributeErrors.length > 0) {
      return NextResponse.json(
        { error: "invalid_attributes", message: attributeErrors.join("؛ ") },
        { status: 400 },
      );
    }

    const item = await createVariantChild(
      parent.id,
      location.id,
      name,
      body.sku?.trim() || null,
      attributes,
    );
    return NextResponse.json({ ok: true, item });
  });
}

async function ownedItem(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const item = await getItem(id);
  if (!item || item.locationId !== location.id) return null;
  return item;
}

/** Receives units into stock (rolling the average cost forward) and/or sets the shelf price. */
export function tradeGoodsItemStockPost(industry: TradeGoodsIndustry, roleGuard: RoleGuard) {
  return withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await roleGuard();
    if (error) return error;
    const industryError = await requireIndustryForApi(session, industry);
    if (industryError) return industryError;
    const { id } = await context.params;

    const item = await ownedItem(session, id);
    if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

    let body: { quantity?: string; unitCost?: number; unitPrice?: number };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    try {
      if (body.unitPrice != null) {
        await setTradeGoodsUnitPrice(id, Number(body.unitPrice));
        await recordItemEvent({
          businessId: session.businessId,
          locationId: item.locationId,
          itemId: id,
          eventType: "item.price_changed",
          payload: { unitPrice: Number(body.unitPrice) },
          createdBy: session.sub,
        });
      }
      const stock = body.quantity != null
        ? await receiveTradeGoodsStock(id, { quantity: String(body.quantity), unitCost: Number(body.unitCost ?? 0) })
        : null;
      // A purchase price sent without a quantity (the price-list editor's
      // «قیمت خرید» column) is not a receipt. It may set the opening cost of
      // an item with nothing on hand, and is refused once stock exists —
      // before this it answered `ok` and wrote nothing.
      if (body.quantity == null && body.unitCost != null) {
        await setInitialUnitCost(id, Number(body.unitCost));
      }
      if (stock) {
        await recordItemEvent({
          businessId: session.businessId,
          locationId: item.locationId,
          itemId: id,
          eventType: "item.stock_received",
          payload: {
            quantity: String(body.quantity),
            unitCost: Number(body.unitCost ?? 0),
            quantityOnHand: stock.quantity,
            averageUnitCost: stock.unitCost,
          },
          createdBy: session.sub,
        });
      }
      return NextResponse.json({ ok: true, stock });
    } catch (err) {
      return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
    }
  });
}

/** Sells units of one variant: revenue, COGS and the stock decrement in one transaction. */
export function tradeGoodsItemSellPost(industry: TradeGoodsIndustry, roleGuard: RoleGuard) {
  return withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await roleGuard();
    if (error) return error;
    const industryError = await requireIndustryForApi(session, industry);
    if (industryError) return industryError;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
    const item = await getItem(id);
    if (!item || item.locationId !== location.id) {
      return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    }

    let body: {
      quantity?: string;
      unitPrice?: number;
      discount?: number;
      vatPercent?: number;
      paymentMethod?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const paymentMethod = body.paymentMethod as SettlementMethod;
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
    }
    const vatPercent = Number(body.vatPercent ?? 0);
    if (!Number.isFinite(vatPercent)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await sellTradeGoodsUnits(client, {
        trade: industry,
        businessId: session.businessId,
        locationId: location.id,
        itemId: id,
        quantity: String(body.quantity ?? "1"),
        unitPrice: body.unitPrice != null ? Number(body.unitPrice) : undefined,
        discount: Number(body.discount ?? 0),
        vatPercent,
        paymentMethod,
        createdBy: session.sub,
      });
      await client.query("COMMIT");
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof MissingLedgerAccountError) {
        return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
      }
      return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
    } finally {
      client.release();
    }
  });
}

/** تحلیل فروش تنوع‌ها — which variants actually sell, read straight off the trade's sale events. */
export function tradeGoodsReportsGet(industry: TradeGoodsIndustry, roleGuard: RoleGuard) {
  return withTenantScope(async (request: NextRequest) => {
    const { session, error } = await roleGuard();
    if (error) return error;
    const industryError = await requireIndustryForApi(session, industry);
    if (industryError) return industryError;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ rows: [] });

    const params = request.nextUrl.searchParams;
    const rows = await variantSalesAnalysis(session.businessId, location.id, {
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
      eventPrefix: tradeGoodsEventPrefix(industry),
    });
    return NextResponse.json({ rows });
  });
}
