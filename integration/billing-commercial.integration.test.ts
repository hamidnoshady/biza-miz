/**
 * Commercial domain (migration 0177) against a migrated database:
 * purchased auto-renew, a real trial, an open invoice after a failed
 * renewal, atomic invoice numbers, idempotent usage, and projection order.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let subs: typeof import("../src/lib/subscription-service");
let wallet: typeof import("../src/lib/wallet-service");
let runtime: typeof import("../src/lib/billing/runtime");
let dbLib: typeof import("../src/lib/db");

const BID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  process.env.JWT_SECRET ||= "integration-test-secret";
  databaseName = `pos_commercial_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  subs = await import("../src/lib/subscription-service");
  wallet = await import("../src/lib/wallet-service");
  runtime = await import("../src/lib/billing/runtime");
  dbLib = await import("../src/lib/db");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه تجاری', 'commercial-cafe', 'free')`,
    [BID],
  );
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
});

function scoped<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(BID, fn);
}

describe("purchased plans and trials", () => {
  it("turns auto-renew on for a customer purchase", async () => {
    await scoped(async () => {
      const created = await subs.changeBusinessPlan({ businessId: BID, planKey: "pro", source: "purchase" });
      expect(created.subscription.autoRenew).toBe(true);
      expect(created.subscription.status).toBe("active");
      const again = await subs.changeBusinessPlan({ businessId: BID, planKey: "pro", source: "purchase" });
      expect(again.outcome).toBe("unchanged");
      expect(again.subscription.autoRenew).toBe(true);
    });
  });

  it("starts a trial in trialing and refuses a second trial", async () => {
    const fresh = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab";
    await db.query(
      `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه آزمایش', 'trial-cafe', 'free')`,
      [fresh],
    );
    await dbLib.withTenant(fresh, async () => {
      const { saveBillingPlan } = await import("../src/lib/billing-plans-service");
      await saveBillingPlan({
        key: "trial-plan",
        name: "آزمایشی",
        status: "active",
        trialDays: 14,
        sortOrder: 90,
        limits: {
          branches: { unlimited: true },
          members: { unlimited: true },
          monthlyOrders: { unlimited: true },
        },
      });
      const started = await subs.changeBusinessPlan({ businessId: fresh, planKey: "trial-plan", source: "trial" });
      expect(started.subscription.status).toBe("trialing");
      expect(started.subscription.trialStartedAt).not.toBeNull();
      await expect(
        subs.changeBusinessPlan({ businessId: fresh, planKey: "trial-plan", source: "trial" }),
      ).rejects.toMatchObject({ code: "trial_already_used" });
      const paid = await subs.changeBusinessPlan({ businessId: fresh, planKey: "pro", source: "purchase" });
      expect(paid.subscription.status).toBe("active");
      expect(paid.subscription.autoRenew).toBe(true);
      expect(paid.subscription.trialEnd).toBeNull();
    });
  });
});

describe("renewal accounting", () => {
  it("keeps an open invoice when the wallet cannot pay", async () => {
    await scoped(async () => {
      await subs.setAutoRenew(BID, true);
      await db.query(
        `UPDATE business_subscriptions SET current_period_end = now() - interval '1 day', status = 'active' WHERE business_id = $1`,
        [BID],
      );
      const outcome = await subs.renewBusinessSubscription(BID);
      expect(outcome.status).toBe("past_due");
      const invoices = await subs.listInvoices({ businessId: BID });
      expect(invoices.some((invoice) => invoice.status === "open" || invoice.status === "overdue")).toBe(true);
      const subscription = await subs.getBusinessSubscription(BID);
      expect(subscription?.status).toBe("past_due");
    });
  });

  it("allocates distinct invoice numbers", async () => {
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      const first = await runtime.allocateInvoiceNumber(client);
      const second = await runtime.allocateInvoiceNumber(client);
      await client.query("ROLLBACK");
      expect(first).not.toBe(second);
      expect(first).toMatch(/^INV-\d{6}-\d{4}$/);
    } finally {
      client.release();
    }
  });

  it("allocates distinct invoice numbers from two transactions at once", async () => {
    async function take(): Promise<string> {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        const number = await runtime.allocateInvoiceNumber(client);
        await client.query("COMMIT");
        return number;
      } finally {
        client.release();
      }
    }
    const [first, second] = await Promise.all([take(), take()]);
    expect(first).not.toBe(second);
  });
});

describe("usage ledger", () => {
  it("appends a usage event once", async () => {
    await scoped(async () => {
      const first = await runtime.appendUsageEvent({
        eventId: "evt-1",
        businessId: BID,
        meterKey: "automation.run",
        source: "test",
        quantity: 2,
        unit: "run",
      });
      const second = await runtime.appendUsageEvent({
        eventId: "evt-1",
        businessId: BID,
        meterKey: "automation.run",
        source: "test",
        quantity: 9,
        unit: "run",
      });
      expect(first.status).toBe("accepted");
      expect(second.status).toBe("duplicate");
      const { rows } = await db.query(
        `SELECT quantity FROM billing_usage_events WHERE business_id = $1 AND event_id = 'evt-1'`,
        [BID],
      );
      expect(Number(rows[0].quantity)).toBe(2);
    });
  });

  it("rejects a CMS meter the catalogue does not know", async () => {
    const result = await runtime.ingestCmsUsageBatchBody({
      source: "eshobe-cms",
      contractVersion: 1,
      events: [
        {
          eventId: "cms:test:01",
          siteId: "00000000-0000-4000-8000-000000000099",
          meterKey: "not.a.meter",
          quantity: 1,
          unit: "byte",
          periodStart: "2026-09-26T13:00:00.000Z",
          periodEnd: "2026-09-26T14:00:00.000Z",
          occurredAt: "2026-09-26T13:00:00.000Z",
        },
        {
          eventId: "cms:test:02",
          siteId: "00000000-0000-4000-8000-000000000099",
          meterKey: "ai.credit",
          quantity: 1,
          unit: "rial",
          periodStart: "2026-09-26T13:00:00.000Z",
          periodEnd: "2026-09-26T14:00:00.000Z",
          occurredAt: "2026-09-26T13:00:00.000Z",
        },
      ],
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.results.filter((row) => row.status === "rejected").map((row) => row.reason)).toEqual([
      "unknown_meter",
      "unknown_meter",
    ]);
    expect(result.accepted).toBe(0);
  });

  it("charges the connected business and treats a repeated CMS event as a duplicate", async () => {
    const other = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaac";
    await db.query(
      `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه دیگر', 'other-cafe', 'free')`,
      [other],
    );
    await db.query(
      `INSERT INTO eshobe_cms_connections
         (business_id, site_id, site_domain, base_url, api_key_ciphertext)
       VALUES ($1, 'site-owned', 'owned.example', 'https://cms.example', 'cipher')`,
      [BID],
    );
    const batch = {
      source: "eshobe-cms" as const,
      contractVersion: 1,
      events: [
        {
          eventId: "cms:bw:0001",
          siteId: "site-owned",
          meterKey: "cms.bandwidth_bytes",
          quantity: 100,
          unit: "byte",
          periodStart: "2026-09-26T13:00:00.000Z",
          periodEnd: "2026-09-26T14:00:00.000Z",
          occurredAt: "2026-09-26T13:00:00.000Z",
          dimensions: { forged: String(other) },
        },
      ],
    };
    const first = await runtime.ingestCmsUsageBatchBody(batch);
    const second = await runtime.ingestCmsUsageBatchBody(batch);
    if ("error" in first || "error" in second) throw new Error("ingest failed");
    expect(first.accepted).toBe(1);
    expect(second.duplicates).toBe(1);
    const { rows } = await db.query<{ business_id: string; quantity: string }>(
      `SELECT business_id, quantity::text FROM billing_usage_events WHERE source = 'eshobe-cms' AND event_id = 'cms:bw:0001'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.business_id).toBe(BID);
    expect(rows[0]?.quantity).toBe("100");
    const missing = await runtime.ingestCmsUsageBatchBody({
      source: "eshobe-cms",
      contractVersion: 1,
      events: [
        {
          eventId: "cms:bw:miss",
          siteId: "site-nobody",
          meterKey: "cms.bandwidth_bytes",
          quantity: 5,
          unit: "byte",
          periodStart: "2026-09-26T13:00:00.000Z",
          periodEnd: "2026-09-26T14:00:00.000Z",
          occurredAt: "2026-09-26T13:00:00.000Z",
        },
      ],
    });
    if ("error" in missing) throw new Error(missing.error);
    expect(missing.results).toEqual([{ eventId: "cms:bw:miss", status: "rejected", reason: "unknown_site" }]);
  });

  it("refuses an older entitlement projection", async () => {
    const first = await dbLib.withoutTenantScope("platform", () => runtime.publishEntitlementProjection({
      siteId: "site-1",
      businessId: BID,
      serving: true,
      planKey: "pro",
      features: [],
      limits: {},
      periodStart: null,
      periodEnd: null,
    }));
    expect(first).toBe(1);
    const applied = await dbLib.withoutTenantScope("platform", () =>
      runtime.applyEntitlementProjection({
        siteId: "site-1",
        businessId: BID,
        version: 1,
        payload: { serving: false },
      }),
    );
    expect(applied.applied).toBe(false);
    const second = await dbLib.withoutTenantScope("platform", () => runtime.publishEntitlementProjection({
      siteId: "site-1",
      businessId: BID,
      serving: true,
      planKey: "business",
      features: ["website.cms"],
      limits: {},
      periodStart: null,
      periodEnd: null,
    }));
    expect(second).toBe(2);
  });
});
