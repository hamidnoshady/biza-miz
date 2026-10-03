/**
 * The ONE plan domain service (migration 0176) — definitions, packaging,
 * limits and the per-feature pricing catalogue, plus business entitlements.
 *
 * Model after the consolidation:
 *  - `billing_plans` — a plan's identity, base pricing (monthly fee, currency
 *    is Rial platform-wide), operational limits (branch/member/monthly-order,
 *    NULL = intentionally unlimited), trial/grace defaults, monthly AI credit
 *    and a lifecycle status:
 *      • draft   — editable, not purchasable, not assignable
 *      • active  — purchasable, usable by businesses
 *      • retired — closed to new customers, still valid for existing
 *                  subscriptions and historical references (never hard-deleted)
 *  - `billing_plan_features` — for each (plan, feature) a commercial model:
 *      • included — part of the plan, no extra charge
 *      • monthly  — costs price_rial per month (a recurring add-on)
 *      • per_use  — costs price_rial for each use, charged from the wallet
 *      • addon    — one-off purchase, then owned
 *    plus optional `free_until` / `free_limit` promotions.
 *  - `business_entitlements` — features a business owns (via plan/addon/promo/
 *    manual grant), with expiry and free-promo allowances copied at grant.
 *  - `feature_usage` — counters; a per_use feature is free until the promo
 *    window closes or `free_limit` uses are consumed.
 *
 * Money is integer Rial everywhere. The old `plans` limits catalogue
 * (migration 0034) was folded into `billing_plans` by 0176; this service is
 * the only writer, so a plan can never again exist in one catalogue with its
 * limits missing from the other.
 *
 * Entitlement resolution order (most specific wins):
 *   manual grant → addon purchase → plan feature → promo row
 */
import { query } from "./db";
import { n, positiveInt } from "./billing-helpers";
import { publishPriceVersion } from "./billing/runtime";

/**
 * Postgres `timestamptz` columns come back from node-postgres as JS `Date`
 * objects; every comparison here is an ISO-string lexicographic compare (which
 * is correct only when both sides are strings). Normalize at the boundary.
 */
function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? (typeof value === "string" ? value : null) : d.toISOString();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PricingModel = "included" | "monthly" | "per_use" | "addon";

/** The plan lifecycle (migration 0176). Historical rows are never deleted. */
export type PlanStatus = "draft" | "active" | "retired";

/**
 * How one operational limit is expressed. `unlimited` is an explicit choice,
 * never an accident of a missing row: the API requires this object for every
 * limit when a plan is created, and stores unlimited as NULL by design.
 */
export interface LimitSpec {
  unlimited: boolean;
  value?: number | null;
}

export interface PlanLimitsSpec {
  branches: LimitSpec;
  members: LimitSpec;
  monthlyOrders: LimitSpec;
}

export interface BillingPlan {
  key: string;
  name: string;
  description: string | null;
  status: PlanStatus;
  /** Derived: status === 'active'. */
  isActive: boolean;
  monthlyPriceRial: number | null;
  /**
   * AI credit included per calendar month (migration 0168). Consumed by the
   * wallet settlement BEFORE the wallet itself, so a plan can ship
   * «۱۰۰٬۰۰۰ تومان اعتبار هوش مصنوعی» with no manual grant and no second
   * balance. NULL = the plan includes no AI credit.
   */
  monthlyAiCreditRial: number | null;
  /** Operational limits — NULL = unlimited (an explicit choice, see LimitSpec). */
  branchLimit: number | null;
  memberLimit: number | null;
  monthlyOrderLimit: number | null;
  trialDays: number;
  graceDays: number;
  sortOrder: number;
}

export interface BillingPlanFeature {
  id: string;
  planKey: string;
  featureKey: string;
  featureName: string | null;
  pricingModel: PricingModel;
  priceRial: number;
  freeUntil: string | null;
  freeLimit: number | null;
  sortOrder: number;
}

export interface FeatureCatalogueEntry {
  key: string;
  name: string;
  description: string | null;
  defaultEnabled: boolean;
}

