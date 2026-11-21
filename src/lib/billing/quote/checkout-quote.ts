/**
 * ESH-193 / #1378 — the one way a tenant checkout gets a persisted quote.
 *
 * The quote endpoint and the payment endpoint both need the same sequence:
 * read the configured promotion policy, resolve a coupon for this business and
 * term, price through the canonical resolver, take a coupon hold only when the
 * coupon actually contributes, then store the quote with its integer inputs.
 * Duplicating that in two routes is how the price the person saw and the price
 * the payment settles drift apart.
 *
 * A coupon that loses the default no-stacking comparison is not part of the
 * quote, so it takes no capacity; the caller never has to know that rule.
 */
import { query } from "../../db";
import {
  type PlanQuote,
  type PlanTermMonths,
  type QuoteCoupon,
  type QuoteStackingPolicy,
  addCalendarMonths,
} from "./plan-quote";
import { quotePlanSubscription } from "./plan-quote-service";
import {
  readPromotionPolicy,
  termDiscountRateFor,
  type PromotionPolicy,
} from "./promotion-policy";
import { persistQuote } from "./quote-store";
import { releaseCouponReservation, reserveCoupon, resolveCoupon } from "./coupon-service";
import type { CouponRefusal } from "./coupon-service";

export type CheckoutQuoteResult =
  | {
      ok: true;
      quoteId: string;
      quote: PlanQuote;
      promotion: PromotionPolicy;
      stackingPolicy: QuoteStackingPolicy;
      couponId: string | null;
      reservationId: string | null;
    }
  | {
      ok: false;
      error:
        | "plan_not_found"
        | "plan_not_purchasable"
        | "plan_price_missing"
        | "quote_invalid"
        | "actor_not_found"
        | "coupon_reservation_missing"
        | CouponRefusal
        | "coupon_capacity_unavailable"
        | "plan_change_pending";
    };

