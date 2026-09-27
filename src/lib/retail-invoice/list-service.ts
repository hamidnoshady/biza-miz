/**
 * The retail invoice history query — extracted out of
 * `src/app/api/sales/invoices/route.ts`'s `GET` handler so it can be
 * exercised directly against a real database (integration/retail-invoice-
 * list.integration.test.ts) without reconstructing a `NextRequest`/session.
 * The route stays responsible for auth, parameter parsing/validation and the
 * HTTP response shape; this owns only the query and the row mapping.
 */
import { query } from "../db";

/** One settlement method an invoice was actually paid with, for display. */
export interface RetailInvoicePaymentMethodSummary {
  /** The ledger/payment_method enum value ('card' for a bank way). */
  method: string;
  /** The business's own name for the way, or the Persian fallback for a legacy row with none. */
  name: string;
}

export interface RetailInvoiceListRow {
  id: string;
  orderNumber: number;
  status: string;
  total: number;
  closedAt: string | null;
  customerName: string | null;
  lineCount: number;
  /**
   * Every distinct way this invoice was actually settled with — a split
   * payment (retail-tenders.ts) can post more than one `payments` row per
   * invoice, so this is never just the first one. Empty for a legacy row with
   * no payment recorded at all. Reversal rows (a void's negative slices)
   * don't add a method here — this is what the customer originally paid
   * with, not the invoice's current net position.
   */
  paymentMethods: RetailInvoicePaymentMethodSummary[];
  creditTotal: number;
  hasInstallmentPlan: boolean;
}

export interface ListRetailInvoicesInput {
  businessId: string;
  locationId: string;
  /** Already normalised (see `normalizedInvoiceSearch`), "" = no filter. */
  q: string;
  /** The ledger/payment_method enum value ('card' for a bank way), "" = all. */
  method: string;
  /** "completed" | "voided" | "" = all. */
  status: string;
  /** ISO calendar date (YYYY-MM-DD), "" = no lower bound. */
  dateFrom: string;
  /** ISO calendar date (YYYY-MM-DD), "" = no upper bound. */
  dateTo: string;
  installmentEligible: boolean;
  page: number;
  pageSize: number;
}

/** The Persian fallback name for a payment enum value with no named way on the row (legacy data). */
function fallbackMethodName(method: string): string {
  switch (method) {
    case "cash":
      return "نقدی";
    case "card":
      return "کارت‌خوان";
    case "credit":
      return "نسیه";
    default:
      return method;
  }
}

export async function listRetailInvoices(
  input: ListRetailInvoicesInput,
): Promise<{ invoices: RetailInvoiceListRow[]; count: number }> {
  const offset = (input.page - 1) * input.pageSize;

  const { rows } = await query<{
    id: string;
    order_number: string;
    status: string;
    total: string;
    closed_at: string | null;
    customer_name: string | null;
    line_count: string;
    payment_methods: { method: string; name: string | null }[];
    credit_total: string;
    has_installment_plan: boolean;
    result_count: string;
  }>(
    `WITH payment_summary AS (
       SELECT p.order_id,
              jsonb_agg(DISTINCT jsonb_build_object('method', p.method::text, 'name', pm.name)) AS methods
         FROM payments p
         LEFT JOIN payment_methods pm ON pm.id = p.payment_method_id
        WHERE p.amount > 0
        GROUP BY p.order_id
     ),
     invoice_rows AS (
       SELECT o.id, o.order_number, o.status, o.total, o.closed_at,
              c.name AS customer_name,
              (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id) AS line_count,
              COALESCE(ps.methods, '[]'::jsonb) AS payment_methods,
              COALESCE((SELECT sum(p.amount) FROM payments p
                          WHERE p.order_id = o.id AND p.method = 'credit'), 0)::text AS credit_total,
              EXISTS (SELECT 1 FROM installments ip
                        WHERE ip.business_id = $2 AND ip.invoice_order_id = o.id) AS has_installment_plan
         FROM orders o
         JOIN locations l ON l.id = o.location_id
         LEFT JOIN parties c ON c.id = o.customer_id
         LEFT JOIN payment_summary ps ON ps.order_id = o.id
        WHERE o.location_id = $1
          AND o.type = 'retail'
          AND o.status IN ('completed', 'voided')
          AND ($3 = '' OR c.name ILIKE '%' || $3 || '%' OR o.order_number::text LIKE '%' || $3 || '%')
          -- A split-payment invoice can carry more than one payments row
          -- (retail-tenders.ts); the filter matches an invoice that used this
          -- method at all, not only whichever row happened to post first.
          AND ($4 = '' OR EXISTS (
                SELECT 1 FROM payments p2 WHERE p2.order_id = o.id AND p2.amount > 0 AND p2.method::text = $4
              ))
          AND ($8 = '' OR o.status::text = $8)
          -- A Jalali date range on the screen, stored and compared as plain
          -- ISO calendar dates against the branch's own business day
          -- (app_business_date — migration 0076), the same function the
          -- dashboard and reports use, so a sale rung up after midnight but
          -- before the branch's day-start still lands on the day the cashier
          -- rang it up, not the calendar day the clock read.
          AND ($9 = '' OR app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) >= $9::date)
          AND ($10 = '' OR app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) <= $10::date)
     )
     SELECT invoice_rows.*, count(*) OVER ()::text AS result_count
       FROM invoice_rows
      WHERE ($5 = false OR (status = 'completed' AND credit_total::bigint > 0 AND NOT has_installment_plan))
      ORDER BY order_number DESC
      LIMIT $6 OFFSET $7`,
    [
      input.locationId,
      input.businessId,
      input.q,
      input.method,
      input.installmentEligible,
      input.pageSize,
      offset,
      input.status,
      input.dateFrom,
      input.dateTo,
    ],
  );

  const invoices: RetailInvoiceListRow[] = rows.map((r) => ({
    id: r.id,
    orderNumber: Number(r.order_number),
    status: r.status,
    total: Number(r.total),
    closedAt: r.closed_at,
    customerName: r.customer_name,
    lineCount: Number(r.line_count),
    paymentMethods: [...r.payment_methods]
      .sort((a, b) => a.method.localeCompare(b.method))
      .map((m) => ({
        // The API deliberately exposes settlement vocabulary, not the
        // underlying payment enum (`card` is what a retail bank payment
        // stores) — same public contract the singular field used to keep.
        method: m.method === "card" ? "bank" : m.method,
        name: m.name ?? fallbackMethodName(m.method),
      })),
    creditTotal: Number(r.credit_total),
    hasInstallmentPlan: r.has_installment_plan,
  }));

  return { invoices, count: rows[0] ? Number(rows[0].result_count) : 0 };
}

