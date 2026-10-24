import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";
import { isValidIsoDate } from "@/lib/iso-date";
import { formatJalali } from "@/lib/jalali";
import { queryReportPage } from "@/lib/report-page-query";
import { PurchaseLineError, type PurchaseItemInput } from "@/lib/purchase-lines";
import { createDraftPurchase, PurchaseServiceError } from "@/lib/purchase-service";
import { getBusinessVatPercent } from "@/lib/vat-policy-service";

const PURCHASE_STATUSES = ["draft", "ordered", "received", "cancelled"] as const;

/** `!`-escape LIKE wildcards so a typed `%`/`_` matches literally. */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[!%_]/g, (ch) => `!${ch}`);
}

/** RFC-4180 quoting plus a formula-injection guard for text cells. */
function csvCell(value: unknown, text = false): string {
  let normalized = value === null || value === undefined ? "" : String(value);
  if (text && /^[\s]*[=+@\-\t\r]/.test(normalized)) normalized = `'${normalized}`;
  return `"${normalized.replaceAll('"', '""')}"`;
}

interface PurchaseListTotals {
  goodsRial?: string;
  vatRial?: string;
}

/**
 * Purchase history, newest first (headers only — GET /api/inventory/purchases/[id]
 * has line items). Narrowed by status, supplier, purchase_date range,
 * supplier-invoice number and ingredient; both date bounds are inclusive,
 * since purchase_date is a plain date and the caller picks a date, not an
 * instant. Issue #915 phase 3: paginated via `queryReportPage` (50 per
 * page) instead of the old `LIMIT 100` that silently truncated history,
 * with the filtered set's totals on every response and `?format=csv` for a
 * full filtered export (dates in Shamsi). Malformed filters are stable
 * 400s, never raw Postgres cast errors.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  // Audit F11 — the business's own VAT rate, which the form proposes for a
  // supplier invoice's VAT (never a platform-wide assumed rate).
  const vatPercent = await getBusinessVatPercent(session.businessId);
  if (!location) {
    return NextResponse.json({
      purchases: [], vatPercent,
      totals: { count: 0, goodsRial: "0", vatRial: "0" },
      pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
    });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const supplierId = searchParams.get("supplierId");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");
  const invoiceNumber = searchParams.get("invoiceNumber")?.trim() || "";
  const itemId = searchParams.get("itemId");
  const format = searchParams.get("format");
  const pageRaw = searchParams.get("page");
  if (status && !(PURCHASE_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  if (supplierId && !isUuid(supplierId)) {
    return NextResponse.json({ error: "invalid_supplier" }, { status: 400 });
  }
  if ((dateFrom && !isValidIsoDate(dateFrom)) || (dateTo && !isValidIsoDate(dateTo))) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (invoiceNumber.length > 64) {
    return NextResponse.json({ error: "invalid_filter" }, { status: 400 });
  }
  if (itemId && !isUuid(itemId)) {
    return NextResponse.json({ error: "invalid_item" }, { status: 400 });
  }
  if (format && format !== "csv") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }
  const page = pageRaw == null ? 1 : Number(pageRaw);
  if (!Number.isInteger(page) || page < 1) {
    return NextResponse.json({ error: "invalid_page" }, { status: 400 });
  }

  const conditions = ["p.location_id = $1"];
  const params: unknown[] = [location.id];
  if (status) {
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
  if (invoiceNumber) {
    params.push(`%${escapeLikePattern(invoiceNumber)}%`);
    conditions.push(`p.supplier_invoice_number ILIKE $${params.length} ESCAPE '!'`);
  }
  if (itemId) {
    params.push(itemId);
    conditions.push(
      `EXISTS (SELECT 1 FROM purchase_items li WHERE li.purchase_id = p.id AND li.inventory_item_id = $${params.length})`,
    );
  }

  // purchase_date as text, not as a `date` node-postgres would hand back as a
  // Date at the *server's* midnight — JSON would then shift a back-dated
  // purchase a day off for any server not running in the branch's zone.
  const source = `SELECT p.id, p.status, p.total, p.note, p.supplier_id, p.ordered_at, p.received_at, p.created_at,
            p.purchase_date::text AS purchase_date,
            p.supplier_invoice_number, p.supplier_invoice_date::text AS supplier_invoice_date,
            p.vat_amount::text AS vat_amount, p.payment_terms_days, p.payment_due_date::text AS payment_due_date,
            p.settlement_method,
            s.name AS supplier_name
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE ${conditions.join(" AND ")}`;
  // Totals ride along in the SAME snapshot as the page — exact bigint sums
  // rendered as text, never Number().
  const summary = `jsonb_build_object(
          'goodsRial', COALESCE(sum(total::numeric), 0)::text,
          'vatRial', COALESCE(sum(vat_amount::numeric), 0)::text)`;
  const orderBy = "purchase_date DESC, created_at DESC, id DESC";

  type ListRow = {
    id: string; status: string; total: string; note: string | null; supplier_id: string | null;
    ordered_at: string | null; received_at: string | null; created_at: string; purchase_date: string;
    supplier_invoice_number: string | null; supplier_invoice_date: string | null; vat_amount: string;
    payment_terms_days: number | null; payment_due_date: string | null; settlement_method: string | null;
    supplier_name: string | null;
  };

  if (format === "csv") {
    // The export is the full filtered set (no page clamp) — a purchase
    // history snapshot for audit/reconciliation. Dates leave the product in
    // Shamsi like every other export; money stays exact Rial digits.
    const full = await queryReportPage<ListRow, PurchaseListTotals>(source, params, { orderBy, summary });
    const header = [
      "purchase_id", "purchase_date", "status", "supplier", "settlement_method", "supplier_invoice_number",
      "supplier_invoice_date", "payment_due_date", "total_rial", "vat_rial", "note",
    ];
    const lines = [header.map((h) => csvCell(h)).join(",")];
    for (const p of full.rows) {
      lines.push(
        [
          csvCell(p.id),
          csvCell(formatJalali(p.purchase_date)),
          csvCell(p.status),
          csvCell(p.supplier_name ?? "", true),
          csvCell(p.settlement_method ?? ""),
          csvCell(p.supplier_invoice_number ?? "", true),
          csvCell(p.supplier_invoice_date ? formatJalali(p.supplier_invoice_date) : ""),
          csvCell(p.payment_due_date ? formatJalali(p.payment_due_date) : ""),
          csvCell(p.total),
          csvCell(p.vat_amount),
          csvCell(p.note ?? "", true),
        ].join(","),
      );
    }
    // BOM so Excel opens the Persian text as UTF-8.
    return new NextResponse("\uFEFF" + lines.join("\r\n") + "\r\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="purchase-history.csv"',
        "cache-control": "private, no-store",
      },
    });
  }

  const result = await queryReportPage<ListRow, PurchaseListTotals>(source, params, { page, orderBy, summary });
  return NextResponse.json({
    purchases: result.rows,
    vatPercent,
    totals: {
      count: result.total,
      goodsRial: result.summary?.goodsRial ?? "0",
      vatRial: result.summary?.vatRial ?? "0",
    },
    pagination: result.pagination,
  });
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
