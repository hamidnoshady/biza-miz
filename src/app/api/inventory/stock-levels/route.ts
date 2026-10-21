import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse } from "@/lib/authorize";

/**
 * Phase 42 — «موجودی انبار»: the per-warehouse stock level.
 *
 * One row per active item of the warehouse, quantity from the append-only
 * stock ledger and value from v_inventory_valuation — the same canonical
 * valuation the NRV and GL reconciliation views use, so the screen, the
 * warehouse list and the balance sheet never disagree about what stock is
 * worth. `?locationId` targets a warehouse (the session's active location by
 * default, like the rest of the inventory module); `search` filters by name
 * or SKU; the response totals feed the screen's footer.
 *
 * P0 branch security: explicitly authorizes the requested warehouse.
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
      totals: { count: 0, lowStockCount: 0, outOfStockCount: 0, totalValueRial: "0" },
    });
  }
  if (!isUuid(locationId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // Authorize the requested warehouse against the caller's live branch scope
  const decision = await authorize(session, { locationId });
  if (!decision.ok) return denialResponse(decision);

  const search = (url.searchParams.get("search") ?? "").trim();

  const clauses = ["v.location_id = $1", "v.business_id = $2"];
  const params: unknown[] = [locationId, session.businessId];
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(v.item_name ILIKE $${params.length} OR ii.sku ILIKE $${params.length})`);
  }

  const { rows: items } = await query<{
    id: string;
    item_name: string;
    sku: string | null;
    unit: string;
    quantity: string;
    reorder_level: string | null;
    value_rial: string;
    unit_cost: string;
  }>(
    `SELECT ii.id, v.item_name, ii.sku, v.unit,
            v.stock_qty::text AS quantity,
            ii.reorder_level::text AS reorder_level,
            v.valuation::text AS value_rial,
            CASE WHEN v.stock_qty > 0
                 THEN ROUND(v.valuation::numeric / v.stock_qty)::text
                 ELSE ROUND(COALESCE(v.weighted_average_cost, 0))::text END AS unit_cost
       FROM v_inventory_valuation v
       JOIN inventory_items ii ON ii.id = v.inventory_item_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY v.item_name`,
    params,
  );

  const { rows: totals } = await query<{ count: string; low: string; out: string; value: string }>(
    `SELECT count(*)::text AS count,
            count(*) FILTER (WHERE ii.reorder_level IS NOT NULL AND v.stock_qty > 0 AND v.stock_qty <= ii.reorder_level)::text AS low,
            count(*) FILTER (WHERE v.stock_qty <= 0)::text AS out,
            COALESCE(sum(v.valuation),0)::text AS value
       FROM v_inventory_valuation v
       JOIN inventory_items ii ON ii.id = v.inventory_item_id
      WHERE v.location_id = $1 AND v.business_id = $2`,
    [locationId, session.businessId],
  );

  return NextResponse.json({
    locationId,
    items,
    totals: {
      count: Number(totals[0]?.count ?? 0),
      lowStockCount: Number(totals[0]?.low ?? 0),
      outOfStockCount: Number(totals[0]?.out ?? 0),
      totalValueRial: totals[0]?.value ?? "0",
    },
  });
});
