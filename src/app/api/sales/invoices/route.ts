import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { industryProfile } from "@/lib/industry-profile";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getBusinessDayStatus } from "@/lib/business-day-service";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import {
  createRetailInvoice,
  RetailInvoiceError,
  type CreateRetailInvoiceTenderInput,
  type RetailInvoiceLineInput,
} from "@/lib/retail-invoice-service";
import { listRetailInvoices } from "@/lib/retail-invoice/list-service";
import type { SettlementMethod } from "@/lib/ledger";
import { rialText } from "@/lib/inventory-exact";
import { enqueueHolooSaleForOrder } from "@/lib/integrations/holoo/outbox-producer";
import { ledgerSettlementFor, type PaymentSettlement } from "@/lib/payment-methods";
import { MAX_RETAIL_TENDERS } from "@/lib/retail-tenders";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { rowsToCsv, type ReportTable } from "@/lib/report-export";

const PAYMENT_METHODS: SettlementMethod[] = ["cash", "bank", "credit"];
const INVOICE_METHODS = new Set<string>(PAYMENT_METHODS);
/** A CSV export ignores pagination — this is the hard cap on how many rows one request will ever build, so a very wide filter can't exhaust memory or time out the request. */
const EXPORT_ROW_CAP = 5_000;

/** One slice of the invoice's payment, as the checkout screen sends it. */
interface RawTenderBody {
  method?: string;
  /** Rial, whole — required at the HTTP layer (the screen always knows the invoice's due amount before it posts). */
  amount?: number;
  paymentMethodId?: string | null;
  reference?: string | null;
}

function normalizedInvoiceSearch(value: string): string {
  // Cashiers commonly paste the Persian invoice number from the screen. The
  // stored order number is ASCII, so normalize only the digits and leave the
  // customer's Persian name untouched.
  return toLatinDigits(value).replace(/[٬,]/g, "").trim();
}

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * The retail industries' sale document.
 *
 * Gated on the industry's *sales model* rather than on a named industry: any
 * trade whose profile says `retail_invoice` sells this way, so adding a fifth
 * one is a profile entry rather than another branch here. F&B is refused —
 * its sale is an order ticket, and `/api/orders` is where that lives.
 */
async function requireRetailIndustry(businessId: string) {
  const industry = await getBusinessIndustry(businessId);
  if (!industry || industryProfile(industry).salesModel !== "retail_invoice") {
    return { industry: null, error: NextResponse.json({ error: "industry_mismatch" }, { status: 403 }) };
  }
  return { industry, error: null };
}

