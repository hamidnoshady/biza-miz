/**
 * Issue #1325 — the projected depreciation schedule endpoints against a REAL
 * database, through the route handlers themselves (the session-mock pattern of
 * retail-purchase-detail-route.integration.test.ts):
 *
 *   * tenant scope — another business's asset id answers the same 404 as a
 *     nonexistent one, the portfolio schedule selects only the session's own
 *     assets and totals, and a branch filter cannot reach a foreign branch;
 *   * permission gate — the gate is decided by the real role presets, so an
 *     accountant reads both schedules while a cashier (no `ledger.view`)
 *     receives the guard's 403 and no schedule at all.
 *
 * The services filter every read by `business_id` themselves; this file proves
 * the endpoints actually reach the database that way, rather than pinning the
 * SQL's shape.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { runMigrations } from "../scripts/migrate";

const auth = vi.hoisted(() => ({
  businessId: "",
  sub: "",
  role: "accountant" as "accountant" | "cashier",
}));

vi.mock("../src/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth")>();
  const { NextResponse } = await import("next/server");
  const { effectivePermissions } = await import("../src/lib/permissions");
  return {
    ...actual,
    // The real permission model decides: a role that does not hold the key the
    // route asks for gets the guard's 403, exactly as in production.
    requirePermission: vi.fn(async (permission: string) => {
      const session = { businessId: auth.businessId, sub: auth.sub, role: auth.role };
      const granted = effectivePermissions(auth.role, null).has(permission as never);
      if (!granted) return { session, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
      return { session, error: null };
    }),
    withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
  };
});

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let authModule: typeof import("../src/lib/auth");
let permissions: typeof import("../src/lib/permissions");
let assetScheduleRoute: typeof import("../src/app/api/ledger/fixed-assets/[id]/schedule/route");
let portfolioScheduleRoute: typeof import("../src/app/api/ledger/fixed-assets/schedule/route");

interface Tenant {
  businessId: string;
  locationId: string;
  assetId: string;
  cost: number;
  name: string;
}

const mine: Tenant = { businessId: "", locationId: "", assetId: "", cost: 0, name: "" };
const theirs: Tenant = { businessId: "", locationId: "", assetId: "", cost: 0, name: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_fa_schedule_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(rootDatabaseUrl!);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  authModule = await import("../src/lib/auth");
  permissions = await import("../src/lib/permissions");
  assetScheduleRoute = await import("../src/app/api/ledger/fixed-assets/[id]/schedule/route");
  portfolioScheduleRoute = await import("../src/app/api/ledger/fixed-assets/schedule/route");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenanceUrl = new URL(rootDatabaseUrl!);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function provisionTenant(label: string, cost: number): Promise<Tenant> {
  const name = `${label} یخچال صنعتی`;
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [`${label} Co`, `fa-schedule-${randomUUID().slice(0, 8)}`],
  );
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [business.rows[0].id],
  );
  const user = await db.query<{ id: string }>(
    "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id",
    [business.rows[0].id],
  );
  const asset = await db.query<{ id: string }>(
    `INSERT INTO fixed_assets
       (business_id, location_id, name, acquisition_date, cost, salvage_value, useful_life_months, created_by, code)
     VALUES ($1, $2, $3, '2024-03-20', $4, 0, 24, $5, $6)
     RETURNING id`,
    [business.rows[0].id, location.rows[0].id, name, cost, user.rows[0].id, `FA-${label}`],
  );
  return {
    businessId: business.rows[0].id,
    locationId: location.rows[0].id,
    assetId: asset.rows[0].id,
    cost,
    name,
  };
}

beforeEach(async () => {
  // fixed_asset_depreciation_entries references fixed_assets, which references
  // users and locations — all cascade from businesses, so two deletes suffice.
  await db.query("DELETE FROM fixed_asset_depreciation_entries");
  await db.query("DELETE FROM fixed_assets");
  await db.query("DELETE FROM businesses");

  Object.assign(mine, await provisionTenant("Mine", 12_000_000));
  Object.assign(theirs, await provisionTenant("Theirs", 99_000_000));

  auth.businessId = mine.businessId;
  auth.sub = randomUUID();
  auth.role = "accountant";
});

function getAssetSchedule(id: string) {
  return assetScheduleRoute.GET(
    new NextRequest(`http://localhost:3000/api/ledger/fixed-assets/${id}/schedule`),
    { params: Promise.resolve({ id }) },
  );
}

function getPortfolio(query = "") {
  return portfolioScheduleRoute.GET(
    new NextRequest(`http://localhost:3000/api/ledger/fixed-assets/schedule${query}`),
  );
}

describe("GET /api/ledger/fixed-assets/[id]/schedule — tenant scope and permission gate", () => {
  it("answers another tenant's asset id with the nonexistent id's exact 404", async () => {
    const foreign = await getAssetSchedule(theirs.assetId);
    expect(foreign.status).toBe(404);
    const foreignBody = await foreign.json();
    expect(foreignBody).toEqual({ error: "fixed_asset_not_found" });

    const absent = await getAssetSchedule(randomUUID());
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual(foreignBody);
  });

  it("returns the session's own asset and its schedule without the other tenant's facts", async () => {
    const res = await getAssetSchedule(mine.assetId);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.asset.id).toBe(mine.assetId);
    expect(body.asset.cost).toBe(mine.cost);
    expect(body.asset.name).toBe(mine.name);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.totals.cost).toBe(mine.cost);
    expect(JSON.stringify(body)).not.toContain(theirs.assetId);
    expect(JSON.stringify(body)).not.toContain(theirs.name);
    expect(JSON.stringify(body)).not.toContain(String(theirs.cost));
  });

  it("refuses a caller without ledger.view and does not read the schedule", async () => {
    auth.role = "cashier";
    const res = await getAssetSchedule(mine.assetId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });

    const guard = vi.mocked(authModule.requirePermission);
    expect(guard).toHaveBeenCalledWith(permissions.PERMISSIONS.ledgerView);
    expect(guard).not.toHaveBeenCalledWith(permissions.PERMISSIONS.financeAssetsManage);
  });
});

describe("GET /api/ledger/fixed-assets/schedule — tenant scope and permission gate", () => {
  it("selects only the session's own assets and totals", async () => {
    const res = await getPortfolio();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.assets.map((row: { asset: { id: string } }) => row.asset.id)).toEqual([mine.assetId]);
    expect(body.totals.assets).toBe(1);
    expect(body.totals.cost).toBe(mine.cost);
    // The projected periods are this tenant's arithmetic only.
    expect(JSON.stringify(body)).not.toContain(theirs.assetId);
    expect(JSON.stringify(body)).not.toContain(theirs.name);
    expect(JSON.stringify(body)).not.toContain(String(theirs.cost));
  });

  it("cannot reach another tenant's branch through the location filter", async () => {
    const res = await getPortfolio(`?locationId=${theirs.locationId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assets).toEqual([]);
    expect(body.totals.cost).toBe(0);
  });

  it("refuses a caller without ledger.view and does not read the portfolio", async () => {
    auth.role = "cashier";
    const res = await getPortfolio();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(vi.mocked(authModule.requirePermission)).toHaveBeenCalledWith(permissions.PERMISSIONS.ledgerView);
  });
});
