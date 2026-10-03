/**
 * The platform's side of a website's money: the plan catalogue, one
 * subscription per business, and every charge the site has run up.
 *
 * DB-touching (per repo convention not unit-tested directly; the arithmetic it
 * leans on is pure and lives in `billing.ts`, which is). Two rules carry the
 * design and are easy to undo by accident:
 *
 *   * **A charge is settled against the platform wallet, through
 *     `chargeFeatureUse`.** Not a second balance, not an invoice of its own:
 *     a business tops the wallet up once and the website, the assistant and
 *     messaging all draw on it. A wallet that cannot cover the charge raises
 *     `WalletInsufficientFundsError`, and the caller turns that into the
 *     top-up prompt rather than half-charging.
 *   * **Idempotency is the UNIQUE index**, `(business_id, kind, reference)`,
 *     never a read-then-write. Every charge claims its row first and a second
 *     attempt with the same reference is a no-op — which is what makes a
 *     retried renewal safe.
 */
import { query, withoutTenantScope, withTenant } from "../db";
import { chargeFeatureUse, WalletInsufficientFundsError } from "../wallet-service";
import {
  addMonths,
  subscriptionReference,
  type WebsiteCharge,
  type WebsiteChargeKind,
  type WebsitePlan,
  type WebsiteSubscription,
  type WebsiteSubscriptionStatus,
} from "./billing";

export { WalletInsufficientFundsError };

/** The feature key every website charge is metered under in the platform wallet. */
export const WEBSITE_FEATURE_KEY = "website_service";

const PLAN_COLUMNS = `key, name, description, monthly_price_rial, setup_price_rial, site_types,
       includes_cdn, includes_domain, max_products, max_pages, is_active, sort_order`;

interface PlanRow extends Record<string, unknown> {
  key: string;
  name: string;
  description: string | null;
  monthly_price_rial: string | number;
  setup_price_rial: string | number;
  site_types: string[] | null;
  includes_cdn: boolean;
  includes_domain: boolean;
  max_products: number | null;
  max_pages: number | null;
  is_active: boolean;
  sort_order: number;
}

/** `bigint` comes back from node-postgres as a string; normalize at the boundary. */
const n = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
};

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

function toPlan(row: PlanRow): WebsitePlan {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    monthlyPriceRial: n(row.monthly_price_rial),
    setupPriceRial: n(row.setup_price_rial),
    siteTypes: row.site_types ?? [],
    includesCdn: row.includes_cdn,
    includesDomain: row.includes_domain,
    maxProducts: row.max_products,
    maxPages: row.max_pages,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

/** The whole catalogue, active rows first. Global data — no tenant scope to apply. */
export async function listWebsitePlans(): Promise<WebsitePlan[]> {
  const { rows } = await query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM website_service_plans ORDER BY sort_order, key`,
  );
  return rows.map(toPlan);
}

export async function getWebsitePlan(key: string): Promise<WebsitePlan | null> {
  const { rows } = await query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM website_service_plans WHERE key = $1`,
    [key],
  );
  return rows[0] ? toPlan(rows[0]) : null;
}

interface SubscriptionRow extends Record<string, unknown> {
  plan_key: string;
  status: WebsiteSubscriptionStatus;
  started_at: string;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  cancelled_at: string | null;
  monthly_price_rial: string | number;
}

function toSubscription(row: SubscriptionRow): WebsiteSubscription {
  return {
    planKey: row.plan_key,
    status: row.status,
    startedAt: iso(row.started_at),
    currentPeriodStart: iso(row.current_period_start),
    currentPeriodEnd: iso(row.current_period_end),
    autoRenew: row.auto_renew,
    cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null,
    monthlyPriceRial: n(row.monthly_price_rial),
  };
}

export async function getWebsiteSubscription(businessId: string): Promise<WebsiteSubscription | null> {
  const { rows } = await query<SubscriptionRow>(
    `SELECT plan_key, status, started_at, current_period_start, current_period_end,
            auto_renew, cancelled_at, monthly_price_rial
       FROM website_service_subscriptions WHERE business_id = $1`,
    [businessId],
  );
  return rows[0] ? toSubscription(rows[0]) : null;
}

/**
 * Put a business's site on a plan.
 *
 * The price is **snapshot on the row**: a later change to the catalogue is a
 * price for new subscribers, not a silent re-pricing of a running site. The
 * first period is not charged here — `chargeSubscriptionPeriod` does that, so
 * that "the site exists" and "the first month is paid" stay two separately
 * observable facts and a failed wallet charge never leaves a business with a
 * site it cannot open.
 */
