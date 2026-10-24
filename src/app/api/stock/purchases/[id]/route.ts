import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Issue #915 — one retail purchase receipt in full: the header (supplier,
 * settlement, the supplier's invoice, who recorded it) and every line with
 * its item, lot and serial provenance. The history list links here, so a
 * receipt is auditable without reading the database.
 *
 * Money is decimal text end to end — a bigint Rial cost past 2^53 must
 * arrive exactly, never through `Number()`.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const { id } = await context.params;
  // A malformed id is a stable 404-shaped 400, not a Postgres cast error.
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: header } = await query<{
    id: string; status: string; total: string; vat_amount: string; note: string | null;
    received_at: string; settlement_method: string; supplier_invoice_number: string | null;
    supplier_invoice_date: string | null; payment_terms_days: number | null; payment_due_date: string | null;
    supplier_id: string | null; supplier_name: string | null; created_by_name: string | null;
  }>(
    `SELECT p.id, p.status, p.total::text, p.vat_amount::text, p.note, p.received_at,
            p.settlement_method, p.supplier_invoice_number, p.supplier_invoice_date::text,
            p.payment_terms_days, p.payment_due_date::text,
            p.supplier_id, s.name AS supplier_name, u.full_name AS created_by_name
       FROM item_purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u ON u.id = p.created_by
      WHERE p.id = $1 AND p.location_id = $2`,
    [id, location.id],
  );
  if (!header[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { rows: lines } = await query<{
    id: string; item_id: string; item_name: string; sku: string | null; tracking: string;
    quantity: string; unit_cost: string; batch_number: string | null; internal_batch_number: boolean | null;
    manufacture_date: string | null; expiry_date: string | null; supplier_reference: string | null;
    serial_number: string | null;
  }>(
    `SELECT pi.id, pi.item_id, it.name AS item_name, it.sku, it.tracking,
            pi.quantity::text, pi.unit_cost::text, pi.batch_number, pi.internal_batch_number,
            pi.manufacture_date::text, pi.expiry_date::text, pi.supplier_reference,
            sr.serial_number
       FROM item_purchase_items pi
       JOIN items it ON it.id = pi.item_id AND it.location_id = $2
       LEFT JOIN item_serials sr ON sr.id = pi.serial_id
      WHERE pi.purchase_id = $1
      ORDER BY pi.id`,
    [id, location.id],
  );

  const h = header[0];
  return NextResponse.json({
    purchase: {
      id: h.id,
      status: h.status,
      total: h.total,
      vatAmount: h.vat_amount,
      settlementMethod: h.settlement_method,
      supplierInvoiceNumber: h.supplier_invoice_number,
      supplierInvoiceDate: h.supplier_invoice_date,
      paymentTermsDays: h.payment_terms_days,
      paymentDueDate: h.payment_due_date,
      note: h.note,
      receivedAt: h.received_at,
      supplierId: h.supplier_id,
      supplierName: h.supplier_name,
      createdByName: h.created_by_name,
    },
    lines: lines.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      itemName: l.item_name,
      sku: l.sku,
      tracking: l.tracking,
      quantity: l.quantity,
      unitCost: l.unit_cost,
      batchNumber: l.batch_number,
      internalBatchNumber: Boolean(l.internal_batch_number),
      manufactureDate: l.manufacture_date,
      expiryDate: l.expiry_date,
      supplierReference: l.supplier_reference,
      serialNumber: l.serial_number,
    })),
  });
});
