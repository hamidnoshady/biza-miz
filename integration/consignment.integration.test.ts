/**
 * Phase 21 Wave 4: consignment (امانی). Proves a consigned item's sale is
 * genuinely off the business's own balance sheet -- no COGS entry at all
 * (the shop never owned the piece), and the sale proceeds split into
 * "owed to the consignor" (metal value + making charge) vs. "the shop's
 * own commission revenue" (profit) instead of the owned-inventory
 * goldSalesRevenue/makingChargeRevenue accounts -- and that a consigned
 * item needs no cost basis to sell, unlike an owned one.
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
let goldPricesService: typeof import("../src/lib/gold-prices-service");
let goldSalesService: typeof import("../src/lib/gold-sales-service");
let consignmentService: typeof import("../src/lib/consignment-service");

const biz = { id: "", locationId: "" };
const acct = {
  cash: "",
  goldSalesRevenue: "",
  makingChargeRevenue: "",
  vatPayable: "",
  goldCogs: "",
  goldInventory: "",
  consignmentPayable: "",
  consignmentCommissionRevenue: "",
};

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
  databaseName = `pos_consignment_${randomUUID().replaceAll("-", "")}`;

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
  goldPricesService = await import("../src/lib/gold-prices-service");
  goldSalesService = await import("../src/lib/gold-sales-service");
  consignmentService = await import("../src/lib/consignment-service");

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
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM item_consignments");
  await db.query("DELETE FROM item_weight_attributes");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM consignors");
  await db.query("DELETE FROM gold_prices");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Gold Co', $1, 'jewelry') RETURNING id",
    [`consignment-${randomUUID().slice(0, 8)}`],
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
            ($1, '4500', 'Gold Sales Revenue', 'revenue'),
            ($1, '4600', 'Making Charge Revenue', 'revenue'),
            ($1, '2200', 'VAT Payable', 'liability'),
            ($1, '5110', 'Gold COGS', 'expense'),
            ($1, '1320', 'Gold Inventory', 'asset'),
            ($1, '2110', 'Consignment Payable', 'liability'),
            ($1, '4700', 'Consignment Commission Revenue', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "4500") acct.goldSalesRevenue = row.id;
    if (row.code === "4600") acct.makingChargeRevenue = row.id;
    if (row.code === "2200") acct.vatPayable = row.id;
    if (row.code === "5110") acct.goldCogs = row.id;
    if (row.code === "1320") acct.goldInventory = row.id;
    if (row.code === "2110") acct.consignmentPayable = row.id;
    if (row.code === "4700") acct.consignmentCommissionRevenue = row.id;
  }
});

describe("consignors", () => {
  it("creates and lists consignors", async () => {
    await consignmentService.createConsignor(biz.id, { name: "آقای رضایی", phone: "0912xxxxxxx" });
    const list = await consignmentService.listConsignors(biz.id);
    expect(list.map((c) => c.name)).toEqual(["آقای رضایی"]);
  });

  it("rejects a blank name", async () => {
    await expect(consignmentService.createConsignor(biz.id, { name: "  " })).rejects.toThrow();
  });
});

describe("markAsConsigned", () => {
  it("marks a weight-tracked item as consigned", async () => {
    const consignor = await consignmentService.createConsignor(biz.id, { name: "آقای رضایی" });
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "دستبند امانی",
      tracking: "weight",
    });
    await consignmentService.markAsConsigned(item.id, consignor.id);

    const consignment = await consignmentService.getConsignment(item.id);
    expect(consignment?.consignorId).toBe(consignor.id);
  });

  it("refuses a non-weight-tracked item", async () => {
    const consignor = await consignmentService.createConsignor(biz.id, { name: "آقای رضایی" });
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "زنجیر" });
    await expect(consignmentService.markAsConsigned(item.id, consignor.id)).rejects.toThrow();
  });
});

async function makeConsignedBracelet(consignorId: string) {
  const item = await itemsService.createItem({
    locationId: biz.locationId,
    name: "دستبند امانی",
    tracking: "weight",
  });
  // No unitCostPerGram -- a consigned item needs none.
  await itemsService.setWeightAttributes(item.id, { purity: "18", grossWeight: "2.5", netWeight: "2.5" });
  await consignmentService.markAsConsigned(item.id, consignorId);
  return item;
}

describe("sellWeightedItem: consigned pieces", () => {
  it("sells with no cost basis set, posts to consignor-payable + commission revenue, and skips COGS entirely", async () => {
    const consignor = await consignmentService.createConsignor(biz.id, { name: "آقای رضایی" });
    const bracelet = await makeConsignedBracelet(consignor.id);
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });

    const client = await dbLib.getPool().connect();
    let result: Awaited<ReturnType<typeof goldSalesService.sellWeightedItem>>;
    try {
      await client.query("BEGIN");
      result = await goldSalesService.sellWeightedItem(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: bracelet.id,
        makingCharge: { type: "percent", value: 7 },
        profitPercent: 10,
        vatPercent: 9,
        paymentMethod: "cash",
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect(result.consigned).toBe(true);
    expect(result.cogsEntryId).toBeNull();
    // Same breakdown math as an owned sale: total = 14,911,625
    expect(result.breakdown.total).toBe("14911625");

    const revenueLines = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [result.revenueEntryId],
    );
    // consignorPortion = metalValue (12,500,000) + makingCharge (875,000) = 13,375,000
    // commission = profit = 1,337,500
    expect(revenueLines.rows).toEqual([
      { account_id: acct.cash, debit: "14911625", credit: "0" },
      { account_id: acct.consignmentPayable, debit: "0", credit: "13375000" },
      { account_id: acct.consignmentCommissionRevenue, debit: "0", credit: "1337500" },
      { account_id: acct.vatPayable, debit: "0", credit: "199125" },
    ]);

    // Never touches the owned-inventory accounts at all.
    const ownedAccountLines = await db.query(
      `SELECT 1 FROM journal_lines
        WHERE entry_id = $1 AND account_id = ANY($2::uuid[])`,
      [result.revenueEntryId, [acct.goldSalesRevenue, acct.makingChargeRevenue, acct.goldInventory, acct.goldCogs]],
    );
    expect(ownedAccountLines.rows).toHaveLength(0);

    const weightAttrs = await itemsService.getWeightAttributes(bracelet.id);
    expect(weightAttrs?.status).toBe("sold");

    const events = await db.query<{ event_type: string }>(
      "SELECT event_type FROM domain_events WHERE business_id = $1",
      [biz.id],
    );
    // Exactly one event -- no gold.sale_cogs at all for a consignment sale.
    expect(events.rows.map((r) => r.event_type)).toEqual(["gold.consignment_sale_revenue"]);
    // #810: the batch reporting path must equal the original detail statement,
    // including payouts and held stock, without a read per consignor.
    await makeConsignedBracelet(consignor.id);
    await db.query(`INSERT INTO domain_events (business_id, location_id, event_type, source_type, source_id, payload)
      VALUES ($1, $2, 'consignment.payout', 'test', $3, $4)`,
      [biz.id, biz.locationId, randomUUID(), JSON.stringify({ consignorId: consignor.id, amount: 500000 })]);
    const statement = (await consignmentService.getConsignorStatement(biz.id, consignor.id))!;
    const summary = (await consignmentService.getConsignorSummaries(biz.id)).find((row) => row.consignorId === consignor.id)!;
    expect(summary).toEqual({ consignorId: consignor.id, name: statement.consignor.name,
      itemsOnHand: statement.itemsOnHand.length, totalOwed: statement.totalOwed,
      totalPaid: statement.totalPaid, balance: statement.balance });
  });

  it("refuses to sell an unconsigned item with no cost basis (the ordinary Wave 3 rule still applies)", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "دستبند",
      tracking: "weight",
    });
    await itemsService.setWeightAttributes(item.id, { purity: "18", grossWeight: "1", netWeight: "1" });
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });

    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await expect(
        goldSalesService.sellWeightedItem(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          itemId: item.id,
          makingCharge: { type: "percent", value: 7 },
          profitPercent: 10,
          vatPercent: 9,
          paymentMethod: "cash",
        }),
      ).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});
