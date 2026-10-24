import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { canActInLocation } from "@/lib/authorize";

type Context = { params: Promise<{ id: string }> };

/**
 * One received purchase, read by two screens:
 *
 *   • the return-voucher editor (issue #918) needs what is still returnable —
 *     received / already-returned / remaining per line, and the in-stock
 *     serials a serialized line may still name;
 *   • the purchase-history detail (issue #915) needs the receipt's own
 *     provenance — settlement, the supplier's invoice, payment terms, who
 *     recorded it, and each line's lot / serial / supplier reference.
 *
 * The body carries both namings (snake_case as the voucher editor reads it,
 * camelCase as the history reader does) on purpose: one endpoint means the two
 * screens can never disagree about what a receipt says. The voucher editor
 * re-validates everything server-side, so `availableSerials` is guidance, not
 * authority.
 *
 * Money is decimal text end to end — a bigint Rial cost past 2^53 must arrive
 * exactly, never through `Number()`.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: Context) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const { id } = await context.params;
  // A malformed id is a stable 404, not a Postgres cast error.
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
    vat_amount: string;
    settlement_method: string;
    supplier_invoice_number: string | null;
    supplier_invoice_date: string | null;
    payment_terms_days: number | null;
    payment_due_date: string | null;
    received_at: string;
    created_by_name: string | null;
  }>(
    `SELECT p.id, p.supplier_id, s.name AS supplier_name, p.status::text AS status,
            p.location_id, l.name AS location_name, p.note,
            p.total::text AS total, p.vat_amount::text AS vat_amount,
            p.settlement_method, p.supplier_invoice_number,
            p.supplier_invoice_date::text AS supplier_invoice_date,
            p.payment_terms_days, p.payment_due_date::text AS payment_due_date,
            p.received_at, u.full_name AS created_by_name
       FROM item_purchases p
       JOIN locations l ON l.id = p.location_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u ON u.id = p.created_by
      WHERE p.id = $2 AND p.business_id = $1`,
    [session.businessId, id],
  );
  const purchase = purchases[0];
  // A foreign tenant's purchase id — or one in a branch this member cannot act
  // in — is simply one that does not exist here.
  if (!purchase || !(await canActInLocation(membership, purchase.location_id))) {
    return NextResponse.json({ error: "purchase_not_found" }, { status: 404 });
  }

  const { rows: lines } = await query<{
    purchase_item_id: string;
    item_id: string;
    item_name: string;
    sku: string | null;
    tracking: string;
    quantity_received: string;
    unit_cost: string;
    batch_number: string | null;
    internal_batch_number: boolean | null;
    manufacture_date: string | null;
    expiry_date: string | null;
    supplier_reference: string | null;
    serial_number: string | null;
    quantity_returned: string;
  }>(
    `SELECT pi.id AS purchase_item_id, pi.item_id, i.name AS item_name, i.sku,
            i.tracking::text AS tracking,
            pi.quantity::text AS quantity_received, pi.unit_cost::text AS unit_cost,
            pi.batch_number, pi.internal_batch_number,
            pi.manufacture_date::text AS manufacture_date,
            pi.expiry_date::text AS expiry_date,
            pi.supplier_reference,
            sn.serial_number,
            COALESCE((
              SELECT SUM(li.quantity)::text FROM item_supplier_return_items li
              JOIN item_supplier_returns r ON r.id = li.return_id
              WHERE r.purchase_id = p.id AND r.status = 'posted'
                AND (li.purchase_item_id = pi.id OR (li.purchase_item_id IS NULL AND li.item_id = pi.item_id))
            ), '0') AS quantity_returned
       FROM item_purchase_items pi
       JOIN item_purchases p ON p.id = pi.purchase_id
       JOIN items i ON i.id = pi.item_id
       LEFT JOIN item_serials sn ON sn.id = pi.serial_id
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
    purchase: {
      // The voucher editor's snake_case half.
      ...purchase,
      // The history detail's camelCase half.
      vatAmount: purchase.vat_amount,
      settlementMethod: purchase.settlement_method,
      supplierInvoiceNumber: purchase.supplier_invoice_number,
      supplierInvoiceDate: purchase.supplier_invoice_date,
      paymentTermsDays: purchase.payment_terms_days,
      paymentDueDate: purchase.payment_due_date,
      receivedAt: purchase.received_at,
      supplierName: purchase.supplier_name,
      createdByName: purchase.created_by_name,
    },
    lines: lines.map((line) => ({
      ...line,
      // Same values under the names the history reader uses.
      id: line.purchase_item_id,
      itemName: line.item_name,
      quantity: line.quantity_received,
      unitCost: line.unit_cost,
      batchNumber: line.batch_number,
      internalBatchNumber: Boolean(line.internal_batch_number),
      manufactureDate: line.manufacture_date,
      expiryDate: line.expiry_date,
      supplierReference: line.supplier_reference,
      serialNumber: line.serial_number,
    })),
    availableSerials: serials,
  });
});