export async function createPlanCheckoutQuote(input: {
  businessId: string;
  /** The global person (ESH-199); resolved from the membership when absent. */
  platformUserId: string | null;
  /** `users.id` of the acting membership, used only for that fallback. */
  membershipId?: string | null;
  planKey: string;
  termMonths: PlanTermMonths;
  couponCode?: string | null;
  now?: Date;
  validityMinutes?: number;
}): Promise<CheckoutQuoteResult> {
  const now = input.now ?? new Date();
  const platformUserId = await resolvePlatformUserId(
    input.businessId,
    input.platformUserId,
    input.membershipId ?? null,
  );
  if (!platformUserId) return { ok: false, error: "actor_not_found" };
  const promotion = await readPromotionPolicy();
  const termDiscountRate = termDiscountRateFor(promotion, input.termMonths);
  const taxRate = await readTaxRate();

  let resolvedCoupon: { couponId: string; coupon: QuoteCoupon } | null = null;
  const couponCode = input.couponCode?.trim() ?? "";
  if (couponCode) {
    const resolved = await resolveCoupon({
      code: couponCode,
      businessId: input.businessId,
      termMonths: input.termMonths,
      now,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    resolvedCoupon = { couponId: resolved.couponId, coupon: resolved.coupon };
  }

  const quoted = await quotePlanSubscription({
    planKey: input.planKey,
    termMonths: input.termMonths,
    termDiscountRate,
    taxRate,
    stackingPolicy: promotion.stackingPolicy,
    coupon: resolvedCoupon?.coupon ?? null,
    now,
    validityMinutes: input.validityMinutes,
  });
  if (!quoted.ok) return quoted;
  const quote = quoted.quote;

  // ESH-193 — a cross-plan purchase while a paid period is running starts at
  // that period's end. The UI and the invoice snapshot therefore show the
  // future interval, and `changeBusinessPlan` schedules the same instant. One
  // pending change at a time is the rule; a second different target waits.
  const deferral = await readPlanDeferral({
    businessId: input.businessId,
    targetPlanKey: input.planKey,
    now,
  });
  if (deferral.conflict) return { ok: false, error: "plan_change_pending" };
  if (deferral.startsAt) {
    quote.period = {
      start: deferral.startsAt,
      end: addCalendarMonths(deferral.startsAt, input.termMonths),
    };
  }

  // The coupon is reserved only if it survived the no-stacking comparison.
  let reservationId: string | null = null;
  if (resolvedCoupon && quote.totals.couponDiscountRial > 0) {
    const reserved = await reserveCoupon({
      couponId: resolvedCoupon.couponId,
      businessId: input.businessId,
      termMonths: input.termMonths,
      amountRial: quote.totals.couponDiscountRial,
      reservedUntil: new Date(quote.expiresAt),
      now,
    });
    if (!reserved.ok) return { ok: false, error: reserved.error };
    reservationId = reserved.redemptionId;
  }

  const persisted = await persistQuote({
    businessId: input.businessId,
    platformUserId: platformUserId,
    quote,
    termDiscountRate,
    taxRate,
    coupon:
      reservationId && resolvedCoupon
        ? { coupon: resolvedCoupon.coupon, redemptionId: reservationId }
        : null,
  });
  if (!persisted.ok) {
    if (reservationId) {
      await releaseCouponReservation({ redemptionId: reservationId, businessId: input.businessId });
    }
    return { ok: false, error: persisted.error };
  }

  return {
    ok: true,
    quoteId: persisted.quoteId,
    quote,
    promotion,
    stackingPolicy: quote.stackingPolicy,
    couponId: quote.totals.couponDiscountRial > 0 ? resolvedCoupon?.couponId ?? null : null,
    reservationId,
  };
}

/**
 * The global person behind this session. A token minted before the shared
 * identity contract may carry only the membership (`users.id`), so fall back to
 * that membership's `platform_user_id` rather than inventing an actor.
 */
async function resolvePlatformUserId(
  businessId: string,
  provided: string | null,
  membershipId: string | null,
): Promise<string | null> {
  if (provided) return provided;
  if (!membershipId) return null;
  const { rows } = await query<{ platform_user_id: string | null }>(
    `SELECT platform_user_id FROM users WHERE id = $1 AND business_id = $2`,
    [membershipId, businessId],
  );
  return rows[0]?.platform_user_id ?? null;
}

/** The configured tax rate; a missing row means no tax, never a guessed one. */
async function readTaxRate(): Promise<number> {
  const { rows } = await query<{ tax_rate_bps: number | string | null }>(
    `SELECT tax_rate_bps FROM billing_commercial_settings WHERE id`,
  );
  const bps = Number(rows[0]?.tax_rate_bps ?? 0);
  return Number.isFinite(bps) && bps >= 0 && bps <= 10_000 ? Math.round(bps) / 10_000 : 0;
}

/**
 * When must a cross-plan purchase start? At the end of the running paid period,
 * so the customer keeps the time they already paid for. `conflict` is a second
 * different pending target; buying it now would need a refund/credit decision.
 */
async function readPlanDeferral(input: {
  businessId: string;
  targetPlanKey: string;
  now: Date;
}): Promise<{ startsAt: string | null; conflict: boolean }> {
  const { rows } = await query<{
    plan_key: string;
    status: string;
    current_period_end: Date | string;
    pending_plan_key: string | null;
  }>(
    `SELECT plan_key, status, current_period_end, pending_plan_key
       FROM business_subscriptions
      WHERE business_id = $1`,
    [input.businessId],
  );
  const row = rows[0];
  if (!row) return { startsAt: null, conflict: false };
  // A trial is not a paid interval; switching during it is immediate.
  if (!["active", "past_due"].includes(row.status)) {
    return { startsAt: null, conflict: false };
  }
  if (row.plan_key === input.targetPlanKey) return { startsAt: null, conflict: false };
  const periodEnd =
    row.current_period_end instanceof Date
      ? row.current_period_end.toISOString()
      : new Date(row.current_period_end).toISOString();
  if (periodEnd <= input.now.toISOString()) return { startsAt: null, conflict: false };
  if (row.pending_plan_key) return { startsAt: null, conflict: true };
  return { startsAt: periodEnd, conflict: false };
}
