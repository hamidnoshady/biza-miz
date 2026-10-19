import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";

type Context = { params: Promise<{ id: string }> };

/**
 * Issue #918 — one received purchase as the return voucher sees it: the
 * header (supplier, warehouse, status), every receipt line with its
 * received/previously-returned/remaining quantities, and the in-stock serials
 * a serialized line can still name. The voucher editor builds its eligible
 * lines from this; the POST re-validates everything server-side, so this is
 * guidance, not authority.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: Context) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "purchase_not_found" }, { status: 404 });

  const { rows: purchases } = await query<{
    id: string;
    supplier_id: string | null;
    supplier_name: string | null;
    status: string;
    location_id: string;
    location_name: string;
    note: string | null;
    total: string;
    received_at: string;
  }>(
    `SELECT p.id, p.supplier_id, s.name AS supplier_name, p.status::text AS status,
            p.location_id, l.name AS location_name, p.note,
            p.total::text AS total, p.received_at
       FROM item_purchases p
       JOIN locations l ON l.id = p.location_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.id = $2 AND p.business_id = $1`,
    [session.businessId, id],
  );
  const purchase = purchases[0];
  // A foreign tenant's purchase id is simply one that does not exist here.
  if (!purchase) return NextResponse.json({ error: "purchase_not_found" }, { status: 404 });

  const { rows: lines } = await query<{
    purchase_item_id: string;
    item_id: string;
    item_name: string;
    sku: string | null;
    tracking: string;
    quantity_received: string;
    unit_cost: string;
    batch_number: string | null;
    expiry_date: string | null;
    quantity_returned: string;
  }>(
    `SELECT pi.id AS purchase_item_id, pi.item_id, i.name AS item_name, i.sku,
            i.tracking::text AS tracking,
            pi.quantity::text AS quantity_received, pi.unit_cost::text AS unit_cost,
            pi.batch_number, pi.expiry_date::text AS expiry_date,
            COALESCE((
              SELECT SUM(li.quantity)::text FROM item_supplier_return_items li
              JOIN item_supplier_returns r ON r.id = li.return_id
              WHERE r.purchase_id = p.id AND r.status = 'posted'
                AND (li.purchase_item_id = pi.id OR (li.purchase_item_id IS NULL AND li.item_id = pi.item_id))
            ), '0') AS quantity_returned
       FROM item_purchase_items pi
       JOIN item_purchases p ON p.id = pi.purchase_id
       JOIN items i ON i.id = pi.item_id
      WHERE p.id = $1 AND p.business_id = $2
      ORDER BY i.name, pi.id`,
    [id, session.businessId],
  );

  // Serial-tracked lines name exact units: the still-on-the-shelf serials of
  // this purchase's serial items. Legacy units without per-unit provenance
  // (purchase_id NULL) are listed too — the POST applies the item-level
  // fallback check to them, so the picker and the guard agree.
  const { rows: serials } = await query<{
    item_id: string;
    serial_id: string;
    serial_number: string;
    unit_cost: string | null;
  }>(
    `SELECT DISTINCT sn.item_id, sn.id AS serial_id, sn.serial_number, sn.unit_cost::text AS unit_cost
       FROM item_serials sn
       JOIN items i ON i.id = sn.item_id
       JOIN item_purchase_items pi ON pi.item_id = sn.item_id AND pi.purchase_id = $1
      WHERE sn.status = 'in_stock'
        AND (sn.purchase_id = $1 OR sn.purchase_id IS NULL)
        AND i.tracking = 'serial'
      ORDER BY sn.serial_number`,
    [id],
  );

  return NextResponse.json({
    purchase,
    lines: lines.map((l) => ({ ...l, purchase_item_id: l.purchase_item_id })),
    availableSerials: serials,
  });
});
