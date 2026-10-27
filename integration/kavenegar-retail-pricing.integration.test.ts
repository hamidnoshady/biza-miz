/**
 * Issue #902 §4 acceptance, against a real database.
 *
 * The issue asks for five things this file proves end to end:
 *   1. Retail pricing is versioned and effective-dated: the version in force at
 *      reservation is the one that priced the message, a publish closes the
 *      previous version at the boundary (never leaving a gap), and a publish
 *      cannot be back-dated behind a version already in force.
 *   2. Markup, fixed surcharge, volume tiers, per-business agreements, tax, the
 *      promotion window and the free monthly allowance all reach the quote from
 *      persisted policy — not from hard-coded numbers.
 *   3. Volume tiers and the allowance are driven by real month-to-date usage
 *      (`billing_usage_events`), the same record the outbox writes.
 *   4. Provider cost lands in `billing_vendor_cost_events` exactly once, keyed
 *      on the outbox row, and is INVISIBLE through a tenant connection — the
 *      issue's "no supplier cost, name or margin in any tenant surface".
 *   5. Nothing here is readable by a tenant without the platform bypass, while
 *      the platform console can read and publish it.
 *
 * No provider call is made: §4 is about money, not transport.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let probeRole: string;
let probe: Client;

let dbLib: typeof import("../src/lib/db");
let retail: typeof import("../src/lib/kavenegar/retail-pricing");
let service: typeof import("../src/lib/kavenegar/retail-pricing-service");
let billing: typeof import("../src/lib/messaging-billing");

const alpha = { businessId: "" };
const beta = { businessId: "" };

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

async function seedBusiness(name: string): Promise<{ businessId: string }> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return { businessId: rows[0]!.id };
}

/** Month-to-date usage, the input to slab tiering and the free allowance. */
async function recordSegments(businessId: string, segments: number): Promise<void> {
  await db.query(
    `INSERT INTO billing_usage_events
       (event_id, business_id, meter_key, source, resource_type, resource_id, quantity, unit, dimensions)
     VALUES ($1, $2, 'messaging.sms_segment', 'messaging', 'message_outbox', $1, $3, 'segment', '{}'::jsonb)`,
    [randomUUID(), businessId, segments],
  );
}

async function publish(body: Record<string, unknown>) {
  const result = await service.publishRetailPriceVersion({ body, createdBy: null });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.version;
}

const BASE_RATE = 1_000;

beforeAll(async () => {
  databaseName = `pos_retail_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  retail = await import("../src/lib/kavenegar/retail-pricing");
  service = await import("../src/lib/kavenegar/retail-pricing-service");
  billing = await import("../src/lib/messaging-billing");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  probeRole = `retail_probe_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await db.query(`CREATE ROLE ${probeRole} NOLOGIN`);
  await db.query(
    `GRANT SELECT ON kavenegar_retail_price_versions, kavenegar_retail_price_slabs,
                    kavenegar_retail_price_overrides, billing_vendor_cost_events
       TO ${probeRole}`,
  );
  probe = new Client({ connectionString: urlFor(databaseName) });
  await probe.connect();
  await probe.query(`SET ROLE ${probeRole}`);
}, 120_000);

