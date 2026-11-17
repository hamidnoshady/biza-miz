/**
 * ESH-193 / #1378 — coupons, persisted quotes and the payment boundary.
 *
 * The quote calculator is unit-tested elsewhere; this file proves the database
 * facts that make a quote payable: a coupon hold cannot be taken twice by one
 * business, a stored quote is refused once the catalogue re-prices it or it
 * expires, and settlement consumes a quote exactly once while spending the
 * coupon's global cap atomically.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: typeof import("../src/lib/db");
let quotes: typeof import("../src/lib/billing/quote/plan-quote-service");
let coupons: typeof import("../src/lib/billing/quote/coupon-service");
let store: typeof import("../src/lib/billing/quote/quote-store");

const planKey = `pro-${randomUUID().slice(0, 8)}`;
let businessId: string;
let otherBusinessId: string;
let platformUserId: string;

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

async function createCoupon(overrides: Partial<{
  percentBasisPoints: number;
  minTermMonths: number;
  maxRedemptionsPerBusiness: number;
}> = {}): Promise<{ id: string; code: string }> {
  const code = `C${randomUUID().slice(0, 8).toUpperCase()}`;
  const { rows } = await db.withoutTenantScope("platform", () =>
    db.query<{ id: string }>(
      `INSERT INTO billing_coupons
         (code, discount_kind, percent_basis_points, min_term_months,
          max_redemptions, max_redemptions_per_business, status)
       VALUES ($1, 'percent', $2, $3, 100, $4, 'active')
       RETURNING id`,
      [code, overrides.percentBasisPoints ?? 1_000, overrides.minTermMonths ?? 1, overrides.maxRedemptionsPerBusiness ?? 1],
    ),
  );
  return { id: rows[0].id, code };
}

/** Quote, hold the coupon and persist the quote — the checkout happy path. */
async function quoteWithCoupon(code: string): Promise<{
  quoteId: string;
  netRial: number;
  quote: import("../src/lib/billing/quote/plan-quote").PlanQuote;
}> {
  const resolved = await coupons.resolveCoupon({ code, businessId, termMonths: 3 });
  if (!resolved.ok) throw new Error(`resolve failed: ${resolved.error}`);

  const quoted = await quotes.quotePlanSubscription({
    planKey,
    termMonths: 3,
    termDiscountRate: 0.05,
    taxRate: 0.09,
    coupon: resolved.coupon,
  });
  if (!quoted.ok) throw new Error(`quote failed: ${quoted.error}`);

  const held = await coupons.reserveCoupon({
    couponId: resolved.couponId,
    businessId,
    termMonths: 3,
    amountRial: quoted.quote.totals.couponDiscountRial,
    reservedUntil: new Date(quoted.quote.expiresAt),
  });
  if (!held.ok) throw new Error(`reserve failed: ${held.error}`);

  const persisted = await store.persistQuote({
    businessId,
    platformUserId,
    quote: quoted.quote,
    termDiscountRate: 0.05,
    taxRate: 0.09,
    coupon: { coupon: resolved.coupon, redemptionId: held.redemptionId },
  });
  if (!persisted.ok) throw new Error(`persist failed: ${persisted.error}`);

  return {
    quoteId: persisted.quoteId,
    netRial: quoted.quote.totals.netRial,
    quote: quoted.quote,
  };
}

