import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { authorize, denialResponse } from "@/lib/authorize";

/**
 * Sellable items (variants, not families) with stock, for the purchase/transfer
 * pickers.
 *
 * P0 branch security: `?locationId` is a *request* to look at a branch, never a
 * grant. The request is authorized against the membership before any item is
 * read, so a member restricted to branch A cannot enumerate B's catalogue by
 * naming B's id — they get the same refusal the rest of the stock module gives.
 * The query also carries the tenant boundary explicitly, so an item row whose
 * branch belongs to another business can never surface even if the id is right.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const session = guard.session;

  const active = await resolveActiveLocation(session);
  const requestedLocation = request.nextUrl.searchParams.get("locationId");
  const locationId = requestedLocation || active?.id;
  if (!locationId) return NextResponse.json({ items: [] });

  const decision = await authorize(session, { locationId });
  if (!decision.ok) return denialResponse(decision);

  const { rows } = await query<{
    id: string;
    name: string;
    sku: string | null;
    tracking: string;
    quantity: string;
    unit_cost: string | null;
    unit_price: string | null;
  }>(
    `SELECT i.id, i.name, i.sku, i.tracking,
            COALESCE(s.quantity, 0)::text AS quantity,
            s.unit_cost::text, s.unit_price::text
       FROM items i
       JOIN locations l ON l.id = i.location_id
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.location_id = $1 AND l.business_id = $2
        AND i.kind <> 'variant_parent' AND i.is_active
      ORDER BY i.name`,
    [locationId, session.businessId],
  );

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
  });
});