export const POST = withTenantScope(async (request: NextRequest) => {
  // Issuing a retail invoice settles it immediately (it IS the till taking
  // payment) — the same gate the /accounting/pos page itself checks before
  // it will even render `RetailInvoiceScreen`. `ordersCreate` alone used to
  // guard this, which let e.g. a waiter's role name the permission without
  // ever being able to reach the screen that calls it.
  const { session, error } = await requirePermission(PERMISSIONS.paymentsTake);
  if (error) return error;
  const { industry, error: industryError } = await requireRetailIndustry(session.businessId);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const businessDay = await getBusinessDayStatus(location.id);

  let body: {
    lines?: unknown;
    /** ۱ تا ۱۰ سهم؛ ببینید RawTenderBody — یک روش تنها هم یک آرایهٔ یک‌عضوی است. */
    tenders?: RawTenderBody[];
    customerId?: string | null;
    note?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return NextResponse.json({ error: "empty_invoice" }, { status: 400 });
  }
  const customerId = typeof body.customerId === "string" && body.customerId.trim() ? body.customerId.trim() : null;
  if (customerId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM parties
        WHERE id = $1 AND business_id = $2 AND roles && ARRAY['customer']::text[]`,
      [customerId, session.businessId],
    );
    if (!rows[0]) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  }

  // ۱ تا ۱۰ سهم. هر سهم می‌تواند مبلغ صریح خودش را بفرستد، و **حداکثر یکی** از
  // آن‌ها (هر جای آرایه) می‌تواند مبلغ را کنار بگذارد — یعنی «هرچه فاکتور شد».
  // این همان سهم «باز»ی است که createRetailInvoice/buildTenderQueue در سطح
  // سرویس می‌پذیرد، و اینجا هم لازم است: تخفیف پروموشن (retailPromotionDiscounts)
  // روی خطوط تجمیع‌پذیر فقط داخل تراکنش محاسبه می‌شود و صفحهٔ صدور فاکتور از
  // پیش نمی‌داندش، پس فروش تک‌روشی (اکثریت قریب‌به‌اتفاق فاکتورها) باید بتواند
  // بدون دانستن جمع نهایی، «همه‌چیز را با همین روش بگیر» بفرستد. یک فروش
  // چندروشی هر سهمش را صریح می‌فرستد و فقط آخرین (یا هر یک) سهم را باز می‌گذارد.
  if (!Array.isArray(body.tenders) || body.tenders.length === 0) {
    return NextResponse.json({ error: "no_payment" }, { status: 400 });
  }
  if (body.tenders.length > MAX_RETAIL_TENDERS) {
    return NextResponse.json({ error: "too_many_tenders" }, { status: 400 });
  }
  let openTenderCount = 0;
  const tenders: CreateRetailInvoiceTenderInput[] = [];
  for (const raw of body.tenders) {
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const method = raw.method as SettlementMethod;
    if (!PAYMENT_METHODS.includes(method)) {
      return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
    }
    const amountOmitted = raw.amount === undefined || raw.amount === null;
    if (amountOmitted) {
      openTenderCount += 1;
      if (openTenderCount > 1) {
        return NextResponse.json({ error: "too_many_open_tenders" }, { status: 400 });
      }
    } else if (!isSafePositiveInteger(raw.amount as number)) {
      return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
    }
    const paymentMethodId = typeof raw.paymentMethodId === "string" && raw.paymentMethodId.trim()
      ? raw.paymentMethodId.trim()
      : null;
    const reference = typeof raw.reference === "string" ? raw.reference.trim() : "";
    if (reference.length > 120) {
      return NextResponse.json({ error: "payment_reference_too_long" }, { status: 400 });
    }

    // A named way is tenant-owned and its settlement class must agree with
    // the compact settlement sent to the retail posting services. Without
    // this check a caller could display one way, post another, and lose the
    // audit trail — checked per slice, since each can name its own way.
    let requiresReference = false;
    if (paymentMethodId) {
      const { rows: paymentWays } = await query<{
        settlement: string;
        requires_reference: boolean;
        is_active: boolean;
      }>(
        `SELECT settlement::text, requires_reference, is_active
           FROM payment_methods
          WHERE id = $1 AND business_id = $2`,
        [paymentMethodId, session.businessId],
      );
      const paymentWay = paymentWays[0];
      if (!paymentWay || !paymentWay.is_active || ledgerSettlementFor(paymentWay.settlement as PaymentSettlement) !== method) {
        return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
      }
      requiresReference = paymentWay.requires_reference;
    }
    if (requiresReference && !reference) {
      return NextResponse.json({ error: "payment_reference_required" }, { status: 400 });
    }

    tenders.push({
      method,
      amount: amountOmitted ? undefined : rialText(String(raw.amount)),
      paymentMethodId,
      reference: reference || null,
    });
  }

  if (body.customerId) {
    const { rowCount } = await query(
      `SELECT 1 FROM parties
        WHERE id = $1 AND business_id = $2 AND is_active
          AND (role = 'customer' OR roles @> ARRAY['customer']::text[])`,
      [body.customerId, session.businessId],
    );
    if (rowCount !== 1) {
      return NextResponse.json({ error: "customer_not_found" }, { status: 400 });
    }
  }

  // The service validates each line against the industry; this only checks the
  // shape is a line at all, so a malformed body fails before a transaction opens.
  const lines = body.lines as RetailInvoiceLineInput[];
  if (!lines.every((line) => line && typeof line === "object" && typeof line.kind === "string")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const invoice = await createRetailInvoice(client, {
      businessId: session.businessId,
      locationId: location.id,
      industry,
      lines,
      tenders,
      customerId,
      note: typeof body.note === "string" ? body.note : null,
      businessDate: businessDay?.businessDate,
      createdBy: session.sub,
    });
    await enqueueHolooSaleForOrder(client, session.businessId, invoice.orderId);
    await client.query("COMMIT");
    return NextResponse.json({ invoice });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof RetailInvoiceError) {
      return NextResponse.json({ error: "invoice_failed", message: err.message }, { status: 400 });
    }
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "missing_ledger_account", message: err.message }, { status: 409 });
    }
    // Every sell service raises a Persian, operator-readable Error for the
    // ordinary refusals (no stock, no cost basis, no gold price for today).
    // One transaction, so this response also guarantees nothing was committed.
    if (err instanceof Error && err.message) {
      return NextResponse.json({ error: "invoice_failed", message: err.message }, { status: 400 });
    }
    throw err;
  } finally {
    client.release();
  }
});

/**
 * This branch's retail invoices, newest first — the sales history behind
 * «مدیریت فاکتورها». Filtering and pagination stay in PostgreSQL: a busy shop
 * must not download every historical invoice just to show page one.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  // Listing/searching past invoices is a read of sales history — every role
  // that can see the orders list should see this one too, not only the
  // subset that may also create a new order.
  const { session, error } = await requirePermission(PERMISSIONS.ordersView);
  if (error) return error;
  const { error: industryError } = await requireRetailIndustry(session.businessId);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const params = request.nextUrl.searchParams;
  const rawQuery = params.get("q")?.trim() ?? "";
  const q = normalizedInvoiceSearch(rawQuery);
  const method = params.get("method") ?? ""; // cash | bank | credit | "" = all
  const installmentEligible = params.get("installmentEligible") === "true";
  if (method && !INVOICE_METHODS.has(method)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }
  const rawStatus = params.get("status") ?? ""; // completed | voided | "" = all
  if (rawStatus && rawStatus !== "completed" && rawStatus !== "voided") {
    return NextResponse.json({ error: "invalid_invoice_status" }, { status: 400 });
  }
  // A Jalali date range on the screen, stored and compared as plain ISO
  // calendar dates against the branch's own business day (`app_business_date`
  // — migration 0076), the same function the dashboard and reports use, so a
  // sale rung up after midnight but before the branch's day-start still lands
  // on the day the cashier rang it up, not the calendar day the clock read.
  const isoDate = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  const rawDateFrom = params.get("dateFrom");
  const rawDateTo = params.get("dateTo");
  const dateFrom = isoDate(rawDateFrom);
  const dateTo = isoDate(rawDateTo);
  if ((rawDateFrom && !dateFrom) || (rawDateTo && !dateTo)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return NextResponse.json({ error: "invalid_date_range" }, { status: 400 });
  }

  const requestedPage = Number(params.get("page") ?? 1);
  const requestedPageSize = Number(params.get("pageSize") ?? 20);
  const page = isSafePositiveInteger(requestedPage) ? Math.min(requestedPage, 1_000_000) : 1;
  const pageSize = isSafePositiveInteger(requestedPageSize)
    ? Math.min(requestedPageSize, 100)
    : 20;
  // Retail settlement stores the bank-shaped ways as the `card` enum value.
  // Keep the public API vocabulary stable (`bank`) for the POS and installments
  // screens, while still allowing the named payment-way join to render its name.
  const dbMethod = method === "bank" ? "card" : method;

  const format = params.get("format") ?? "";
  if (format && format !== "csv") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }
  // `all=true` is CSV-only: the on-screen table always paginates, but an
  // export exists precisely so a filtered search isn't limited to one page —
  // it re-runs the same query the screen just ran, with the same filters,
  // ignoring `page`/`pageSize` up to EXPORT_ROW_CAP.
  const exportAll = format === "csv" && params.get("all") === "true";

  const { invoices, count } = await listRetailInvoices({
    businessId: session.businessId,
    locationId: location.id,
    q,
    method: dbMethod,
    status: rawStatus,
    dateFrom: dateFrom ?? "",
    dateTo: dateTo ?? "",
    installmentEligible,
    page: exportAll ? 1 : page,
    pageSize: exportAll ? EXPORT_ROW_CAP : pageSize,
  });

  if (format === "csv") {
    const table: ReportTable = {
      columns: [
        { key: "orderNumber", label: "شماره فاکتور" },
        { key: "customerName", label: "مشتری" },
        { key: "lineCount", label: "اقلام" },
        { key: "paymentMethods", label: "روش پرداخت" },
        { key: "status", label: "وضعیت" },
        { key: "total", label: "مبلغ (ریال)" },
        { key: "closedAt", label: "تاریخ ثبت" },
      ],
      rows: invoices.map((invoice) => ({
        orderNumber: invoice.orderNumber,
        customerName: invoice.customerName ?? "",
        lineCount: invoice.lineCount,
        paymentMethods: invoice.paymentMethods.map((m) => m.name).join("، "),
        status: invoice.status === "voided" ? "باطل‌شده" : "تکمیل‌شده",
        total: invoice.total,
        closedAt: invoice.closedAt
          ? toPersianDigits(formatJalali(invoice.closedAt, { timeZone: location.timezone, withTime: true }))
          : "",
      })),
    };
    const csv = rowsToCsv(table);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="invoices.csv"',
      },
    });
  }

  return NextResponse.json({
    invoices,
    count,
    page,
    pageSize,
    timeZone: location.timezone,
  });
});
