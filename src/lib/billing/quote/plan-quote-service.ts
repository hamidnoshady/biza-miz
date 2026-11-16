/**
 * ESH-193 / #1378 — the plan quote resolver, stage 1.
 *
 * Reads the *existing* commercial catalogue — `billing_plans`,
 * `billing_price_versions` and `billing_plan_features` — and hands it to the
 * pure calculator in `plan-quote.ts`. It deliberately adds no second price
 * table: a published `billing_price_versions` row (target `plan`, unit `month`)
 * is what a quote cites, and a plan that only has the legacy
 * `billing_plans.monthly_price_rial` column is quoted from that column with an
 * honest `legacy:` pseudo-version instead of a fake published one.
 *
 * What this slice does **not** do yet (each is a later stage, in order):
 * coupon reservation and redemption, prepaid service terms, proration on
 * upgrade/downgrade, automatic renewal quoting, and wallet debit. The quote is
 * read-only: nothing here charges, reserves or writes.
 *
 * Scope: the caller is a tenant route or the super-admin preview. The reads are
 * tenant-scoped through the ambient `query()` where a business context exists;
 * the catalogue itself (`billing_plans`, price versions) is platform-owned and
 * readable by any authenticated caller, which is what lets the preview quote a
 * plan the caller has not bought.
 */
import { query } from "../../db";
import {
  buildPlanQuote,
  planBasePriceVersion,
  type PlanQuote,
  type PlanTermMonths,
  type QuoteAddOn,
  type QuotePriceVersion,
} from "./plan-quote";

export interface QuoteExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface PlanQuoteOptions {
  planKey: string;
  termMonths: PlanTermMonths;
  /** Configured for this term; never a default in code. */
  termDiscountRate: number;
  taxRate: number;
  now?: Date;
  validityMinutes?: number;
  exec?: QuoteExecutor;
}

export type PlanQuoteError =
  | "plan_not_found"
  | "plan_not_purchasable"
  | "plan_price_missing";

export type PlanQuoteResult =
  | { ok: true; quote: PlanQuote }
  | { ok: false; error: PlanQuoteError };

/** The facts the payment boundary compares a quote against. */
export interface CurrentQuoteFacts {
  planKey: string;
  termMonths: PlanTermMonths;
  netRial: number;
  basePriceVersionId: string;
  basePriceVersion: number;
}

/**
 * Quote one plan for one term.
 *
 * A retired or draft plan is refused: its key stays a valid reference for
 * historical subscriptions, but it must not be sold again.
 */
export async function quotePlanSubscription(
  options: PlanQuoteOptions,
): Promise<PlanQuoteResult> {
  const now = options.now ?? new Date();
  const exec = options.exec ?? { query };

  const { rows: planRows } = await exec.query<{
    key: string;
    monthly_price_rial: string | number | null;
    status: string;
  }>(
    `SELECT key, monthly_price_rial, status
       FROM billing_plans
      WHERE key = $1`,
    [options.planKey],
  );
  const plan = planRows[0];
  if (!plan) return { ok: false, error: "plan_not_found" };
  if (plan.status !== "active") return { ok: false, error: "plan_not_purchasable" };

  // The newest published price effective at `now`. `version DESC` first because
  // two effective rows are legal (a scheduled price plus the live one) and the
  // higher version is the later decision.
  const { rows: priceRows } = await exec.query<{
    id: string;
    version: number;
    unit_amount_rial: string | number;
    effective_from: Date | string;
  }>(
    `SELECT id, version, unit_amount_rial, effective_from
       FROM billing_price_versions
      WHERE target_type = 'plan'
        AND target_key = $1
        AND unit = 'month'
        AND effective_from <= $2
        AND (effective_until IS NULL OR effective_until > $2)
      ORDER BY version DESC, effective_from DESC
      LIMIT 1`,
    [options.planKey, now.toISOString()],
  );

  const published = priceRows[0] ?? null;
  const legacyPrice =
    plan.monthly_price_rial === null ? null : Number(plan.monthly_price_rial);
  if (!published && (legacyPrice === null || Number.isNaN(legacyPrice))) {
    return { ok: false, error: "plan_price_missing" };
  }

  const basePriceVersion: QuotePriceVersion = published
    ? { id: published.id, version: published.version }
    : // No published version exists yet. `legacy:` cannot collide with a real
      // uuid, and version 0 says plainly that no version priced this line.
      { id: `legacy:${options.planKey}`, version: 0 };
  const monthlyBaseRial = published
    ? Number(published.unit_amount_rial)
    : legacyPrice!;

  const { rows: featureRows } = await exec.query<{
    feature_key: string;
    pricing_model: string;
    price_rial: string | number;
  }>(
    `SELECT feature_key, pricing_model, price_rial
       FROM billing_plan_features
      WHERE plan_key = $1
        AND pricing_model IN ('monthly', 'addon')
      ORDER BY sort_order, feature_key`,
    [options.planKey],
  );

  const recurringAddOns: QuoteAddOn[] = [];
  const oneOffAddOns: QuoteAddOn[] = [];
  for (const row of featureRows) {
    const amountRial = Number(row.price_rial);
    if (!Number.isSafeInteger(amountRial) || amountRial < 0) continue;
    const addOn: QuoteAddOn = {
      key: row.feature_key,
      amountRial,
      // Priced from a plain column, not a published version — say so by
      // omitting the citation rather than borrowing the plan's version.
      priceVersion: null,
    };
    if (row.pricing_model === "monthly") recurringAddOns.push(addOn);
    else oneOffAddOns.push(addOn);
  }

  const quote = buildPlanQuote({
    planKey: options.planKey,
    termMonths: options.termMonths,
    monthlyBaseRial,
    basePriceVersion,
    recurringAddOns,
    oneOffAddOns,
    termDiscountRate: options.termDiscountRate,
    taxRate: options.taxRate,
    issuedAt: now.toISOString(),
    validityMinutes: options.validityMinutes,
  });

  return { ok: true, quote };
}

/** The comparable facts of a freshly built quote, for `isQuoteStale`. */
export function currentQuoteFacts(quote: PlanQuote): CurrentQuoteFacts {
  // By kind, not index: a future trial/proration line may precede the base.
  const base = planBasePriceVersion(quote);
  return {
    planKey: quote.planKey,
    termMonths: quote.termMonths,
    netRial: quote.totals.netRial,
    basePriceVersionId: base?.id ?? "",
    basePriceVersion: base?.version ?? 0,
  };
}