export interface BusinessEntitlement {
  featureKey: string;
  source: "plan" | "addon" | "promo" | "manual";
  expiresAt: string | null;
  freeUntil: string | null;
  freeLimit: number | null;
}

export interface FeatureAccess {
  featureKey: string;
  /** Entitled at all (plan includes it, addon owned, or active promo). */
  entitled: boolean;
  /** True when this feature is a per-use metered function (price may be 0
   *  during a free promo, but each use still counts toward free limits). */
  metered: boolean;
  /** Per-use price in Rial *right now* — 0 while a free promo applies. */
  perUsePriceRial: number;
  /** True while a free promotion covers this feature. */
  promoActive: boolean;
  /** Free uses remaining (null when there is no usage cap). */
  freeUsesRemaining: number | null;
  /** Entitlement/promo expiry, whichever is sooner and relevant. */
  expiresAt: string | null;
  source: BusinessEntitlement["source"] | null;
}

// ---------------------------------------------------------------------------
// Plan catalogue
// ---------------------------------------------------------------------------

const PLAN_COLUMNS = `key, name, description, status, monthly_price_rial, monthly_ai_credit_rial,
       branch_limit, member_limit, monthly_order_limit, trial_days, grace_days, sort_order`;

type PlanRow = {
  key: string;
  name: string;
  description: string | null;
  status: PlanStatus;
  monthly_price_rial: string | null;
  monthly_ai_credit_rial: string | null;
  branch_limit: number | null;
  member_limit: number | null;
  monthly_order_limit: number | null;
  trial_days: number;
  grace_days: number;
  sort_order: number;
}

function toPlan(r: PlanRow): BillingPlan {
  return {
    key: r.key,
    name: r.name,
    description: r.description,
    status: r.status,
    isActive: r.status === "active",
    monthlyPriceRial: r.monthly_price_rial == null ? null : n(r.monthly_price_rial),
    monthlyAiCreditRial: r.monthly_ai_credit_rial == null ? null : n(r.monthly_ai_credit_rial),
    branchLimit: r.branch_limit,
    memberLimit: r.member_limit,
    monthlyOrderLimit: r.monthly_order_limit,
    trialDays: r.trial_days,
    graceDays: r.grace_days,
    sortOrder: r.sort_order,
  };
}

/** Which plans a business may be put on: active plans (retired is historical). */
export async function listAssignablePlans(): Promise<BillingPlan[]> {
  const { rows } = await query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM billing_plans WHERE status = 'active' ORDER BY sort_order, key`,
  );
  return rows.map(toPlan);
}

export async function listBillingPlans(activeOnly = false): Promise<BillingPlan[]> {
  const { rows } = await query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM billing_plans
      WHERE ($1::boolean = false OR status = 'active')
      ORDER BY sort_order, key`,
    [activeOnly],
  );
  return rows.map(toPlan);
}

