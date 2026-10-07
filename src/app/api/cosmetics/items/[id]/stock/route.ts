import { NextRequest, NextResponse } from "next/server";
import { type SessionPayload, withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import { receiveStock, setUnitPrice } from "@/lib/cosmetics-service";
import { recordItemEvent } from "@/lib/item-audit-service";

async function ownedItem(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const item = await getItem(id);
  if (!item || item.locationId !== location.id) return null;
  return item;
}

/** Receives units into stock (rolling the average cost forward) and/or sets the shelf price. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "cosmetics");
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
    // Cosmetics cost comes from each received batch, so a bare purchase price
    // (the price-list editor's «قیمت خرید» column) has nothing to update.
    if (body.quantity == null && body.unitCost != null) {
      throw new Error("قیمت خرید آرایشی از هر بچ دریافتی می‌آید؛ آن را هنگام دریافت بچ ثبت کنید.");
    }
    if (body.unitPrice != null) {
      await setUnitPrice(id, Number(body.unitPrice));
      await recordItemEvent({
        businessId: session.businessId,
        locationId: item.locationId,
        itemId: id,
        eventType: "item.price_changed",
        payload: { unitPrice: Number(body.unitPrice) },
        createdBy: session.sub,
      });
    }
    const stock =
      body.quantity != null
        ? await receiveStock(id, { quantity: String(body.quantity), unitCost: Number(body.unitCost ?? 0) })
        : null;
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
