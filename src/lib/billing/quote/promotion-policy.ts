/**
 * ESH-193 / #1378 — the promotion policy a quote is priced under.
 *
 * Duration discounts are configuration, never constants: a 3-month or annual
 * rate that lives in code is a promise nobody can turn off. The same table
 * carries the one explicit decision that lets a coupon stack with a duration
 * discount, and its default is OFF.
 *
 * `best_single` is the default for a reason: a campaign and a prepayment term
 * are two independent promotions, and applying both silently is how a business
 * ends up selling a year for the price of a quarter.
 */
import { query } from "../../db";
import { PLAN_TERM_MONTHS, type PlanTermMonths, type QuoteStackingPolicy } from "./plan-quote";

export interface PromotionPolicy {
  /** Configured rate per term (0.05 = 5%); zero when the term has no promotion. */
  termDiscountRates: Record<PlanTermMonths, number>;
  stackingPolicy: QuoteStackingPolicy;
}

export interface PolicyReader {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
  termDiscountRates: { 1: 0, 3: 0, 12: 0 },
  stackingPolicy: "best_single",
};

interface PolicyRow extends Record<string, unknown> {
  term_discount_bps_1: number | string | null;
  term_discount_bps_3: number | string | null;
  term_discount_bps_12: number | string | null;
  coupon_stacking_enabled: boolean | null;
}

function rate(value: unknown): number {
  const bps = Number(value ?? 0);
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) return 0;
  return Math.round(bps) / 10_000;
}

/** Read the one commercial settings row; zero discounts and no stacking if absent. */
export async function readPromotionPolicy(exec?: PolicyReader): Promise<PromotionPolicy> {
  const reader = exec ?? { query };
  const { rows } = await reader.query<PolicyRow>(
    `SELECT term_discount_bps_1, term_discount_bps_3, term_discount_bps_12,
            coupon_stacking_enabled
       FROM billing_commercial_settings
      WHERE id`,
  );
  const row = rows[0];
  if (!row) return DEFAULT_PROMOTION_POLICY;
  return {
    termDiscountRates: {
      1: rate(row.term_discount_bps_1),
      3: rate(row.term_discount_bps_3),
      12: rate(row.term_discount_bps_12),
    },
    // Only an explicit `true` allows stacking; anything else — a legacy row,
    // a null, a string — stays single-discount.
    stackingPolicy: row.coupon_stacking_enabled === true ? "stack" : "best_single",
  };
}

/** The configured rate for one of the sold terms. */
export function termDiscountRateFor(policy: PromotionPolicy, termMonths: PlanTermMonths): number {
  return policy.termDiscountRates[termMonths] ?? 0;
}

/** A policy with a specific term's discount, for a single-term quote. */
export function withTermDiscount(
  policy: PromotionPolicy,
  termMonths: PlanTermMonths,
  rateValue: number,
): PromotionPolicy {
  if (!(PLAN_TERM_MONTHS as readonly number[]).includes(termMonths)) return policy;
  return {
    ...policy,
    termDiscountRates: { ...policy.termDiscountRates, [termMonths]: rateValue },
  };
}
