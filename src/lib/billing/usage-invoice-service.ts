/**
 * Issue #902 §9 item 3 (second half) — the database half of usage invoicing.
 *
 * `billing_usage_ratings` says what was used and how it was priced; the wallet
 * says what was already paid. This service is the third thing: an **invoice
 * line** the business can read, one per meter-and-price-version, built from the
 * ratings the wallet has not already collected.
 *
 * ## What it deliberately does not do
 *
 * - **It does not touch the wallet.** Money collected by a wallet debit has
 *   already left the business's balance; invoicing it again is a double charge.
 *   The billable set is therefore *ratings whose event was not wallet-backed*,
 *   which is the same predicate the spend breakdown uses (`walletBacked` false
 *   on the event's dimensions) — one definition of "billable outside the wallet",
 *   asserted by a test so the two can never drift into two answers.
 * - **It does not run on a timer.** Post-paid metered usage is a commercial
 *   decision, not a missing cron entry: today essentially every rateable event is
 *   wallet-backed, so a monthly pass would be inert now and dangerous the day a
 *   new source starts rating without charging. Issuing is an explicit,
 *   capability-guarded, audited operator action until that decision is made.
 * - **It does not tax metered usage.** `0271` links lines to versions; a tax
 *   policy for usage is a different question and inventing a rate here would put
 *   a number on an invoice that no one approved.
 *
 * ## Idempotency, in three layers
 *
 * 1. `billing_invoices.UNIQUE (business_id, reference)` with reference
 *    `usage:<period-month>` — one usage invoice per business per month, and a
 *    retry finds the same row.
 * 2. `billing_invoice_line_usage.usage_event_id` UNIQUE — a rating is billed
 *    **at most once, ever**. A late event with an older occurrence date cannot be
 *    collected again by the next month's run.
 * 3. The rating read excludes everything already linked, inside the same
 *    transaction that writes the links, so two concurrent issuers cannot both see
 *    the same rating as unbilled.
 */
import { getPool, query, withTenant, type PoolClient } from "../db";
import { tehranMonthWindow } from "../ai-plan-allowance";
import { allocateInvoiceNumber } from "./runtime";
import { billingLog } from "./observability";
import {
  groupUsageInvoiceLines,
  type BillableRating,
  type UsageInvoiceBody,
  type UsageInvoiceLine,
} from "./usage-invoice";
import type { PriceBasis } from "./rating-basis";

/** Issued usage invoices fall due a week after they are issued. */
export const USAGE_INVOICE_DUE_DAYS = 7;

export interface UsageInvoiceWindow {
  periodMonth: string;
  startIso: string;
  nextStartIso: string;
}

export interface UsageInvoicePreview extends UsageInvoiceWindow {
  businessId: string;
  lines: UsageInvoiceLine[];
  subtotalRial: number;
  totalRial: number;
  ratingCount: number;
  billedCount: number;
  /** Set when this business already has an invoice for the month. */
  existingInvoiceId: string | null;
}

export interface IssueUsageInvoiceResult {
  invoiceId: string | null;
  /** True when this call created the invoice. */
  created: boolean;
  totalRial: number;
  lineCount: number;
  /** Why nothing was added, when the returned invoice already existed. */
  skipped?: "nothing_to_bill" | "invoice_closed";
}

export class UsageInvoicePeriodError extends Error {
  constructor(public periodMonth: string) {
    super("invalid_period_month");
  }
}

const PERIOD_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function usageInvoiceReference(periodMonth: string): string {
  return `usage:${periodMonth}`;
}

/**
 * The Tehran calendar-month window for a `YYYY-MM` key.
 *
 * Anchoring on the 15th at noon UTC is what makes this safe: it is 15:30 in
 * Tehran, so the instant is unambiguously inside the month the key names, and
 * `tehranMonthWindow` — the same function the spend breakdown uses — derives the
 * boundaries. Nothing here does its own timezone arithmetic.
 */
export function usageInvoiceWindow(periodMonth: string): UsageInvoiceWindow {
  if (!PERIOD_MONTH.test(periodMonth)) throw new UsageInvoicePeriodError(periodMonth);
  const [year, month] = periodMonth.split("-").map(Number);
  const window = tehranMonthWindow(new Date(Date.UTC(year!, month! - 1, 15, 12)));
  if (window.periodMonth !== periodMonth) throw new UsageInvoicePeriodError(periodMonth);
  return {
    periodMonth,
    startIso: window.startUtc.toISOString(),
    nextStartIso: window.nextStartUtc.toISOString(),
  };
}

/** The current month's key, in the same calendar the spend reports use. */
export function currentUsagePeriodMonth(now: Date = new Date()): string {
  return tehranMonthWindow(now).periodMonth;
}

type Sql = Pick<PoolClient, "query"> | { query: PoolClient["query"] };

