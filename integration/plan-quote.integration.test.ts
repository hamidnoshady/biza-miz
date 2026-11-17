/**
 * ESH-193 / #1378 — the quote resolver against the real commercial catalogue.
 *
 * Proves the stage-1 resolver composes tables that already exist rather than a
 * parallel price domain: a published `billing_price_versions` row (target
 * `plan`), a monthly plan feature and a one-off add-on produce an itemised
 * quote, and a newer price version makes the earlier quote stale.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { isQuoteStale } from "../src/lib/billing/quote/plan-quote";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: typeof import("../src/lib/db");
let quotes: typeof import("../src/lib/billing/quote/plan-quote-service");

const planKey = `pro-${randomUUID().slice(0, 8)}`;

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
  databaseName = `pos_quote_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  db = await import("../src/lib/db");
  quotes = await import("../src/lib/billing/quote/plan-quote-service");

  await db.withoutTenantScope("platform", async () => {
    await db.query(
      `INSERT INTO billing_plans (key, name, monthly_price_rial, status, sort_order)
       VALUES ($1, 'پلن آزمون', 1000000, 'active', 1)`,
      [planKey],
    );
    await db.query(
      `INSERT INTO billing_price_versions
         (target_type, target_key, unit, unit_amount_rial, version, effective_from)
       VALUES ('plan', $1, 'month', 1000000, 1, '2026-01-01T00:00:00Z')`,
      [planKey],
    );
    // Two feature keys that already exist in the catalogue.
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

describe("quotePlanSubscription", () => {
  it("builds a 3-month quote from the published catalogue and plan features", async () => {
    const result = await quotes.quotePlanSubscription({
      planKey,
      termMonths: 3,
      termDiscountRate: 0.05,
      taxRate: 0.09,
      now: new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { quote } = result;
    // (1,000,000 + 200,000 monthly) × 3 = 3,600,000 gross; 5% = 180,000;
    // one-off 500,000 is not multiplied or discounted; 9% tax after discount.
    expect(quote.totals.grossRial).toBe(4_100_000);
    expect(quote.totals.discountRial).toBe(180_000);
    expect(quote.totals.taxRial).toBe(352_800);
    expect(quote.totals.netRial).toBe(4_272_800);
    expect(quote.period.end).toBe("2026-05-01T00:00:00.000Z");

    const base = quote.lines[0];
    expect(base.kind).toBe("plan_base");
    expect(base.priceVersion?.version).toBe(1);
    expect(quote.lines.find((line) => line.key === "inventory")).toMatchObject({
      kind: "recurring_addon",
      quantity: 3,
      grossRial: 600_000,
    });
    expect(quote.lines.find((line) => line.key === "delivery")).toMatchObject({
      kind: "one_off_addon",
      quantity: 1,
      grossRial: 500_000,
    });
  });

  it("marks the quote stale once a newer published price takes effect", async () => {
    const first = await quotes.quotePlanSubscription({
      planKey,
      termMonths: 3,
      termDiscountRate: 0.05,
      taxRate: 0.09,
      now: new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await db.withoutTenantScope("platform", () =>
      db.query(
        `INSERT INTO billing_price_versions
           (target_type, target_key, unit, unit_amount_rial, version, effective_from)
         VALUES ('plan', $1, 'month', 1200000, 2, '2026-02-01T01:00:00Z')`,
        [planKey],
      ),
    );

    const repriced = await quotes.quotePlanSubscription({
      planKey,
      termMonths: 3,
      termDiscountRate: 0.05,
      taxRate: 0.09,
      now: new Date("2026-02-01T02:00:00.000Z"),
    });
    expect(repriced.ok).toBe(true);
    if (!repriced.ok) return;

    expect(repriced.quote.totals.netRial).not.toBe(first.quote.totals.netRial);
    expect(
      isQuoteStale(first.quote, quotes.currentQuoteFacts(repriced.quote), new Date("2026-02-01T02:00:05.000Z")),
    ).toBe(true);
    // And the fresh quote is current at the same instant.
    expect(
      isQuoteStale(repriced.quote, quotes.currentQuoteFacts(repriced.quote), new Date("2026-02-01T02:00:05.000Z")),
    ).toBe(false);
  });

  it("refuses a plan that is not active", async () => {
    await db.withoutTenantScope("platform", () =>
      db.query(`UPDATE billing_plans SET status = 'retired' WHERE key = $1`, [planKey]),
    );
    expect(
      await quotes.quotePlanSubscription({
        planKey,
        termMonths: 1,
        termDiscountRate: 0,
        taxRate: 0,
        now: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ).toEqual({ ok: false, error: "plan_not_purchasable" });
  });

  it("reports an unknown plan rather than quoting nothing", async () => {
    expect(
      await quotes.quotePlanSubscription({
        planKey: "no-such-plan",
        termMonths: 1,
        termDiscountRate: 0,
        taxRate: 0,
      }),
    ).toEqual({ ok: false, error: "plan_not_found" });
  });
});
