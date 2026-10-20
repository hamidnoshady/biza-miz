import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { isValidIsoDate } from "@/lib/iso-date";
import { formatJalali } from "@/lib/jalali";
import { resolveActiveLocation } from "@/lib/setup-state";
import { queryReportPage } from "@/lib/report-page-query";
import { getBusinessVatPercent } from "@/lib/vat-policy-service";
import { parseSupplierInvoice, PayablesInputError, type SupplierInvoiceInput } from "@/lib/payables-input";
import {
  receiveItemPurchase,
  readItemPurchaseByIdempotencyKey,
  retailRequestHash,
  RetailIdempotencyConflictError,
  RetailIdempotencyRaceError,
  RetailStockError,
  RETAIL_PURCHASE_SETTLEMENT_METHODS,
  type RetailPurchaseSettlementMethod,
} from "@/lib/retail-stock-service";
import { enqueueHolooPurchase } from "@/lib/integrations/holoo/outbox-producer";

/**
 * This branch's purchase history — server-side filtered (supplier, date
 * range, status, supplier-invoice number, item/SKU) and paginated (50 per
 * page, `queryReportPage`), replacing the old unconditional `LIMIT 100`
 * that silently truncated history (issue #915). Money crosses the wire as
 * decimal text, never through `Number()` — a bigint Rial total past 2^53
 * must arrive exactly. `?format=csv` streams the SAME filtered set as a
 * CSV download (dates in Shamsi, money as exact Rial digits), and every
 * response carries the filtered set's totals so the screen can show "N
 * purchases · X Rial" without a second query.
 *
 * There is deliberately NO warehouse filter: the retail engine scopes all
 * stock by location (`item_stock.location_id`) — the branch IS the
 * warehouse — and this list is already branch-scoped. A warehouse master
 * table does not exist in the retail model (product decision recorded in
 * ISSUE_915_PLAN.md).
 */