/**
 * The ratings still owed for a window: rated, not wallet-backed, not already on
 * an invoice.
 *
 * The `source NOT IN (...)` list is not decoration — it is the same belt as the
 * spend breakdown's, so a source that forgot to mark its events wallet-backed is
 * still not billed from the ledger side.
 */
async function loadBillableRatings(
  db: Sql,
  businessId: string,
  window: UsageInvoiceWindow,
): Promise<BillableRating[]> {
  const { rows } = await db.query<{
    usage_event_id: string;
    meter_key: string;
    quantity: string;
    rated_amount_rial: string;
    price_basis: PriceBasis | null;
    price_version_id: string | null;
    retail_price_version_id: string | null;
    retail_price_version: number | null;
  }>(
    `SELECT r.usage_event_id,
            e.meter_key,
            e.quantity::text            AS quantity,
            r.rated_amount_rial::text   AS rated_amount_rial,
            r.price_basis,
            r.price_version_id,
            r.retail_price_version_id,
            r.retail_price_version
       FROM billing_usage_ratings r
       JOIN billing_usage_events e ON e.id = r.usage_event_id
      WHERE r.business_id = $1
        AND e.occurred_at >= $2::timestamptz
        AND e.occurred_at < $3::timestamptz
        AND COALESCE((e.dimensions->>'walletBacked')::boolean, false) = false
        AND e.source NOT IN ('ai', 'media', 'messaging', 'ai_wallet_settlement', 'media_billing', 'message_outbox')
        AND NOT EXISTS (
          SELECT 1 FROM billing_invoice_line_usage u WHERE u.usage_event_id = r.usage_event_id
        )
      ORDER BY e.occurred_at, r.usage_event_id`,
    [businessId, window.startIso, window.nextStartIso],
  );
  return rows.map((row) => ({
    usageEventId: row.usage_event_id,
    meterKey: row.meter_key,
    quantity: Number(row.quantity),
    ratedAmountRial: Number(row.rated_amount_rial),
    priceBasis: row.price_basis,
    priceVersionId: row.price_version_id,
    retailPriceVersionId: row.retail_price_version_id,
    retailPriceVersion: row.retail_price_version,
  }));
}

