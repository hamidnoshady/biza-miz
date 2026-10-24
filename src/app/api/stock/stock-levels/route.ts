import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import Decimal from "decimal.js";
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
  const category = (url.searchParams.get("category") ?? "").trim() || null;
  const valuation = (url.searchParams.get("valuation") as "all" | "valued" | "missing" | null) ?? null;

  const clauses = [
    "i.location_id = $1",
    "i.is_active",
    "i.kind <> 'variant_parent'",
    "EXISTS (SELECT 1 FROM locations l WHERE l.id = i.location_id AND l.business_id = $2)",
  ];
  const params: unknown[] = [locationId, session.businessId];
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(i.name ILIKE $${params.length} OR i.sku ILIKE $${params.length} OR COALESCE(i.collection,'') ILIKE $${params.length})`);
  }
  if (category) {
    params.push(category);
    clauses.push(`COALESCE(i.collection, i.season) = $${params.length}`);
  }
  if (valuation === "valued") clauses.push("s.unit_cost IS NOT NULL");
  if (valuation === "missing") clauses.push("s.unit_cost IS NULL");

  const { rows } = await query<{
    id: string;
    name: string;
    sku: string | null;
    tracking: string;
    quantity: string;
    unit_cost: string | null;
    total_value_rial: string | null;
    reorder_point: string;
    category: string | null;
    has_missing_cost: boolean;
    value_rial_text: string;
  }>(
    `SELECT i.id, i.name, i.sku, i.tracking::text,
            COALESCE(s.quantity, 0)::text AS quantity,
            s.unit_cost::text, s.total_value_rial::text AS total_value_rial, COALESCE(s.reorder_point, 0)::text AS reorder_point,
            COALESCE(i.collection, i.season)::text AS category,
            (s.unit_cost IS NULL) AS has_missing_cost,
            COALESCE(s.total_value_rial::text, ROUND(COALESCE(s.quantity,0) * COALESCE(s.unit_cost,0))::text, '0') AS value_rial_text
       FROM items i
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY i.name`,
    params,
  );

  const items = rows.map((r) => {
    // Use stored exact total if available, else Decimal quantity*unit_cost to avoid Number drift on large Rial
    let valueRial: number;
    if (r.total_value_rial != null) {
      valueRial = Number(r.total_value_rial);
    } else if (r.unit_cost == null) {
      valueRial = 0;
    } else {
      try {
        valueRial = Number(new Decimal(r.quantity).times(r.unit_cost).toFixed(0));
      } catch {
        valueRial = Math.round(Number(r.quantity) * Number(r.unit_cost));
      }
    }
    return {
      id: r.id,
      name: r.name,
      sku: r.sku,
      tracking: r.tracking,
      quantity: r.quantity,
      unitCost: r.unit_cost == null ? null : Math.round(Number(r.unit_cost)),
      reorderPoint: r.reorder_point,
      valueRial,
      valueRialText: r.value_rial_text,
      category: r.category,
      hasMissingCost: r.has_missing_cost,
      level: classifyStockLevel(r.quantity, r.reorder_point),
    };
  });

  // Use Decimal for totals to avoid overflow and preserve fractional units
  let totalUnits = new Decimal(0);
  let totalValue = new Decimal(0);
  let lowStockCount = 0;
  let outOfStockCount = 0;
  for (const item of items) {
    totalUnits = totalUnits.plus(item.quantity);
    totalValue = totalValue.plus(item.valueRial);
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
      totalUnits: totalUnits.toFixed().replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1"),
      totalValueRial: totalValue.toFixed(0),
    },
  });
});
