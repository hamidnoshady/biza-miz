/**
 * The subscription lifecycle service (migration 0176) — the ONE path a
 * business's platform plan ever moves through.
 *
 * Before this service existed, `businesses.plan` was set from three places
 * (the console's PATCH, the tenant's verified purchase, and the admin's
 * manual payment approval), none of which knew about the others. Every plan
 * transition now goes through `changeBusinessPlan`, which:
 *
 *   1. validates the target plan (exists, not draft, not retired for new
 *      assignments),
 *   2. reads + validates the current subscription,
 *   3. updates the subscription row and `businesses.plan` in one transaction,
 *   4. preserves purchased add-ons (business_entitlements with source
 *      'addon'/'manual' are never touched by a plan change),
 *   5. re-stamps the plan's included features,
 *   6. returns the new state for the caller to audit.
 *
 * Renewals run through `runSubscriptionRenewalTick`: the invoice row is
 * claimed first (`UNIQUE (business_id, reference)` + ON CONFLICT DO NOTHING),
 * money only moves after a claim, and a failed wallet charge commits the
 * open invoice together with `past_due`. The same period is never invoiced
 * twice. Invoice numbers come from `billing_invoice_counters`.
 *
 * Recurring totals come from `calculateSubscriptionTotal` — the one
 * authoritative computation (plan base fee + recurring add-ons). No other
 * code path invents a renewal amount.
 */
import { getPool, query, withoutTenantScope, withTenant, type PoolClient } from "./db";
import { chargeSubscriptionFeeTx, WalletInsufficientFundsError } from "./wallet-service";
import {
  getBillingPlan,
  grantEntitlement,
  listPlanFeatures,
  type BillingPlan,
} from "./billing-plans-service";
import { allocateInvoiceNumber } from "./billing/runtime";
import { billingLog } from "./billing/observability";
import { decidePlanTransition, PlanTransitionError } from "./billing/policy/transitions";
import { applyPayment, markOverdue, voidInvoice, InvoiceStateError } from "./billing/policy/invoice-state";

export { WalletInsufficientFundsError };

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired";

export interface BusinessSubscription {
  businessId: string;
  businessName?: string | null;
  planKey: string;
  status: SubscriptionStatus;
  startedAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEnd: string | null;
  trialStartedAt: string | null;
  graceEnd: string | null;
  cancelAtPeriodEnd: boolean;
  autoRenew: boolean;
  cancelledAt: string | null;
  lastRenewalAt: string | null;
}

/** Persian labels for the console UI. */
export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: "دورهٔ آزمایشی",
  active: "فعال",
  past_due: "عقب‌افتاده",
  cancelled: "لغو شده",
  expired: "منقضی",
};

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function n(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

export class SubscriptionError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type SubscriptionRow = {
  business_id: string;
  business_name?: string | null;
  plan_key: string;
  status: SubscriptionStatus;
  started_at: string | Date;
  current_period_start: string | Date;
  current_period_end: string | Date;
  trial_end: string | Date | null;
  trial_started_at: string | Date | null;
  grace_end: string | Date | null;
  cancel_at_period_end: boolean;
  auto_renew: boolean;
  cancelled_at: string | Date | null;
  last_renewal_at: string | Date | null;
}

function toSubscription(row: SubscriptionRow): BusinessSubscription {
  return {
    businessId: row.business_id,
    businessName: row.business_name ?? null,
    planKey: row.plan_key,
    status: row.status,
    startedAt: iso(row.started_at),
    currentPeriodStart: iso(row.current_period_start),
    currentPeriodEnd: iso(row.current_period_end),
    trialEnd: row.trial_end ? iso(row.trial_end) : null,
    trialStartedAt: row.trial_started_at ? iso(row.trial_started_at) : null,
    graceEnd: row.grace_end ? iso(row.grace_end) : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    autoRenew: row.auto_renew,
    cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null,
    lastRenewalAt: row.last_renewal_at ? iso(row.last_renewal_at) : null,
  };
}

const SUBSCRIPTION_COLUMNS = `s.business_id, b.name AS business_name, s.plan_key, s.status, s.started_at,
       s.current_period_start, s.current_period_end, s.trial_end, s.trial_started_at, s.grace_end,
       s.cancel_at_period_end, s.auto_renew, s.cancelled_at, s.last_renewal_at`;

export async function getBusinessSubscription(businessId: string): Promise<BusinessSubscription | null> {
  const { rows } = await query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS}
       FROM business_subscriptions s JOIN businesses b ON b.id = s.business_id
      WHERE s.business_id = $1`,
    [businessId],
  );
  return rows[0] ? toSubscription(rows[0]) : null;
}

export async function listSubscriptions(
  filter: { status?: SubscriptionStatus; businessId?: string; limit?: number } = {},
): Promise<BusinessSubscription[]> {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  const { rows } = await query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS}
       FROM business_subscriptions s JOIN businesses b ON b.id = s.business_id
      WHERE ($1::text IS NULL OR s.status = $1)
        AND ($2::uuid IS NULL OR s.business_id = $2)
      ORDER BY s.current_period_end ASC, s.business_id
      LIMIT $3`,
    [filter.status ?? null, filter.businessId ?? null, limit],
  );
  return rows.map(toSubscription);
}

