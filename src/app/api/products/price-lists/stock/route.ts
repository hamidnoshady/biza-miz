import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";
import { isValidStockVersion, saveStockPrices } from "@/lib/price-lists-service";

/**
 * Batch save for sale/purchase stock prices with optimistic concurrency.
 * Complements /entries for named lists; together they provide atomic matrix save via client orchestration.
 */

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: { updates?: { itemId: string; kind: "sale" | "purchase"; price: number | null; expectedVersion?: string | null }[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const updates = body.updates ?? [];
  if (!Array.isArray(updates) || updates.length > 2000) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  for (const u of updates) {
    if (!u || typeof u.itemId !== "string" || !isUuid(u.itemId) || (u.kind !== "sale" && u.kind !== "purchase")) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (u.price !== null && (typeof u.price !== "number" || !Number.isFinite(u.price) || !Number.isInteger(u.price) || u.price < 0 || u.price > Number.MAX_SAFE_INTEGER)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (u.kind === "sale" && u.price === 0) {
      return NextResponse.json({ error: "sale_price_must_be_positive" }, { status: 400 });
    }
    if (u.expectedVersion !== undefined && u.expectedVersion !== null) {
      if (typeof u.expectedVersion !== "string" || !isValidStockVersion(u.expectedVersion)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
    }
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const result = await saveStockPrices(
    updates.map((u) => ({ itemId: u.itemId, kind: u.kind, price: u.price, expectedVersion: u.expectedVersion })),
    { locationId: location.id, businessId: session.businessId, userId: session.sub },
  );

  return NextResponse.json({ ok: true, ...result });
});

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ items: [] });

  // Return stock versions for concurrency (used by matrix)
  const { query } = await import("@/lib/db");
  const { rows } = await query<{
    item_id: string;
    quantity: string;
    unit_cost: string | null;
    unit_price: string | null;
    version: string;
    updated_at: Date;
  }>(
    `SELECT s.item_id, s.quantity::text AS quantity, s.unit_cost::text AS unit_cost, s.unit_price::text AS unit_price,
            (extract(epoch FROM s.updated_at)*1000000)::bigint::text AS version, s.updated_at
       FROM item_stock s JOIN items i ON i.id = s.item_id AND i.location_id = $1`,
    [location.id],
  );
  return NextResponse.json({
    items: rows.map((r) => ({
      itemId: r.item_id,
      quantity: r.quantity,
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      unitPrice: r.unit_price == null ? null : Number(r.unit_price),
      version: r.version,
      updatedAt: r.updated_at,
    })),
  });
});
