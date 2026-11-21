/**
 * ESH-193 / #1378 — the read-only plan-transition quote.
 *
 * This module answers "what would moving to this plan cost, and when?" without
 * moving money or changing the subscription. It exists so the tenant UI (#1380)
 * can show a real upgrade/downgrade quote before the release-gated charging
 * path is wired: the arithmetic lives in `proration.ts`, this file only reads
 * the facts.
 *
 * Facts it is careful about:
 *  - the current plan, term and *paid period* come from the subscription;
 *  - the amount actually paid for the running period comes from the paid
 *    invoice that covers it, when one exists. A published-price fallback is
 *    labelled as such (`creditBasis`), because a credit computed from a list
 *    price is an estimate, not a receipt;
 *  - the target monthly price is a published `billing_price_versions` row, and
 *    a draft/retired plan is refused;
 *  - the proration policy is configuration, never a request field.
 */
import { query, withTenant } from "../../db";
import { getBillingPlan } from "../../billing-plans-service";
import { readCommercialSettings } from "../runtime";
import { readPlanPricing } from "../quote/plan-quote-service";
import { getBusinessSubscription } from "../../subscription-service";
import {
  quotePlanTransition,
  type ProrationPolicy,
  type TransitionQuote,
} from "./proration";

export type PlanTransitionRefusal =
  | "subscription_not_found"
  | "plan_not_found"
  | "plan_not_purchasable"
  | "plan_price_missing"
  | "same_plan"
  | "invalid_transition";

export interface PlanTransitionQuoteResult {
  ok: boolean;
  refusal: PlanTransitionRefusal | null;
  /** The calculator's answer; null on refusal. */
  quote: TransitionQuote | null;
  current: {
    planKey: string;
    termMonths: number;
    periodStart: string;
    periodEnd: string;
    paidRial: number;
    /** `paid_invoice` is a receipt; `published_price` is a labelled estimate. */
    creditBasis: "paid_invoice" | "published_price";
  } | null;
  target: {
    planKey: string;
    monthlyPriceRial: number;
    priceVersion: { id: string; version: number } | null;
  } | null;
  prorationPolicy: ProrationPolicy;
  taxRateBps: number;
}

function refused(refusal: PlanTransitionRefusal): PlanTransitionQuoteResult {
  return {
    ok: false,
    refusal,
    quote: null,
    current: null,
    target: null,
    prorationPolicy: "none",
    taxRateBps: 0,
  };
}

export async function readPlanTransitionQuote(input: {
  businessId: string;
  targetPlanKey: string;
  now?: Date;
}): Promise<PlanTransitionQuoteResult> {
  const now = input.now ?? new Date();
  const targetKey = input.targetPlanKey.trim();
  if (!targetKey) return refused("plan_not_found");

  const subscription = await getBusinessSubscription(input.businessId);
  if (!subscription) return refused("subscription_not_found");
  if (subscription.planKey === targetKey) return refused("same_plan");

  const [currentPlan, targetPlan, pricing, settings] = await Promise.all([
    getBillingPlan(subscription.planKey),
    getBillingPlan(targetKey),
    readPlanPricing({ planKey: targetKey, now }),
    readCommercialSettings(),
  ]);
  if (!targetPlan) return refused("plan_not_found");
  if (targetPlan.status !== "active") return refused("plan_not_purchasable");
  if (!pricing.ok) {
    return refused(pricing.error === "plan_price_missing" ? "plan_price_missing" : "plan_not_purchasable");
  }

  const prorationPolicy: ProrationPolicy =
    settings.proration_policy === "daily" ? "daily" : "none";
  const taxRateBps = clampBps(Number(settings.tax_rate_bps ?? 0));

  const paid = await paidAmountForPeriod({
    businessId: input.businessId,
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
  });
  const publishedBasis = Math.max(0, currentPlan?.monthlyPriceRial ?? 0) * Math.max(1, subscription.termMonths);
  const paidRial = paid ?? publishedBasis;

  const quote = quotePlanTransition({
    kind:
      pricing.pricing.monthlyBaseRial >= (currentPlan?.monthlyPriceRial ?? 0)
        ? "upgrade"
        : "downgrade",
    policy: prorationPolicy,
    at: now.toISOString(),
    current: {
      planKey: subscription.planKey,
      termMonths: subscription.termMonths,
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      paidRial,
    },
    target: {
      planKey: targetKey,
      monthlyPriceRial: pricing.pricing.monthlyBaseRial,
    },
    taxRate: taxRateBps / 10_000,
  });

  return {
    ok: quote.ok,
    refusal: quote.ok ? null : quote.refusal === "same_plan" ? "same_plan" : "invalid_transition",
    quote,
    current: {
      planKey: subscription.planKey,
      termMonths: subscription.termMonths,
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      paidRial,
      creditBasis: paid == null ? "published_price" : "paid_invoice",
    },
    target: {
      planKey: targetKey,
      monthlyPriceRial: pricing.pricing.monthlyBaseRial,
      priceVersion: pricing.pricing.basePriceVersion,
    },
    prorationPolicy,
    taxRateBps,
  };
}

/** The amount actually paid for the running period, if a paid invoice covers it. */
async function paidAmountForPeriod(input: {
  businessId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<number | null> {
  const { rows } = await withTenant(input.businessId, () =>
    query<{ total_rial: string }>(
      `SELECT total_rial
         FROM billing_invoices
        WHERE business_id = $1
          AND status = 'paid'
          AND period_start IS NOT NULL AND period_end IS NOT NULL
          AND period_start < $3::timestamptz AND period_end > $2::timestamptz
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.businessId, input.periodStart, input.periodEnd],
    ),
  );
  const value = rows[0]?.total_rial;
  return value == null ? null : Math.max(0, Number(value));
}

function clampBps(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10_000, Math.round(value)));
}