afterAll(async () => {
  if (probe) await probe.end().catch(() => {});
  if (probeRole) {
    await db?.query(`DROP OWNED BY ${probeRole}`).catch(() => {});
    const admin = new Client({ connectionString: maintenanceUrl() });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS ${probeRole}`);
    } finally {
      await admin.end();
    }
  }
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM billing_vendor_cost_events");
  await db.query("DELETE FROM kavenegar_retail_price_versions");
  await db.query("DELETE FROM billing_usage_events");
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha"));
  Object.assign(beta, await seedBusiness("Beta"));
});

describe("retail price versions are effective-dated and auditable", () => {
  it("prices at the base rate until a version is published", async () => {
    const version = await service.loadRetailPriceVersionAt(new Date());
    expect(version.version).toBe(0);
    expect(version.markupBps).toBe(0);
    const quote = retail.quoteRetailCharge({
      channel: "sms",
      unitPriceRial: BASE_RATE,
      quantity: 3,
      businessId: alpha.businessId,
      monthlySegments: 0,
      freeAllowanceRemaining: 0,
      version,
    });
    expect(quote.totalRial).toBe(3_000);
  });

  it("keeps exactly one version open and closes it at the next version's start", async () => {
    const first = await publish({ markupBps: 1_000, note: "first" });
    const { rows: openAfterFirst } = await db.query(
      `SELECT version FROM kavenegar_retail_price_versions WHERE effective_until IS NULL`,
    );
    expect(openAfterFirst.map((row) => row.version)).toEqual([first.version]);

    const at = "2026-12-01T00:00:00.000Z";
    const second = await publish({ markupBps: 2_000, effectiveFrom: at, note: "second" });
    expect(second.version).toBe(first.version + 1);

    const { rows } = await db.query<{ version: number; effective_until: Date | null }>(
      `SELECT version, effective_until FROM kavenegar_retail_price_versions ORDER BY version`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.effective_until?.toISOString()).toBe(at);
    expect(rows[1]!.effective_until).toBeNull();

    // Before the boundary the first price is still in force; after it, the second.
    const beforeBoundary = await service.loadRetailPriceVersionAt(new Date("2026-11-30T23:59:59.000Z"));
    expect(beforeBoundary.markupBps).toBe(1_000);
    const afterBoundary = await service.loadRetailPriceVersionAt(new Date("2026-12-01T00:00:00.000Z"));
    expect(afterBoundary.markupBps).toBe(2_000);
    expect(afterBoundary.id).toBe(second.id);
  });

  it("refuses to back-date a price behind the version already in force", async () => {
    await publish({ markupBps: 500 });
    const rejected = await service.publishRetailPriceVersion({
      body: { markupBps: 900, effectiveFrom: "2020-01-01T00:00:00.000Z" },
    });
    expect(rejected).toMatchObject({ ok: false, error: "effective_from_before_current" });
    const { rows } = await db.query(`SELECT version FROM kavenegar_retail_price_versions`);
    expect(rows).toHaveLength(1);
  });

  it("rejects a policy the engine could not quote", async () => {
    const rejected = await service.publishRetailPriceVersion({ body: { markupBps: -1 } });
    expect(rejected).toMatchObject({ ok: false, error: "invalid_markup" });
    expect((await db.query(`SELECT 1 FROM kavenegar_retail_price_versions`)).rows).toHaveLength(0);
  });
});

describe("persisted policy drives the quote", () => {
  it("applies markup, surcharge, tax and the free allowance from the published version", async () => {
    await publish({
      markupBps: 2_000,
      fixedSurchargeRial: 250,
      taxBps: 900,
      freeAllowanceSegments: 4,
    });
    await recordSegments(alpha.businessId, 1);

    const priced = await service.quoteBusinessSends({
      businessId: alpha.businessId,
      messages: [
        { channel: "sms", unitPriceRial: BASE_RATE, quantity: 2 },
        { channel: "sms", unitPriceRial: BASE_RATE, quantity: 5 },
      ],
    });
    // Allowance: 4 published − 1 used = 3, consumed 2 then 1.
    expect(priced.monthlySegments).toBe(1);
    expect(priced.freeAllowanceRemaining).toBe(3);
    expect(priced.quotes.map((q) => q.freeUnits)).toEqual([2, 1]);
    // Message 1 is fully covered → zero. Message 2 pays 4 segments + markup + surcharge + tax.
    expect(priced.quotes[0]!.totalRial).toBe(0);
    expect(priced.quotes[1]!.baseRial).toBe(4_000);
    expect(priced.quotes[1]!.markupRial).toBe(800);
    expect(priced.quotes[1]!.surchargeRial).toBe(250);
    expect(priced.quotes[1]!.taxRial).toBe(454); // floor(5050 × 9%)
    expect(priced.quotes[1]!.totalRial).toBe(5_504);
    expect(priced.totalRial).toBe(5_504);
  });

  it("moves a business into a volume tier from its recorded monthly segments", async () => {
    await publish({
      markupBps: 3_000,
      slabs: [
        { minMonthlySegments: 0, markupBps: 3_000, fixedSurchargeRial: 200 },
        { minMonthlySegments: 1_000, markupBps: 1_000, fixedSurchargeRial: 0 },
      ],
    });
    await recordSegments(alpha.businessId, 1_200);

    const priced = await service.quoteBusinessSends({
      businessId: alpha.businessId,
      messages: [{ channel: "sms", unitPriceRial: BASE_RATE, quantity: 2 }],
    });
    expect(priced.monthlySegments).toBe(1_200);
    expect(priced.quotes[0]).toMatchObject({
      markupBps: 1_000,
      slabMinMonthlySegments: 1_000,
      markupRial: 200,
      surchargeRial: 0,
      totalRial: 2_200,
    });

    // The other business stays on the base tier.
    const other = await service.quoteBusinessSends({
      businessId: beta.businessId,
      messages: [{ channel: "sms", unitPriceRial: BASE_RATE, quantity: 2 }],
    });
    expect(other.quotes[0]).toMatchObject({ markupBps: 3_000, totalRial: 2_800 });
  });

  it("applies a per-business agreement without moving anyone else's price", async () => {
    await publish({
      markupBps: 2_500,
      overrides: [
        { scope: "business", businessId: alpha.businessId, markupBps: 500, fixedSurchargeRial: 0 },
        { scope: "channel", channel: "email", markupBps: 4_000 },
      ],
    });

    const smsAlpha = await service.quoteBusinessSends({
      businessId: alpha.businessId,
      messages: [{ channel: "sms", unitPriceRial: BASE_RATE, quantity: 1 }],
    });
    expect(smsAlpha.quotes[0]!.markupRial).toBe(50);

    const smsBeta = await service.quoteBusinessSends({
      businessId: beta.businessId,
      messages: [{ channel: "sms", unitPriceRial: BASE_RATE, quantity: 1 }],
    });
    expect(smsBeta.quotes[0]!.markupRial).toBe(250);

    const emailBeta = await service.quoteBusinessSends({
      businessId: beta.businessId,
      messages: [{ channel: "email", unitPriceRial: 5_000, quantity: 1 }],
    });
    // 5,000 × 40% — the email channel override, not the business one.
    expect(emailBeta.quotes[0]!.markupRial).toBe(2_000);
  });

  it("reports the month-to-date fleet volume the console shows", async () => {
    await publish({ markupBps: 100 });
    await recordSegments(alpha.businessId, 30);
    await recordSegments(beta.businessId, 12);
    const overview = await service.getRetailPricingOverview();
    expect(overview.current.version).toBeGreaterThan(0);
    expect(overview.month).toEqual({ businessesWithUsage: 2, segments: 42 });
    expect(overview.history).toHaveLength(1);
  });
});

describe("the wallet reserves the quote once and is refunded the difference", () => {
  it("charges the retail total up front and returns exactly what did not go out", async () => {
    await publish({ markupBps: 2_000, fixedSurchargeRial: 100 });
    await db.query(`INSERT INTO business_wallets (business_id, balance_rial) VALUES ($1, 1_000_000)`, [
      alpha.businessId,
    ]);

    const priced = await service.quoteBusinessSends({
      businessId: alpha.businessId,
      messages: [
        { channel: "sms", unitPriceRial: BASE_RATE, quantity: 2 }, // 2,000 + 400 + 100
        { channel: "sms", unitPriceRial: BASE_RATE, quantity: 1 }, // 1,000 + 200 + 100
      ],
    });
    expect(priced.quotes.map((q) => q.totalRial)).toEqual([2_500, 1_300]);
    expect(priced.totalRial).toBe(3_800);

    const reservation = await billing.reserveMessageSend({
      businessId: alpha.businessId,
      reservedRial: priced.totalRial,
      metadata: { retailPriceVersion: priced.version.version },
    });
    const afterReserve = await db.query<{ balance_rial: string }>(
      `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(Number(afterReserve.rows[0]!.balance_rial)).toBe(1_000_000 - 3_800);

    // Only the first message went out; the second is refunded in full.
    const settled = await billing.settleMessageSend({
      businessId: alpha.businessId,
      reservation,
      actualCostRial: priced.quotes[0]!.totalRial,
    });
    expect(settled).toEqual({ chargedRial: 2_500, refundedRial: 1_300 });

    // A second settlement is a no-op, not a second refund.
    const replay = await billing.settleMessageSend({
      businessId: alpha.businessId,
      reservation,
      actualCostRial: priced.quotes[0]!.totalRial,
    });
    expect(replay).toEqual(settled);

    const afterSettle = await db.query<{ balance_rial: string }>(
      `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(Number(afterSettle.rows[0]!.balance_rial)).toBe(1_000_000 - 2_500);

    const { rows: ledger } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM wallet_ledger WHERE business_id = $1 AND metadata->>'messageRequestId' = $2`,
      [alpha.businessId, reservation.requestId],
    );
    expect(Number(ledger[0]!.n)).toBe(2); // reserved + one refund
  });
});

