import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { isValidIsoDate } from "@/lib/iso-date";
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
 * range) and paginated (50 per page, `queryReportPage`), replacing the old
 * unconditional `LIMIT 100` that silently truncated history (issue #915).
 * Money crosses the wire as decimal text, never through `Number()` — a
 * bigint Rial total past 2^53 must arrive exactly.
 */
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
      pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
    });
  }

  const { searchParams } = new URL(request.url);
  const supplierId = searchParams.get("supplierId");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");
  const pageRaw = searchParams.get("page");
  // Malformed filters are a stable 400, never a raw Postgres cast error.
  if (supplierId && !isUuid(supplierId)) {
    return NextResponse.json({ error: "invalid_supplier" }, { status: 400 });
  }
  if ((dateFrom && !isValidIsoDate(dateFrom)) || (dateTo && !isValidIsoDate(dateTo))) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
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

  const [result, { rows: suppliers }] = await Promise.all([
    queryReportPage<{
      id: string; total: string; vat_amount: string; note: string | null; received_at: string;
      settlement_method: string; supplier_invoice_number: string | null; supplier_invoice_date: string | null;
      payment_due_date: string | null; supplier_name: string | null; line_count: string;
    }>(
      `SELECT p.id, p.total::text, p.vat_amount::text, p.note, p.received_at,
              p.settlement_method, p.supplier_invoice_number, p.supplier_invoice_date::text,
              p.payment_due_date::text, s.name AS supplier_name,
              (SELECT count(*) FROM item_purchase_items i WHERE i.purchase_id = p.id) AS line_count
         FROM item_purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE ${conditions.join(" AND ")}`,
      params,
      { page, orderBy: "received_at DESC, id DESC" },
    ),
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
