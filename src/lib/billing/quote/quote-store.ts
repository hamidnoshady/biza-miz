/**
 * ESH-193 / #1378 — persisted quotes and the payment boundary.
 *
 * A quote is only a price until someone is about to pay; from then on the
 * question is "is this still the price?". This module answers it against the
 * database, not against the object the browser sent back:
 *
 *  - `persistQuote` stores the quote exactly as shown, together with the
 *    integer inputs needed to reproduce it (basis-point rates, the coupon
 *    snapshot, the base price version). The stored net is *derived*, never
 *    trusted as an input.
 *  - `assertQuotePayable` re-reads live prices through the same
 *    `readPlanPricing` the quote used, rebuilds the quote from the stored
 *    inputs, and compares. A changed price, plan, term or coupon is
 *    `quote_stale`; an elapsed validity is `quote_expired`. The payment
 *    boundary must re-quote, never settle.
 *  - `consumeQuote` is the single-transaction settlement seam: it flips an open,
 *    unexpired quote to consumed exactly once, stamps the payment, and spends
 *    the coupon hold (with the global cap enforced by the coupon row itself).
 *    Any refusal rolls the whole settlement back.
 *
 * The wallet debit itself is *not* here: it belongs to the entitlement/ledger
 * services, which call this seam and must pass its result through. This module
 * moves no money.
 */
import type { PoolClient } from "pg";
import { query, withTenant, withTenantTransaction } from "../../db";
import {
  buildPlanQuote,
  planBasePriceVersion,
  type PlanQuote,
  type PlanTermMonths,
  type QuoteCoupon,
  type QuoteLine,
} from "./plan-quote";
import { currentQuoteFacts, readPlanPricing, type QuoteExecutor } from "./plan-quote-service";
import { redeemCouponForQuote, revalidateCoupon, type CouponRefusal } from "./coupon-service";

/** Without settlement, this is how a quote is remembered. */
export interface StoredQuote {
  id: string;
  businessId: string;
  platformUserId: string;
  quote: PlanQuote;
  couponId: string | null;
  coupon: QuoteCoupon | null;
  status: "open" | "consumed" | "expired" | "cancelled";
  termDiscountRate: number;
  taxRate: number;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  expiresAt: string;
}

export type PersistQuoteResult =
  | { ok: true; quoteId: string }
  | { ok: false; error: "coupon_reservation_missing" | "quote_invalid" };

/**
 * Store the quote and attach its coupon hold, in one transaction.
 *
 * The hold is attached by `quote_id` with `status = 'reserved'` in the WHERE
 * clause: a hold that expired, was released, or belongs to another business
 * cannot be attached, and the quote insert is rolled back with it.
 */