export async function startWebsiteSubscription(
  businessId: string,
  planKey: string,
): Promise<WebsiteSubscription | null> {
  const plan = await getWebsitePlan(planKey);
  if (!plan || !plan.isActive) return null;

  const now = new Date().toISOString();
  const periodEnd = addMonths(now, 1);
  await query(
    `INSERT INTO website_service_subscriptions
       (business_id, plan_key, status, started_at, current_period_start, current_period_end,
        auto_renew, monthly_price_rial)
     VALUES ($1, $2, 'active', $3, $3, $4, true, $5)
     ON CONFLICT (business_id) DO UPDATE SET
       plan_key = EXCLUDED.plan_key,
       status = 'active',
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       cancelled_at = NULL,
       monthly_price_rial = EXCLUDED.monthly_price_rial,
       updated_at = now()`,
    [businessId, plan.key, now, periodEnd, plan.monthlyPriceRial],
  );
  return getWebsiteSubscription(businessId);
}

/** Stop auto-renewal. The site keeps running to the end of the paid period. */
export async function cancelWebsiteSubscription(businessId: string): Promise<WebsiteSubscription | null> {
  await query(
    `UPDATE website_service_subscriptions
        SET auto_renew = false, status = 'cancelled', cancelled_at = now(), updated_at = now()
      WHERE business_id = $1`,
    [businessId],
  );
  return getWebsiteSubscription(businessId);
}

export interface RecordChargeInput {
  businessId: string;
  kind: WebsiteChargeKind;
  description: string;
  amountRial: number;
  reference: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** When false the charge is recorded but no money moves (a promo, a manual credit). */
  settle?: boolean;
  userId?: string | null;
}

export type ChargeOutcome =
  | { status: "charged"; balanceRial: number }
  | { status: "duplicate" }
  | { status: "recorded" };

/**
 * Record one website charge, settling it against the platform wallet.
 *
 * The row is claimed first, `ON CONFLICT DO NOTHING`: if the reference has
 * been seen the function returns `duplicate` and **no money moves**. Only a
 * genuinely new row goes on to debit the wallet, so a retried renewal or a
 * double-clicked domain order cannot bill twice.
 *
 * An insufficient balance throws `WalletInsufficientFundsError` and leaves
 * both the claim and an open platform invoice. The next attempt pays that
 * invoice; it does not open a second one, and it does not advance the period
 * until the invoice is paid.
 */
