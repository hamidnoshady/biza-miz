import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { resolveActiveLocation } from "@/lib/setup-state";
import { authorize, denialResponse } from "@/lib/authorize";

/**
 * Lists an item's lots for the issue and supplier-return forms. A lot response
 * includes its stable id, current quantity/cost, and (for return vouchers) the
 * purchase receipt provenance. The requested branch is authorized before any
 * lot query; an item outside the authorized business/branch returns 404.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const session = guard.session;

  const url = new URL(request.url);
  const itemId = url.searchParams.get("item") ?? url.searchParams.get("itemId") ?? "";
  if (!itemId || !isUuid(itemId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const defaultLocation = await resolveActiveLocation(session);
  const locationId =
    url.searchParams.get("branch") || url.searchParams.get("locationId") || defaultLocation?.id || "";
  if (!locationId) return NextResponse.json({ batches: [] });
  if (!isUuid(locationId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // A user authorized for branch A must not enumerate branch B's batches.
  const decision = await authorize(session, { locationId });
  if (!decision.ok) return denialResponse(decision);

  // Fence the item to this tenant. An item in another branch of the same
  // tenant keeps the existing endpoint contract (an empty lot list), while a
  // missing/foreign-tenant id is a 404 and never reveals another tenant's rows.
  const { rows: scopedItems } = await query<{ location_id: string }>(
    `SELECT i.location_id
       FROM items i
       JOIN locations l ON l.id = i.location_id
      WHERE i.id = $1 AND l.business_id = $2`,
    [itemId, session.businessId],
  );
  if (!scopedItems[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (scopedItems[0].location_id !== locationId) return NextResponse.json({ batches: [] });

  const { rows } = await query<{
    id: string;
    batch_number: string;
    expiry_date: string | null;
    manufacture_date: string | null;
    quantity: string;
    unit_cost: string | null;
    supplier_reference: string | null;
    purchase_id: string | null;
    purchase_received_at: string | null;
    supplier_name: string | null;
  }>(
    `SELECT b.id, b.batch_number, b.expiry_date::text AS expiry_date,
            b.manufacture_date::text AS manufacture_date,
            b.quantity::text AS quantity, b.unit_cost::text,
            b.supplier_reference,
            prov.purchase_id, prov.purchase_received_at, prov.supplier_name
       FROM item_batches b
       JOIN items i ON i.id = b.item_id
       JOIN locations l ON l.id = i.location_id
       LEFT JOIN LATERAL (
         SELECT p.id AS purchase_id, p.received_at AS purchase_received_at, s.name AS supplier_name
           FROM item_purchase_items pi
           JOIN item_purchases p ON p.id = pi.purchase_id
           LEFT JOIN suppliers s ON s.id = p.supplier_id
          WHERE pi.item_id = b.item_id AND pi.batch_number = b.batch_number
          ORDER BY p.received_at DESC
          LIMIT 1
       ) prov ON true
      WHERE b.item_id = $1 AND i.location_id = $2 AND l.business_id = $3
      ORDER BY b.expiry_date NULLS LAST, b.batch_number`,
    [itemId, locationId, session.businessId],
  );

  return NextResponse.json({
    batches: rows.map((row) => ({
      id: row.id,
      batchNumber: row.batch_number,
      expiryDate: row.expiry_date,
      manufactureDate: row.manufacture_date,
      quantity: row.quantity,
      // Keep the stock-before/after field expected by the warehouse document form.
      displayQuantity: row.quantity,
      unitCost: row.unit_cost == null ? null : Number(row.unit_cost),
      supplierReference: row.supplier_reference,
      purchaseId: row.purchase_id,
      purchaseReceivedAt: row.purchase_received_at,
      supplierName: row.supplier_name,
    })),
  });
});