export async function getBillingPlan(key: string): Promise<BillingPlan | null> {
  const { rows } = await query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM billing_plans WHERE key = $1`, [key]);
  return rows[0] ? toPlan(rows[0]) : null;
}

/** Normalizes one LimitSpec into the stored integer (NULL = unlimited). */
function limitValue(spec: LimitSpec | undefined): number | null {
  if (!spec || spec.unlimited) return null;
  const value = Math.floor(n(spec.value ?? 0));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_limit");
  return value;
}

export interface SaveBillingPlanInput {
  key?: string;
  name: string;
  description?: string | null;
  monthlyPriceRial?: number | null;
  monthlyAiCreditRial?: number | null;
  status?: PlanStatus;
  sortOrder: number;
  trialDays?: number;
  graceDays?: number;
  /**
   * Required when CREATING a plan: every limit must be an explicit
   * limited/unlimited choice, so a new plan can never become unlimited by
   * accident. Optional when UPDATING — absent limits keep their stored value.
   */
  limits?: PlanLimitsSpec;
}

/**
 * Create or update a plan. One table, one write: the old dual-write into the
 * 0034 `plans` catalogue is gone with the table (migration 0176).
 */
export async function saveBillingPlan(input: SaveBillingPlanInput): Promise<BillingPlan> {
  const name = input.name.trim();
  if (!name) throw new Error("missing_fields");
  const key = (input.key ?? "").trim() || slugifyKey(name);
  const price = input.monthlyPriceRial == null ? null : Math.max(0, Math.floor(n(input.monthlyPriceRial)));
  // NULL keeps "no included AI credit"; 0 normalises to NULL (same meaning,
  // one representation).
  const aiCredit =
    input.monthlyAiCreditRial == null || n(input.monthlyAiCreditRial) <= 0
      ? null
      : Math.max(0, Math.floor(n(input.monthlyAiCreditRial)));
  const status = input.status ?? "active";
  if (!["draft", "active", "retired"].includes(status)) throw new Error("bad_status");

  const existing = await getBillingPlan(key);
  if (!existing && !input.limits) throw new Error("limits_required");

  const branchLimit = input.limits ? limitValue(input.limits.branches) : existing?.branchLimit ?? null;
  const memberLimit = input.limits ? limitValue(input.limits.members) : existing?.memberLimit ?? null;
  const monthlyOrderLimit = input.limits
    ? limitValue(input.limits.monthlyOrders)
    : existing?.monthlyOrderLimit ?? null;
  const trialDays = Math.max(0, Math.floor(n(input.trialDays ?? existing?.trialDays ?? 0)));
  const graceDays = Math.max(0, Math.floor(n(input.graceDays ?? existing?.graceDays ?? 7)));

  await query(
    `INSERT INTO billing_plans
       (key, name, description, monthly_price_rial, monthly_ai_credit_rial, status,
        branch_limit, member_limit, monthly_order_limit, trial_days, grace_days, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (key) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description,
       monthly_price_rial = EXCLUDED.monthly_price_rial,
       monthly_ai_credit_rial = EXCLUDED.monthly_ai_credit_rial,
       status = EXCLUDED.status,
       branch_limit = EXCLUDED.branch_limit,
       member_limit = EXCLUDED.member_limit,
       monthly_order_limit = EXCLUDED.monthly_order_limit,
       trial_days = EXCLUDED.trial_days,
       grace_days = EXCLUDED.grace_days,
       sort_order = EXCLUDED.sort_order,
       updated_at = now()`,
    [
      key,
      name,
      input.description?.trim() || null,
      price,
      aiCredit,
      status,
      branchLimit,
      memberLimit,
      monthlyOrderLimit,
      trialDays,
      graceDays,
      input.sortOrder || 0,
    ],
  );
  const { syncAiAllowance, publishPriceVersion } = await import("./billing/runtime");
  await syncAiAllowance(key, aiCredit);
  if (price != null) {
    await publishPriceVersion({
      targetType: "plan",
      targetKey: key,
      unit: "month",
      unitAmountRial: price,
      unitSize: 1,
    });
  }
  const plan = await getBillingPlan(key);
  if (!plan) throw new Error("save_failed");
  return plan;
}

function slugifyKey(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || `plan_${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Plan lifecycle
// ---------------------------------------------------------------------------

export class PlanTransitionError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** draft → active: the plan becomes purchasable and assignable. */
export async function activatePlan(key: string): Promise<BillingPlan> {
  const plan = await getBillingPlan(key);
  if (!plan) throw new PlanTransitionError("plan_not_found");
  if (plan.status === "retired") throw new PlanTransitionError("plan_retired");
  await query(`UPDATE billing_plans SET status = 'active', updated_at = now() WHERE key = $1`, [key]);
  return (await getBillingPlan(key))!;
}

/** active → retired: closed to new customers; existing references stay valid. */
export async function retirePlan(key: string): Promise<BillingPlan> {
  const plan = await getBillingPlan(key);
  if (!plan) throw new PlanTransitionError("plan_not_found");
  if (plan.status !== "active") throw new PlanTransitionError("plan_not_active");
  await query(`UPDATE billing_plans SET status = 'retired', updated_at = now() WHERE key = $1`, [key]);
  return (await getBillingPlan(key))!;
}

/**
 * Hard-delete a plan. Only an UNUSED DRAFT may be removed: an active plan is
 * purchasable by definition, a retired plan keeps historical references
 * honest, and any plan a business (or a payment) ever pointed at is history.
 * The businesses.plan FK is the hard guarantee; this check turns a would-be
 * FK violation into an actionable reason.
 */
export async function deleteDraftPlan(key: string): Promise<void> {
  const plan = await getBillingPlan(key);
  if (!plan) throw new PlanTransitionError("plan_not_found");
  if (plan.status !== "draft") throw new PlanTransitionError("plan_not_draft");
  const { rows } = await query<{ businesses: string; subscriptions: string; payments: string }>(
    `SELECT
       (SELECT count(*)::text FROM businesses WHERE plan = $1) AS businesses,
       (SELECT count(*)::text FROM business_subscriptions WHERE plan_key = $1) AS subscriptions,
       (SELECT count(*)::text FROM billing_payments WHERE plan_key = $1) AS payments`,
    [key],
  );
  const used = Number(rows[0]?.businesses ?? 0) + Number(rows[0]?.subscriptions ?? 0) + Number(rows[0]?.payments ?? 0);
  if (used > 0) throw new PlanTransitionError("plan_in_use");
  await query(`DELETE FROM billing_plans WHERE key = $1`, [key]);
}

// ---------------------------------------------------------------------------
// Feature catalogue + per-plan pricing
// ---------------------------------------------------------------------------

export async function listFeatureCatalogue(): Promise<FeatureCatalogueEntry[]> {
  const { rows } = await query<{
    key: string;
    name: string;
    description: string | null;
    default_enabled: boolean;
  }>(`SELECT key, name, description, default_enabled FROM feature_flags ORDER BY name, key`);
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    defaultEnabled: r.default_enabled,
  }));
}