beforeAll(async () => {
  databaseName = `pos_quote_store_${randomUUID().replaceAll("-", "")}`;
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
  quotes = await import("../src/lib/billing/quote/plan-quote-service");
  coupons = await import("../src/lib/billing/quote/coupon-service");
  store = await import("../src/lib/billing/quote/quote-store");

  platformUserId = randomUUID();
  businessId = randomUUID();
  otherBusinessId = randomUUID();

  await db.withoutTenantScope("platform", async () => {
    await db.query(
      `INSERT INTO platform_users (id, email, password_hash, full_name)
       VALUES ($1, $2, 'hash', 'خریدار')`,
      [platformUserId, `buyer-${platformUserId.slice(0, 8)}@example.com`],
    );
    await db.query(
      `INSERT INTO businesses (id, name, slug, subdomain)
       VALUES ($1, 'کسب‌وکار آزمون', $2, $3), ($4, 'دیگری', $5, $6)`,
      [
        businessId,
        `biz-${businessId.slice(0, 8)}`,
        `biz-${businessId.slice(0, 8)}`,
        otherBusinessId,
        `biz-${otherBusinessId.slice(0, 8)}`,
        `biz-${otherBusinessId.slice(0, 8)}`,
      ],
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
       VALUES ($1, 'inventory', 'monthly', 200000, 1),
              ($1, 'delivery', 'addon', 500000, 2)`,
      [planKey],
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

describe("coupon holds", () => {
  it("lets one business hold a code once, even under a concurrent double-submit", async () => {
    const coupon = await createCoupon({ maxRedemptionsPerBusiness: 2 });
    const attempt = () =>
      coupons.reserveCoupon({
        couponId: coupon.id,
        businessId,
        termMonths: 3,
        amountRial: 1_000,
        reservedUntil: new Date(Date.now() + 15 * 60_000),
      });
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      error: "coupon_already_used",
    });
  });

  it("refuses a code the term is not eligible for", async () => {
    const annual = await createCoupon({ minTermMonths: 12 });
    expect(await coupons.resolveCoupon({ code: annual.code, businessId, termMonths: 3 })).toEqual({
      ok: false,
      error: "coupon_term_not_eligible",
    });
  });
});

describe("persisted quotes and the payment boundary", () => {
  it("stores the quote with its coupon and re-prices it as still payable", async () => {
    const coupon = await createCoupon();
    const { quoteId, netRial, quote } = await quoteWithCoupon(coupon.code);

    const loaded = await store.loadQuote({ businessId, quoteId });
    expect(loaded?.quote.totals.netRial).toBe(netRial);
    expect(loaded?.coupon?.code).toBe(coupon.code);
    expect(loaded?.termDiscountRate).toBe(0.05);
    expect(loaded?.taxRate).toBe(0.09);

    const payable = await store.assertQuotePayable({ businessId, quoteId });
    expect(payable.ok).toBe(true);
    if (payable.ok) {
      expect(payable.refreshed.totals.netRial).toBe(quote.totals.netRial);
      expect(payable.refreshed.totals.couponDiscountRial).toBe(
        quote.totals.couponDiscountRial,
      );
    }
  });

  it("is invisible to another business even with the exact quote id", async () => {
    const coupon = await createCoupon();
    const { quoteId } = await quoteWithCoupon(coupon.code);
    expect(await store.loadQuote({ businessId: otherBusinessId, quoteId })).toBeNull();
    expect(
      await store.assertQuotePayable({ businessId: otherBusinessId, quoteId }),
    ).toEqual({ ok: false, error: "quote_not_found" });
  });

  it("consumes once, spends the coupon, and refuses the second attempt", async () => {
    const coupon = await createCoupon();
    const { quoteId } = await quoteWithCoupon(coupon.code);
    const paymentId = randomUUID();

    expect(
      await store.consumeQuote({ businessId, quoteId, paymentId }),
    ).toEqual({ ok: true });
    expect(
      await store.consumeQuote({ businessId, quoteId, paymentId: randomUUID() }),
    ).toEqual({ ok: false, error: "quote_consumed" });

    const { rows } = await db.withoutTenantScope("platform", () =>
      db.query<{ status: string; redeemed_count: number }>(
        `SELECT r.status, c.redeemed_count
           FROM billing_coupon_redemptions r
           JOIN billing_coupons c ON c.id = r.coupon_id
          WHERE r.quote_id = $1`,
        [quoteId],
      ),
    );
    expect(rows[0]).toEqual({ status: "redeemed", redeemed_count: 1 });

    // The business's single allowed redemption is spent.
    expect(
      await coupons.resolveCoupon({ code: coupon.code, businessId, termMonths: 3 }),
    ).toEqual({ ok: false, error: "coupon_already_used" });
  });

  it("refuses a quote whose plan price was re-versioned after it was shown", async () => {
    const coupon = await createCoupon();
    const { quoteId } = await quoteWithCoupon(coupon.code);

    await db.withoutTenantScope("platform", () =>
      db.query(
        `INSERT INTO billing_price_versions
           (target_type, target_key, unit, unit_amount_rial, version, effective_from)
         VALUES ('plan', $1, 'month', 1200000, 2, '2026-01-01T00:00:00Z')`,
        [planKey],
      ),
    );

    expect(await store.assertQuotePayable({ businessId, quoteId })).toEqual({
      ok: false,
      error: "quote_stale",
    });
    expect(
      await store.consumeQuote({ businessId, quoteId, paymentId: randomUUID() }),
    ).toEqual({ ok: false, error: "quote_stale" });
  });

  it("refuses an expired quote", async () => {
    const quoted = await quotes.quotePlanSubscription({
      planKey,
      termMonths: 1,
      termDiscountRate: 0,
      taxRate: 0,
      validityMinutes: 1,
    });
    if (!quoted.ok) throw new Error("quote failed");

    const persisted = await store.persistQuote({
      businessId,
      platformUserId,
      quote: quoted.quote,
      termDiscountRate: 0,
      taxRate: 0,
    });
    if (!persisted.ok) throw new Error("persist failed");

    const later = new Date(Date.now() + 2 * 60_000);
    expect(
      await store.assertQuotePayable({ businessId, quoteId: persisted.quoteId, now: later }),
    ).toEqual({ ok: false, error: "quote_expired" });
    expect(
      await store.consumeQuote({
        businessId,
        quoteId: persisted.quoteId,
        paymentId: randomUUID(),
        now: later,
      }),
    ).toEqual({ ok: false, error: "quote_expired" });
  });
});
