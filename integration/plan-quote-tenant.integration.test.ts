/**
 * ESH-193 / #1378 — quoting from inside a tenant scope, under RLS.
 *
 * The resolver reads platform-owned catalogue tables (`billing_plans`,
 * `billing_price_versions`, `billing_plan_features`) while the request is
 * scoped to one business. That combination is exactly where a policy written
 * only for tenant tables can make a catalogue read return zero rows — a quote
 * would then fail as `plan_not_found` for every business, and no superuser-run
 * test would ever see it.
 *
 * So this test connects as the restricted runtime role (NOSUPERUSER,
 * NOBYPASSRLS — the same role the app runs as), first asserting that, then
 * quotes inside `withTenant`.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_quote_tenant_role";
const APP_PASSWORD = "quote-tenant-password";
const planKey = `tenant-plan-${randomUUID().slice(0, 8)}`;
const slug = `tenant-quote-${randomUUID().slice(0, 8)}`;

let databaseName: string;
let ownerClient: Client;
let businessId: string;
let db: typeof import("../src/lib/db");
let quotes: typeof import("../src/lib/billing/quote/plan-quote-service");

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_quote_tenant_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  const ownerUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl: ownerUrl, quiet: true });
  await createAppRole({
    databaseUrl: ownerUrl,
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  ownerClient = new Client({ connectionString: ownerUrl });
  await ownerClient.connect();

  // The catalogue the resolver must read while a tenant scope is active.
  await ownerClient.query(
    `INSERT INTO billing_plans (key, name, monthly_price_rial, status, sort_order)
     VALUES ($1, 'پلن آزمایشی', 1000000, 'active', 1)`,
    [planKey],
  );
  await ownerClient.query(
    `INSERT INTO billing_price_versions
       (target_type, target_key, unit, unit_amount_rial, version, effective_from)
     VALUES ('plan', $1, 'month', 1000000, 1, '2026-01-01T00:00:00Z')`,
    [planKey],
  );
  await ownerClient.query(
    `INSERT INTO billing_plan_features (plan_key, feature_key, pricing_model, price_rial, sort_order)
     VALUES ($1, 'inventory', 'monthly', 200000, 1)`,
    [planKey],
  );
  const business = await ownerClient.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, plan) VALUES ('کافهٔ آزمون', $1, $2) RETURNING id`,
    [slug, planKey],
  );
  businessId = business.rows[0].id;

  // From here on, the pool is the unprivileged runtime role.
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  db = await import("../src/lib/db");
  quotes = await import("../src/lib/billing/quote/plan-quote-service");
}, 180_000);

afterAll(async () => {
  await db?.getPool().end().catch(() => {});
  delete (globalThis as { pgPool?: unknown }).pgPool;
  await ownerClient?.end();

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await dropAppRole(maintenance, APP_ROLE);
  } finally {
    await maintenance.end();
  }
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("the test is actually testing RLS", () => {
  it("connects as a role row-level security applies to", async () => {
    const { rows } = await db.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0].privileged).toBe(false);
  });
});

describe("quoting inside a tenant scope", () => {
  it("reads the plan catalogue while scoped to the business", async () => {
    const result = await db.withTenant(businessId, () =>
      quotes.quotePlanSubscription({
        planKey,
        termMonths: 3,
        termDiscountRate: 0.05,
        taxRate: 0.09,
        now: new Date("2026-02-01T00:00:00.000Z"),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // (1,000,000 + 200,000 monthly) × 3; 5% off; 9% tax after the discount.
    expect(result.quote.totals).toEqual({
      grossRial: 3_600_000,
      discountRial: 180_000,
      taxRial: 307_800,
      netRial: 3_727_800,
      savingsRial: 180_000,
    });
    expect(result.quote.lines[0]).toMatchObject({
      kind: "plan_base",
      priceVersion: { version: 1 },
    });
    expect(result.quote.period.end).toBe("2026-05-01T00:00:00.000Z");
  });

  it("still refuses an unknown plan inside the scope, rather than erroring", async () => {
    const result = await db.withTenant(businessId, () =>
      quotes.quotePlanSubscription({
        planKey: "does-not-exist",
        termMonths: 1,
        termDiscountRate: 0,
        taxRate: 0,
      }),
    );
    expect(result).toEqual({ ok: false, error: "plan_not_found" });
  });
});
