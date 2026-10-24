/**
 * Issue #915 phase 3 — GET /api/stock/purchases/[id] against a REAL
 * database, through the route handler itself (f11-payables' session-mock
 * pattern): the unit tests pin the SQL's shape, this proves the predicate
 * actually isolates tenants — a receipt id from another business answers
 * 404 for this session, never that tenant's document, while the session's
 * own receipt comes back with exact text money.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { runMigrations } from "../scripts/migrate";

const session = vi.hoisted(() => ({ businessId: "", locationId: "", sub: "" }));

vi.mock("../src/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth")>();
  const granted = async () => ({
    session: { businessId: session.businessId, sub: session.sub, role: "owner" },
    error: null,
  });
  return {
    ...actual,
    requirePermission: vi.fn(granted),
    withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
  };
});

vi.mock("../src/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn(async () => ({ id: session.locationId })) };
});

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let stockService: typeof import("../src/lib/retail-stock-service");
let itemsService: typeof import("../src/lib/items-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let detailRoute: typeof import("../src/app/api/stock/purchases/[id]/route");

/** 2^53 + 1 — exact only as text. */
const HUGE = "9007199254740993";

const mine = { businessId: "", locationId: "", itemId: "", purchaseId: "" };
const theirs = { businessId: "", locationId: "", itemId: "", purchaseId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_prt_${randomUUID().replaceAll("-", "")}`;
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
  stockService = await import("../src/lib/retail-stock-service");
  itemsService = await import("../src/lib/items-service");
  provisioning = await import("../src/lib/business-provisioning");
  detailRoute = await import("../src/app/api/stock/purchases/[id]/route");

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

async function provisionTenant(name: string): Promise<{ businessId: string; locationId: string; itemId: string; purchaseId: string }> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, 'cosmetics') RETURNING id",
    [name, `prt-${randomUUID().slice(0, 8)}`],
  );
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.rows[0].id],
  );
  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, biz.rows[0].id, "cosmetics");
  } finally {
    client.release();
  }
  const item = await itemsService.createItem({ locationId: loc.rows[0].id, name: `کالا ${name}`, tracking: "none" });

  const pool = await dbLib.getPool().connect();
  let purchaseId: string;
  try {
    await pool.query("BEGIN");
    const purchase = await stockService.receiveItemPurchase(pool, {
      businessId: biz.rows[0].id,
      locationId: loc.rows[0].id,
      lines: [{ itemId: item.id, quantity: "1", unitCost: HUGE }],
    });
    await pool.query("COMMIT");
    purchaseId = purchase.id;
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  } finally {
    pool.release();
  }
  return { businessId: biz.rows[0].id, locationId: loc.rows[0].id, itemId: item.id, purchaseId };
}

beforeEach(async () => {
  // journal_lines → accounts is RESTRICT, so the ledger goes first.
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");
  Object.assign(mine, await provisionTenant("Mine Co"));
  Object.assign(theirs, await provisionTenant("Theirs Co"));
  session.businessId = mine.businessId;
  session.locationId = mine.locationId;
  session.sub = randomUUID();
});

function getDetail(id: string) {
  return detailRoute.GET(
    new Request(`http://localhost:3000/api/stock/purchases/${id}`) as unknown as NextRequest,
    { params: Promise.resolve({ id }) },
  );
}

describe("GET /api/stock/purchases/[id] — tenant isolation against a real database (issue #915)", () => {
  it("another tenant's receipt id answers 404 — indistinguishable from a nonexistent id", async () => {
    const foreign = await getDetail(theirs.purchaseId);
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error).toBe("not_found");

    const absent = await getDetail(randomUUID());
    expect(absent.status).toBe(404);
    expect((await absent.json()).error).toBe("not_found");
  });

  it("the session's own receipt returns header and lines with exact text money", async () => {
    const res = await getDetail(mine.purchaseId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purchase.id).toBe(mine.purchaseId);
    expect(body.purchase.total).toBe(HUGE);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].unitCost).toBe(HUGE);
    expect(body.lines[0].itemId).toBe(mine.itemId);
  });

  it("a malformed id is a stable 404, never a cast error", async () => {
    const res = await getDetail("not-a-uuid");
    expect(res.status).toBe(404);
  });
});
