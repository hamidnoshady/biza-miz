import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission, getSession } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { BranchError, createBranch } from "@/lib/branch-service";
import { actionableLocationIds } from "@/lib/authorize";

/**
 * Phase 42 — the warehouse module's view of the business's locations.
 *
 * A warehouse (انبار) is a branch: stock, suppliers and every warehouse
 * document live per location. This endpoint is the warehouse module's front
 * door onto that — the list with per-warehouse stock statistics, and the
 * «افزودن انبار» write path, which delegates to the same `createBranch`
 * service the branches screen uses (one write path for locations).
 *
 * P0 branch security: scopes warehouses to the member's allowed branches.
 */
export const GET = withTenantScope(async () => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const session = guard.session;

  const allowedIds = await actionableLocationIds(guard.membership);
  if (allowedIds.length === 0) {
    return NextResponse.json({ warehouses: [] });
  }

  const [{ rows: warehouses }, { rows: suppliers }] = await Promise.all([
    query<{
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
        (SELECT count(*) FROM inventory_items ii
          WHERE ii.location_id = l.id AND ii.is_active)::text AS item_count,
        (SELECT COALESCE(sum(v.valuation),0)::text
           FROM v_inventory_valuation v WHERE v.location_id = l.id)::text AS stock_value_rial,
        (SELECT count(*)
           FROM inventory_items ii
          WHERE ii.location_id = l.id AND ii.is_active
            AND ii.reorder_level IS NOT NULL
            AND COALESCE((SELECT sum(sm.quantity)
                            FROM stock_movements sm
                           WHERE sm.location_id = l.id
                             AND sm.inventory_item_id = ii.id), 0) <= ii.reorder_level
        )::text AS low_stock_count,
        (SELECT max(sm.occurred_at) FROM stock_movements sm WHERE sm.location_id = l.id) AS last_movement_at
       FROM locations l
      WHERE l.business_id = $1 AND l.id = ANY($2::uuid[])
      ORDER BY l.created_at`,
      [session.businessId, allowedIds],
    ),
    query<{ location_id: string; id: string; display_name: string }>(
      `SELECT s.location_id, s.id, COALESCE(p.name, s.name) AS display_name
         FROM suppliers s
         LEFT JOIN parties p ON p.id = s.party_id AND p.business_id = $1
        WHERE s.is_active
          AND s.location_id = ANY($2::uuid[])
        ORDER BY s.location_id, COALESCE(p.name, s.name)`,
      [session.businessId, allowedIds],
    ),
  ]);

  const suppliersByLocation = new Map<string, { id: string; name: string }[]>();
  for (const s of suppliers) {
    const list = suppliersByLocation.get(s.location_id);
    if (list) list.push({ id: s.id, name: s.display_name });
    else suppliersByLocation.set(s.location_id, [{ id: s.id, name: s.display_name }]);
  }

  return NextResponse.json({
    warehouses: warehouses.map((w) => ({
      ...w,
      suppliers: suppliersByLocation.get(w.id) ?? [],
    })),
  });
});

/**
 * «افزودن انبار» — create a location. Same gate as the rest of the inventory
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