export async function persistQuote(input: {
  businessId: string;
  platformUserId: string;
  quote: PlanQuote;
  /** The configured rates that produced it, so it can be reproduced exactly. */
  termDiscountRate: number;
  taxRate: number;
  coupon?: { coupon: QuoteCoupon; redemptionId: string } | null;
}): Promise<PersistQuoteResult> {
  const basisPoints = (rate: number) => Math.round(rate * 10_000);
  if (
    !Number.isSafeInteger(basisPoints(input.termDiscountRate)) ||
    !Number.isSafeInteger(basisPoints(input.taxRate))
  ) {
    return { ok: false, error: "quote_invalid" };
  }
  const base = planBasePriceVersion(input.quote);
  if (!base) return { ok: false, error: "quote_invalid" };

  const coupon = input.coupon ?? null;

  try {
    return await withTenantTransaction(input.businessId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO billing_quotes
           (business_id, platform_user_id, plan_key, term_months,
            term_discount_basis_points, tax_basis_points,
            coupon_id, coupon_code, coupon_kind, coupon_value,
            gross_rial, discount_rial, coupon_discount_rial, tax_rial, net_rial,
            lines, base_price_version_id, base_price_version,
            period_start, period_end, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 $7, $8, $9, $10,
                 $11, $12, $13, $14, $15,
                 $16::jsonb, $17, $18,
                 $19, $20, $21, $22)
         RETURNING id`,
        [
          input.businessId,
          input.platformUserId,
          input.quote.planKey,
          input.quote.termMonths,
          basisPoints(input.termDiscountRate),
          basisPoints(input.taxRate),
          null,
          coupon?.coupon.code ?? null,
          coupon?.coupon.kind ?? null,
          coupon?.coupon.value ?? null,
          input.quote.totals.grossRial,
          input.quote.totals.discountRial,
          input.quote.totals.couponDiscountRial,
          input.quote.totals.taxRial,
          input.quote.totals.netRial,
          JSON.stringify(input.quote.lines),
          base.id,
          base.version,
          input.quote.period.start,
          input.quote.period.end,
          input.quote.issuedAt,
          input.quote.expiresAt,
        ],
      );
      const quoteId = rows[0].id;

      if (coupon) {
        const { rows: attached } = await client.query<{ coupon_id: string }>(
          `UPDATE billing_coupon_redemptions
              SET quote_id = $1
            WHERE id = $2
              AND business_id = $3
              AND status = 'reserved'
          RETURNING coupon_id`,
          [quoteId, coupon.redemptionId, input.businessId],
        );
        if (!attached[0]) {
          throw codedError("coupon_reservation_missing");
        }
        await client.query(`UPDATE billing_quotes SET coupon_id = $2 WHERE id = $1`, [
          quoteId,
          attached[0].coupon_id,
        ]);
      }

      return { ok: true as const, quoteId };
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === "coupon_reservation_missing") {
      return { ok: false, error: "coupon_reservation_missing" };
    }
    throw error;
  }
}

/** Read a stored quote, tenant-scoped. Null when it is not this business's. */
export async function loadQuote(input: {
  businessId: string;
  quoteId: string;
}): Promise<StoredQuote | null> {
  return withTenant(input.businessId, () =>
    loadStoredQuoteWith({ query }, input.businessId, input.quoteId),
  );
}

/** The minimum a caller needs from a connection to read and re-price a quote. */
type QuoteReader = QuoteExecutor;

/**
 * Read one quote through a specific executor.
 *
 * Settlement passes its transaction's own client, so the stored quote and the
 * catalogue it is compared against are read on the connection that then writes.
 * The observation therefore shares one snapshot with the UPDATE, instead of
 * being a separate connection's read that another commit can outrun.
 */
async function loadStoredQuoteWith(
  reader: QuoteReader,
  businessId: string,
  quoteId: string,
): Promise<StoredQuote | null> {
  const { rows } = await reader.query<StoredQuoteRow>(
    `SELECT id, business_id, platform_user_id, plan_key, term_months,
            term_discount_basis_points, tax_basis_points,
            coupon_id, coupon_code, coupon_kind, coupon_value,
            gross_rial, discount_rial, coupon_discount_rial, tax_rial, net_rial,
            lines, base_price_version_id, base_price_version,
            period_start, period_end, issued_at, expires_at, status
       FROM billing_quotes
      WHERE id = $1
        AND business_id = $2`,
    [quoteId, businessId],
  );
  return rows[0] ? toStoredQuote(rows[0]) : null;
}

/** Adapt a pg client to the narrow reader shape the pricing path expects. */
function asReader(client: PoolClient): QuoteReader {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) {
      const result = await client.query(text, params);
      return { rows: result.rows as T[] };
    },
  };
}

export type QuoteRefusal =
  | "quote_not_found"
  | "quote_expired"
  | "quote_consumed"
  | "quote_stale"
  | "plan_not_purchasable"
  | "plan_price_missing"
  | CouponRefusal;

export type QuotePayability =
  | { ok: true; quote: StoredQuote; refreshed: PlanQuote }
  | { ok: false; error: QuoteRefusal };

/**
 * Is this quote still payable at this instant?
 *
 * Re-price first, then compare. Rebuilding through `buildPlanQuote` from the
 * stored integer inputs means the comparison also catches a change in the
 * coupon's contribution or the configured tax, not just the plan price.
 */
export async function assertQuotePayable(input: {
  businessId: string;
  quoteId: string;
  now?: Date;
}): Promise<QuotePayability> {
  const now = input.now ?? new Date();
  const stored = await loadQuote(input);
  if (!stored) return { ok: false, error: "quote_not_found" };
  if (stored.status !== "open") return { ok: false, error: "quote_consumed" };
  if (new Date(stored.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, error: "quote_expired" };
  }

  // Inside the tenant scope the coupon re-validation can see this business's
  // redemptions (the table is RLS'd); outside it they read as empty and the
  // preview would disagree with settlement.
  return withTenant(input.businessId, () => repriceStoredQuote({ query }, stored, now));
}

/**
 * Re-read the catalogue and decide whether the stored quote still matches.
 *
 * Shared by the read-only check and by settlement, so both compare with the
 * same arithmetic; only the connection differs. Settlement passes its own
 * client, which is what makes the check transactional rather than advisory.
 *
 * The coupon is re-validated from its live row, not the quote's snapshot: the
 * campaign can be paused, expire, tighten its term or change its discount
 * after the quote was shown. A changed discount then fails the comparison
 * below as `quote_stale`; a coupon that is no longer usable is refused by name.
 */
async function repriceStoredQuote(
  reader: QuoteReader,
  stored: StoredQuote,
  now: Date,
): Promise<QuotePayability> {
  const pricing = await readPlanPricing({ planKey: stored.quote.planKey, now, exec: reader });
  if (!pricing.ok) {
    return {
      ok: false,
      error:
        pricing.error === "plan_not_purchasable" ? "plan_not_purchasable" : "plan_price_missing",
    };
  }

  let coupon = stored.coupon;
  if (coupon) {
    if (!stored.couponId) return { ok: false, error: "coupon_not_found" };
    const live = await revalidateCoupon(reader, {
      couponId: stored.couponId,
      businessId: stored.businessId,
      termMonths: stored.quote.termMonths,
      now,
    });
    if (!live.ok) return { ok: false, error: live.error };
    coupon = live.coupon;
  }

  const refreshed = buildPlanQuote({
    planKey: stored.quote.planKey,
    termMonths: stored.quote.termMonths,
    ...pricing.pricing,
    termDiscountRate: stored.termDiscountRate,
    taxRate: stored.taxRate,
    coupon,
    issuedAt: stored.issuedAt,
    validityMinutes: validityMinutes(stored),
  });

  const before = currentQuoteFacts(stored.quote);
  const after = currentQuoteFacts(refreshed);
  if (
    before.netRial !== after.netRial ||
    before.basePriceVersionId !== after.basePriceVersionId ||
    before.basePriceVersion !== after.basePriceVersion
  ) {
    return { ok: false, error: "quote_stale" };
  }
  return { ok: true, quote: stored, refreshed };
}

export type ConsumeQuoteResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | QuoteRefusal
        | "payment_already_used"
        | "coupon_exhausted"
        | "coupon_reservation_missing"
        | "settlement_conflict";
    };

/**
 * Consume an open quote for a payment, exactly once.
 *
 * The price check runs **inside** a `REPEATABLE READ` transaction, on the same
 * client that flips the row. That level is deliberate: under READ COMMITTED
 * every statement takes a fresh snapshot, so the catalogue could be re-priced
 * between the re-price and the UPDATE. Here the stored quote and the live
 * catalogue are read from one snapshot, and the settlement therefore agrees
 * with itself. The guarantee is exactly that — a price version committed after
 * this transaction's snapshot is *not* applied to it; it applies to later
 * settlements, and this one is the price the person was shown. Postgres also
 * detects a concurrent write to either row (serialization failure, 40001),
 * which is surfaced as `settlement_conflict` so the caller can retry rather
 * than double-settle.
 *
 * The UPDATE's WHERE clause still carries status, ownership and expiry, so a
 * concurrent settlement or cancellation cannot interleave either. The coupon
 * is spent in the same transaction: if the cap has been reached, the quote
 * consumption rolls back and the caller gets `coupon_exhausted` — never a
 * discounted settlement that the campaign did not actually authorise.
 */
export async function consumeQuote(input: {
  businessId: string;
  quoteId: string;
  paymentId: string;
  now?: Date;
}): Promise<ConsumeQuoteResult> {
  const now = input.now ?? new Date();

  try {
    return await withTenantTransaction(
      input.businessId,
      async (client) => {
        const reader = asReader(client);

        // REPEATABLE READ: the quote read, the catalogue read and the write all
        // observe this transaction's one snapshot (see the doc comment).
        const stored = await loadStoredQuoteWith(reader, input.businessId, input.quoteId);
        if (!stored) return { ok: false as const, error: "quote_not_found" as const };
        if (stored.status !== "open") {
          return { ok: false as const, error: "quote_consumed" as const };
        }
        if (new Date(stored.expiresAt).getTime() <= now.getTime()) {
          return { ok: false as const, error: "quote_expired" as const };
        }

        const settled = await repriceStoredQuote(reader, stored, now);
        if (!settled.ok) return { ok: false as const, error: settled.error };

        const { rows } = await client.query<{ coupon_id: string | null }>(
          `UPDATE billing_quotes
              SET status = 'consumed', payment_id = $3, consumed_at = now()
            WHERE id = $1
              AND business_id = $2
              AND status = 'open'
              AND expires_at > $4
          RETURNING coupon_id`,
          [input.quoteId, input.businessId, input.paymentId, now.toISOString()],
        );
        const consumed = rows[0];
        if (!consumed) {
          return { ok: false as const, error: await refusalFor(client, { ...input, now }) };
        }

        if (consumed.coupon_id) {
          const redeemed = await redeemCouponForQuote(client, {
            couponId: consumed.coupon_id,
            quoteId: input.quoteId,
            businessId: input.businessId,
          });
          if (!redeemed.ok) throw codedError(redeemed.error);
        }

        return { ok: true as const };
      },
      { isolationLevel: "repeatable read" },
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "coupon_exhausted" || code === "coupon_reservation_missing") {
      return { ok: false, error: code };
    }
    if (code === "23505") return { ok: false, error: "payment_already_used" };
    // The quote or its coupon row moved under us; nothing was settled.
    if (code === "40001") return { ok: false, error: "settlement_conflict" };
    throw error;
  }
}

async function refusalFor(
  client: PoolClient,
  input: { businessId: string; quoteId: string; now: Date },
): Promise<"quote_not_found" | "quote_expired" | "quote_consumed"> {
  const { rows } = await client.query<{ status: string; expires_at: Date | string }>(
    `SELECT status, expires_at FROM billing_quotes WHERE id = $1 AND business_id = $2`,
    [input.quoteId, input.businessId],
  );
  const row = rows[0];
  if (!row) return "quote_not_found";
  if (row.status !== "open") return "quote_consumed";
  return new Date(row.expires_at).getTime() <= input.now.getTime()
    ? "quote_expired"
    : "quote_consumed";
}

interface StoredQuoteRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  platform_user_id: string;
  plan_key: string;
  term_months: number;
  term_discount_basis_points: number;
  tax_basis_points: number;
  coupon_id: string | null;
  coupon_code: string | null;
  coupon_kind: "percent" | "fixed" | null;
  coupon_value: number | null;
  gross_rial: string | number;
  discount_rial: string | number;
  coupon_discount_rial: string | number;
  tax_rial: string | number;
  net_rial: string | number;
  lines: QuoteLine[];
  base_price_version_id: string;
  base_price_version: number;
  period_start: Date | string;
  period_end: Date | string;
  issued_at: Date | string;
  expires_at: Date | string;
  status: "open" | "consumed" | "expired" | "cancelled";
}

function toStoredQuote(row: StoredQuoteRow): StoredQuote {
  const coupon: QuoteCoupon | null =
    row.coupon_code && row.coupon_kind && row.coupon_value
      ? { code: row.coupon_code, kind: row.coupon_kind, value: Number(row.coupon_value) }
      : null;
  return {
    id: row.id,
    businessId: row.business_id,
    platformUserId: row.platform_user_id,
    quote: {
      planKey: row.plan_key,
      termMonths: Number(row.term_months) as PlanTermMonths,
      lines: row.lines,
      totals: {
        grossRial: Number(row.gross_rial),
        discountRial: Number(row.discount_rial),
        couponDiscountRial: Number(row.coupon_discount_rial),
        taxRial: Number(row.tax_rial),
        netRial: Number(row.net_rial),
      },
      period: { start: new Date(row.period_start).toISOString(), end: new Date(row.period_end).toISOString() },
      issuedAt: new Date(row.issued_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    },
    couponId: row.coupon_id,
    coupon,
    status: row.status,
    termDiscountRate: Number(row.term_discount_basis_points) / 10_000,
    taxRate: Number(row.tax_basis_points) / 10_000,
    periodStart: new Date(row.period_start).toISOString(),
    periodEnd: new Date(row.period_end).toISOString(),
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function validityMinutes(stored: StoredQuote): number {
  return Math.max(
    1,
    Math.round(
      (new Date(stored.expiresAt).getTime() - new Date(stored.issuedAt).getTime()) / 60_000,
    ),
  );
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}