export async function listPlanFeatures(planKey: string): Promise<BillingPlanFeature[]> {
  const { rows } = await query<{
    id: string;
    plan_key: string;
    feature_key: string;
    feature_name: string | null;
    pricing_model: PricingModel;
    price_rial: string;
    free_until: string | null;
    free_limit: number | null;
    sort_order: number;
  }>(
    `SELECT pf.*, f.name AS feature_name
       FROM billing_plan_features pf
       LEFT JOIN feature_flags f ON f.key = pf.feature_key
      WHERE pf.plan_key = $1
      ORDER BY pf.sort_order, pf.created_at, pf.id`,
    [planKey],
  );
  return rows.map((r) => ({
    id: r.id,
    planKey: r.plan_key,
    featureKey: r.feature_key,
    featureName: r.feature_name,
    pricingModel: r.pricing_model,
    priceRial: n(r.price_rial),
    freeUntil: iso(r.free_until),
    freeLimit: r.free_limit,
    sortOrder: r.sort_order,
  }));
}

export async function savePlanFeature(input: {
  id?: string;
  planKey: string;
  featureKey: string;
  pricingModel: PricingModel;
  priceRial: number;
  freeUntil?: string | null;
  freeLimit?: number | null;
  sortOrder: number;
}): Promise<BillingPlanFeature> {
  if (!["included", "monthly", "per_use", "addon"].includes(input.pricingModel)) {
    throw new Error("bad_pricing_model");
  }
  const plan = await getBillingPlan(input.planKey);
  if (!plan) throw new PlanTransitionError("plan_not_found");
  // A retired plan is a historical record: its pricing rows no longer move.
  if (plan.status === "retired") throw new PlanTransitionError("plan_retired");
  const price = Math.max(0, Math.floor(n(input.priceRial)));
  if ((input.pricingModel === "per_use" || input.pricingModel === "monthly" || input.pricingModel === "addon") && price <= 0) {
    // A price of zero is legal — it reads as "free" — but the promo columns
    // are the intended free-for-time/use mechanism; zero price simply bills 0.
  }
  const freeLimit =
    input.freeLimit == null || input.freeLimit < 0 ? null : Math.floor(input.freeLimit);
  await query(
    `INSERT INTO billing_plan_features
       (id, plan_key, feature_key, pricing_model, price_rial, free_until, free_limit, sort_order)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (plan_key, feature_key) DO UPDATE SET
       pricing_model = EXCLUDED.pricing_model,
       price_rial = EXCLUDED.price_rial,
       free_until = EXCLUDED.free_until,
       free_limit = EXCLUDED.free_limit,
       sort_order = EXCLUDED.sort_order,
       updated_at = now()
     RETURNING id`,
    [
      input.id ?? null,
      input.planKey,
      input.featureKey,
      input.pricingModel,
      price,
      input.freeUntil ?? null,
      freeLimit,
      input.sortOrder || 0,
    ],
  );
  const all = await listPlanFeatures(input.planKey);
  const row = all.find((f) => f.featureKey === input.featureKey);
  if (!row) throw new Error("save_failed");
  await publishPriceVersion({
    targetType: input.pricingModel === "addon" ? "addon" : "capability",
    targetKey: `${input.planKey}:${input.featureKey}`,
    unit: input.pricingModel === "monthly" ? "month" : "use",
    unitAmountRial: price,
    unitSize: 1,
    metadata: { planKey: input.planKey, featureKey: input.featureKey, pricingModel: input.pricingModel },
  });
  return row;
}

