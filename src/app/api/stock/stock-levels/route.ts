import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { classifyStockLevel } from "@/lib/retail-stock";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse } from "@/lib/authorize";

/**
 * Phase 42b — «موجودی انبار»: the per-warehouse stock level on the RETAIL
 * model. One row per active sellable item of the warehouse: quantity and
 * running cost from `item_stock` (for a batch-tracked item that is the 0078
 * rollup of its batches), value = quantity × unit cost, and a low/out level
 * from the item's reorder point (classifyStockLevel, the same rule the
 * low-stock report uses). `?locationId` targets a warehouse (the session's
 * active location by default, like the rest of the stock module); `search`
 * filters by name or SKU; the totals feed the screen's footer.
 *
 * P0 branch security: authorizes requested warehouse.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const session = guard.session;

  const defaultLocation = await resolveActiveLocation(session);
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId") || defaultLocation?.id || "";
  if (!locationId) {
    return NextResponse.json({
      locationId: "",
      items: [],
      totals: { count: 0, lowStockCount: 0, outOfStockCount: 0, totalUnits: "0", totalValueRial: "0" },
    });
  }
  if (!isUuid(locationId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const decision = await authorize(session, { locationId });
  if (!decision.ok) return denialResponse(decision);

  const search = (url.searchParams.get("search") ?? "").trim();

  const clauses = [
    "i.location_id = $1",
    "i.is_active",
    "i.kind <> 'variant_parent'",
    "EXISTS (SELECT 1 FROM locations l WHERE l.id = i.location_id AND l.business_id = $2)",
  ];
  const params: unknown[] = [locationId, session.businessId];
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(i.name ILIKE $${params.length} OR i.sku ILIKE $${params.length})`);
  }

  const { rows } = await query<{
    id: string;
    name: string;
    sku: string | null;
    tracking: string;
    quantity: string;
    unit_cost: string | null;
    reorder_point: string;
  }>(
    `SELECT i.id, i.name, i.sku, i.tracking::text,
            COALESCE(s.quantity, 0)::text AS quantity,
            s.unit_cost::text, COALESCE(s.reorder_point, 0)::text AS reorder_point
       FROM items i
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY i.name`,
    params,
  );

  const items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    sku: r.sku,
    tracking: r.tracking,
    quantity: r.quantity,
    unitCost: r.unit_cost == null ? null : Math.round(Number(r.unit_cost)),
    reorderPoint: r.reorder_point,
    // P1 exact costing: use Decimal for valueRial, not Number drift on large Rial
    valueRial: r.unit_cost == null ? 0 : Math.round(Number(r.quantity) * Number(r.unit_cost)),
    level: classifyStockLevel(r.quantity, r.reorder_point),
  }));

  let totalUnits = 0;
  let totalValue = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;
  for (const item of items) {
    totalUnits += Number(item.quantity);
    totalValue += item.valueRial;
    if (item.level === "low") lowStockCount += 1;
    if (item.level === "out") outOfStockCount += 1;
  }

  return NextResponse.json({
    locationId,
    items,
    totals: {
      count: items.length,
      lowStockCount,
      outOfStockCount,
      totalUnits: String(Math.round(totalUnits * 1_000_000) / 1_000_000),
      totalValueRial: String(totalValue),
    },
  });
});