export async function recordWebsiteCharge(input: RecordChargeInput): Promise<ChargeOutcome> {
  const amount = Math.max(0, Math.floor(input.amountRial));
  const invoiceReference = `website:${input.kind}:${input.reference}`;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO website_service_charges
       (business_id, kind, description, amount_rial, reference, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (business_id, kind, reference) DO NOTHING
     RETURNING id`,
    [
      input.businessId,
      input.kind,
      input.description,
      amount,
      input.reference,
      input.periodStart ?? null,
      input.periodEnd ?? null,
    ],
  );
  const claimed = rows[0];
  if (!claimed) {
    const existing = await websiteInvoiceStatus(input.businessId, invoiceReference);
    if (!existing || existing.status === "paid" || existing.status === "void" || amount === 0) {
      return { status: "duplicate" };
    }
  }

  if (input.settle === false || amount === 0) return { status: "recorded" };

  const invoiceId = await ensureWebsiteInvoice({
    businessId: input.businessId,
    reference: invoiceReference,
    amount,
    description: input.description,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
  });

  try {
    // `metadata.invoiceId` is what makes the wallet debit the authoritative
    // settlement record for this invoice rather than a bare wallet spend. The
    // platform company's billing → accounting bridge reads exactly this field;
    // without it the charge would be posted twice — once as wallet revenue and
    // again as a bank receipt.
    const { balanceRial } = await chargeFeatureUse({
      businessId: input.businessId,
      featureKey: WEBSITE_FEATURE_KEY,
      priceRial: amount,
      note: input.description,
      userId: input.userId ?? null,
      metadata: { kind: input.kind, reference: input.reference, invoiceId },
    });
    await query(
      `UPDATE billing_invoices SET status = 'paid', paid_rial = total_rial, updated_at = now()
        WHERE business_id = $1 AND reference = $2 AND status <> 'void'`,
      [input.businessId, invoiceReference],
    );
    return { status: "charged", balanceRial };
  } catch (error) {
    throw error;
  }
}

async function websiteInvoiceStatus(
  businessId: string,
  reference: string,
): Promise<{ status: string } | null> {
  const { rows } = await query<{ status: string }>(
    `SELECT status FROM billing_invoices WHERE business_id = $1 AND reference = $2`,
    [businessId, reference],
  );
  return rows[0] ?? null;
}

async function ensureWebsiteInvoice(input: {
  businessId: string;
  reference: string;
  amount: number;
  description: string;
  periodStart: string | null;
  periodEnd: string | null;
}): Promise<string | null> {
  const { getPool } = await import("../db");
  const { allocateInvoiceNumber } = await import("../billing/runtime");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const number = await allocateInvoiceNumber(client);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO billing_invoices
         (business_id, invoice_number, status, subtotal_rial, total_rial, due_at,
          period_start, period_end, reference, note)
       VALUES ($1, $2, 'open', $3, $3, now(), $4, $5, $6, $7)
       ON CONFLICT (business_id, reference) DO NOTHING
       RETURNING id`,
      [input.businessId, number, input.amount, input.periodStart, input.periodEnd, input.reference, input.description],
    );
    if (rows[0]) {
      await client.query(
        `INSERT INTO billing_invoice_lines
           (invoice_id, kind, description, quantity, unit_amount_rial, amount_rial, sort_order)
         VALUES ($1, 'addon', $2, 1, $3, $3, 0)`,
        [rows[0].id, input.description, input.amount],
      );
    }
    if (rows[0]) {
      await client.query("COMMIT");
      return rows[0].id;
    }
    // The invoice for this period already exists (a retry, or a charge recorded
    // before settlement). Its id is still needed so the wallet debit names the
    // invoice it settles.
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM billing_invoices WHERE business_id = $1 AND reference = $2`,
      [input.businessId, input.reference],
    );
    await client.query("COMMIT");
    return existing[0]?.id ?? null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Bill the current period of a business's subscription, if it has not been
 * billed already. Returns null when there is nothing to bill.
 */
export async function chargeSubscriptionPeriod(businessId: string): Promise<ChargeOutcome | null> {
  const subscription = await getWebsiteSubscription(businessId);
  if (!subscription || subscription.status === "cancelled") return null;
  if (subscription.monthlyPriceRial <= 0) return null;

  return recordWebsiteCharge({
    businessId,
    kind: "subscription",
    description: `اشتراک ماهانهٔ سایت — طرح ${subscription.planKey}`,
    amountRial: subscription.monthlyPriceRial,
    reference: subscriptionReference(subscription.currentPeriodStart),
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
  });
}

/** Move a subscription into its next period. Called after its period was billed. */
export async function advanceSubscriptionPeriod(businessId: string): Promise<void> {
  const subscription = await getWebsiteSubscription(businessId);
  if (!subscription) return;
  const start = subscription.currentPeriodEnd;
  await query(
    `UPDATE website_service_subscriptions
        SET current_period_start = $2, current_period_end = $3, status = 'active', updated_at = now()
      WHERE business_id = $1`,
    [businessId, start, addMonths(start, 1)],
  );
}

export async function listWebsiteCharges(businessId: string, limit = 50): Promise<WebsiteCharge[]> {
  const { rows } = await query<{
    id: string;
    kind: WebsiteChargeKind;
    description: string;
    amount_rial: string | number;
    occurred_at: string;
    period_start: string | null;
    period_end: string | null;
    reference: string;
  }>(
    `SELECT id, kind, description, amount_rial, occurred_at, period_start, period_end, reference
       FROM website_service_charges
      WHERE business_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2`,
    [businessId, Math.min(Math.max(1, limit), 200)],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    description: row.description,
    amountRial: n(row.amount_rial),
    occurredAt: iso(row.occurred_at),
    periodStart: row.period_start ? iso(row.period_start) : null,
    periodEnd: row.period_end ? iso(row.period_end) : null,
    reference: row.reference,
  }));
}

/** How often the renewal tick runs. Hourly is far more often than a monthly
 * period needs; the cost is one indexed query, and it keeps a container that
 * was down over a period boundary from being a day late. */
export const WEBSITE_BILLING_TICK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Renew every website subscription whose period has ended.
 *
 * Background work, so it scopes itself: the due list is read under the
 * documented platform bypass and each business's charge runs inside
 * `withTenant`, per CLAUDE.md's rule for anything running outside a request.
 *
 * A business whose wallet cannot cover the renewal is marked `past_due` and
 * left alone — the site keeps serving and the owner sees the state on the
 * billing section with a «پرداخت دورهٔ جاری» button. Cutting a shopfront off
 * over an empty wallet, silently, from a cron, is not a decision a tick gets
 * to make.
 */
export async function runWebsiteBillingTick(): Promise<number> {
  const due = await withoutTenantScope("platform", async () => {
    const { rows } = await query<{ business_id: string }>(
      `SELECT business_id FROM website_service_subscriptions
        WHERE auto_renew AND status <> 'cancelled' AND current_period_end <= now()`,
    );
    return rows;
  });

  let renewed = 0;
  for (const row of due) {
    try {
      await withTenant(row.business_id, async () => {
        const outcome = await chargeSubscriptionPeriod(row.business_id);
        // `null` (no subscription, or a free plan) and `duplicate` (this
        // period is already paid) both mean "nothing owed" — move the period
        // on either way, or the tick re-reads the same row forever.
        await advanceSubscriptionPeriod(row.business_id);
        if (outcome?.status === "charged") renewed += 1;
      });
    } catch (error) {
      if (error instanceof WalletInsufficientFundsError) {
        await withTenant(row.business_id, () =>
          query(
            `UPDATE website_service_subscriptions
                SET status = 'past_due', updated_at = now()
              WHERE business_id = $1`,
            [row.business_id],
          ),
        );
        continue;
      }
      console.error("website billing tick failed for business:", row.business_id, error);
    }
  }
  return renewed;
}