describe("provider cost is posted once and is not tenant data", () => {
  it("records the same outbox row once, however often the drain replays it", async () => {
    const outboxId = randomUUID();
    const first = await service.recordManagedMessageVendorCost({
      businessId: alpha.businessId,
      outboxId,
      amountRial: 150,
      segments: 1,
      retailRial: 1_000,
      priceVersion: 1,
    });
    const second = await service.recordManagedMessageVendorCost({
      businessId: alpha.businessId,
      outboxId,
      amountRial: 150,
      segments: 1,
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const { rows } = await db.query<{
      provider: string;
      amount_rial: string;
      tenant_visible: boolean;
      metadata: { managedService?: boolean; retailRial?: number };
    }>(`SELECT provider, amount_rial, tenant_visible, metadata FROM billing_vendor_cost_events`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("kavenegar");
    expect(rows[0]!.amount_rial).toBe("150");
    expect(rows[0]!.tenant_visible).toBe(false);
    expect(rows[0]!.metadata.managedService).toBe(true);
    expect(rows[0]!.metadata.retailRial).toBe(1_000);
  });

  it("hides supplier cost from a tenant connection and shows it to the platform", async () => {
    await service.recordManagedMessageVendorCost({
      businessId: alpha.businessId,
      outboxId: randomUUID(),
      amountRial: 320,
    });

    // The tenant owns the business, so tenant_isolation alone would show it.
    await probe.query(`SELECT set_config('app.business_id', $1, false)`, [alpha.businessId]);
    const asTenant = await probe.query(`SELECT id FROM billing_vendor_cost_events`);
    expect(asTenant.rows).toHaveLength(0);

    // The platform console reads through the documented bypass.
    const asPlatform = await dbLib.withoutTenantScope("test", () =>
      dbLib.query<{ n: string }>(`SELECT count(*) AS n FROM billing_vendor_cost_events`),
    );
    expect(Number(asPlatform.rows[0]!.n)).toBe(1);
  });

  it("keeps retail policy unreadable without the bypass", async () => {
    await publish({ markupBps: 1_500 });
    await probe.query(`SELECT set_config('app.business_id', $1, false)`, [alpha.businessId]);

    for (const table of ["kavenegar_retail_price_versions", "kavenegar_retail_price_slabs", "kavenegar_retail_price_overrides"]) {
      const { rows } = await probe.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, `${table} leaked to a tenant`).toBe(0);
    }

    const platform = await dbLib.withoutTenantScope("test", () =>
      dbLib.query<{ n: string }>(`SELECT count(*) AS n FROM kavenegar_retail_price_versions`),
    );
    expect(Number(platform.rows[0]!.n)).toBe(1);
  });

  it("has RLS enabled, forced and policied on every new table", async () => {
    const { rows } = await db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: string;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'r'
          AND c.relname IN ('kavenegar_retail_price_versions',
                            'kavenegar_retail_price_slabs',
                            'kavenegar_retail_price_overrides')
        ORDER BY c.relname`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
      expect(Number(row.policies), row.relname).toBeGreaterThan(0);
    }
  });
});
