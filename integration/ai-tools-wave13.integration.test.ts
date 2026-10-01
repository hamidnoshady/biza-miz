/**
 * Phase 27 Wave 13 — the close-out AI tools answer from real data and refuse
 * a caller whose industry does not permit the underlying route.
 *
 * `runReadTool` is the same executor the dashboard assistant uses; each of
 * the three new tools is exercised here, and `get_near_expiry_items` is shown
 * to fail closed for a non-cosmetics business (the route it wraps is
 * `requireIndustryForApi(session, "cosmetics")`).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { SYSTEM_AI_READ_PERMISSIONS } from "../src/lib/ai-capabilities";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let aiTools: typeof import("../src/lib/ai-tools");

const cosmetics = { businessId: "", locationId: "" };
const jewelry = { businessId: "", locationId: "" };

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
  databaseName = `pos_ai_wave13_${randomUUID().replaceAll("-", "")}`;

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
  aiTools = await import("../src/lib/ai-tools");

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

describe("Wave 13 assistant tools", () => {
  it("get_near_expiry_items answers for cosmetics and refuses every other trade", async () => {
    const cRow = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry) VALUES ('Cosmetics AI', $1, 'cosmetics') RETURNING id`,
      [`cosmetics-ai-${randomUUID().slice(0, 8)}`],
    );
    cosmetics.businessId = cRow.rows[0].id;
    const cLoc = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`,
      [cosmetics.businessId],
    );
    cosmetics.locationId = cLoc.rows[0].id;

    const allowed = await aiTools.runReadTool("get_near_expiry_items", {}, cosmetics.businessId, undefined, undefined, SYSTEM_AI_READ_PERMISSIONS);
    expect(allowed.ok).toBe(true);
    expect(Array.isArray(allowed.data)).toBe(true);

    const jRow = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry) VALUES ('Jewelry AI', $1, 'jewelry') RETURNING id`,
      [`jewelry-ai-${randomUUID().slice(0, 8)}`],
    );
    jewelry.businessId = jRow.rows[0].id;
    const jLoc = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`,
      [jewelry.businessId],
    );
    jewelry.locationId = jLoc.rows[0].id;

    const refused = await aiTools.runReadTool("get_near_expiry_items", {}, jewelry.businessId, undefined, undefined, SYSTEM_AI_READ_PERMISSIONS);
    expect(refused.ok).toBe(false);
    expect((refused.data as { error?: string }).error).toBeTruthy();
  });

  it("get_staff_commission answers with an empty leaderboard for a business with no accruals", async () => {
    const result = await aiTools.runReadTool("get_staff_commission", {}, cosmetics.businessId, undefined, undefined, SYSTEM_AI_READ_PERMISSIONS);
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("get_repurchase_candidates answers with an empty list when there is no purchase history", async () => {
    const result = await aiTools.runReadTool("get_repurchase_candidates", {}, cosmetics.businessId, undefined, undefined, SYSTEM_AI_READ_PERMISSIONS);
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });
});
