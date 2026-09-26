/**
 * Regression tests for a duplicate-key crash shared by three
 * `cosmetics-service.ts` entry points: `sellCosmeticUnits`,
 * `writeOffExpiredBatches`, and `openTester`.
 *
 * All three used to post their journal entries with a fixed
 * `sourceId: input.itemId`. `journal_entries` has a unique index
 * `uq_journal_business_source_posting` on
 * (business_id, source_type, source_id, posting_kind), so only the *first*
 * call for a given cosmetic item could ever post — every later sale, write-off
 * batch, or tester bottle of the same item (all ordinary, expected repeat
 * events for shelf stock) threw a raw `duplicate key value violates unique
 * constraint "uq_journal_business_source_posting"`.
 *
 * This is a narrow, purpose-built regression check, not a full test suite
 * for cosmetics-service.ts (which has no dedicated integration test file
 * yet); it only proves the fix for these three call sites.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let accessories: typeof import("../src/lib/accessories-service");
let cosmetics: typeof import("../src/lib/cosmetics-service");

const biz = { id: "", locationId: "" };
const acct = { cash: "", revenue: "", vatPayable: "", cogs: "", inventory: "", expiredAndTester: "" };

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
  databaseName = `pos_cosmetics_idem_${randomUUID().replaceAll("-", "")}`;

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
  itemsService = await import("../src/lib/items-service");
  accessories = await import("../src/lib/accessories-service");
  cosmetics = await import("../src/lib/cosmetics-service");

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

beforeEach(async () => {
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM item_variant_attributes");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Cosmetics Co', $1, 'cosmetics') RETURNING id",
    [`cosmetics-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const accountsRes = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '4570', 'Cosmetic Sales Revenue', 'revenue'),
            ($1, '2200', 'VAT Payable', 'liability'),
            ($1, '5150', 'Cosmetic COGS', 'expense'),
            ($1, '1350', 'Cosmetic Inventory', 'asset'),
            ($1, '5160', 'Expired/Tester Cosmetics', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  const byCode: Record<string, keyof typeof acct> = {
    "1100": "cash",
    "4570": "revenue",
    "2200": "vatPayable",
    "5150": "cogs",
    "1350": "inventory",
    "5160": "expiredAndTester",
  };
  for (const row of accountsRes.rows) acct[byCode[row.code]] = row.id;
});

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

describe("sellCosmeticUnits", () => {
  it("sells the same item twice in separate transactions without a duplicate-key crash", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "رژ لب",
      kind: "simple",
    });
    await accessories.setUnitPrice(item.id, 150_000);
    await accessories.receiveStock(item.id, { quantity: "10", unitCost: 40_000 });

    const first = await withTransaction((client) =>
      cosmetics.sellCosmeticUnits(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: item.id,
        quantity: "3",
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    const second = await withTransaction((client) =>
      cosmetics.sellCosmeticUnits(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: item.id,
        quantity: "2",
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    expect(second.revenueEntryId).not.toBe(first.revenueEntryId);
    expect(second.cogsEntryId).not.toBe(first.cogsEntryId);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM journal_entries WHERE source_type = 'cosmetic_sale'`,
    );
    expect(rows[0].count).toBe("4");

    const stock = await accessories.getStock(item.id);
    expect(stock?.quantity).toBe("5.000000000");
  });
});

describe("writeOffExpiredBatches", () => {
  it("writes off expired batches on the same item twice, on two separate days, without a duplicate-key crash", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "کرم ضدآفتاب",
      kind: "simple",
      tracking: "batch",
    });

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await withTransaction((client) =>
      cosmetics.receiveBatch(client, {
        itemId: item.id,
        batchNumber: "B1",
        expiryDate: yesterday,
        quantity: "5",
        unitCost: 20_000,
      }),
    );

    const first = await withTransaction((client) =>
      cosmetics.writeOffExpiredBatches(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: item.id,
      }),
    );
    expect(first.writtenOffQuantity).toBe("5");
    expect(first.entryId).not.toBeNull();

    // A second batch of the same item expires later; writing it off must post
    // its own independent entry rather than colliding with the first.
    await withTransaction((client) =>
      cosmetics.receiveBatch(client, {
        itemId: item.id,
        batchNumber: "B2",
        expiryDate: yesterday,
        quantity: "3",
        unitCost: 20_000,
      }),
    );

    const second = await withTransaction((client) =>
      cosmetics.writeOffExpiredBatches(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: item.id,
      }),
    );
    expect(second.writtenOffQuantity).toBe("3");
    expect(second.entryId).not.toBeNull();
    expect(second.entryId).not.toBe(first.entryId);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM journal_entries WHERE source_type = 'cosmetic_write_off'`,
    );
    expect(rows[0].count).toBe("2");
  });
});

describe("openTester", () => {
  it("opens a second tester of the same item without a duplicate-key crash", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "رژگونه",
      kind: "simple",
    });
    await accessories.setUnitPrice(item.id, 120_000);
    await accessories.receiveStock(item.id, { quantity: "5", unitCost: 30_000 });

    const first = await withTransaction((client) =>
      cosmetics.openTester(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: item.id,
      }),
    );
    expect(first.entryId).not.toBeNull();

    const second = await withTransaction((client) =>
      cosmetics.openTester(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: item.id,
      }),
    );
    expect(second.entryId).not.toBeNull();
    expect(second.entryId).not.toBe(first.entryId);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM journal_entries WHERE source_type = 'cosmetic_tester'`,
    );
    expect(rows[0].count).toBe("2");

    const stock = await accessories.getStock(item.id);
    expect(stock?.quantity).toBe("3.000000000");
  });
});
