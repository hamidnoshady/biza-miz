import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { BranchError, createBranch } from "@/lib/branch-service";
import { stockNeedsAttentionSql } from "@/lib/retail-stock";

/**
 * Phase 42b — the retail warehouse module's view of the business's branches.
 *
 * A warehouse (انبار) is a branch: retail items, their stock and every
 * warehouse document live per location (`items.location_id`). GET is the
 * «لیست انبارها» list with per-warehouse statistics on the retail model —
 * item count, stock value (Σ item_stock.quantity × unit_cost, the same
 * figure the stock-levels footer totals), low-stock count (the
 * classifyStockLevel rule) and the last stock touch; POST is «افزودن انبار»,
 * delegating to the same `createBranch` service the branches screen uses
 * (one write path for locations).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const { rows } = await query<{
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    is_active: boolean;
    created_at: string;
    item_count: string;
    stock_value_rial: string;
    low_stock_count: string;
    last_movement_at: string | null;
  }>(
    `SELECT l.id, l.name, l.address, l.phone, l.is_active, l.created_at,
        (SELECT count(*) FROM items i
          WHERE i.location_id = l.id AND i.is_active AND i.kind <> 'variant_parent')::text AS item_count,
        /* Keep all summary figures aligned with the visible stock screen:
         * inactive items and variant families are not sellable inventory. */
        (SELECT COALESCE(sum(COALESCE(s.quantity * s.unit_cost, 0)), 0)::text
           FROM item_stock s JOIN items i ON i.id = s.item_id
          WHERE i.location_id = l.id AND i.is_active AND i.kind <> 'variant_parent')::text AS stock_value_rial,
        (SELECT count(*)
           FROM items i
           LEFT JOIN item_stock s ON s.item_id = i.id
          WHERE i.location_id = l.id AND i.is_active AND i.kind <> 'variant_parent'
            AND ${stockNeedsAttentionSql("COALESCE(s.quantity, 0)", "COALESCE(s.reorder_point, 0)")})::text AS low_stock_count,
        (SELECT max(s.updated_at) FROM item_stock s JOIN items i ON i.id = s.item_id
          WHERE i.location_id = l.id AND i.is_active AND i.kind <> 'variant_parent') AS last_movement_at
       FROM locations l
      WHERE l.business_id = $1
      ORDER BY l.created_at`,
    [session.businessId],
  );

  return NextResponse.json({ warehouses: rows });
});

/**
 * «افزودن انبار» — create a location. Same gate as the rest of the stock
 * module; the write itself is branch-service's createBranch, so the branches
 * screen and this one can never drift apart.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (typeof input.name !== "string") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (
    (input.address !== undefined && input.address !== null && typeof input.address !== "string") ||
    (input.phone !== undefined && input.phone !== null && typeof input.phone !== "string")
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!input.name.trim()) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  try {
    const { locationId } = await createBranch({
      businessId: session.businessId,
      name: input.name,
      address: input.address as string | null | undefined,
      phone: input.phone as string | null | undefined,
      timezone: "Asia/Tehran",
      copyMenuFromLocationId: null,
      actorId: session.sub,
    });
    return NextResponse.json({ id: locationId }, { status: 201 });
  } catch (err) {
    if (err instanceof BranchError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
