/**
 * ESH-193 / #1378 — the persisted quote, from checkout to money and books.
 *
 * Proves the acceptance seam the issue asks for: one stored quote is settled
 * against the wallet, debits `wallet_ledger` exactly once, buys the prepaid
 * term, and produces an invoice whose lines, discount, tax and total reconcile
 * with the quote it came from. A retry of the same payment moves no money
 * again.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { addCalendarMonths } from "../src/lib/billing/quote/plan-quote";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: typeof import("../src/lib/db");
let wallet: typeof import("../src/lib/wallet-service");
let store: typeof import("../src/lib/billing/quote/quote-store");
let checkout: typeof import("../src/lib/billing/quote/checkout-quote");
let billing: typeof import("../src/lib/billing-service");
let subscriptions: typeof import("../src/lib/subscription-service");

const planKey = `checkout-${randomUUID().slice(0, 8)}`;
let businessId: string;
let platformUserId: string;
const startingBalanceRial = 5_000_000;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_plan_checkout_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  delete (globalThis as { pgPool?: unknown }).pgPool;
  db = await import("../src/lib/db");
  wallet = await import("../src/lib/wallet-service");
  store = await import("../src/lib/billing/quote/quote-store");
  checkout = await import("../src/lib/billing/quote/checkout-quote");
  billing = await import("../src/lib/billing-service");
  subscriptions = await import("../src/lib/subscription-service");

  platformUserId = randomUUID();
  businessId = randomUUID();

  await db.withoutTenantScope("platform", async () => {
    await db.query(
      `INSERT INTO platform_users (id, email, password_hash, full_name)
       VALUES ($1, $2, 'hash', 'خریدار')`,
      [platformUserId, `buyer-${platformUserId.slice(0, 8)}@example.com`],
    );
    await db.query(
      `INSERT INTO businesses (id, name, slug, subdomain)
       VALUES ($1, 'کسب‌وکار آزمون', $2, $3)`,
      [businessId, `biz-${businessId.slice(0, 8)}`, `biz-${businessId.slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO billing_plans (key, name, monthly_price_rial, status, sort_order)
       VALUES ($1, 'پلن آزمون', 1000000, 'active', 1)`,
      [planKey],
    );
    await db.query(
      `INSERT INTO billing_price_versions
         (target_type, target_key, unit, unit_amount_rial, version, effective_from)
       VALUES ('plan', $1, 'month', 1000000, 1, '2025-01-01T00:00:00Z')`,
      [planKey],
    );
    await db.query(
      `INSERT INTO billing_plan_features (plan_key, feature_key, pricing_model, price_rial, sort_order)
       VALUES ($1, 'inventory', 'monthly', 200000, 1)`,
      [planKey],
    );
    await db.query(
      `UPDATE billing_commercial_settings
          SET tax_rate_bps = 900, term_discount_bps_3 = 500, coupon_stacking_enabled = false
        WHERE id`,
    );
    await db.query(
      `INSERT INTO business_wallets (business_id, balance_rial)
       VALUES ($1, $2)`,
      [businessId, startingBalanceRial],
    );
  });
}, 180_000);

afterAll(async () => {
  await db?.getPool().end().catch(() => {});
  delete (globalThis as { pgPool?: unknown }).pgPool;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("quote-driven checkout", () => {
  it("settles one quote from the wallet, posts one ledger debit and one reconciling invoice", async () => {
    const code = `CP${randomUUID().slice(0, 8).toUpperCase()}`;
    await db.withoutTenantScope("platform", () =>
      db.query(
        `INSERT INTO billing_coupons
           (code, discount_kind, percent_basis_points, min_term_months,
            max_redemptions, max_redemptions_per_business, valid_from, status)
         VALUES ($1, 'percent', 1000, 3, 10, 1, now() - interval '1 minute', 'active')`,
        [code],
      ),
    );

    // 1. Checkout quotes the canonical document and persists it.
    const quoted = await checkout.createPlanCheckoutQuote({
      businessId,
      platformUserId,
      planKey,
      termMonths: 3,
      couponCode: code,
    });
    if (!quoted.ok) throw new Error(`quote failed: ${quoted.error}`);
    // 3 × (1,000,000 base + 200,000 monthly add-on) = 3,600,000.
    // 10% coupon (360,000) beats the 5% term discount (180,000): no stacking.
    // Tax 9% on 3,240,000 = 291,600; total 3,531,600.
    expect(quoted.quote.totals).toEqual({
      grossRial: 3_600_000,
      discountRial: 0,
      couponDiscountRial: 360_000,
      taxRial: 291_600,
      netRial: 3_531_600,
    });

    // 2. The payment is created against the stored quote.
    const payment = await db.withTenant(businessId, () =>
      wallet.createPayment({
        businessId,
        gateway: "wallet",
        purpose: "plan_purchase",
        amountRial: quoted.quote.totals.netRial,
        creditRial: 0,
        planKey,
        termMonths: 3,
        quoteId: quoted.quoteId,
        description: "اشتراک پلن آزمون — دورهٔ ۳ ماهه",
        idempotencyKey: quoted.quoteId,
        quoteSnapshot: {
          quoteId: quoted.quoteId,
          termMonths: 3,
          grossRial: quoted.quote.totals.grossRial,
          discountRial: quoted.quote.totals.discountRial,
          couponDiscountRial: quoted.quote.totals.couponDiscountRial,
          taxRial: quoted.quote.totals.taxRial,
          totalRial: quoted.quote.totals.netRial,
          lines: quoted.quote.lines,
        },
      }),
    );

    // 3. Wallet settlement: quote consumption + debit + coupon spend, once.
    const settled = await store.consumeQuote({
      businessId,
      quoteId: quoted.quoteId,
      paymentId: payment.id,
      debitWallet: { note: "خرید اشتراک پلن آزمون" },
    });
    expect(settled.ok).toBe(true);
    await db.withoutTenantScope("platform", () =>
      db.query(
        `UPDATE billing_payments
            SET status = 'verified', gateway_status = 'wallet', verified_at = now()
          WHERE id = $1`,
        [payment.id],
      ),
    );

    // 4. Fulfilment activates the prepaid term and issues the invoice.
    await db.withTenant(businessId, () =>
      billing.fulfilPurchasedPayment({
        id: payment.id,
        businessId,
        purpose: "plan_purchase",
        planKey,
        featureKey: null,
      }),
    );

    const after = await db.withTenant(businessId, () =>
      wallet.getWallet(businessId),
    );
    expect(after.balanceRial).toBe(startingBalanceRial - 3_531_600);

    const ledger = await db.withTenant(businessId, () =>
      db.query<{ amount_rial: string; kind: string; direction: string }>(
        `SELECT amount_rial, kind, direction FROM wallet_ledger
          WHERE business_id = $1 AND kind = 'subscription'`,
        [businessId],
      ),
    );
    expect(ledger.rows).toHaveLength(1);
    expect(Number(ledger.rows[0].amount_rial)).toBe(3_531_600);
    expect(ledger.rows[0].direction).toBe("debit");

    const subscription = await db.withTenant(businessId, () =>
      subscriptions.getBusinessSubscription(businessId),
    );
    expect(subscription?.termMonths).toBe(3);
    expect(subscription?.status).toBe("active");
    // A prepaid term is three CALENDAR months, not 90 days and not one month.
    expect(subscription?.currentPeriodEnd).toBe(
      addCalendarMonths(subscription!.currentPeriodStart, 3),
    );

    const invoice = await db.withTenant(businessId, () =>
      db.query<{
        status: string;
        subtotal_rial: string;
        discount_rial: string;
        tax_rial: string;
        total_rial: string;
        paid_rial: string;
        reference: string;
      }>(
        `SELECT status, subtotal_rial, discount_rial, tax_rial, total_rial, paid_rial, reference
           FROM billing_invoices WHERE business_id = $1`,
        [businessId],
      ),
    );
    expect(invoice.rows).toHaveLength(1);
    expect(invoice.rows[0]).toMatchObject({
      status: "paid",
      subtotal_rial: "3600000",
      discount_rial: "360000",
      tax_rial: "291600",
      total_rial: "3531600",
      paid_rial: "3531600",
      reference: `plan-purchase:${payment.id}`,
    });

    const lines = await db.withTenant(businessId, () =>
      db.query<{ kind: string; amount_rial: string; price_version_id: string | null }>(
        `SELECT kind, amount_rial, price_version_id
           FROM billing_invoice_lines
          WHERE invoice_id = (SELECT id FROM billing_invoices WHERE business_id = $1)
          ORDER BY sort_order`,
        [businessId],
      ),
    );
    expect(lines.rows.map((row) => row.kind)).toEqual(["plan", "addon"]);
    expect(lines.rows.map((row) => row.amount_rial)).toEqual(["3000000", "600000"]);
    expect(lines.rows[0].price_version_id).toBeTruthy();

    // 5. A retry of the same payment is a success and moves no money again.
    expect(
      await store.consumeQuote({
        businessId,
        quoteId: quoted.quoteId,
        paymentId: payment.id,
        debitWallet: { note: "retry" },
      }),
    ).toEqual({ ok: true });
    const retried = await db.withTenant(businessId, () => wallet.getWallet(businessId));
    expect(retried.balanceRial).toBe(startingBalanceRial - 3_531_600);

    // 6. Another payment cannot reuse the consumed quote.
    const otherPayment = randomUUID();
    expect(
      await store.consumeQuote({
        businessId,
        quoteId: quoted.quoteId,
        paymentId: otherPayment,
        debitWallet: { note: "second" },
      }),
    ).toEqual({ ok: false, error: "quote_consumed" });
    const untouched = await db.withTenant(businessId, () => wallet.getWallet(businessId));
    expect(untouched.balanceRial).toBe(startingBalanceRial - 3_531_600);
  });
});
