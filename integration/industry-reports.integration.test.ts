/**
 * Phase 21 Wave 7: the specialized reports and audit controls — weight
 * reconciliation (jewelry), consignor statements and payouts, warranty and
 * repair reporting (watch), variant-level sales analysis (accessories),
 * and the item-level audit trail all three share.
 *
 * Each report is asserted against records the earlier waves' own code
 * wrote, not against hand-inserted rows, so a report that drifts from what
 * the services actually store fails here.
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
let goldPrices: typeof import("../src/lib/gold-prices-service");
let goldSales: typeof import("../src/lib/gold-sales-service");
let consignment: typeof import("../src/lib/consignment-service");
let watchSales: typeof import("../src/lib/watch-sales-service");
let repairs: typeof import("../src/lib/repairs-service");
let accessories: typeof import("../src/lib/accessories-service");
let reports: typeof import("../src/lib/industry-reports-service");
let itemAudit: typeof import("../src/lib/item-audit-service");

const biz = { id: "", locationId: "" };
const acct: Record<string, string> = {};

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
  databaseName = `pos_industry_reports_${randomUUID().replaceAll("-", "")}`;

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
  goldPrices = await import("../src/lib/gold-prices-service");
  goldSales = await import("../src/lib/gold-sales-service");
  consignment = await import("../src/lib/consignment-service");
  watchSales = await import("../src/lib/watch-sales-service");
  repairs = await import("../src/lib/repairs-service");
  accessories = await import("../src/lib/accessories-service");
  reports = await import("../src/lib/industry-reports-service");
  itemAudit = await import("../src/lib/item-audit-service");

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
  for (const table of [
    "weight_counts",
    "repair_ticket_parts",
    "repair_tickets",
    "repair_ticket_counters",
    "serial_warranties",
    "item_stock",
    "item_variant_attributes",
    "item_consignments",
    "consignors",
    "item_stones",
    "item_weight_attributes",
    "item_serials",
    "domain_events",
    "journal_lines",
    "journal_entries",
    "items",
    "gold_prices",
    "accounts",
    "businesses",
  ]) {
    await db.query(`DELETE FROM ${table}`);
  }

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Multi Co', $1, 'jewelry') RETURNING id",
    [`reports-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  // One chart covering all three industries' accounts — this test exercises
  // every wave's postings against one business, which no real tenant does
  // (one industry per business), but keeps the fixture to a single setup.
  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '1120', 'Bank Clearing', 'asset'),
            ($1, '2110', 'Consignment Payable', 'liability'),
            ($1, '2200', 'VAT Payable', 'liability'),
            ($1, '4500', 'Gold Sales Revenue', 'revenue'),
            ($1, '4600', 'Making Charge Revenue', 'revenue'),
            ($1, '4700', 'Consignment Commission', 'revenue'),
            ($1, '1320', 'Gold Inventory', 'asset'),
            ($1, '5110', 'Gold COGS', 'expense'),
            ($1, '1330', 'Watch Inventory', 'asset'),
            ($1, '4550', 'Watch Sales Revenue', 'revenue'),
            ($1, '5120', 'Watch COGS', 'expense'),
            ($1, '4800', 'Repair Revenue', 'revenue'),
            ($1, '5130', 'Repair Parts Expense', 'expense'),
            ($1, '1340', 'Accessory Inventory', 'asset'),
            ($1, '4560', 'Accessory Sales Revenue', 'revenue'),
            ($1, '5140', 'Accessory COGS', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) acct[row.code] = row.id;
});

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

async function makeGoldPiece(netWeight: string, unitCostPerGram: string | null = "4000000") {
  const item = await itemsService.createItem({
    locationId: biz.locationId,
    name: `قطعه ${netWeight}`,
    tracking: "weight",
  });
  await itemsService.setWeightAttributes(item.id, {
    purity: "18",
    grossWeight: netWeight,
    netWeight,
    unitCostPerGram,
  });
  return item;
}

describe("weight reconciliation", () => {
  it("sums the net weight of unsold pieces per purity and excludes sold ones", async () => {
    await makeGoldPiece("2.5");
    await makeGoldPiece("1.25");
    const sold = await makeGoldPiece("10");
    await goldPrices.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
    await withTransaction((client) =>
      goldSales.sellWeightedItem(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: sold.id,
        makingCharge: { type: "percent", value: 7 },
        profitPercent: 10,
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    const onHand = await reports.weightOnHand(biz.locationId);
    expect(onHand).toEqual([{ purity: "18", netWeight: "3.750000000", pieces: 2 }]);
  });

  it("records a count against what the books believed at that moment, and reports the variance", async () => {
    await makeGoldPiece("2.5");
    await makeGoldPiece("1.25");

    const count = await reports.recordWeightCount({
      locationId: biz.locationId,
      purity: "18",
      countedWeight: "3.7",
      countDate: "2026-08-12",
    });
    expect(count.systemWeight).toBe("3.750000000");
    expect(count.variance).toBe("-0.05");
    expect(count.countDate).toBe("2026-08-12");

    // A later intake must not retroactively change what the count recorded.
    await makeGoldPiece("5");
    const [stored] = await reports.listWeightCounts(biz.locationId);
    expect(stored.systemWeight).toBe("3.750000000");

    const board = await reports.weightReconciliation(biz.locationId);
    expect(board).toEqual([
      expect.objectContaining({ purity: "18", systemWeight: "8.750000000", pieces: 3 }),
    ]);
    expect(board[0].lastCount?.id).toBe(count.id);
  });

  it("rejects an invalid purity", async () => {
    await expect(
      reports.recordWeightCount({ locationId: biz.locationId, purity: "14", countedWeight: "1" }),
    ).rejects.toThrow(/عیار/);
  });
});

describe("consignor statement and payout", () => {
  async function consignedSale() {
    const consignor = await consignment.createConsignor(biz.id, { name: "آقای امانی" });
    const item = await makeGoldPiece("2.5", null);
    await consignment.markAsConsigned(item.id, consignor.id);
    await goldPrices.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
    const result = await withTransaction((client) =>
      goldSales.sellWeightedItem(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: item.id,
        makingCharge: { type: "percent", value: 7 },
        profitPercent: 10,
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );
    return { consignor, item, result };
  }

  it("credits metal value + making charge to the consignor and keeps profit as the shop's commission", async () => {
    const { consignor } = await consignedSale();

    const statement = await consignment.getConsignorStatement(biz.id, consignor.id);
    // metal 12,500,000 + making 875,000 = 13,375,000 owed; profit 1,337,500 is the shop's
    expect(statement?.sales).toHaveLength(1);
    expect(statement?.sales[0]).toMatchObject({
      metalValue: 12_500_000,
      makingCharge: 875_000,
      commission: 1_337_500,
      owed: 13_375_000,
    });
    expect(statement?.totalOwed).toBe(13_375_000);
    expect(statement?.balance).toBe(13_375_000);
    expect(statement?.sales[0].entryId).not.toBeNull();
  });

  it("lists unsold consigned pieces as still on hand", async () => {
    const consignor = await consignment.createConsignor(biz.id, { name: "خانم امانی" });
    const item = await makeGoldPiece("3", null);
    await consignment.markAsConsigned(item.id, consignor.id);

    const statement = await consignment.getConsignorStatement(biz.id, consignor.id);
    expect(statement?.itemsOnHand).toEqual([
      { itemId: item.id, name: "قطعه 3", purity: "18", netWeight: "3.000000000" },
    ]);
    expect(statement?.totalOwed).toBe(0);
  });

  it("posts a payout against the payable and reduces the balance", async () => {
    const { consignor } = await consignedSale();

    const payout = await withTransaction((client) =>
      consignment.payConsignor(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        consignorId: consignor.id,
        amount: 10_000_000,
        paymentMethod: "cash",
      }),
    );

    const { rows } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [payout.entryId],
    );
    expect(rows).toEqual([
      { account_id: acct["2110"], debit: "10000000", credit: "0" },
      { account_id: acct["1100"], debit: "0", credit: "10000000" },
    ]);

    const statement = await consignment.getConsignorStatement(biz.id, consignor.id);
    expect(statement?.totalPaid).toBe(10_000_000);
    expect(statement?.balance).toBe(3_375_000);
  });

  it("pays out the same consignor twice, in two separate transactions, without a duplicate-key crash", async () => {
    // Regression test: payConsignor used to post its entry with a fixed
    // `sourceId: input.consignorId`. journal_entries has a unique index on
    // (business_id, source_type, source_id, posting_kind), so only the
    // *first* payout to any consignor could ever post — every later partial
    // payout to the same consignor (this function's own doc comment says
    // "part or all" of the balance) threw a raw duplicate-key violation.
    const { consignor } = await consignedSale();

    const first = await withTransaction((client) =>
      consignment.payConsignor(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        consignorId: consignor.id,
        amount: 5_000_000,
        paymentMethod: "cash",
      }),
    );
    expect(first.entryId).not.toBeNull();

    const second = await withTransaction((client) =>
      consignment.payConsignor(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        consignorId: consignor.id,
        amount: 3_000_000,
        paymentMethod: "cash",
      }),
    );
    expect(second.entryId).not.toBeNull();
    expect(second.entryId).not.toBe(first.entryId);

    const statement = await consignment.getConsignorStatement(biz.id, consignor.id);
    expect(statement?.totalPaid).toBe(8_000_000);
    expect(statement?.balance).toBe(5_375_000);
  });

  it("refuses to pay out more than the outstanding balance", async () => {
    const { consignor } = await consignedSale();
    await expect(
      withTransaction((client) =>
        consignment.payConsignor(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          consignorId: consignor.id,
          amount: 20_000_000,
          paymentMethod: "cash",
        }),
      ),
    ).rejects.toThrow(/بیشتر است/);

    const statement = await consignment.getConsignorStatement(biz.id, consignor.id);
    expect(statement?.totalPaid).toBe(0);
  });
});

describe("warranty and repair reports", () => {
  async function soldWatch(warrantyMonths: number, saleDate: string) {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ساعت",
      tracking: "serial",
    });
    const serial = await itemsService.addSerial(item.id, `SN-${randomUUID().slice(0, 8)}`, {
      unitCost: 30_000_000,
      warrantyMonths,
    });
    await withTransaction((client) =>
      watchSales.sellSerializedUnit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: serial.id,
        price: 50_000_000,
        vatPercent: 9,
        paymentMethod: "cash",
        saleDate,
      }),
    );
    return serial;
  }

  it("classifies each warranty window as of a given date", async () => {
    await soldWatch(24, "2026-01-01"); // ends 2028-01-01 — active
    await soldWatch(12, "2026-08-01"); // ends 2027-08-01 — expiring at 2027-07-20
    await soldWatch(6, "2025-01-01"); // ends 2025-07-01 — expired

    const report = await reports.warrantyReport(biz.locationId, { asOfDate: "2027-07-20" });
    expect(report.counts).toEqual({ active: 1, expiring: 1, expired: 1, none: 0 });
    expect(report.rows).toHaveLength(3);
  });

  it("totals repair revenue and parts cost over closed tickets only", async () => {
    const billed = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت مشتری",
      laborCharge: 2_000_000,
      vatPercent: 9,
    });
    await repairs.addRepairPart(billed.id, {
      description: "باتری",
      quantity: "1",
      unitCost: 300_000,
      charge: 800_000,
    });
    await withTransaction((client) =>
      repairs.closeRepairTicket(client, {
        businessId: biz.id,
        ticketId: billed.id,
        paymentMethod: "cash",
      }),
    );

    // An open ticket's agreed charges are an intention, not revenue.
    const open = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت دیگر",
      laborCharge: 5_000_000,
    });
    await repairs.addRepairPart(open.id, {
      description: "بند",
      quantity: "1",
      unitCost: 100_000,
      charge: 400_000,
    });

    const report = await reports.repairReport(biz.locationId);
    expect(report.byStatus).toEqual({ closed: 1, received: 1 });
    expect(report.totals).toEqual({ revenue: 2_800_000, partsCost: 300_000, margin: 2_500_000 });
  });

  it("shows a warranty repair as a negative margin rather than hiding it", async () => {
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت گارانتی",
      laborCharge: 0,
    });
    await repairs.addRepairPart(ticket.id, {
      description: "موتور",
      quantity: "1",
      unitCost: 1_500_000,
      charge: 0,
    });
    await withTransaction((client) =>
      repairs.closeRepairTicket(client, {
        businessId: biz.id,
        ticketId: ticket.id,
        paymentMethod: "cash",
      }),
    );

    const report = await reports.repairReport(biz.locationId);
    expect(report.totals).toEqual({ revenue: 0, partsCost: 1_500_000, margin: -1_500_000 });
  });
});

describe("variant sales analysis", () => {
  it("ranks variants by what they actually sold, with margin", async () => {
    const parent = await itemsService.createItem({
      locationId: biz.locationId,
      name: "دستبند",
      kind: "variant_parent",
    });
    const gold = await itemsService.createVariantChild(parent.id, biz.locationId, "دستبند طلایی", null, [
      { name: "رنگ", value: "طلایی" },
    ]);
    const silver = await itemsService.createVariantChild(parent.id, biz.locationId, "دستبند نقره‌ای", null, [
      { name: "رنگ", value: "نقره‌ای" },
    ]);

    for (const item of [gold, silver]) {
      await accessories.setUnitPrice(item.id, 250_000);
      await accessories.receiveStock(item.id, { quantity: "10", unitCost: 60_000 });
    }

    await withTransaction((client) =>
      accessories.sellAccessoryUnits(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: gold.id,
        quantity: "4",
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );
    await withTransaction((client) =>
      accessories.sellAccessoryUnits(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: silver.id,
        quantity: "1",
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    const rows = await reports.variantSalesAnalysis(biz.id, biz.locationId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      itemId: gold.id,
      parentName: "دستبند",
      quantitySold: "4",
      netRevenue: 1_000_000,
      cogs: 240_000,
      margin: 760_000,
    });
    expect(rows[0].attributes).toEqual([{ name: "رنگ", value: "طلایی" }]);
    expect(rows[1]).toMatchObject({ itemId: silver.id, netRevenue: 250_000 });
  });
});

describe("item audit trail", () => {
  it("interleaves recorded-only lifecycle events with the postings a sale produced", async () => {
    const item = await makeGoldPiece("2.5");
    await itemAudit.recordItemEvent({
      businessId: biz.id,
      locationId: biz.locationId,
      itemId: item.id,
      eventType: "item.created",
      payload: { name: "قطعه 2.5" },
    });
    await itemAudit.recordItemEvent({
      businessId: biz.id,
      locationId: biz.locationId,
      itemId: item.id,
      eventType: "item.cost_basis_changed",
      payload: { to: { unitCostPerGram: "4000000" } },
    });

    await goldPrices.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
    await withTransaction((client) =>
      goldSales.sellWeightedItem(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: item.id,
        makingCharge: { type: "percent", value: 7 },
        profitPercent: 10,
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    const trail = await reports.itemAuditTrail(biz.id, item.id);
    expect(trail.map((e) => e.eventType)).toEqual([
      "item.created",
      "item.cost_basis_changed",
      "gold.sale_revenue",
      "gold.sale_cogs",
    ]);
    // Lifecycle events record without posting; the sale's events carry entries.
    expect(trail[0].entryId).toBeNull();
    expect(trail[1].entryId).toBeNull();
    expect(trail[2].entryId).not.toBeNull();
    expect(trail[2].memo).toBe("فروش طلا");
    expect(trail[3].entryId).not.toBeNull();
  });

  it("follows a watch unit through its serial id as well as its item id", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ساعت",
      tracking: "serial",
    });
    const serial = await itemsService.addSerial(item.id, "SN-AUDIT", { unitCost: 30_000_000 });
    await withTransaction((client) =>
      watchSales.sellSerializedUnit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: serial.id,
        price: 50_000_000,
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    const byItem = await reports.itemAuditTrail(biz.id, item.id);
    expect(byItem.map((e) => e.eventType)).toEqual(["watch.sale_revenue", "watch.sale_cogs"]);

    const bySerial = await reports.itemAuditTrail(biz.id, serial.id);
    expect(bySerial.map((e) => e.eventType)).toEqual(["watch.sale_revenue", "watch.sale_cogs"]);
  });

  it("never returns another business's events", async () => {
    const item = await makeGoldPiece("2.5");
    await itemAudit.recordItemEvent({
      businessId: biz.id,
      locationId: biz.locationId,
      itemId: item.id,
      eventType: "item.created",
    });

    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    expect(await reports.itemAuditTrail(other.rows[0].id, item.id)).toEqual([]);
  });
});
