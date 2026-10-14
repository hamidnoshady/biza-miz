/**
 * Issue #812 §4 — the scheduled-job switches, against a real database.
 *
 * The generic `tenant-isolation.integration.test.ts` proves ai_agent_settings
 * carries RLS like every other tenant table; this file proves the actual product
 * behaviour the table exists for — a business can turn off
 * `receivables_follow_up` and stop getting customer-debt drafts, while a sibling
 * business with that same job enabled keeps getting them, and each business's
 * other jobs stay independently toggleable regardless of what
 * receivables_follow_up is set to.
 *
 * "Job", not "agent": these are the background scheduled runs of the proactive
 * tick. Issue #812 reclaimed the word "Agent" for the Superadmin-built system
 * agents, so this surface was migrated rather than left to share a name with
 * them. The table keeps its old name; renaming a tenant table for vocabulary
 * is a data migration with no product payoff.
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
let dbLib: typeof import("../src/lib/db");
let proactive: typeof import("../src/lib/ai-proactive-service");
let customersService: typeof import("../src/lib/parties-service");

const alpha = { businessId: "", locationId: "", customerId: "" };
const beta = { businessId: "", locationId: "", customerId: "" };

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
  databaseName = `pos_ai_agents_${randomUUID().replaceAll("-", "")}`;

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
  proactive = await import("../src/lib/ai-proactive-service");
  customersService = await import("../src/lib/parties-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
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

/** Gives a business a debtor customer (a credit-order AR debit never repaid) and the master proactive switch on. */
async function seedBusiness(name: string, slug: string): Promise<{ businessId: string; locationId: string; customerId: string }> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = locRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1200', 'Accounts Receivable', 'asset'), ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [businessId],
  );
  const ar = accounts.rows.find((r) => r.code === "1200")!.id;
  const revenue = accounts.rows.find((r) => r.code === "4300")!.id;

  const customer = await dbLib.withTenant(businessId, () =>
    customersService.createCustomer(businessId, { name: `Debtor ${slug}` }),
  );

  const orderRow = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, status, customer_id, total, opened_at, closed_at)
     VALUES ($1, 1, 'completed', $2, 300000, now(), now()) RETURNING id`,
    [locationId, customer.id],
  );
  const entryRow = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id)
     VALUES ($1, current_date, 'Order payment', 'order', $2) RETURNING id`,
    [businessId, orderRow.rows[0].id],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 300000, 0), ($1, $3, 0, 300000)`,
    [entryRow.rows[0].id, ar, revenue],
  );

  await db.query(
    `INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'ai_assistant', true)`,
    [businessId],
  );
  // daily_digest_hour = 0 keeps customer_debt_drafts always due regardless of wall-clock time.
  await db.query(
    `INSERT INTO ai_proactive_settings (business_id, enabled, daily_digest_hour) VALUES ($1, true, 0)`,
    [businessId],
  );

  return { businessId, locationId, customerId: customer.id };
}

beforeEach(async () => {
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM ai_proactive_drafts");
  await db.query("DELETE FROM ai_proactive_runs");
  await db.query("DELETE FROM ai_agent_settings");
  await db.query("DELETE FROM ai_proactive_settings");
  await db.query("DELETE FROM businesses");

  const seededAlpha = await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`);
  alpha.businessId = seededAlpha.businessId;
  alpha.locationId = seededAlpha.locationId;
  alpha.customerId = seededAlpha.customerId;

  const seededBeta = await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`);
  beta.businessId = seededBeta.businessId;
  beta.locationId = seededBeta.locationId;
  beta.customerId = seededBeta.customerId;
});

describe("per-job switches", () => {
  it("default to disabled and stay isolated per business", async () => {
    const alphaDefaults = await dbLib.withTenant(alpha.businessId, () => proactive.getScheduledJobSwitches(alpha.businessId));
    expect(alphaDefaults.receivables_follow_up).toEqual({ enabled: false, scheduleHour: 8 });
    expect(alphaDefaults.sales_analyzer.enabled).toBe(false);

    await dbLib.withTenant(alpha.businessId, () =>
      proactive.setScheduledJobEnabled(alpha.businessId, "sales_analyzer", true),
    );

    const alphaAfter = await dbLib.withTenant(alpha.businessId, () => proactive.getScheduledJobSwitches(alpha.businessId));
    expect(alphaAfter.sales_analyzer.enabled).toBe(true);
    expect(alphaAfter.receivables_follow_up.enabled).toBe(false);

    // Beta never opted in, and enabling Alpha's agent must not leak across the tenant boundary.
    const betaSettings = await dbLib.withTenant(beta.businessId, () => proactive.getScheduledJobSwitches(beta.businessId));
    expect(betaSettings.sales_analyzer.enabled).toBe(false);
  });
});

describe("receivables_follow_up gates customer_debt_drafts", () => {
  it("produces a draft for a business with the agent on, none for a sibling with it off, on the same tick", async () => {
    await dbLib.withTenant(alpha.businessId, () =>
      proactive.setScheduledJobEnabled(alpha.businessId, "receivables_follow_up", true),
    );
    // Beta enables a different agent to prove it stays independent of receivables_follow_up.
    await dbLib.withTenant(beta.businessId, () =>
      proactive.setScheduledJobEnabled(beta.businessId, "reconciliation_assistant", true),
    );

    await proactive.runAiProactiveTick();

    const alphaDrafts = await db.query(`SELECT customer_id FROM ai_proactive_drafts WHERE business_id = $1`, [
      alpha.businessId,
    ]);
    expect(alphaDrafts.rows).toEqual([{ customer_id: alpha.customerId }]);
    const alphaRuns = await db.query(
      `SELECT status FROM ai_proactive_runs WHERE business_id = $1 AND kind = 'customer_debt_drafts'`,
      [alpha.businessId],
    );
    expect(alphaRuns.rows).toEqual([{ status: "completed" }]);

    const betaDrafts = await db.query(`SELECT customer_id FROM ai_proactive_drafts WHERE business_id = $1`, [
      beta.businessId,
    ]);
    expect(betaDrafts.rows).toEqual([]);
    const betaRuns = await db.query(
      `SELECT status FROM ai_proactive_runs WHERE business_id = $1 AND kind = 'customer_debt_drafts'`,
      [beta.businessId],
    );
    expect(betaRuns.rows).toEqual([]);

    // Beta's own reconciliation_assistant toggle is untouched by receivables_follow_up staying off.
    const betaSwitches = await dbLib.withTenant(beta.businessId, () => proactive.getScheduledJobSwitches(beta.businessId));
    expect(betaSwitches.reconciliation_assistant.enabled).toBe(true);
    expect(betaSwitches.receivables_follow_up.enabled).toBe(false);
  });
});

describe("the tick never claims a run a disabled job owes", () => {
  // receivables_follow_up (customer_debt_drafts) needs no AI provider call, unlike
  // the digest jobs, so it is the cheapest job to actually drive to a completed
  // run here.
  it("claims a run for the business that turned the job on, and none for a sibling that did not", async () => {
    // Same job enabled on both sides is the scenario where a missing business_id
    // filter (or a broken RLS policy) would leak Alpha's run into Beta's read.
    await dbLib.withTenant(alpha.businessId, () =>
      proactive.setScheduledJobEnabled(alpha.businessId, "receivables_follow_up", true),
    );

    await proactive.runAiProactiveTick();

    const alphaRuns = await db.query(
      `SELECT status FROM ai_proactive_runs WHERE business_id = $1 AND kind = 'customer_debt_drafts'`,
      [alpha.businessId],
    );
    expect(alphaRuns.rows).toEqual([{ status: "completed" }]);

    // Beta never enabled it, so the tick left its period key unclaimed — which is
    // what lets a business enable the job later the same day and still get that
    // day's run.
    const betaRuns = await db.query(
      `SELECT status FROM ai_proactive_runs WHERE business_id = $1 AND kind = 'customer_debt_drafts'`,
      [beta.businessId],
    );
    expect(betaRuns.rows).toEqual([]);

    const betaDrafts = await db.query(`SELECT customer_id FROM ai_proactive_drafts WHERE business_id = $1`, [
      beta.businessId,
    ]);
    expect(betaDrafts.rows).toEqual([]);
  });

  it("stops claiming once the job is turned off, even with runs recorded from when it was on", async () => {
    await dbLib.withTenant(alpha.businessId, () =>
      proactive.setScheduledJobEnabled(alpha.businessId, "receivables_follow_up", true),
    );
    await proactive.runAiProactiveTick();
    await dbLib.withTenant(alpha.businessId, () =>
      proactive.setScheduledJobEnabled(alpha.businessId, "receivables_follow_up", false),
    );
    await proactive.runAiProactiveTick();

    const alphaRuns = await db.query(
      `SELECT status FROM ai_proactive_runs WHERE business_id = $1 AND kind = 'customer_debt_drafts'`,
      [alpha.businessId],
    );
    expect(alphaRuns.rows).toEqual([{ status: "completed" }]);

    const switches = await dbLib.withTenant(alpha.businessId, () =>
      proactive.getScheduledJobSwitches(alpha.businessId),
    );
    expect(switches.receivables_follow_up.enabled).toBe(false);
  });
});
