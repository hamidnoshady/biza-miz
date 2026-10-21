import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse } from "@/lib/authorize";

/**
 * Phase 42b — the lots (`item_batches`) of one item at one branch, for the
 * issue form's per-line lot select: a حواله line relieves a named lot at that
 * lot's own cost, so the picker needs the lot numbers with their quantity,
 * cost and expiry. `?item=` is required; `?branch=` (or `locationId`) targets
 * the warehouse and defaults to the session's active location.
 *
 * P0 branch security: authorizes the branch before returning batches and
 * verifies the item belongs to that branch.
 * P1 exact costing: returns batch id alongside number for stable selection.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const session = guard.session;

  const url = new URL(request.url);
  const itemId = url.searchParams.get("item") ?? url.searchParams.get("itemId") ?? "";
  if (!itemId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!isUuid(itemId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const defaultLocation = await resolveActiveLocation(session);
  const locationId =
    url.searchParams.get("branch") || url.searchParams.get("locationId") || defaultLocation?.id || "";
  if (!locationId) return NextResponse.json({ batches: [] });
  if (!isUuid(locationId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // Authorize the branch — staff allowed only branch A must not enumerate B's lots
  const decision = await authorize(session, { locationId });
  if (!decision.ok) return denialResponse(decision);

  // Verify item belongs to this business/branch; otherwise return empty (not 500)
  const { rows: itemRows } = await query<{ id: string }>(
    `SELECT i.id FROM items i JOIN locations l ON l.id = i.location_id WHERE i.id = $1 AND i.location_id = $2 AND l.business_id = $3`,
    [itemId, locationId, session.businessId],
  );
  if (itemRows.length === 0) {
    return NextResponse.json({ batches: [] });
  }

  const { rows } = await query<{
    id: string;
    batch_number: string;
    expiry_date: string | null;
    quantity: string;
    unit_cost: string | null;
  }>(
    `SELECT b.id, b.batch_number, b.expiry_date::text AS expiry_date,
            b.quantity::text AS quantity, b.unit_cost::text
       FROM item_batches b
       JOIN items i ON i.id = b.item_id
      WHERE b.item_id = $1 AND i.location_id = $2
      ORDER BY b.expiry_date NULLS LAST, b.batch_number`,
    [itemId, locationId],
  );

  return NextResponse.json({
    batches: rows.map((r) => ({
      id: r.id,
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date,
      quantity: r.quantity,
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      // P2 UX: expose availability for stock-before/after display
      displayQuantity: r.quantity,
    })),
  });
});
