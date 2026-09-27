/**
 * Phase 21 Wave 6: accessories (بدلیجات) on Wave 1's variant primitive —
 * a product family, its variants with their distinguishing attributes,
 * stock received at a rolling average cost, and a sale that posts revenue
 * and COGS and relieves the quantity on hand.
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
let itemsService: typeof import("../src/lib/items-service");
let accessories: typeof import("../src/lib/accessories-service");

const biz = { id: "", locationId: "" };
const acct = { cash: "", revenue: "", vatPayable: "", cogs: "", inventory: "" };

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
  databaseName = `pos_accessories_${randomUUID().replaceAll("-", "")}`;

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
    "INSERT INTO businesses (name, slug, industry) VALUES ('Bijoux Co', $1, 'accessories') RETURNING id",
    [`accessories-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '4560', 'Accessory Sales Revenue', 'revenue'),
            ($1, '2200', 'VAT Payable', 'liability'),
            ($1, '5140', 'Accessory COGS', 'expense'),
            ($1, '1340', 'Accessory Inventory', 'asset')
     RETURNING id, code`,
    [biz.id],
  );
  const byCode: Record<string, keyof typeof acct> = {
    "1100": "cash",
    "4560": "revenue",
    "2200": "vatPayable",
    "5140": "cogs",
    "1340": "inventory",
  };
  for (const row of accounts.rows) acct[byCode[row.code]] = row.id;
});

async function makeFamilyWithVariant(attributes = [{ name: "رنگ", value: "طلایی" }]) {
  const parent = await itemsService.createItem({
    locationId: biz.locationId,
    name: "دستبند بدلیجات",
    kind: "variant_parent",
  });
  const child = await itemsService.createVariantChild(
    parent.id,
    biz.locationId,
    "دستبند بدلیجات — طلایی",
    null,
    attributes,
  );
  return { parent, child };
}

async function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
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

async function linesOf(entryId: string | null) {
  const { rows } = await db.query<{ account_id: string; debit: string; credit: string }>(
    "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
    [entryId],
  );
  return rows;
}

describe("variant stock", () => {
  it("rolls the average cost forward across receipts", async () => {
    const { child } = await makeFamilyWithVariant();

    await accessories.receiveStock(child.id, { quantity: "10", unitCost: 50_000 });
    let stock = await accessories.getStock(child.id);
    expect(stock?.quantity).toBe("10.000000000");
    expect(stock?.unitCost).toBe(50_000);

    await accessories.receiveStock(child.id, { quantity: "10", unitCost: 70_000 });
    stock = await accessories.getStock(child.id);
    expect(stock?.quantity).toBe("20.000000000");
    expect(stock?.unitCost).toBe(60_000);
  });

  it("refuses stock on a product family — only its variants sit on a shelf", async () => {
    const { parent } = await makeFamilyWithVariant();
    await expect(accessories.receiveStock(parent.id, { quantity: "1", unitCost: 100 })).rejects.toThrow(
      /خانوادهٔ کالا/,
    );
  });

  it("keeps a price and a cost as separate facts about the same variant", async () => {
    const { child } = await makeFamilyWithVariant();
    await accessories.setUnitPrice(child.id, 250_000);
    await accessories.receiveStock(child.id, { quantity: "5", unitCost: 90_000 });

    const stock = await accessories.getStock(child.id);
    expect(stock?.unitPrice).toBe(250_000);
    expect(stock?.unitCost).toBe(90_000);
  });
});

describe("sellAccessoryUnits", () => {
  it("posts revenue and COGS and relieves the quantity on hand", async () => {
    const { child } = await makeFamilyWithVariant();
    await accessories.setUnitPrice(child.id, 250_000);
    await accessories.receiveStock(child.id, { quantity: "10", unitCost: 60_000 });

    const result = await withTransaction((client) =>
      accessories.sellAccessoryUnits(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: child.id,
        quantity: "4",
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    // 4 × 250,000 = 1,000,000 + 9% VAT = 1,090,000; COGS 4 × 60,000 = 240,000
    expect(result.breakdown.total).toBe("1090000");
    expect(await linesOf(result.revenueEntryId)).toEqual([
      { account_id: acct.cash, debit: "1090000", credit: "0" },
      { account_id: acct.revenue, debit: "0", credit: "1000000" },
      { account_id: acct.vatPayable, debit: "0", credit: "90000" },
    ]);
    expect(await linesOf(result.cogsEntryId)).toEqual([
      { account_id: acct.cogs, debit: "240000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "240000" },
    ]);

    expect((await accessories.getStock(child.id))?.quantity).toBe("6.000000000");
  });

  it("sells at an overridden price without touching the shelf price", async () => {
    const { child } = await makeFamilyWithVariant();
    await accessories.setUnitPrice(child.id, 250_000);
    await accessories.receiveStock(child.id, { quantity: "10", unitCost: 60_000 });

    const result = await withTransaction((client) =>
      accessories.sellAccessoryUnits(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: child.id,
        quantity: "1",
        unitPrice: 300_000,
        vatPercent: 0,
        paymentMethod: "cash",
      }),
    );
    expect(result.breakdown.total).toBe("300000");
    expect((await accessories.getStock(child.id))?.unitPrice).toBe(250_000);
  });

  it("refuses to oversell, leaving stock and the ledger untouched", async () => {
    const { child } = await makeFamilyWithVariant();
    await accessories.setUnitPrice(child.id, 250_000);
    await accessories.receiveStock(child.id, { quantity: "2", unitCost: 60_000 });

    await expect(
      withTransaction((client) =>
        accessories.sellAccessoryUnits(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          itemId: child.id,
          quantity: "3",
          vatPercent: 9,
          paymentMethod: "cash",
        }),
      ),
    ).rejects.toThrow(/موجودی کافی نیست/);

    expect((await accessories.getStock(child.id))?.quantity).toBe("2.000000000");
    const { rows } = await db.query("SELECT 1 FROM journal_entries");
    expect(rows).toHaveLength(0);
  });

  it("refuses a sale with no cost basis or no price", async () => {
    const { child } = await makeFamilyWithVariant();
    await accessories.setUnitPrice(child.id, 250_000);

    await expect(
      withTransaction((client) =>
        accessories.sellAccessoryUnits(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          itemId: child.id,
          quantity: "1",
          vatPercent: 9,
          paymentMethod: "cash",
        }),
      ),
    ).rejects.toThrow(/بهای تمام‌شده/);

    const { child: unpriced } = await makeFamilyWithVariant([{ name: "رنگ", value: "نقره‌ای" }]);
    await accessories.receiveStock(unpriced.id, { quantity: "5", unitCost: 60_000 });
    await expect(
      withTransaction((client) =>
        accessories.sellAccessoryUnits(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          itemId: unpriced.id,
          quantity: "1",
          vatPercent: 9,
          paymentMethod: "cash",
        }),
      ),
    ).rejects.toThrow(/قیمت فروش/);
  });

  it("sells the same item twice in separate transactions without a duplicate-key crash", async () => {
    // Regression test: sellAccessoryUnits used to post its revenue/COGS
    // journal entries with `sourceId: input.itemId`, a fixed value for a
    // given item. journal_entries has a unique index on (business_id,
    // source_type, source_id, posting_kind), so the *first* sale of an
    // accessory posted fine but every subsequent sale of that same item —
    // the ordinary case for stock a shop expects to sell many times — threw
    // a raw `duplicate key value violates unique constraint
    // "uq_journal_business_source_posting"`. Each sale must get its own
    // posting identity.
    const { child } = await makeFamilyWithVariant();
    await accessories.setUnitPrice(child.id, 250_000);
    await accessories.receiveStock(child.id, { quantity: "10", unitCost: 60_000 });

    const first = await withTransaction((client) =>
      accessories.sellAccessoryUnits(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: child.id,
        quantity: "3",
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    const second = await withTransaction((client) =>
      accessories.sellAccessoryUnits(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: child.id,
        quantity: "2",
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    expect(second.revenueEntryId).not.toBe(first.revenueEntryId);
    expect(second.cogsEntryId).not.toBe(first.cogsEntryId);
    expect(await linesOf(first.revenueEntryId)).not.toHaveLength(0);
    expect(await linesOf(second.revenueEntryId)).not.toHaveLength(0);
    expect((await accessories.getStock(child.id))?.quantity).toBe("5.000000000");

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM journal_entries WHERE source_type = 'accessory_sale'`,
    );
    expect(rows[0].count).toBe("4");
  });
});

describe("listVariantBoard", () => {
  it("returns families and their variants with attributes, stock and pricing", async () => {
    const { parent, child } = await makeFamilyWithVariant([
      { name: "رنگ", value: "طلایی" },
      { name: "سایز", value: "متوسط" },
    ]);
    await accessories.setUnitPrice(child.id, 250_000);
    await accessories.receiveStock(child.id, { quantity: "7", unitCost: 60_000 });

    const board = await accessories.listVariantBoard(biz.locationId);
    const family = board.find((row) => row.id === parent.id);
    const variant = board.find((row) => row.id === child.id);

    expect(family).toMatchObject({ kind: "variant_parent", quantity: "0", attributes: [] });
    expect(variant).toMatchObject({
      kind: "variant_child",
      parentItemId: parent.id,
      parentName: "دستبند بدلیجات",
      quantity: "7.000000000",
      unitCost: 60_000,
      unitPrice: 250_000,
    });
    expect(variant?.attributes).toEqual([
      { name: "رنگ", value: "طلایی" },
      { name: "سایز", value: "متوسط" },
    ]);
  });
});
