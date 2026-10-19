import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation, resolveActiveLocationForUser } from "@/lib/setup-state";

/** Sellable items (variants, not families) with stock, for the purchase/transfer/count pickers. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const active = await resolveActiveLocation(session);
  const requestedLocation = request.nextUrl.searchParams.get("locationId") || request.nextUrl.searchParams.get("warehouseId");
  let locationId: string | null = null;
  if (requestedLocation) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedLocation)) {
      return NextResponse.json({ error: "invalid_warehouse" }, { status: 400 });
    }
    const resolved = await resolveActiveLocationForUser(session.businessId, session.sub, requestedLocation);
    if (!resolved || resolved.id !== requestedLocation) {
      return NextResponse.json({ error: "warehouse_not_accessible" }, { status: 403 });
    }
    locationId = resolved.id;
  } else {
    locationId = active?.id ?? null;
  }
  if (!locationId) return NextResponse.json({ items: [] });

  const includeTracking = request.nextUrl.searchParams.get("includeTracking");
  const filterCounts = request.nextUrl.searchParams.get("forCounts") !== "false";

  // For count workflow (#921 P0): filter/explain unsupported tracking types.
  // By default forCounts=true, we exclude serial/weight from the count UI list
  // so the operator never sees an item they cannot count generically.
  // Callers can pass forCounts=false to get the raw catalogue.
  const trackingFilter = filterCounts
    ? `AND i.tracking IN ('none','batch')`
    : "";

  const { rows } = await query<{
    id: string;
    name: string;
    sku: string | null;
    tracking: string;
    quantity: string;
    unit_cost: string | null;
    unit_price: string | null;
  }>(
    `SELECT i.id, i.name, i.sku, i.tracking::text AS tracking,
            COALESCE(s.quantity, 0)::text AS quantity,
            s.unit_cost::text, s.unit_price::text
       FROM items i
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.location_id = $1 AND i.kind <> 'variant_parent' AND i.is_active
      ${trackingFilter}
      ORDER BY i.name`,
    [locationId],
  );

  // Provide explanation for filtered types so UI can explain why they are missing
  let filteredOut: Array<{ tracking: string; count: number }> | undefined = undefined;
  if (filterCounts) {
    const { rows: filteredRows } = await query<{ tracking: string; cnt: string }>(
      `SELECT tracking::text AS tracking, count(*)::text AS cnt
         FROM items WHERE location_id=$1 AND kind <> 'variant_parent' AND is_active
           AND tracking IN ('serial','weight')
         GROUP BY tracking`,
      [locationId],
    );
    if (filteredRows.length > 0) {
      filteredOut = filteredRows.map((r) => ({ tracking: r.tracking, count: Number(r.cnt) }));
    }
  }

  return NextResponse.json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      sku: r.sku,
      tracking: r.tracking,
      quantity: r.quantity,
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      unitPrice: r.unit_price == null ? null : Number(r.unit_price),
    })),
    filteredOut,
    meta: { locationId, trackingFilter: filterCounts ? "countable_only" : "all" },
  });
});
