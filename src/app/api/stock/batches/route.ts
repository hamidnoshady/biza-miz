import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Phase 42b — the lots (`item_batches`) of one item at one branch, for the
 * issue form's per-line lot select: a حواله line relieves a named lot at that
 * lot's own cost, so the picker needs the lot numbers with their quantity,
 * cost and expiry. `?item=` is required; `?branch=` (or `locationId`) targets
 * the warehouse and defaults to the session's active location.
 *
 * Issue #918 — the return voucher's lot selector reuses this endpoint, so
 * each lot also carries its receipt/purchase provenance (which purchase
 * received it, when, from whom). Both the item and the branch are fenced to
 * the session's business: a foreign tenant's id answers 404, never rows.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const url = new URL(request.url);
  const itemId = url.searchParams.get("item") ?? url.searchParams.get("itemId") ?? "";
  if (!itemId || !isUuid(itemId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const defaultLocation = await resolveActiveLocation(session);
  const locationId =
    url.searchParams.get("branch") || url.searchParams.get("locationId") || defaultLocation?.id || "";
  if (!locationId) return NextResponse.json({ batches: [] });
  if (!isUuid(locationId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const { rows: scope } = await query<{ item_id: string }>(
    `SELECT i.id AS item_id
       FROM items i
       JOIN locations l ON l.id = i.location_id
      WHERE i.id = $1 AND i.location_id = $2 AND l.business_id = $3`,
    [itemId, locationId, session.businessId],
  );
  if (!scope[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });

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
       LEFT JOIN LATERAL (
         SELECT p.id AS purchase_id, p.received_at AS purchase_received_at, s.name AS supplier_name
           FROM item_purchase_items pi
           JOIN item_purchases p ON p.id = pi.purchase_id
           LEFT JOIN suppliers s ON s.id = p.supplier_id
          WHERE pi.item_id = b.item_id AND pi.batch_number = b.batch_number
          ORDER BY p.received_at DESC
          LIMIT 1
       ) prov ON true
      WHERE b.item_id = $1 AND i.location_id = $2
      ORDER BY b.expiry_date NULLS LAST, b.batch_number`,
    [itemId, locationId],
  );

  return NextResponse.json({
    batches: rows.map((r) => ({
      id: r.id,
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date,
      manufactureDate: r.manufacture_date,
      quantity: r.quantity,
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      supplierReference: r.supplier_reference,
      purchaseId: r.purchase_id,
      purchaseReceivedAt: r.purchase_received_at,
      supplierName: r.supplier_name,
    })),
  });
});
