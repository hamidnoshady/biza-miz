import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { PurchaseLineError, type PurchaseItemInput } from "@/lib/purchase-lines";
import { createDraftPurchase, PurchaseServiceError } from "@/lib/purchase-service";
import { getBusinessVatPercent } from "@/lib/vat-policy-service";

const PURCHASE_STATUSES = ["draft", "ordered", "received", "cancelled"] as const;

/**
 * Recent purchases, newest first (headers only — GET /api/inventory/purchases/[id]
 * has line items). Optionally narrowed by status, supplier, and a purchase_date
 * range; both bounds are inclusive, since purchase_date is a plain date and the
 * caller picks a date, not an instant.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  // Audit F11 — the business's own VAT rate, which the form proposes for a
  // supplier invoice's VAT (never a platform-wide assumed rate).
  const vatPercent = await getBusinessVatPercent(session.businessId);
  if (!location) return NextResponse.json({ purchases: [], vatPercent });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const supplierId = searchParams.get("supplierId");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");

  const conditions = ["p.location_id = $1"];
  const params: unknown[] = [location.id];
  if (status && (PURCHASE_STATUSES as readonly string[]).includes(status)) {
    params.push(status);
    conditions.push(`p.status = $${params.length}::purchase_status`);
  }
  if (supplierId) {
    params.push(supplierId);
    conditions.push(`p.supplier_id = $${params.length}::uuid`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`p.purchase_date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`p.purchase_date <= $${params.length}::date`);
  }

  // purchase_date as text, not as a `date` node-postgres would hand back as a
  // Date at the *server's* midnight — JSON would then shift a back-dated
  // purchase a day off for any server not running in the branch's zone.
  const { rows } = await query(
    `SELECT p.id, p.status, p.total, p.note, p.supplier_id, p.ordered_at, p.received_at, p.created_at,
            p.purchase_date::text AS purchase_date,
            p.supplier_invoice_number, p.supplier_invoice_date::text AS supplier_invoice_date,
            p.vat_amount::text AS vat_amount, p.payment_terms_days, p.payment_due_date::text AS payment_due_date,
            p.settlement_method,
            s.name AS supplier_name
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE ${conditions.join(" AND ")} ORDER BY p.purchase_date DESC, p.created_at DESC LIMIT 100`,
    params,
  );
  return NextResponse.json({ purchases: rows, vatPercent });
});

/**
 * Creates a draft purchase. Line validation, ownership checks, and the
 * purchase-unit -> base-unit conversion live in preparePurchaseLines so the
 * edit path (PUT /api/inventory/purchases/[id]) behaves identically.
 * unit_cost is derived from the line's total cost, not entered directly,
 * since suppliers invoice by the purchased quantity, not the base unit.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.purchasesManage);
  if (error) return error;

  let body: {
    supplierId?: string | null;
    note?: string;
    purchaseDate?: string | null;
    items?: PurchaseItemInput[];
    /** Migration 0179 — the Media asset for the invoice photo this draft was
     * scanned from (`POST /api/ai/invoice-ocr`), when applied through the
     * purchases form's OCR panel rather than typed by hand. Re-validated
     * against this business below so a stale or cross-tenant id from the
     * client can never be linked onto someone else's purchase. */
    invoiceAssetId?: string | null;
    /** Audit F11 — the supplier's invoice number/date, VAT (integer Rial), payment terms and due date. */
    invoice?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const { id, total } = await createDraftPurchase({
      locationId: location.id,
      supplierId: body.supplierId,
      note: body.note,
      purchaseDate: body.purchaseDate,
      items: body.items ?? [],
      createdBy: session.sub,
      sync: { actorRole: session.role },
      businessId: session.businessId,
      invoiceAssetId: typeof body.invoiceAssetId === "string" ? body.invoiceAssetId : null,
      invoice: body.invoice,
    });
    return NextResponse.json({ ok: true, id, total });
  } catch (err) {
    if (err instanceof PurchaseLineError || err instanceof PurchaseServiceError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
});