export async function deletePlanFeature(planKey: string, featureKey: string): Promise<void> {
  const plan = await getBillingPlan(planKey);
  if (plan?.status === "retired") throw new PlanTransitionError("plan_retired");
  await query(`DELETE FROM billing_plan_features WHERE plan_key = $1 AND feature_key = $2`, [
    planKey,
    featureKey,
  ]);
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export async function listEntitlements(businessId: string): Promise<BusinessEntitlement[]> {
  const { rows } = await query<{
    feature_key: string;
    source: BusinessEntitlement["source"];
    expires_at: string | null;
    free_until: string | null;
    free_limit: number | null;
  }>(
    `SELECT feature_key, source, expires_at, free_until, free_limit
       FROM business_entitlements WHERE business_id = $1
      ORDER BY feature_key`,
    [businessId],
  );
  return rows.map((r) => ({
    featureKey: r.feature_key,
    source: r.source,
    expiresAt: iso(r.expires_at),
    freeUntil: iso(r.free_until),
    freeLimit: r.free_limit,
  }));
}

/** Super-admin: manually grant (or extend) a feature for a business. */
export async function grantEntitlement(input: {
  businessId: string;
  featureKey: string;
  source?: BusinessEntitlement["source"];
  expiresAt?: string | null;
  freeUntil?: string | null;
  freeLimit?: number | null;
  grantedBy?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO business_entitlements
       (business_id, feature_key, source, expires_at, free_until, free_limit, granted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (business_id, feature_key) DO UPDATE SET
       source = EXCLUDED.source,
       expires_at = EXCLUDED.expires_at,
       free_until = EXCLUDED.free_until,
       free_limit = EXCLUDED.free_limit,
       granted_by = EXCLUDED.granted_by,
       updated_at = now()`,
    [
      input.businessId,
      input.featureKey,
      input.source ?? "manual",
      input.expiresAt ?? null,
      input.freeUntil ?? null,
      input.freeLimit == null ? null : Math.max(0, Math.floor(input.freeLimit)),
      input.grantedBy ?? null,
    ],
  );
}

export async function revokeEntitlement(businessId: string, featureKey: string): Promise<void> {
  await query(`DELETE FROM business_entitlements WHERE business_id = $1 AND feature_key = $2`, [
    businessId,
    featureKey,
  ]);
}

// ---------------------------------------------------------------------------
// Effective feature access (the pricing decision used at charge time)
// ---------------------------------------------------------------------------

/**
 * Whether the business's subscription still carries its plan: an active,
 * trialing or in-grace subscription does; a cancelled one does until its paid
 * period ends; an expired one does not. Businesses with no subscription row
 * (pre-0176 data edge) are treated as active so nothing regresses.
 */
type DbExec = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

/**
 * Pure lifecycle evaluation: whether a subscription row still carries the
 * business's plan at `nowIso`. Shared by `subscriptionCarriesPlan`,
 * `entitlement-service.ts`, and `ai-plan-allowance.ts`.
 *
 *   - no subscription row (`null`/`undefined` or `status == null`) → true
 *     (pre-0176 businesses keep their `businesses.plan`).
 *   - `cancelled` (immediate cancellation) or `expired` → false.
 *   - `past_due` → true while inside grace (`graceEnd == null || graceEnd > nowIso`),
 *     false once `graceEnd <= nowIso`.
 *   - `trialing` → false when `(cancelAtPeriodEnd || autoRenew === false)` and
 *     `(trialEnd ?? currentPeriodEnd) <= nowIso`; otherwise true.
 *   - `active` → false when `(cancelAtPeriodEnd || autoRenew === false)` and
 *     `currentPeriodEnd <= nowIso`; otherwise true.
 */
export function isSubscriptionCarryingPlan(
  sub: {
    status?: string | null;
    currentPeriodEnd?: string | Date | null;
    cancelAtPeriodEnd?: boolean | null;
    autoRenew?: boolean | null;
    graceEnd?: string | Date | null;
    trialEnd?: string | Date | null;
  } | null | undefined,
  nowIso: string,
): boolean {
  if (!sub || sub.status == null) return true;
  if (sub.status === "cancelled" || sub.status === "expired") return false;

  const periodEnd = sub.currentPeriodEnd ? iso(sub.currentPeriodEnd) : null;
  const graceEnd = sub.graceEnd ? iso(sub.graceEnd) : null;
  const trialEnd = sub.trialEnd ? iso(sub.trialEnd) : null;

  if (sub.status === "past_due") {
    if (graceEnd != null && graceEnd <= nowIso) return false;
    return true;
  }

  if (sub.status === "trialing") {
    const effectiveEnd = trialEnd ?? periodEnd;
    if (
      (sub.cancelAtPeriodEnd || sub.autoRenew === false) &&
      effectiveEnd != null &&
      effectiveEnd <= nowIso
    ) {
      return false;
    }
    return true;
  }

  if (sub.status === "active") {
    if (
      (sub.cancelAtPeriodEnd || sub.autoRenew === false) &&
      periodEnd != null &&
      periodEnd <= nowIso
    ) {
      return false;
    }
    return true;
  }

  return false;
}

export async function subscriptionCarriesPlan(
  businessId: string,
  nowIso: string,
  exec: DbExec = { query },
): Promise<boolean> {
  const { rows } = await exec.query<{
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean | null;
    auto_renew: boolean | null;
    grace_end: string | null;
    trial_end: string | null;
  }>(
    `SELECT status, current_period_end, cancel_at_period_end, auto_renew, grace_end, trial_end
       FROM business_subscriptions WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) return true;
  return isSubscriptionCarryingPlan(
    {
      status: row.status,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      autoRenew: row.auto_renew,
      graceEnd: row.grace_end,
      trialEnd: row.trial_end,
    },
    nowIso,
  );
}

/**
 * Resolve how one feature stands for a business: whether it is usable and the
 * per-use Rial price in the current moment.
 *
 * A per_use plan feature bills from the wallet; but while its `free_until`
 * date is in the future or `free_limit` uses remain, the price is 0. Features
 * marked `included`/`monthly`/`addon` are entitled when the business has the
 * plan or owns the addon; manual grants always entitle.
 */
export async function resolveFeatureAccess(
  businessId: string,
  featureKey: string,
  now: Date = new Date(),
  exec: DbExec = { query },
): Promise<FeatureAccess> {
  const [access] = await resolveFeaturesAccess(businessId, [featureKey], now, exec);
  return access;
}

async function resolveFeatureAccessImpl(
  businessId: string,
  featureKeys: string[],
  now: Date,
  exec: DbExec = { query },
): Promise<FeatureAccess[]> {
  const nowIso = now.toISOString();
  const { rows: bizRows } = await exec.query<{ plan: string }>(
    `SELECT plan FROM businesses WHERE id = $1`,
    [businessId],
  );
  const planKey = bizRows[0]?.plan ?? "free";
  const planEffective = await subscriptionCarriesPlan(businessId, nowIso, exec);

  const { rows: planFeatures } = await exec.query<{
    feature_key: string;
    pricing_model: PricingModel;
    price_rial: string;
    free_until: string | null;
    free_limit: number | null;
  }>(
    `SELECT feature_key, pricing_model, price_rial, free_until, free_limit
       FROM billing_plan_features
      WHERE plan_key = $1 AND feature_key = ANY($2::text[])`,
    [planKey, featureKeys],
  );

  const { rows: entitlements } = await exec.query<{
    feature_key: string;
    source: BusinessEntitlement["source"];
    expires_at: string | null;
    free_until: string | null;
    free_limit: number | null;
  }>(
    `SELECT feature_key, source, expires_at, free_until, free_limit
       FROM business_entitlements
      WHERE business_id = $1 AND feature_key = ANY($2::text[])`,
    [businessId, featureKeys],
  );

  const { rows: usage } = await exec.query<{
    feature_key: string;
    used_count: string;
  }>(
    `SELECT feature_key, used_count FROM feature_usage
      WHERE business_id = $1 AND feature_key = ANY($2::text[])`,
    [businessId, featureKeys],
  );
  const usedByKey = new Map(usage.map((u) => [u.feature_key, n(u.used_count)]));
  const entByKey = new Map(
    entitlements.map((e) => [
      e.feature_key,
      {
        source: e.source,
        expiresAt: iso(e.expires_at),
        freeUntil: iso(e.free_until),
        freeLimit: e.free_limit == null ? null : n(e.free_limit),
      },
    ]),
  );
  const planByKey = new Map(
    planFeatures.map((f) => [
      f.feature_key,
      { ...f, free_until: iso(f.free_until), free_limit: f.free_limit },
    ]),
  );

  return featureKeys.map((featureKey) => {
    const planFeature = planByKey.get(featureKey);
    const entitlement = entByKey.get(featureKey);
    const usedCount = usedByKey.get(featureKey) ?? 0;

    // Manual / addon entitlement (not expired) → entitled; its free promo may
    // still zero the price of a metered feature. These survive a plan change
    // and an expired subscription — an addon is owned, not rented.
    const ownedEntitlement =
      entitlement &&
      (entitlement.source === "manual" || entitlement.source === "addon") &&
      (!entitlement.expiresAt || entitlement.expiresAt > nowIso)
        ? entitlement
        : null;

    const promoFromEntitlement =
      entitlement &&
      (entitlement.source === "promo" || entitlement.freeUntil || entitlement.freeLimit != null)
        ? entitlement
        : null;

    const model: PricingModel | null = planFeature?.pricing_model ?? null;
    const price = planFeature ? n(planFeature.price_rial) : 0;

    // A time/use promotion in progress (plan-level promo window still open, or
    // a promo entitlement that has not expired).
    const planFreeUntil = planFeature?.free_until ?? null;
    const planFreeLimit = planFeature?.free_limit ?? null;
    const promoWindowOpen =
      (ownedEntitlement?.freeUntil || promoFromEntitlement?.freeUntil || planFreeUntil
        ? (ownedEntitlement?.freeUntil ?? promoFromEntitlement?.freeUntil ?? planFreeUntil)! > nowIso
        : true);
    const hasAnyPromo =
      planFreeUntil != null ||
      planFreeLimit != null ||
      Boolean(ownedEntitlement?.freeUntil || ownedEntitlement?.freeLimit != null || promoFromEntitlement);
    const activePlanPromo = hasAnyPromo && promoWindowOpen;

    // Entitlement?
    //
    // Billing is opt-in: a feature with NO pricing row is not metered here at
    // all (its access is governed by the existing feature_flags / plan-limit
    // layer, which keeps working unchanged). It reads as entitled and free, so
    // chargeForFeature lets the work through without touching the wallet.
    let entitled = model === null;
    let source: FeatureAccess["source"] = model === null ? "plan" : null;
    if (ownedEntitlement) {
      entitled = true;
      source = ownedEntitlement.source;
    } else if (model === "included" || model === "monthly") {
      // Included/monthly features of the current plan are available — but only
      // while the subscription carries the plan. (Monthly fees are collected
      // at plan subscription / renewal; the feature itself is on.)
      entitled = planEffective;
      source = "plan";
    } else if (model === "per_use") {
      // Per-use features are reachable (pay as you go), and a running free
      // promotion makes the feature usable outright during its window/quota.
      entitled = planEffective;
      source = "plan";
    } else if (model === "addon") {
      // Addons require purchase; the ownedEntitlement branch above handles it,
      // but a promo window can open the feature for free as well.
      entitled = activePlanPromo || (promoFromEntitlement != null && promoWindowOpen);
      if (entitled) source = "promo";
    } else if (promoFromEntitlement && promoWindowOpen) {
      entitled = true;
      source = "promo";
    }

    // Free promotion resolution — plan-level promo OR promo entitlement.
    const freeUntil =
      ownedEntitlement?.freeUntil ??
      promoFromEntitlement?.freeUntil ??
      planFeature?.free_until ??
      null;
    const freeLimit =
      ownedEntitlement?.freeLimit ??
      promoFromEntitlement?.freeLimit ??
      planFeature?.free_limit ??
      null;
    // A promo is a time window and/or a use quota. It is active while the
    // window is open AND the quota (if any) is not exhausted: a time-only
    // promo needs `freeUntil` in the future; a use-only promo needs remaining
    // free uses; both together need both.
    const windowOpen = freeUntil == null ? true : freeUntil > nowIso;
    const quotaRemains = freeLimit == null ? true : usedCount < freeLimit;
    const hasPromo = freeUntil != null || freeLimit != null;
    const promoActive = hasPromo && windowOpen && quotaRemains;

    let perUsePrice = 0;
    if (model === "per_use") {
      perUsePrice = promoActive ? 0 : price;
    } else if (model === "addon") {
      perUsePrice = 0; // owned outright; purchase price handled at buy time
    }

    const expiresAt =
      ownedEntitlement?.expiresAt ??
      (freeUntil && freeUntil > nowIso ? freeUntil : null);

    let freeUsesRemaining: number | null = null;
    if (freeLimit != null) {
      freeUsesRemaining = Math.max(0, freeLimit - usedCount);
    }

    return {
      featureKey,
      entitled,
      metered: model === "per_use",
      perUsePriceRial: perUsePrice,
      promoActive,
      freeUsesRemaining,
      expiresAt,
      source,
    };
  });
}

/** Batch version for the billing page / nav badge. */
export async function resolveFeaturesAccess(
  businessId: string,
  featureKeys: string[],
  now: Date = new Date(),
  exec: DbExec = { query },
): Promise<FeatureAccess[]> {
  if (featureKeys.length === 0) return [];
  return resolveFeatureAccessImpl(businessId, featureKeys, featureKeys.length ? now : new Date(), exec);
}

/**
 * The per-use price a caller should charge for one use of a feature, or null
 * when the feature is not metered (included/owned → no wallet charge).
 */
export async function perUsePriceFor(
  businessId: string,
  featureKey: string,
): Promise<{ priceRial: number; entitled: boolean }> {
  const access = await resolveFeatureAccess(businessId, featureKey);
  if (!access.entitled) return { priceRial: -1, entitled: false };
  return { priceRial: access.perUsePriceRial, entitled: true };
}

export { positiveInt };
