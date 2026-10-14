/**
 * Migration 0197 — issue #808's one completion definition, on the real upgrade
 * path: a database at the pre-0197 state, populated the way the old code left
 * it, then the migration applied on top.
 *
 * The migration exists so no operating tenant is forced back into first-run
 * onboarding when `isSetupComplete()` stops honouring the old "every required
 * step is marked" fallback. The claims, in order:
 *
 *   - the old fallback set is stamped, per industry (F&B needs costing+menu; a
 *     trade-goods business never had them, so requiring them would leave
 *     exactly the businesses this migration exists for unstamped);
 *   - a demonstrably trading business is stamped whatever its markers say —
 *     real sales and real journal entries outrank a progress map that may have
 *     been lost by the write race this issue fixes;
 *   - a business provisioned with a chart of accounts and no progress row is
 *     stamped (the super-admin console's ready-to-use contract, issue #808 §4);
 *   - a genuine first run is left alone — nothing is invented for it;
 *   - an already-stamped business's completion time is never rewritten;
 *   - no audit event is fabricated: `setup.completed` records an actor
 *     completing a flow, and normalisation has no actor.
 *
 * Seeding goes through the owner connection, one step before the migration the
 * same way a shipped install would be sitting when the upgrade lands.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const TARGET = "0197_setup_completion_backfill.sql";
const ALREADY_COMPLETED_AT = "2024-05-01T10:20:30.000Z";

let databaseName: string;
let tempDir: string;
let ownerClient: Client;

const businessIds: Record<string, string> = {};

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createDatabase(): Promise<string> {
  const name = `pos_setup_backfill_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`);
  } finally {
    await maintenance.end();
  }
  return name;
}

/** A migrations directory holding everything up to (but not including) 0197. */
async function preMigrationDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pos-setup-backfill-"));
  const all = readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const file of all.filter((name) => name < TARGET)) {
    await copyFile(join(process.cwd(), "migrations", file), join(dir, file));
  }
  return dir;
}

beforeAll(async () => {
  databaseName = await createDatabase();
  tempDir = await preMigrationDir();
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: tempDir, quiet: true });

  ownerClient = new Client({ connectionString: urlFor(databaseName) });
  await ownerClient.connect();
  await ownerClient.query("SELECT set_config('app.rls_bypass', 'on', false)");

  async function business(slug: string, industry: string): Promise<string> {
    const { rows } = await ownerClient.query(
      `INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id`,
      [slug, slug, industry],
    );
    businessIds[slug] = rows[0].id;
    return rows[0].id;
  }

  async function progress(businessId: string, value: Record<string, unknown>): Promise<void> {
    await ownerClient.query(
      `INSERT INTO settings (business_id, location_id, key, value) VALUES ($1, NULL, 'setup.progress', $2)`,
      [businessId, JSON.stringify(value)],
    );
  }

  async function chartOfAccounts(businessId: string): Promise<void> {
    await ownerClient.query(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1000', 'صندوق', 'asset')`,
      [businessId],
    );
  }

  // 1. The old fallback itself, F&B: every required marker, never finished.
  const fullFnb = await business("full-fnb", "food_service");
  await progress(fullFnb, {
    steps: { business: "t", accounts: "t", costing: "t", tax: "t", menu: "t" },
    completedAt: null,
  });

  // 2. F&B mid-wizard: menu marker missing (a category exists, no item was
  //    ever created — exactly the hole issue #808 §3 closes).
  const partialFnb = await business("partial-fnb", "food_service");
  await progress(partialFnb, {
    steps: { business: "t", accounts: "t", costing: "t", tax: "t" },
    completedAt: null,
  });

  // 3. The old fallback, trade goods: costing/menu were never its steps.
  const jewelryFallback = await business("jewelry-fallback", "jewelry");
  await progress(jewelryFallback, {
    steps: { business: "t", accounts: "t", tax: "t" },
    completedAt: null,
  });

  // 4. Provisioned with a chart of accounts, no progress row at all.
  const provisionedRetail = await business("provisioned-retail", "wholesale");
  await chartOfAccounts(provisionedRetail);

  // 5. Trading with incomplete markers (a lost progress write, in effect).
  const trading = await business("trading", "cosmetics");
  await progress(trading, { steps: { business: "t" }, completedAt: null });
  await ownerClient.query(
    `INSERT INTO journal_entries (business_id, entry_date, memo) VALUES ($1, CURRENT_DATE, 'فروش روزانه')`,
    [trading],
  );

  // 6. Trading with no progress row at all (console-provisioned, then traded).
  const tradingNoRow = await business("trading-no-row", "service_saas");
  await ownerClient.query(
    `INSERT INTO journal_entries (business_id, entry_date, memo) VALUES ($1, CURRENT_DATE, 'صورتحساب خدمات')`,
    [tradingNoRow],
  );

  // 7. A genuine first run: no accounts, no progress, no trading.
  await business("fresh-install", "food_service");

  // 8. Already finished — the migration must not touch the timestamp.
  const alreadyStamped = await business("already-stamped", "food_service");
  await progress(alreadyStamped, {
    steps: { business: "t", accounts: "t" },
    completedAt: ALREADY_COMPLETED_AT,
  });

  // 9. Half-configured and never traded: accounts marker without an account
  //    row, say. Not the fallback set, not operational — left alone.
  const halfConfigured = await business("half-configured", "watch");
  await progress(halfConfigured, { steps: { business: "t", tax: "t" }, completedAt: null });

  // The upgrade step under test — the rest of the history is already applied.
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
}, 180_000);