// ---------------------------------------------------------------------------
// The one plan-transition path
// ---------------------------------------------------------------------------

export interface ChangePlanResult {
  subscription: BusinessSubscription;
  plan: BillingPlan;
  /** 'none' when the business was already on this plan. */
  outcome: "created" | "changed" | "unchanged";
}

/**
 * Move a business onto a plan. Every writer — the console's assignment
 * dropdown, a verified gateway purchase, a manual payment approval — calls
 * this and nothing else.
 *
 * `charge` is deliberately NOT handled here: money moves through the payment
 * flow that triggered the change (billing_payments + wallet settlement), so a
 * plan change and its charge stay separately observable facts.
 */
export async function changeBusinessPlan(input: {
  businessId: string;
  planKey: string;
  /** Where the transition came from; recorded in the caller's audit entry. */
  source: "admin" | "purchase" | "trial";
  /** Admin may set this. A purchase always enables auto-renew. */
  autoRenew?: boolean;
  now?: Date;
}): Promise<ChangePlanResult> {
  const now = input.now ?? new Date();
  const plan = await getBillingPlan(input.planKey);
  if (!plan) throw new SubscriptionError("plan_not_found");
  // A draft is not purchasable/assignable; a retired plan is closed to new
  // customers but must remain a valid FK target for existing rows — so a
  // business already on it stays, but nobody new may be moved onto it.
  if (plan.status === "draft") throw new SubscriptionError("plan_not_active");
  const existing = await getBusinessSubscription(input.businessId);
  const samePlan = existing?.planKey === input.planKey;
  const closed = !existing || existing.status === "expired" || existing.status === "cancelled";
  if (plan.status === "retired" && (!samePlan || closed)) throw new SubscriptionError("plan_retired");

  let decision;
  try {
    decision = decidePlanTransition({
      source: input.source,
      nowIso: now.toISOString(),
      trialDays: plan.trialDays,
      current: existing
        ? {
            status: existing.status,
            autoRenew: existing.autoRenew,
            trialStartedAt: existing.trialStartedAt,
            trialEnd: existing.trialEnd,
            planKey: existing.planKey,
          }
        : null,
      autoRenew: input.autoRenew,
      samePlan: Boolean(samePlan),
    });
  } catch (err) {
    if (err instanceof PlanTransitionError) throw new SubscriptionError(err.code);
    throw err;
  }
  if (decision.unchanged && existing) {
    return { subscription: existing, plan, outcome: "unchanged" };
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Lock the business row so two concurrent plan changes serialize.
    const { rows: bizRows } = await client.query<{ id: string; plan: string }>(
      `SELECT id, plan FROM businesses WHERE id = $1 FOR UPDATE`,
      [input.businessId],
    );
    if (!bizRows[0]) throw new SubscriptionError("business_not_found");

    const current = await getBusinessSubscription(input.businessId);
    const periodStart = now.toISOString();
    const paidPeriodEnd = addMonths(periodStart, 1);
    const periodEnd =
      decision.status === "trialing" && decision.trialEnd ? decision.trialEnd : paidPeriodEnd;
    // A manual assignment keeps a period that is already running. A purchase
    // and a new trial open their own window.
    const keepPeriod =
      input.source === "admin" &&
      current &&
      ["active", "trialing", "past_due"].includes(current.status) &&
      current.currentPeriodEnd > periodStart;

    await client.query(
      `INSERT INTO business_subscriptions
         (business_id, plan_key, status, started_at, current_period_start, current_period_end,
          trial_end, trial_started_at, grace_end, cancel_at_period_end, auto_renew, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, false, $9, NULL)
       ON CONFLICT (business_id) DO UPDATE SET
         plan_key = EXCLUDED.plan_key,
         status = EXCLUDED.status,
         auto_renew = EXCLUDED.auto_renew,
         current_period_start = CASE WHEN $10 THEN business_subscriptions.current_period_start
                                     ELSE EXCLUDED.current_period_start END,
         current_period_end = CASE WHEN $10 THEN business_subscriptions.current_period_end
                                   ELSE EXCLUDED.current_period_end END,
         trial_end = EXCLUDED.trial_end,
         trial_started_at = COALESCE(business_subscriptions.trial_started_at, EXCLUDED.trial_started_at),
         grace_end = NULL,
         cancelled_at = NULL,
         updated_at = now()`,
      [
        input.businessId,
        plan.key,
        decision.status,
        periodStart,
        keepPeriod ? current!.currentPeriodStart : periodStart,
        keepPeriod ? current!.currentPeriodEnd : periodEnd,
        decision.clearTrialEnd ? null : decision.trialEnd,
        decision.trialStartedAt,
        decision.autoRenew,
        keepPeriod,
      ],
    );
    await client.query(`UPDATE businesses SET plan = $2, updated_at = now() WHERE id = $1`, [
      input.businessId,
      plan.key,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  billingLog("billing.subscription.transition", {
    businessId: input.businessId,
    planKey: plan.key,
    source: input.source,
    status: decision.status,
    autoRenew: decision.autoRenew,
  });

  // Re-stamp the plan's included/monthly features. Purchased add-ons and
  // manual grants (business_entitlements source 'addon'/'manual') are
  // deliberately untouched: an add-on is owned, not rented from the plan.
  const features = await listPlanFeatures(plan.key);
  for (const feature of features) {
    if (feature.pricingModel === "included" || feature.pricingModel === "monthly") {
      await grantEntitlement({
        businessId: input.businessId,
        featureKey: feature.featureKey,
        source: "plan",
        freeUntil: feature.freeUntil,
        freeLimit: feature.freeLimit,
      });
    }
  }

  const subscription = await getBusinessSubscription(input.businessId);
  if (!subscription) throw new SubscriptionError("subscription_not_found");

  if (process.env.DEPLOYMENT_ROLE !== "site") {
    const { refreshEntitlementsForBusiness } = await import("./billing/entitlement/outbox-service");
    void refreshEntitlementsForBusiness(input.businessId).catch(() => {});
  }

  return { subscription, plan, outcome: existing ? "changed" : "created" };
}

// ---------------------------------------------------------------------------
// Lifecycle actions
// ---------------------------------------------------------------------------

/** Stop auto-renewal; the plan keeps running to the end of the paid period. */
export async function cancelBusinessSubscription(
  businessId: string,
  opts: { atPeriodEnd?: boolean; now?: Date } = {},
): Promise<BusinessSubscription> {
  const now = opts.now ?? new Date();
  const atPeriodEnd = opts.atPeriodEnd ?? true;
  if (atPeriodEnd) {
    await query(
      `UPDATE business_subscriptions
          SET cancel_at_period_end = true, auto_renew = false, updated_at = now()
        WHERE business_id = $1`,
      [businessId],
    );
  } else {
    await query(
      `UPDATE business_subscriptions
          SET cancel_at_period_end = true, auto_renew = false, status = 'cancelled',
              cancelled_at = $2, updated_at = now()
        WHERE business_id = $1`,
      [businessId, now.toISOString()],
    );
  }
  const subscription = await getBusinessSubscription(businessId);
  if (!subscription) throw new SubscriptionError("subscription_not_found");
  return subscription;
}

export async function setAutoRenew(businessId: string, autoRenew: boolean): Promise<BusinessSubscription> {
  await query(
    `UPDATE business_subscriptions SET auto_renew = $2, updated_at = now() WHERE business_id = $1`,
    [businessId, autoRenew],
  );
  const subscription = await getBusinessSubscription(businessId);
  if (!subscription) throw new SubscriptionError("subscription_not_found");
  return subscription;
}

/** Revive a cancelled/expired subscription on its current plan. */
export async function reactivateBusinessSubscription(businessId: string): Promise<BusinessSubscription> {
  const current = await getBusinessSubscription(businessId);
  if (!current) throw new SubscriptionError("subscription_not_found");
  if (current.status === "active" || current.status === "trialing") {
    // An alive subscription can still carry a scheduled cancellation —
    // «فعال‌سازی دوباره» after a cancel-at-period-end must undo exactly that:
    // keep the paid period running and clear the flag (auto-renew stays off;
    // re-enabling it is a separate, explicit choice).
    if (!current.cancelAtPeriodEnd) return current;
    await query(
      `UPDATE business_subscriptions
          SET cancel_at_period_end = false, cancelled_at = NULL, updated_at = now()
        WHERE business_id = $1`,
      [businessId],
    );
    return (await getBusinessSubscription(businessId))!;
  }
  await query(
    `UPDATE business_subscriptions
        SET status = 'active', cancelled_at = NULL, cancel_at_period_end = false,
            current_period_start = now(), current_period_end = now() + interval '1 month',
            updated_at = now()
      WHERE business_id = $1`,
    [businessId],
  );
  return (await getBusinessSubscription(businessId))!;
}

// ---------------------------------------------------------------------------
// The one recurring-total computation
// ---------------------------------------------------------------------------

export interface SubscriptionLine {
  kind: "plan" | "addon" | "usage" | "adjustment" | "credit";
  description: string;
  quantity: number;
  unitAmountRial: number;
  amountRial: number;
  featureKey: string | null;
}

export interface SubscriptionTotal {
  baseRial: number;
  addonsRial: number;
  discountRial: number;
  taxRial: number;
  totalRial: number;
  lines: SubscriptionLine[];
}

/**
 * What one renewal period costs a business: the plan's base fee plus its
 * recurring add-ons (billing_plan_features with pricing_model = 'monthly'),
 * with tax and discounts at 0 until the platform actually configures them.
 * The UI never computes this itself; it displays what this returns.
 */
export async function calculateSubscriptionTotal(businessId: string): Promise<SubscriptionTotal> {
  const { rows } = await query<{
    plan_key: string;
    plan_name: string;
    monthly_price_rial: string | null;
    feature_key: string | null;
    feature_name: string | null;
    price_rial: string | null;
  }>(
    `SELECT b.plan AS plan_key, p.name AS plan_name, p.monthly_price_rial,
            f.feature_key, ff.name AS feature_name, f.price_rial
       FROM businesses b
       JOIN billing_plans p ON p.key = b.plan
       LEFT JOIN billing_plan_features f
              ON f.plan_key = p.key AND f.pricing_model = 'monthly'
       LEFT JOIN feature_flags ff ON ff.key = f.feature_key
      WHERE b.id = $1
      ORDER BY f.sort_order, f.feature_key`,
    [businessId],
  );
  if (!rows[0]) throw new SubscriptionError("business_not_found");

  const lines: SubscriptionLine[] = [];
  const base = rows[0].monthly_price_rial == null ? 0 : n(rows[0].monthly_price_rial);
  if (base > 0) {
    lines.push({
      kind: "plan",
      description: `اشتراک ماهانهٔ پلن ${rows[0].plan_name}`,
      quantity: 1,
      unitAmountRial: base,
      amountRial: base,
      featureKey: null,
    });
  }
  let addons = 0;
  for (const row of rows) {
    if (!row.feature_key) continue;
    const amount = n(row.price_rial);
    addons += amount;
    lines.push({
      kind: "addon",
      description: `افزونهٔ ماهانه: ${row.feature_name ?? row.feature_key}`,
      quantity: 1,
      unitAmountRial: amount,
      amountRial: amount,
      featureKey: row.feature_key,
    });
  }
  const subtotal = base + addons;
  const discount = 0;
  const tax = 0;
  return {
    baseRial: base,
    addonsRial: addons,
    discountRial: discount,
    taxRial: tax,
    totalRial: Math.max(0, subtotal - discount + tax),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface InvoiceRecord {
  id: string;
  businessId: string;
  businessName?: string | null;
  invoiceNumber: string;
  status: "draft" | "open" | "paid" | "partially_paid" | "overdue" | "void";
  subtotalRial: number;
  discountRial: number;
  taxRial: number;
  totalRial: number;
  paidRial: number;
  dueAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  reference: string;
  note: string | null;
  createdAt: string;
  lines?: {
    id: string;
    kind: string;
    description: string;
    quantity: number;
    unitAmountRial: number;
    amountRial: number;
    featureKey: string | null;
  }[];
}

export async function listInvoices(
  filter: { businessId?: string; status?: string; limit?: number; withLines?: boolean } = {},
): Promise<InvoiceRecord[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const { rows } = await query<Record<string, unknown>>(
    `SELECT i.*, b.name AS business_name
       FROM billing_invoices i JOIN businesses b ON b.id = i.business_id
      WHERE ($1::uuid IS NULL OR i.business_id = $1)
        AND ($2::text IS NULL OR i.status = $2)
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT $3`,
    [filter.businessId ?? null, filter.status ?? null, limit],
  );
  const invoices = rows.map(rowToInvoice);
  if (!filter.withLines || invoices.length === 0) return invoices;

  // One round trip for every line of the page — the UI expands rows without
  // a per-invoice fetch.
  const { rows: lineRows } = await query<Record<string, unknown>>(
    `SELECT * FROM billing_invoice_lines
      WHERE invoice_id = ANY($1::uuid[])
      ORDER BY invoice_id, sort_order, created_at`,
    [invoices.map((i) => i.id)],
  );
  const linesByInvoice = new Map<string, InvoiceRecord["lines"]>();
  for (const row of lineRows) {
    const invoiceId = String(row.invoice_id);
    const line = {
      id: String(row.id),
      kind: String(row.kind),
      description: String(row.description),
      quantity: Number(row.quantity),
      unitAmountRial: n(row.unit_amount_rial),
      amountRial: n(row.amount_rial),
      featureKey: (row.feature_key as string | null) ?? null,
    };
    const list = linesByInvoice.get(invoiceId) ?? [];
    list.push(line);
    linesByInvoice.set(invoiceId, list);
  }
  for (const invoice of invoices) {
    invoice.lines = linesByInvoice.get(invoice.id) ?? [];
  }
  return invoices;
}

export async function getInvoice(id: string, withLines = false): Promise<InvoiceRecord | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT i.*, b.name AS business_name
       FROM billing_invoices i JOIN businesses b ON b.id = i.business_id
      WHERE i.id = $1`,
    [id],
  );
  const invoice = rows[0] ? rowToInvoice(rows[0]) : null;
  if (!invoice || !withLines) return invoice;
  const { rows: lines } = await query<Record<string, unknown>>(
    `SELECT * FROM billing_invoice_lines WHERE invoice_id = $1 ORDER BY sort_order, created_at`,
    [id],
  );
  invoice.lines = lines.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    description: String(row.description),
    quantity: Number(row.quantity),
    unitAmountRial: n(row.unit_amount_rial),
    amountRial: n(row.amount_rial),
    featureKey: (row.feature_key as string | null) ?? null,
  }));
  return invoice;
}

function rowToInvoice(row: Record<string, unknown>): InvoiceRecord {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    businessName: (row.business_name as string | null) ?? null,
    invoiceNumber: String(row.invoice_number),
    status: row.status as InvoiceRecord["status"],
    subtotalRial: n(row.subtotal_rial),
    discountRial: n(row.discount_rial),
    taxRial: n(row.tax_rial),
    totalRial: n(row.total_rial),
    paidRial: n(row.paid_rial),
    dueAt: row.due_at ? iso(row.due_at) : null,
    periodStart: row.period_start ? iso(row.period_start) : null,
    periodEnd: row.period_end ? iso(row.period_end) : null,
    reference: String(row.reference),
    note: (row.note as string | null) ?? null,
    createdAt: iso(row.created_at),
  };
}

/** Sequential invoice numbers from the locked monthly counter. */
async function nextInvoiceNumber(client: PoolClient): Promise<string> {
  return allocateInvoiceNumber(client);
}

/**
 * Claim an invoice row for `reference` inside `client`'s transaction.
 * Returns null when the reference was already claimed (idempotency — the
 * same period can never be billed twice).
 */
async function claimInvoice(
  client: PoolClient,
  input: {
    businessId: string;
    reference: string;
    total: SubscriptionTotal;
    dueAt: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    note?: string | null;
  },
): Promise<string | null> {
  const number = await nextInvoiceNumber(client);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO billing_invoices
       (business_id, invoice_number, status, subtotal_rial, discount_rial, tax_rial,
        total_rial, paid_rial, due_at, period_start, period_end, reference, note)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, 0, $7, $8, $9, $10, $11)
     ON CONFLICT (business_id, reference) DO NOTHING
     RETURNING id`,
    [
      input.businessId,
      number,
      input.total.baseRial + input.total.addonsRial,
      input.total.discountRial,
      input.total.taxRial,
      input.total.totalRial,
      input.dueAt,
      input.periodStart,
      input.periodEnd,
      input.reference,
      input.note ?? null,
    ],
  );
  const invoiceId = rows[0]?.id ?? null;
  if (!invoiceId) return null;
  // Line items snapshot today's description/price — a later plan price change
  // must never rewrite a historical invoice.
  let order = 0;
  for (const line of input.total.lines) {
    await client.query(
      `INSERT INTO billing_invoice_lines
         (invoice_id, kind, description, quantity, unit_amount_rial, amount_rial, feature_key, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        invoiceId,
        line.kind,
        line.description,
        line.quantity,
        line.unitAmountRial,
        line.amountRial,
        line.featureKey,
        order++,
      ],
    );
  }
  return invoiceId;
}

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------

export type RenewalOutcome =
  | { status: "renewed"; invoiceId: string }
  | { status: "free"; invoiceId: null }
  | { status: "duplicate"; invoiceId: string | null }
  | { status: "past_due" }
  | { status: "expired" }
  | { status: "nothing_due" };

/**
 * Renew one business's subscription for its next period.
 *
 * Idempotency is the UNIQUE (business_id, reference) index on billing_invoices.
 * The invoice is claimed before any money moves. A wallet that cannot cover
 * the charge commits that open invoice and marks the subscription past_due.
 * A later tick pays the same invoice; it does not open a second one.
 */
export async function renewBusinessSubscription(
  businessId: string,
  now: Date = new Date(),
): Promise<RenewalOutcome> {
  const subscription = await getBusinessSubscription(businessId);
  if (!subscription || !subscription.autoRenew) return { status: "nothing_due" };
  if (subscription.status === "cancelled" || subscription.status === "expired") {
    return { status: "nothing_due" };
  }
  if (subscription.currentPeriodEnd > now.toISOString()) return { status: "nothing_due" };

  // A past-due subscription whose grace window has closed expires.
  if (subscription.status === "past_due" && subscription.graceEnd && subscription.graceEnd <= now.toISOString()) {
    await query(
      `UPDATE business_subscriptions SET status = 'expired', updated_at = now() WHERE business_id = $1`,
      [businessId],
    );
    return { status: "expired" };
  }

  const total = await calculateSubscriptionTotal(businessId);
  const reference = `subscription-renewal:${subscription.currentPeriodEnd}`;
  const plan = await getBillingPlan(subscription.planKey);
  const graceEnd = addDays(subscription.currentPeriodEnd, plan?.graceDays ?? 7);

  // A free plan renews silently: no invoice, no charge, just the next period.
  if (total.totalRial <= 0) {
    await query(
      `UPDATE business_subscriptions
          SET current_period_start = $2, current_period_end = $3, status = 'active',
              grace_end = NULL, last_renewal_at = now(), updated_at = now()
        WHERE business_id = $1`,
      [businessId, subscription.currentPeriodEnd, addMonths(subscription.currentPeriodEnd, 1)],
    );
    return { status: "free", invoiceId: null };
  }

  const client = await getPool().connect();
  let invoiceId: string | null = null;
  try {
    await client.query("BEGIN");
    invoiceId = await claimInvoice(client, {
      businessId,
      reference,
      total,
      dueAt: subscription.currentPeriodEnd,
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      note: `تمدید اشتراک — دورهٔ ${subscription.currentPeriodEnd.slice(0, 10)}`,
    });
    if (!invoiceId) {
      const existing = await findInvoiceByReferenceTx(client, businessId, reference);
      if (!existing || existing.status === "paid" || existing.status === "void") {
        if (existing?.status === "paid") await advancePeriodTx(client, businessId, subscription, now);
        await client.query("COMMIT");
        return { status: "duplicate", invoiceId: existing?.id ?? null };
      }
      const outstanding = existing.totalRial - existing.paidRial;
      if (outstanding <= 0) {
        await client.query(
          `UPDATE billing_invoices SET status = 'paid', paid_rial = total_rial, updated_at = now() WHERE id = $1`,
          [existing.id],
        );
        await advancePeriodTx(client, businessId, subscription, now);
        await client.query("COMMIT");
        return { status: "duplicate", invoiceId: existing.id };
      }
      await chargeSubscriptionFeeTx(client, {
        businessId,
        amountRial: outstanding,
        invoiceId: existing.id,
        note: `هزینهٔ تمدید اشتراک ماهانه (${subscription.planKey})`,
      });
      await client.query(
        `UPDATE billing_invoices SET status = 'paid', paid_rial = total_rial, updated_at = now() WHERE id = $1`,
        [existing.id],
      );
      await advancePeriodTx(client, businessId, subscription, now);
      await client.query(
        `UPDATE business_subscriptions SET last_renewal_at = now() WHERE business_id = $1`,
        [businessId],
      );
      await client.query("COMMIT");
      billingLog("billing.invoice.paid", { businessId, invoiceId: existing.id, reference });
      return { status: "renewed", invoiceId: existing.id };
    }

    // Wallet debit inside THIS transaction. A shortfall commits the open
    // invoice and past_due together; it does not erase the invoice.
    await chargeSubscriptionFeeTx(client, {
      businessId,
      amountRial: total.totalRial,
      invoiceId,
      note: `هزینهٔ تمدید اشتراک ماهانه (${subscription.planKey})`,
    });
    await client.query(
      `UPDATE billing_invoices SET status = 'paid', paid_rial = total_rial, updated_at = now() WHERE id = $1`,
      [invoiceId],
    );
    await advancePeriodTx(client, businessId, subscription, now);
    await client.query(
      `UPDATE business_subscriptions SET last_renewal_at = now() WHERE business_id = $1`,
      [businessId],
    );
    await client.query("COMMIT");
    billingLog("billing.invoice.paid", { businessId, invoiceId, reference });
    return { status: "renewed", invoiceId };
  } catch (err) {
    if (err instanceof WalletInsufficientFundsError) {
      await client.query(
        `UPDATE business_subscriptions
            SET status = 'past_due', grace_end = $2, updated_at = now()
          WHERE business_id = $1`,
        [businessId, graceEnd],
      );
      await client.query("COMMIT");
      billingLog("billing.subscription.past_due", { businessId, invoiceId, reference });
      return { status: "past_due" };
    }
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function findInvoiceByReferenceTx(
  client: PoolClient,
  businessId: string,
  reference: string,
): Promise<InvoiceRecord | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT i.*, b.name AS business_name
       FROM billing_invoices i JOIN businesses b ON b.id = i.business_id
      WHERE i.business_id = $1 AND i.reference = $2`,
    [businessId, reference],
  );
  return rows[0] ? rowToInvoice(rows[0]) : null;
}

async function advancePeriodTx(
  client: PoolClient,
  businessId: string,
  subscription: BusinessSubscription,
  _now: Date,
): Promise<void> {
  await client.query(
    `UPDATE business_subscriptions
        SET current_period_start = $2, current_period_end = $3, status = 'active',
            grace_end = NULL, updated_at = now()
      WHERE business_id = $1`,
    [businessId, subscription.currentPeriodEnd, addMonths(subscription.currentPeriodEnd, 1)],
  );
}

/** How often the renewal tick runs — hourly like the website billing tick. */
export const SUBSCRIPTION_RENEWAL_TICK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Renew every auto-renew subscription whose period has ended. Background
 * work, so it scopes itself: the due list is read under the documented
 * platform bypass and each business's renewal runs inside `withTenant`, per
 * the repo's rule for anything running outside a request. One business's
 * failure never stops the next.
 */
export async function runSubscriptionRenewalTick(now: Date = new Date()): Promise<{
  checked: number;
  renewed: number;
  pastDue: number;
  expired: number;
}> {
  const started = Date.now();
  const due = await withoutTenantScope("platform", async () => {
    await markOverdueInvoices(now);
    const { rows } = await query<{ business_id: string }>(
      `SELECT business_id FROM business_subscriptions
        WHERE auto_renew
          AND status IN ('active', 'trialing', 'past_due')
          AND current_period_end <= now()`,
    );
    return rows;
  });

  let renewed = 0;
  let pastDue = 0;
  let expired = 0;
  for (const row of due) {
    try {
      await withTenant(row.business_id, async () => {
        const outcome = await renewBusinessSubscription(row.business_id, now);
        if (outcome.status === "renewed" || outcome.status === "free") renewed += 1;
        else if (outcome.status === "past_due") pastDue += 1;
        else if (outcome.status === "expired") expired += 1;
      });
    } catch (error) {
      console.error("subscription renewal tick failed for business:", row.business_id, error);
    }
  }
  const result = { checked: due.length, renewed, pastDue, expired };
  billingLog("billing.renewal.tick", { ...result, durationMs: Date.now() - started });
  return result;
}

/** Move open invoices past their due date to overdue. */
export async function markOverdueInvoices(now: Date = new Date()): Promise<number> {
  const { rows } = await query<{ id: string; status: string; total_rial: string; paid_rial: string; due_at: string | null }>(
    `SELECT id, status, total_rial, paid_rial, due_at FROM billing_invoices
      WHERE status IN ('open', 'partially_paid') AND due_at IS NOT NULL AND due_at <= $1`,
    [now.toISOString()],
  );
  let moved = 0;
  for (const row of rows) {
    const next = markOverdue(
      {
        status: row.status as InvoiceRecord["status"],
        totalRial: n(row.total_rial),
        paidRial: n(row.paid_rial),
        dueAt: row.due_at ? iso(row.due_at) : null,
      },
      now.toISOString(),
    );
    if (next.status === row.status) continue;
    await query(`UPDATE billing_invoices SET status = $2, updated_at = now() WHERE id = $1`, [row.id, next.status]);
    moved += 1;
  }
  return moved;
}

/** Apply a payment to an open invoice. Overpayment and void invoices are refused. */
export async function applyInvoicePayment(invoiceId: string, amountRial: number, now: Date = new Date()): Promise<InvoiceRecord> {
  const current = await getInvoice(invoiceId, false);
  if (!current) throw new SubscriptionError("invoice_not_found");
  let next;
  try {
    next = applyPayment(
      { status: current.status, totalRial: current.totalRial, paidRial: current.paidRial, dueAt: current.dueAt },
      amountRial,
      now.toISOString(),
    );
  } catch (err) {
    if (err instanceof InvoiceStateError) throw new SubscriptionError(err.code);
    throw err;
  }
  await query(
    `UPDATE billing_invoices SET status = $2, paid_rial = $3, updated_at = now() WHERE id = $1`,
    [invoiceId, next.status, next.paidRial],
  );
  billingLog("billing.invoice.payment", { invoiceId, amountRial, status: next.status });
  return (await getInvoice(invoiceId, false))!;
}

/** Void an invoice that has taken no payment. */
export async function voidBillingInvoice(invoiceId: string): Promise<InvoiceRecord> {
  const current = await getInvoice(invoiceId, false);
  if (!current) throw new SubscriptionError("invoice_not_found");
  let next;
  try {
    next = voidInvoice({
      status: current.status,
      totalRial: current.totalRial,
      paidRial: current.paidRial,
      dueAt: current.dueAt,
    });
  } catch (err) {
    if (err instanceof InvoiceStateError) throw new SubscriptionError(err.code);
    throw err;
  }
  await query(`UPDATE billing_invoices SET status = $2, updated_at = now() WHERE id = $1`, [invoiceId, next.status]);
  billingLog("billing.invoice.void", { invoiceId });
  return (await getInvoice(invoiceId, false))!;
}

// ---------------------------------------------------------------------------
// Date math (calendar months, UTC — same convention as website/billing.ts)
// ---------------------------------------------------------------------------

export function addMonths(isoDate: string, months: number): string {
  const date = new Date(isoDate);
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months);
  // 1404/01/31 + 1 month must not skip to 03/02 when February has 28 days.
  if (date.getUTCDate() < day) date.setUTCDate(0);
  return date.toISOString();
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}
