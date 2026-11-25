/**
 * Phase 27 Wave 11 — merchandising analytics for accessories/cosmetics.
 *
 * The load-bearing claims: the matrix bulk editor is one transaction (a
 * failure rolls the whole grid back) and writes an audit event per item; the
 * markdown planner surfaces never-sold stock as dead; and an accepted
 * markdown posts Debit write-down expense / Credit inventory and changes the
 * shelf price the sell screen reads.
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
let merch: typeof import("../src/lib/merchandising-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", locationId: "" };
const acct = { inventory: "", writeDownExpense: "" };

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
  databaseName = `pos_merch_${randomUUID().replaceAll("-", "")}`;
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
  merch = await import("../src/lib/merchandising-service");
  provisioning = await import("../src/lib/business-provisioning");

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
  // A matrix quantity edit is a stock count since GH #1567 F2.
  await db.query("DELETE FROM item_stock_count_lines");
  await db.query("DELETE FROM item_stock_counts");
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM item_variant_attributes");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Cosmetics Co', $1, 'cosmetics') RETURNING id",
    [`merch-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  // Seeded from the real cosmetics template, not hand-inserted. Hand-inserting
  // 5170 here is what hid the fact that the template didn't contain it — a
  // markdown posted fine in CI and failed with `ledger_account_missing` in an
  // actual cosmetics shop.
  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, biz.id, "cosmetics");
  } finally {
    client.release();
  }
  const accounts = await db.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts WHERE business_id = $1 AND code IN ('1350', '5170')`,
    [biz.id],
  );
  expect(accounts.rows).toHaveLength(2);
  for (const row of accounts.rows) {
    if (row.code === "1350") acct.inventory = row.id;
    if (row.code === "5170") acct.writeDownExpense = row.id;
  }
});

async function makeVariant(name: string) {
  const parent = await itemsService.createItem({
    locationId: biz.locationId,
    name: "رژ لب",
    kind: "variant_parent",
    tracking: "none",
  });
  const child = await itemsService.createVariantChild(parent.id, biz.locationId, name, null, [
    { name: "رنگ", value: name },
  ]);
  await accessories.receiveStock(child.id, { quantity: "5", unitCost: 20_000 });
  await accessories.setUnitPrice(child.id, 100_000);
  return child;
}

describe("matrix bulk editor", () => {
  it("updates price and stock across the grid in one transaction, and rolls back on a failure", async () => {
    const a = await makeVariant("قرمز");
    const b = await makeVariant("صورتی");

    await merch.withMerchandisingTransaction((client) =>
      merch.bulkUpdateVariantMatrix(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        updates: [
          { itemId: a.id, unitPrice: 90_000, quantity: 4 },
          { itemId: b.id, unitPrice: 80_000, quantity: 3 },
        ],
      }),
    );

    const after = await db.query<{ item_id: string; quantity: string; unit_price: string }>(
      "SELECT item_id, quantity::text, unit_price::text FROM item_stock WHERE item_id = ANY($1::uuid[]) ORDER BY unit_price",
      [[a.id, b.id]],
    );
    expect(Number(after.rows[0].quantity)).toBe(3);
    expect(Number(after.rows[1].quantity)).toBe(4);
    // GH #1567 F2 — the new on-hand figures are a posted count, not a silent
    // overwrite: 5→4 and 5→3 at 20,000 relieve 60,000 from inventory (1350).
    const inventory = await db.query<{ net: string }>(
      `SELECT (coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0))::text AS net
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2`,
      [biz.id, acct.inventory],
    );
    expect(inventory.rows[0].net).toBe("-60000");

    // A failure on the second cell rolls back the first.
    await expect(
      merch.withMerchandisingTransaction((client) =>
        merch.bulkUpdateVariantMatrix(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          updates: [
            { itemId: a.id, unitPrice: 70_000 },
            { itemId: randomUUID(), unitPrice: 50_000 },
          ],
        }),
      ),
    ).rejects.toThrow(/یافت نشد/);

    const rolledBack = await db.query<{ unit_price: string }>(
      "SELECT unit_price::text FROM item_stock WHERE item_id = $1",
      [a.id],
    );
    expect(rolledBack.rows[0].unit_price).toBe("90000");
  });
});

describe("markdown planner", () => {
  it("classifies never-sold stock as dead, and an accepted markdown posts a write-down and changes the price", async () => {
    const variant = await makeVariant("قرمز");

    const candidates = await merch.listMarkdownCandidates(biz.id, biz.locationId, "2026-08-16");
    expect(candidates.map((c) => c.itemId)).toContain(variant.id);
    expect(candidates.find((c) => c.itemId === variant.id)?.velocity).toBe("dead");

    const result = await merch.withMerchandisingTransaction((client) =>
      merch.applyMarkdown(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: variant.id,
        newPrice: 80_000,
        inventoryAccountCode: "1350",
      }),
    );
    // old 100,000 → new 80,000, quantity 5 → 100,000 write-down
    expect(result.writeDownRial).toBe(100_000);

    const price = await db.query<{ unit_price: string }>(
      "SELECT unit_price::text FROM item_stock WHERE item_id = $1",
      [variant.id],
    );
    expect(price.rows[0].unit_price).toBe("80000");

    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [result.entryId],
    );
    expect(lines).toEqual([
      { account_id: acct.writeDownExpense, debit: "100000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "100000" },
    ]);
  });

  it("refuses a markdown that is not a price reduction", async () => {
    const variant = await makeVariant("قرمز");
    await expect(
      merch.withMerchandisingTransaction((client) =>
        merch.applyMarkdown(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          itemId: variant.id,
          newPrice: 120_000,
          inventoryAccountCode: "1350",
        }),
      ),
    ).rejects.toThrow(/کمتر/);
  });

  it("sorts cosmetics expiring within 90 days ahead of merely dead stock", async () => {
    const slow = await makeVariant("قرمز");
    const expiring = await makeVariant("صورتی");
    await db.query(
      `INSERT INTO item_batches (item_id, batch_number, expiry_date, quantity, unit_cost, received_date)
       VALUES ($1, 'B1', '2026-10-15', 5, 20000, CURRENT_DATE)`,
      [expiring.id],
    );

    const candidates = await merch.listMarkdownCandidates(biz.id, biz.locationId, "2026-08-16");
    const expiringIdx = candidates.findIndex((c) => c.itemId === expiring.id);
    const slowIdx = candidates.findIndex((c) => c.itemId === slow.id);
    expect(expiringIdx).toBeGreaterThanOrEqual(0);
    expect(slowIdx).toBeGreaterThanOrEqual(0);
    expect(expiringIdx).toBeLessThan(slowIdx);
  });
});