afterAll(async () => {
  await ownerClient?.end().catch(() => {});
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function progressOf(slug: string): Promise<{ steps: Record<string, string>; completedAt: string | null } | null> {
  const { rows } = await ownerClient.query(
    `SELECT value FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = 'setup.progress'`,
    [businessIds[slug]],
  );
  return (rows[0]?.value as { steps: Record<string, string>; completedAt: string | null }) ?? null;
}

function completedAtOf(progress: { completedAt: string | null } | null): string | null {
  return progress?.completedAt ?? null;
}

describe("migration 0197 — setup completion backfill", () => {
  it("stamps the old required-step fallback, per industry", async () => {
    expect(completedAtOf(await progressOf("full-fnb"))).toBeTruthy();
    expect(completedAtOf(await progressOf("jewelry-fallback"))).toBeTruthy();
  });

  it("leaves a genuine first run and a half-configured business incomplete", async () => {
    expect(await progressOf("fresh-install")).toBeNull();
    expect(completedAtOf(await progressOf("partial-fnb"))).toBeNull();
    expect(completedAtOf(await progressOf("half-configured"))).toBeNull();
  });

  it("stamps provisioned businesses with no progress row, without touching a genuine first run", async () => {
    const provisioned = await progressOf("provisioned-retail");
    expect(completedAtOf(provisioned)).toBeTruthy();
    // Case 2 marks the row so the wizard's ordering has something to read.
    expect(Object.keys(provisioned?.steps ?? {})).toContain("provisioned");
  });

  it("stamps demonstrably trading tenants whatever their markers say", async () => {
    expect(completedAtOf(await progressOf("trading"))).toBeTruthy();

    const noRow = await progressOf("trading-no-row");
    expect(completedAtOf(noRow)).toBeTruthy();
    expect(Object.keys(noRow?.steps ?? {})).toContain("operational");
  });

  it("never rewrites an existing completion time and fabricates no audit event", async () => {
    expect(completedAtOf(await progressOf("already-stamped"))).toBe(ALREADY_COMPLETED_AT);

    const { rows } = await ownerClient.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'setup.completed'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("stamps exactly the unambiguously-established tenants", async () => {
    const { rows } = await ownerClient.query(
      `SELECT count(*)::int AS n
         FROM settings
        WHERE location_id IS NULL AND key = 'setup.progress' AND value ->> 'completedAt' IS NOT NULL`,
    );
    // The five the migration stamps — full-fnb, jewelry-fallback,
    // provisioned-retail, trading, trading-no-row — plus already-stamped,
    // which carried its marker in before the upgrade.
    expect(rows[0].n).toBe(6);
  });
});