const RETAIL_PURCHASE_LIST_STATUSES = ["received", "cancelled"] as const;

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

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  // The business's own VAT rate, which the form proposes for a supplier
  // invoice's VAT (never a platform-wide assumed rate) — same as F&B's list.
  const vatPercent = await getBusinessVatPercent(session.businessId);
  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({
      purchases: [], suppliers: [], vatPercent,
      totals: { count: 0, goodsRial: "0", vatRial: "0" },
      pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
    });
  }

  const { searchParams } = new URL(request.url);
  const supplierId = searchParams.get("supplierId");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");
  const status = searchParams.get("status");
  const invoiceNumber = searchParams.get("invoiceNumber")?.trim() || "";
  const itemId = searchParams.get("itemId");
  const sku = searchParams.get("sku")?.trim() || "";
  const format = searchParams.get("format");
  const pageRaw = searchParams.get("page");
  // Malformed filters are a stable 400, never a raw Postgres cast error.
  if (supplierId && !isUuid(supplierId)) {
    return NextResponse.json({ error: "invalid_supplier" }, { status: 400 });
  }
  if ((dateFrom && !isValidIsoDate(dateFrom)) || (dateTo && !isValidIsoDate(dateTo))) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (status && !(RETAIL_PURCHASE_LIST_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  // 64 is the supplier_invoice_number column bound; items.sku is short too.
  if (invoiceNumber.length > 64 || sku.length > 64) {
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
  if (supplierId) {
    params.push(supplierId);
    conditions.push(`p.supplier_id = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`p.received_at >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    // Inclusive end of day: received_at is a timestamptz.
    conditions.push(`p.received_at < ($${params.length}::date + interval '1 day')`);
  }
  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (invoiceNumber) {
    params.push(`%${escapeLikePattern(invoiceNumber)}%`);
    conditions.push(`p.supplier_invoice_number ILIKE $${params.length} ESCAPE '!'`);
  }
  if (itemId) {
    params.push(itemId);
    conditions.push(
      `EXISTS (SELECT 1 FROM item_purchase_items li WHERE li.purchase_id = p.id AND li.item_id = $${params.length})`,
    );
  }
  if (sku) {
    params.push(sku);
    conditions.push(
      `EXISTS (SELECT 1 FROM item_purchase_items li JOIN items it ON it.id = li.item_id
                WHERE li.purchase_id = p.id AND lower(it.sku) = lower($${params.length}))`,
    );
  }

  const source = `SELECT p.id, p.total::text, p.vat_amount::text, p.note, p.received_at, p.status,
              p.settlement_method, p.supplier_invoice_number, p.supplier_invoice_date::text,
              p.payment_due_date::text, s.name AS supplier_name,
              (SELECT count(*) FROM item_purchase_items i WHERE i.purchase_id = p.id) AS line_count
         FROM item_purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE ${conditions.join(" AND ")}`;
  // The filtered set's totals ride along in the SAME snapshot as the page —
  // exact bigint sums rendered as text, never Number().
  const summary = `jsonb_build_object(
          'goodsRial', COALESCE(sum(total::numeric), 0)::text,
          'vatRial', COALESCE(sum(vat_amount::numeric), 0)::text)`;
  const orderBy = "received_at DESC, id DESC";

  type ListRow = {
    id: string; total: string; vat_amount: string; note: string | null; received_at: string; status: string;
    settlement_method: string; supplier_invoice_number: string | null; supplier_invoice_date: string | null;
    payment_due_date: string | null; supplier_name: string | null; line_count: string;
  };

  if (format === "csv") {
    // The export is the full filtered set (no page clamp) — a purchase
    // history snapshot for audit/reconciliation. Dates leave the product in
    // Shamsi like every other export; money stays exact Rial digits.
    const full = await queryReportPage<ListRow, PurchaseListTotals>(source, params, { orderBy, summary });
    const header = [
      "purchase_id", "received_at", "status", "supplier", "settlement_method", "supplier_invoice_number",
      "supplier_invoice_date", "payment_due_date", "goods_total_rial", "vat_rial", "line_count", "note",
    ];
    const lines = [header.map((h) => csvCell(h)).join(",")];
    for (const p of full.rows) {
      lines.push(
        [
          csvCell(p.id),
          csvCell(formatJalali(p.received_at, { withTime: true })),
          csvCell(p.status),
          csvCell(p.supplier_name ?? "", true),
          csvCell(p.settlement_method),
          csvCell(p.supplier_invoice_number ?? "", true),
          csvCell(p.supplier_invoice_date ? formatJalali(p.supplier_invoice_date) : ""),
          csvCell(p.payment_due_date ? formatJalali(p.payment_due_date) : ""),
          csvCell(p.total),
          csvCell(p.vat_amount),
          csvCell(p.line_count),
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

  const [result, { rows: suppliers }] = await Promise.all([
    queryReportPage<ListRow, PurchaseListTotals>(source, params, { page, orderBy, summary }),
    query<{ id: string; name: string }>(
      `SELECT id, name FROM suppliers WHERE location_id = $1 AND is_active ORDER BY name`,
      [location.id],
    ),
  ]);

  return NextResponse.json({
    purchases: result.rows.map((p) => ({
      id: p.id,
      /** Integer Rial as decimal text — exact past 2^53. */
      total: p.total,
      vatAmount: p.vat_amount,
      status: p.status,
      settlementMethod: p.settlement_method,
      supplierInvoiceNumber: p.supplier_invoice_number,
      supplierInvoiceDate: p.supplier_invoice_date,
      paymentDueDate: p.payment_due_date,
      note: p.note,
      receivedAt: p.received_at,
      supplierName: p.supplier_name,
      lineCount: Number(p.line_count),
    })),
    suppliers,
    vatPercent,
    totals: {
      count: result.total,
      goodsRial: result.summary?.goodsRial ?? "0",
      vatRial: result.summary?.vatRial ?? "0",
    },
    pagination: result.pagination,
  });
});

/** Receives one purchase: writes the document, receives stock, posts the settlement entry. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.purchasesManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: {
    supplierId?: string | null;
    note?: string | null;
    /**
     * Issue #915 — stable, client-generated key reused verbatim across
     * retries, so a retry after a committed-but-lost response returns the
     * original receipt instead of creating a second one.
     */
    idempotencyKey?: string | null;
    /** How the goods were paid: credit (default — AP), cash or bank. */
    settlementMethod?: string | null;
    /** The supplier invoice block (see parseSupplierInvoice). */
    invoice?: unknown;
    lines?: {
      itemId?: string;
      quantity?: string;
      /** Whole Rial — decimal text (exact past 2^53) or a safe integer. */
      unitCost?: number | string;
      /** Batch-tracked items: the real manufacturer/supplier lot number. */
      batchNumber?: string | null;
      expiryDate?: string | null;
      manufactureDate?: string | null;
      supplierReference?: string | null;
      /** Serial-tracked items: the exact physical serials this line receives (issue #795). */
      serials?: { serialNumber?: string; warrantyMonths?: number }[] | null;
    }[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return NextResponse.json({ error: "empty_purchase" }, { status: 400 });
  }
  // A unit cost is whole Rial: decimal text (the exact form for values past
  // 2^53) or a plain safe integer. Anything else is a stable 400.
  const validCost = (c: unknown) =>
    (typeof c === "string" && /^\d{1,19}$/.test(c)) || (typeof c === "number" && Number.isSafeInteger(c) && c >= 0);
  if (!body.lines.every((l) => typeof l?.itemId === "string" && isUuid(l.itemId) && l?.quantity && validCost(l?.unitCost))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (
    !body.lines.every(
      (l) =>
        (l.expiryDate == null || isValidIsoDate(l.expiryDate)) &&
        (l.manufactureDate == null || isValidIsoDate(l.manufactureDate)),
    )
  ) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  // IDs are checked for shape here so a malformed value is a stable 400, not
  // a raw Postgres cast error surfaced as a 500 (issue #915).
  const supplierId = typeof body.supplierId === "string" && body.supplierId ? body.supplierId : null;
  if (supplierId && !isUuid(supplierId)) {
    return NextResponse.json({ error: "invalid_supplier" }, { status: 400 });
  }
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (body.idempotencyKey != null && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
    return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
  }
  const settlementMethod = (body.settlementMethod ?? "credit") as RetailPurchaseSettlementMethod;
  if (!RETAIL_PURCHASE_SETTLEMENT_METHODS.includes(settlementMethod)) {
    return NextResponse.json({ error: "invalid_settlement_method" }, { status: 400 });
  }
  let invoice: SupplierInvoiceInput | null = null;
  try {
    if (body.invoice !== undefined && body.invoice !== null) invoice = parseSupplierInvoice(body.invoice);
  } catch (err) {
    if (err instanceof PayablesInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  // The hash binds the key to this tenant, branch, operation and the exact
  // payload — a retry with the same key but different content is a 409.
  const requestHash = retailRequestHash({
    operation: "stock.purchase",
    businessId: session.businessId,
    locationId: location.id,
    supplierId,
    note: body.note ?? null,
    settlementMethod,
    invoice: invoice as unknown as Record<string, unknown> | null,
    lines: body.lines,
  });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const purchase = await receiveItemPurchase(client, {
      businessId: session.businessId,
      locationId: location.id,
      supplierId,
      note: body.note,
      createdBy: session.sub,
      idempotencyKey: idempotencyKey || null,
      requestHash,
      settlementMethod,
      invoice,
      lines: body.lines as never[],
    });
    // An idempotent replay must not enqueue a second Holoo outbox entry.
    if (!purchase.duplicate) {
      await enqueueHolooPurchase(client, session.businessId, purchase.id, "item_purchase");
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, purchase });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof RetailIdempotencyRaceError) {
      // A concurrent request with the same key committed first — answer
      // from the winner exactly as an idempotent retry would.
      const winner = await readItemPurchaseByIdempotencyKey(session.businessId, err.idempotencyKey);
      if (winner && (!winner.requestHash || winner.requestHash === requestHash)) {
        return NextResponse.json({ ok: true, purchase: { id: winner.id, total: winner.total, duplicate: true } });
      }
      return NextResponse.json(
        { error: "idempotency_conflict", message: "این شناسهٔ درخواست قبلاً برای درخواست دیگری استفاده شده است." },
        { status: 409 },
      );
    }
    if (err instanceof RetailIdempotencyConflictError) {
      return NextResponse.json({ error: "idempotency_conflict", message: err.message }, { status: 409 });
    }
    const message = err instanceof RetailStockError || err instanceof Error ? err.message : "ثبت خرید ناموفق بود.";
    return NextResponse.json({ error: "purchase_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