async function existingInvoiceId(businessId: string, periodMonth: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM billing_invoices WHERE business_id = $1 AND reference = $2`,
    [businessId, usageInvoiceReference(periodMonth)],
  );
  return rows[0]?.id ?? null;
}

/**
 * What an issuance would produce, without writing anything. Runs in the tenant's
 * scope: an invoice line is that business's own data.
 */
export async function previewUsageInvoice(input: {
  businessId: string;
  periodMonth?: string;
}): Promise<UsageInvoicePreview> {
  const window = usageInvoiceWindow(input.periodMonth ?? currentUsagePeriodMonth());
  return withTenant(input.businessId, async () => {
    const [ratings, invoiceId] = await Promise.all([
      loadBillableRatings({ query } as Sql, input.businessId, window),
      existingInvoiceId(input.businessId, window.periodMonth),
    ]);
    const body: UsageInvoiceBody = groupUsageInvoiceLines(ratings);
    return {
      businessId: input.businessId,
      ...window,
      lines: body.lines,
      subtotalRial: body.subtotalRial,
      totalRial: body.totalRial,
      ratingCount: body.ratingCount,
      billedCount: body.billedCount,
      existingInvoiceId: invoiceId,
    };
  });
}

async function writeLines(client: PoolClient, invoiceId: string, businessId: string, body: UsageInvoiceBody): Promise<void> {
  let order = 0;
  for (const line of body.lines) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO billing_invoice_lines
         (invoice_id, kind, description, quantity, unit_amount_rial, amount_rial,
          price_version_id, sort_order, price_basis, retail_price_version_id, retail_price_version)
       VALUES ($1, 'usage', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        invoiceId,
        line.description,
        Math.max(1, line.quantity),
        line.unitAmountRial,
        line.amountRial,
        // A retail-priced line must not cite the meter catalogue (0271's CHECK).
        line.priceBasis === "meter_price_version" ? line.priceVersionId : null,
        order++,
        line.priceBasis,
        line.retailPriceVersionId,
        line.retailPriceVersion,
      ],
    );
    const lineId = rows[0]!.id;
    for (const rating of line.ratings) {
      await client.query(
        `INSERT INTO billing_invoice_line_usage
           (line_id, usage_event_id, business_id, meter_key, rated_amount_rial)
         VALUES ($1, $2, $3, $4, $5)`,
        [lineId, rating.usageEventId, businessId, line.meterKey, rating.amountRial],
      );
    }
  }
}

/**
 * Issue (or complete) one business's usage invoice for a month.
 *
 * Safe to call repeatedly: a second call finds the invoice already claimed and
 * adds nothing. Runs in the tenant's scope and in one transaction, so a partial
 * write leaves no half-built invoice.
 */
export async function issueUsageInvoice(input: {
  businessId: string;
  periodMonth?: string;
  now?: Date;
}): Promise<IssueUsageInvoiceResult> {
  const window = usageInvoiceWindow(input.periodMonth ?? currentUsagePeriodMonth(input.now));
  const now = (input.now ?? new Date()).toISOString();

  return withTenant(input.businessId, async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const ratings = await loadBillableRatings(client as unknown as Sql, input.businessId, window);
      const body = groupUsageInvoiceLines(ratings);

      if (body.lines.length === 0) {
        await client.query("COMMIT");
        return {
          invoiceId: await existingInvoiceId(input.businessId, window.periodMonth),
          created: false,
          totalRial: 0,
          lineCount: 0,
          skipped: "nothing_to_bill" as const,
        };
      }

      const number = await allocateInvoiceNumber(client);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO billing_invoices
           (business_id, invoice_number, status, subtotal_rial, discount_rial, tax_rial,
            total_rial, paid_rial, due_at, period_start, period_end, reference, note)
         VALUES ($1, $2, 'open', $3, 0, 0, $3, 0,
                 $4::timestamptz + ($5::int * interval '1 day'), $6, $7, $8, $9)
         ON CONFLICT (business_id, reference) DO NOTHING
         RETURNING id`,
        [
          input.businessId,
          number,
          body.totalRial,
          now,
          USAGE_INVOICE_DUE_DAYS,
          window.startIso,
          window.nextStartIso,
          usageInvoiceReference(window.periodMonth),
          `مصرف اندازه‌گیری‌شدهٔ دورهٔ ${window.periodMonth}`,
        ],
      );

      if (!rows[0]) {
        // The month is already claimed — by a previous attempt, or by a literal
        // concurrent run. The claim and the lines are two steps, so there are
        // three honest cases and they are not the same:
        //
        //   * the invoice has no lines at all — a crash between the steps.
        //     Finish it; an invoice nobody can read is a defect.
        //   * it is still open (no money applied) — a rating arrived after the
        //     first run (a late event, a corrected price). Append it, so the
        //     business is not left with an unbillable month.
        //   * it is paid, partially paid or void — the document is settled.
        //     Changing it would rewrite a bill the customer already paid, so the
        //     rating waits for an amendment, not for a silent edit.
        const { rows: existing } = await client.query<{ id: string; status: string; line_count: string }>(
          `SELECT i.id, i.status,
                  (SELECT count(*) FROM billing_invoice_lines l WHERE l.invoice_id = i.id)::text AS line_count
             FROM billing_invoices i
            WHERE i.business_id = $1 AND i.reference = $2`,
          [input.businessId, usageInvoiceReference(window.periodMonth)],
        );
        const invoiceId = existing[0]?.id ?? null;
        const status = existing[0]?.status ?? null;
        const lineCount = Number(existing[0]?.line_count ?? 0);
        const canExtend = invoiceId !== null && (lineCount === 0 || status === "open");

        if (invoiceId && canExtend) {
          await writeLines(client, invoiceId, input.businessId, body);
          const { rows: totals } = await client.query<{ total: string; lines: string }>(
            `SELECT COALESCE(sum(amount_rial), 0)::text AS total, count(*)::text AS lines
               FROM billing_invoice_lines WHERE invoice_id = $1`,
            [invoiceId],
          );
          await client.query(
            `UPDATE billing_invoices
                SET subtotal_rial = $2, total_rial = $2, updated_at = now()
              WHERE id = $1`,
            [invoiceId, Number(totals[0]?.total ?? 0)],
          );
          await client.query("COMMIT");
          billingLog("billing.usage_invoice.extended", {
            businessId: input.businessId,
            invoiceId,
            periodMonth: window.periodMonth,
            addedRial: body.totalRial,
            addedLines: body.lines.length,
          });
          return {
            invoiceId,
            created: false,
            totalRial: Number(totals[0]?.total ?? 0),
            lineCount: Number(totals[0]?.lines ?? 0),
          };
        }

        await client.query("COMMIT");
        return {
          invoiceId,
          created: false,
          totalRial: 0,
          lineCount: 0,
          skipped: invoiceId ? ("invoice_closed" as const) : ("nothing_to_bill" as const),
        };
      }

      const invoiceId = rows[0].id;
      await writeLines(client, invoiceId, input.businessId, body);
      await client.query("COMMIT");
      billingLog("billing.usage_invoice.issued", {
        businessId: input.businessId,
        invoiceId,
        periodMonth: window.periodMonth,
        totalRial: body.totalRial,
        lines: body.lines.length,
        ratings: body.billedCount,
      });
      return { invoiceId, created: true, totalRial: body.totalRial, lineCount: body.lines.length };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}
