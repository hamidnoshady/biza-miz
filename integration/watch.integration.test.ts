/**
 * Phase 21 Wave 5 exit criterion: "A watch's serial number, warranty
 * window, and repair history are all queryable from one item record, and a
 * repair ticket's parts/labor post correctly to the ledger."
 *
 * Covers the whole watch flow end to end: registering a serialized unit
 * with its cost basis, selling it (revenue + COGS entries, warranty window
 * opening at the sale date), taking a piece in for repair, consuming parts,
 * and closing the ticket — both the billed case and the warranty case,
 * where the shop bills nothing but still eats the parts cost.
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
let watchSales: typeof import("../src/lib/watch-sales-service");
let repairs: typeof import("../src/lib/repairs-service");
let watchCrm: typeof import("../src/lib/watch-crm-service");

const biz = { id: "", locationId: "" };
const acct = {
  cash: "",
  watchSalesRevenue: "",
  vatPayable: "",
  watchCogs: "",
  watchInventory: "",
  repairServiceRevenue: "",
  repairPartsExpense: "",
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
  databaseName = `pos_watch_${randomUUID().replaceAll("-", "")}`;

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
  watchSales = await import("../src/lib/watch-sales-service");
  repairs = await import("../src/lib/repairs-service");
  watchCrm = await import("../src/lib/watch-crm-service");

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
  await db.query("DELETE FROM repair_ticket_parts");
  await db.query("DELETE FROM repair_tickets");
  await db.query("DELETE FROM repair_ticket_counters");
  await db.query("DELETE FROM serial_warranties");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM item_serials");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Watch Co', $1, 'watch') RETURNING id",
    [`watch-${randomUUID().slice(0, 8)}`],
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
            ($1, '4550', 'Watch Sales Revenue', 'revenue'),
            ($1, '2200', 'VAT Payable', 'liability'),
            ($1, '5120', 'Watch COGS', 'expense'),
            ($1, '1330', 'Watch Inventory', 'asset'),
            ($1, '4800', 'Repair Revenue', 'revenue'),
            ($1, '5130', 'Repair Parts Expense', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  const byCode: Record<string, keyof typeof acct> = {
    "1100": "cash",
    "4550": "watchSalesRevenue",
    "2200": "vatPayable",
    "5120": "watchCogs",
    "1330": "watchInventory",
    "4800": "repairServiceRevenue",
    "5130": "repairPartsExpense",
  };
  for (const row of accounts.rows) acct[byCode[row.code]] = row.id;
});

async function makeWatchUnit(options: { unitCost?: number | null; warrantyMonths?: number } = {}) {
  const item = await itemsService.createItem({
    locationId: biz.locationId,
    name: "ساعت مچی کلاسیک",
    tracking: "serial",
  });
  const serial = await itemsService.addSerial(item.id, `SN-${randomUUID().slice(0, 8)}`, {
    unitCost: options.unitCost === undefined ? 30_000_000 : options.unitCost,
    warrantyMonths: options.warrantyMonths ?? 24,
  });
  return { item, serial };
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

describe("sellSerializedUnit", () => {
  it("posts a balanced revenue entry and COGS entry, marks the unit sold, and opens its warranty window", async () => {
    const { serial } = await makeWatchUnit({ unitCost: 30_000_000, warrantyMonths: 24 });

    const result = await withTransaction((client) =>
      watchSales.sellSerializedUnit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: serial.id,
        price: 50_000_000,
        vatPercent: 9,
        paymentMethod: "cash",
        saleDate: "2026-08-12",
      }),
    );

    expect(result.breakdown.total).toBe("54500000"); // 50,000,000 + 9% VAT
    expect(await linesOf(result.revenueEntryId)).toEqual([
      { account_id: acct.cash, debit: "54500000", credit: "0" },
      { account_id: acct.watchSalesRevenue, debit: "0", credit: "50000000" },
      { account_id: acct.vatPayable, debit: "0", credit: "4500000" },
    ]);
    expect(await linesOf(result.cogsEntryId)).toEqual([
      { account_id: acct.watchCogs, debit: "30000000", credit: "0" },
      { account_id: acct.watchInventory, debit: "0", credit: "30000000" },
    ]);

    expect(result.warranty).toEqual({
      serialId: serial.id,
      months: 24,
      startDate: "2026-08-12",
      endDate: "2028-08-12",
    });

    const stored = await itemsService.getSerial(serial.id);
    expect(stored?.status).toBe("sold");
    expect(stored?.soldAt).toBe("2026-08-12");
  });

  it("applies a discount before VAT", async () => {
    const { serial } = await makeWatchUnit();

    const result = await withTransaction((client) =>
      watchSales.sellSerializedUnit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: serial.id,
        price: 50_000_000,
        discount: 5_000_000,
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    expect(result.breakdown.net).toBe("45000000");
    expect(result.breakdown.total).toBe("49050000");
  });

  it("records no warranty window when the unit is sold with a zero-month term", async () => {
    const { serial } = await makeWatchUnit({ warrantyMonths: 0 });

    const result = await withTransaction((client) =>
      watchSales.sellSerializedUnit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: serial.id,
        price: 10_000_000,
        vatPercent: 0,
        paymentMethod: "cash",
      }),
    );

    expect(result.warranty).toBeNull();
    expect(await watchSales.getSerialWarranty(serial.id)).toBeNull();
  });

  it("refuses to sell the same unit twice, or a unit with no cost basis", async () => {
    const { serial } = await makeWatchUnit();
    await withTransaction((client) =>
      watchSales.sellSerializedUnit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: serial.id,
        price: 10_000_000,
        vatPercent: 9,
        paymentMethod: "cash",
      }),
    );

    await expect(
      withTransaction((client) =>
        watchSales.sellSerializedUnit(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          serialId: serial.id,
          price: 10_000_000,
          vatPercent: 9,
          paymentMethod: "cash",
        }),
      ),
    ).rejects.toThrow(/موجود نیست/);

    const { serial: costless } = await makeWatchUnit({ unitCost: null });
    await expect(
      withTransaction((client) =>
        watchSales.sellSerializedUnit(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          serialId: costless.id,
          price: 10_000_000,
          vatPercent: 9,
          paymentMethod: "cash",
        }),
      ),
    ).rejects.toThrow(/بهای تمام‌شده/);
  });

  it("lists a unit with its model, cost basis and live warranty window in one query", async () => {
    const { item, serial } = await makeWatchUnit({ unitCost: 30_000_000, warrantyMonths: 12 });
    await withTransaction((client) =>
      watchSales.sellSerializedUnit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: serial.id,
        price: 40_000_000,
        vatPercent: 9,
        paymentMethod: "cash",
        saleDate: "2026-08-12",
      }),
    );

    const units = await watchSales.listSerialUnits(biz.locationId);
    expect(units).toEqual([
      {
        id: serial.id,
        itemId: item.id,
        itemName: "ساعت مچی کلاسیک",
        serialNumber: serial.serialNumber,
        status: "sold",
        unitCost: 30_000_000,
        warrantyMonths: 12,
        soldAt: "2026-08-12",
        warrantyStart: "2026-08-12",
        warrantyEnd: "2027-08-12",
      },
    ]);
  });
});

describe("repair tickets", () => {
  it("numbers tickets per location, sequentially", async () => {
    const first = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت مشتری",
    });
    const second = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت دیگر",
    });
    expect(first.ticketNumber).toBe(1);
    expect(second.ticketNumber).toBe(2);
  });

  it("posts revenue and parts cost when a billed ticket closes", async () => {
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت مشتری",
      reportedIssue: "کار نمی‌کند",
      laborCharge: 2_000_000,
      vatPercent: 9,
    });
    await repairs.addRepairPart(ticket.id, {
      description: "باتری",
      quantity: "1",
      unitCost: 300_000,
      charge: 800_000,
    });
    await repairs.setRepairStatus(ticket.id, "in_progress");
    await repairs.setRepairStatus(ticket.id, "ready");

    const result = await withTransaction((client) =>
      repairs.closeRepairTicket(client, {
        businessId: biz.id,
        ticketId: ticket.id,
        paymentMethod: "cash",
      }),
    );

    // labor 2,000,000 + parts 800,000 = 2,800,000; VAT 9% = 252,000
    expect(result.breakdown.total).toBe("3052000");
    expect(await linesOf(result.revenueEntryId)).toEqual([
      { account_id: acct.cash, debit: "3052000", credit: "0" },
      { account_id: acct.repairServiceRevenue, debit: "0", credit: "2800000" },
      { account_id: acct.vatPayable, debit: "0", credit: "252000" },
    ]);
    expect(await linesOf(result.partsCostEntryId)).toEqual([
      { account_id: acct.repairPartsExpense, debit: "300000", credit: "0" },
      { account_id: acct.watchInventory, debit: "0", credit: "300000" },
    ]);

    const closed = await repairs.getRepairTicket(ticket.id);
    expect(closed?.status).toBe("closed");
    expect(closed?.closedAt).not.toBeNull();
  });

  it("bills nothing on a warranty repair but still posts the parts the shop consumed", async () => {
    const { serial } = await makeWatchUnit({ warrantyMonths: 24 });
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

    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت فروخته‌شده",
      serialId: serial.id,
      laborCharge: 0,
      vatPercent: 9,
    });
    expect(ticket.underWarranty).toBe(true);

    await repairs.addRepairPart(ticket.id, {
      description: "موتور",
      quantity: "1",
      unitCost: 1_500_000,
      charge: 0,
    });

    const result = await withTransaction((client) =>
      repairs.closeRepairTicket(client, {
        businessId: biz.id,
        ticketId: ticket.id,
        paymentMethod: "cash",
      }),
    );

    expect(result.breakdown.total).toBe("0");
    expect(result.revenueEntryId).toBeNull(); // nothing billed, so nothing posted
    expect(await linesOf(result.partsCostEntryId)).toEqual([
      { account_id: acct.repairPartsExpense, debit: "1500000", credit: "0" },
      { account_id: acct.watchInventory, debit: "0", credit: "1500000" },
    ]);

    // The event is still recorded even though it posted nothing — the
    // engine's documented "not every domain event has a ledger effect" path.
    const events = await db.query<{ event_type: string; entry_id: string | null }>(
      "SELECT event_type, entry_id FROM domain_events WHERE source_id = $1 ORDER BY event_type",
      [ticket.id],
    );
    expect(events.rows).toEqual([
      { event_type: "watch.repair_cogs", entry_id: result.partsCostEntryId },
      { event_type: "watch.repair_revenue", entry_id: null },
    ]);
  });

  it("is not under warranty when the linked unit's window has expired", async () => {
    const { serial } = await makeWatchUnit({ warrantyMonths: 12 });
    await withTransaction((client) =>
      watchSales.sellSerializedUnit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: serial.id,
        price: 50_000_000,
        vatPercent: 9,
        paymentMethod: "cash",
        saleDate: "2020-01-01",
      }),
    );

    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت قدیمی",
      serialId: serial.id,
    });
    expect(ticket.underWarranty).toBe(false);
  });

  it("takes an in-stock unit off the shelf while it is in repair and puts it back when the ticket closes", async () => {
    const { serial } = await makeWatchUnit();

    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت انبار",
      serialId: serial.id,
    });
    expect((await itemsService.getSerial(serial.id))?.status).toBe("in_repair");

    await withTransaction((client) =>
      repairs.closeRepairTicket(client, {
        businessId: biz.id,
        ticketId: ticket.id,
        paymentMethod: "cash",
      }),
    );
    expect((await itemsService.getSerial(serial.id))?.status).toBe("in_stock");
  });

  it("refuses to change, add parts to, or re-close a closed ticket", async () => {
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت مشتری",
      laborCharge: 1_000_000,
    });
    await withTransaction((client) =>
      repairs.closeRepairTicket(client, {
        businessId: biz.id,
        ticketId: ticket.id,
        paymentMethod: "cash",
      }),
    );

    await expect(
      repairs.addRepairPart(ticket.id, { description: "x", quantity: "1", unitCost: 0, charge: 0 }),
    ).rejects.toThrow();
    await expect(repairs.setRepairStatus(ticket.id, "in_progress")).rejects.toThrow();
    await expect(
      withTransaction((client) =>
        repairs.closeRepairTicket(client, {
          businessId: biz.id,
          ticketId: ticket.id,
          paymentMethod: "cash",
        }),
      ),
    ).rejects.toThrow(/قبلاً بسته/);
  });

  it("returns a cancelled ticket's unit to the shelf", async () => {
    const { serial } = await makeWatchUnit();
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت انبار",
      serialId: serial.id,
    });
    await repairs.setRepairStatus(ticket.id, "cancelled");
    expect((await itemsService.getSerial(serial.id))?.status).toBe("in_stock");
  });

  it("refuses to remove a part from the wrong ticket (parent-child scoping)", async () => {
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت مشتری A",
    });
    const otherTicket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت مشتری B",
    });
    const part = await repairs.addRepairPart(ticket.id, {
      description: "باتری",
      quantity: "1",
      unitCost: 300_000,
      charge: 800_000,
    });

    // Supplying a valid part id against a different ticket must be a no-op.
    const removed = await repairs.removeRepairPart(part.id, otherTicket.id);
    expect(removed).toBe(false);
    const parts = await repairs.listRepairParts(ticket.id);
    expect(parts.map((p) => p.id)).toContain(part.id);

    // Removing through the owning ticket still works.
    const owned = await repairs.removeRepairPart(part.id, ticket.id);
    expect(owned).toBe(true);
    expect(await repairs.listRepairParts(ticket.id)).toHaveLength(0);
  });
});

/** Phase 27 Wave 10 — service reminders, pre-owned provenance, repair estimates. */
describe("Wave 10 — watch flagship", () => {
  it("lists a watch sold 23 months ago with a 24-month interval as due, and one sold last week as not", async () => {
    const due = await itemsService.createItem({
      locationId: biz.locationId,
      name: "کوارتز ۲۴ ماهه",
      tracking: "serial",
      serviceIntervalMonths: 24,
    });
    const dueSerial = await itemsService.addSerial(due.id, `SN-DUE-${randomUUID().slice(0, 6)}`, {
      unitCost: 10_000_000,
      warrantyMonths: 0,
    });
    await withTransaction((client) =>
      watchSales.sellSerializedUnit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: dueSerial.id,
        price: 20_000_000,
        vatPercent: 9,
        paymentMethod: "cash",
        // ~23 months before 2026-08-01, with a 24-month interval the unit is
        // due on 2026-08-20 — inside the 30-day lead window.
        saleDate: "2024-08-20",
      }),
    );

    const fresh = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ساعت تازه",
      tracking: "serial",
      serviceIntervalMonths: 24,
    });
    const freshSerial = await itemsService.addSerial(fresh.id, `SN-FRESH-${randomUUID().slice(0, 6)}`, {
      unitCost: 10_000_000,
      warrantyMonths: 0,
    });
    await withTransaction((client) =>
      watchSales.sellSerializedUnit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        serialId: freshSerial.id,
        price: 20_000_000,
        vatPercent: 9,
        paymentMethod: "cash",
        saleDate: "2026-07-25", // a week before 2026-08-01
      }),
    );

    const reminders = await watchCrm.serviceReminders(biz.locationId, "2026-08-01", 30);
    expect(reminders.map((r) => r.serialId)).toEqual([dueSerial.id]);
    expect(reminders[0]?.state).toBe("due");
    expect(reminders[0]?.referenceDate).toBe("2026-08-20");
  });

  it("records a pre-owned intake's condition grade and box/papers state on the serial", async () => {
    const { serial } = await makeWatchUnit();
    await watchCrm.recordPreOwnedIntake(serial.id, { conditionGrade: "good", boxAndPapers: true });

    const stored = await db.query<{ condition_grade: string; box_and_papers: boolean; pre_owned: boolean }>(
      "SELECT condition_grade, box_and_papers, pre_owned FROM item_serials WHERE id = $1",
      [serial.id],
    );
    expect(stored.rows[0]).toEqual({ condition_grade: "good", box_and_papers: true, pre_owned: true });
  });

  it("refuses to move a ticket to in_progress, or close it, before the estimate is approved", async () => {
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "دستبند",
      laborCharge: 1_000_000,
      vatPercent: 0,
    });

    await watchCrm.setRepairEstimate(ticket.id, { laborRial: 1_000_000, partsRial: 500_000 });
    await expect(repairs.setRepairStatus(ticket.id, "in_progress")).rejects.toThrow(/تأیید مشتری/);
    await expect(
      withTransaction((client) =>
        repairs.closeRepairTicket(client, {
          businessId: biz.id,
          ticketId: ticket.id,
          paymentMethod: "cash",
        }),
      ),
    ).rejects.toThrow(/تأیید مشتری/);

    const approved = await watchCrm.approveRepairEstimate(ticket.id);
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.estimatedTotalRial).toBe(1_500_000);

    await repairs.addRepairPart(ticket.id, {
      description: "بند",
      quantity: "1",
      unitCost: 300_000,
      charge: 500_000,
    });
    await repairs.setRepairStatus(ticket.id, "in_progress");
    await repairs.setRepairStatus(ticket.id, "ready");
    const result = await withTransaction((client) =>
      repairs.closeRepairTicket(client, {
        businessId: biz.id,
        ticketId: ticket.id,
        paymentMethod: "cash",
      }),
    );
    // labor 1,000,000 + parts 500,000 — the bill matches the approved estimate.
    expect(result.breakdown.total).toBe("1500000");
  });

  it("renders the printable estimate with labour and parts broken out", async () => {
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت مچی",
    });
    await watchCrm.setRepairEstimate(ticket.id, { laborRial: 900_000, partsRial: 600_000 });

    const text = await watchCrm.repairEstimateText(ticket.id, "2026-08-01");
    expect(text).toContain("اجرت");
    expect(text).toContain("قطعات");
    expect(text).toContain("برآورد کل");
    expect(text).toContain("امضای تأیید مشتری");
  });

  it("leaves a pre-estimate ticket fully usable — the estimate step is optional", async () => {
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت قدیمی",
      laborCharge: 1_000_000,
    });
    // No estimate set: the workflow behaves exactly as before Wave 10.
    await repairs.setRepairStatus(ticket.id, "in_progress");
    await repairs.setRepairStatus(ticket.id, "ready");
    const result = await withTransaction((client) =>
      repairs.closeRepairTicket(client, {
        businessId: biz.id,
        ticketId: ticket.id,
        paymentMethod: "cash",
      }),
    );
    expect(result.breakdown.total).toBe("1000000");
  });
});

/**
 * Issue #795 Phase 1 — accounting-correctness guards on the shared repair
 * workflow: server-enforced warranty billing, part sourcing (only stock
 * parts relieve inventory), industry-aware repair COGS, cross-branch serial
 * rejection, and the one-active-repair-per-serial invariant.
 */
describe("Issue #795 Phase 1 — repair lifecycle & accounting guards", () => {
  async function sellUnderWarranty() {
    const { serial } = await makeWatchUnit({ warrantyMonths: 24 });
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
    return serial;
  }

  it("refuses a labor charge at intake on a warranty job without an out-of-coverage reason, and accepts one with it", async () => {
    const serial = await sellUnderWarranty();

    await expect(
      repairs.createRepairTicket({
        locationId: biz.locationId,
        itemDescription: "ساعت در گارانتی",
        serialId: serial.id,
        laborCharge: 1_000_000,
      }),
    ).rejects.toThrow(/خارج از پوشش/);

    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت در گارانتی",
      serialId: serial.id,
      laborCharge: 1_000_000,
      nonCoveredReason: "آب‌خوردگی — خارج از پوشش، با تأیید مشتری",
    });
    expect(ticket.underWarranty).toBe(true);
    expect(ticket.nonCoveredReason).toContain("آب‌خوردگی");
  });

  it("refuses to bill a part on a warranty job, and refuses to sneak the bill in through an edit", async () => {
    const serial = await sellUnderWarranty();
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت در گارانتی",
      serialId: serial.id,
    });
    expect(ticket.underWarranty).toBe(true);

    // Part with a customer charge: refused while no reason is on file; the
    // zero-charge (covered) part is fine.
    await expect(
      repairs.addRepairPart(ticket.id, { description: "شیشه", quantity: "1", unitCost: 400_000, charge: 900_000 }),
    ).rejects.toThrow(/خارج از پوشش/);
    await repairs.addRepairPart(ticket.id, { description: "باتری", quantity: "1", unitCost: 300_000, charge: 0 });

    // Editing a labor charge onto the covered job is refused the same way.
    await expect(repairs.updateRepairTicket(ticket.id, { laborCharge: 2_000_000 })).rejects.toThrow(
      /خارج از پوشش/,
    );

    // With the explicit reason recorded, the out-of-coverage work may bill.
    await repairs.updateRepairTicket(ticket.id, { nonCoveredReason: "بند سفارشی — خارج از پوشش" });
    await repairs.addRepairPart(ticket.id, { description: "بند", quantity: "1", unitCost: 500_000, charge: 1_200_000 });

    // ...and once billed parts exist, the reason can no longer be cleared.
    await expect(repairs.updateRepairTicket(ticket.id, { nonCoveredReason: "" })).rejects.toThrow(
      /نمی‌توان حذف کرد/,
    );
  });

  it("re-checks the warranty invariant at close even if the reason was nulled behind the service's back", async () => {
    const serial = await sellUnderWarranty();
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت در گارانتی",
      serialId: serial.id,
      laborCharge: 1_000_000,
      nonCoveredReason: "کار خارج از پوشش",
    });

    // Simulate drift (a direct DB edit) that the earlier guards never saw.
    await db.query("UPDATE repair_tickets SET non_covered_reason = NULL WHERE id = $1", [ticket.id]);

    await expect(
      withTransaction((client) =>
        repairs.closeRepairTicket(client, { businessId: biz.id, ticketId: ticket.id, paymentMethod: "cash" }),
      ),
    ).rejects.toThrow(/خارج از پوشش/);
  });

  it("rejects intake for a serial that belongs to another branch", async () => {
    const otherLoc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Branch 2') RETURNING id",
      [biz.id],
    );
    const item = await itemsService.createItem({
      locationId: otherLoc.rows[0].id,
      name: "ساعت شعبه دو",
      tracking: "serial",
    });
    const serial = await itemsService.addSerial(item.id, `SN-X-${randomUUID().slice(0, 6)}`, {
      unitCost: 10_000_000,
    });

    await expect(
      repairs.createRepairTicket({
        locationId: biz.locationId,
        itemDescription: "ساعت شعبهٔ دیگر",
        serialId: serial.id,
      }),
    ).rejects.toThrow(/شعبهٔ فعال نیست/);

    // The foreign unit must be untouched — still on its own branch's shelf.
    expect((await itemsService.getSerial(serial.id))?.status).toBe("in_stock");
  });

  it("allows only one active repair per serial; a cancelled ticket frees the unit for a new intake", async () => {
    const { serial } = await makeWatchUnit();
    const first = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت انبار",
      serialId: serial.id,
    });

    await expect(
      repairs.createRepairTicket({
        locationId: biz.locationId,
        itemDescription: "پذیرش تکراری",
        serialId: serial.id,
      }),
    ).rejects.toThrow(/تیکت تعمیر باز/);

    await repairs.setRepairStatus(first.id, "cancelled");
    const second = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "پذیرش دوم",
      serialId: serial.id,
    });
    expect(second.ticketNumber).toBe(first.ticketNumber + 1);
  });

  it("relieves inventory only for stock-sourced parts — an external part's cost never credits watch inventory", async () => {
    const ticket = await repairs.createRepairTicket({
      locationId: biz.locationId,
      itemDescription: "ساعت مشتری",
      laborCharge: 1_000_000,
      vatPercent: 0,
    });
    await repairs.addRepairPart(ticket.id, {
      description: "باتری از انبار",
      quantity: "1",
      unitCost: 300_000,
      charge: 500_000,
      source: "stock",
    });
    await repairs.addRepairPart(ticket.id, {
      description: "شیشهٔ سفارشی خرید بیرونی",
      quantity: "1",
      unitCost: 2_000_000,
      charge: 2_500_000,
      source: "external",
    });

    const result = await withTransaction((client) =>
      repairs.closeRepairTicket(client, { businessId: biz.id, ticketId: ticket.id, paymentMethod: "cash" }),
    );

    // The customer is still billed for both parts…
    expect(result.breakdown.partsCharge).toBe("3000000");
    // …but only the stock part's cost leaves watch inventory.
    expect(await linesOf(result.partsCostEntryId)).toEqual([
      { account_id: acct.repairPartsExpense, debit: "300000", credit: "0" },
      { account_id: acct.watchInventory, debit: "0", credit: "300000" },
    ]);
  });

  it("credits the jewelry inventory account — not watch inventory — when a jewelry business closes a repair with parts", async () => {
    // A second, jewelry business with its own branch and chart of accounts.
    const jbiz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Gold Co', $1, 'jewelry') RETURNING id",
      [`gold-${randomUUID().slice(0, 8)}`],
    );
    const jloc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
      [jbiz.rows[0].id],
    );
    const jacct = await db.query<{ id: string; code: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '1100', 'Cash', 'asset'),
              ($1, '2200', 'VAT Payable', 'liability'),
              ($1, '4800', 'Repair Revenue', 'revenue'),
              ($1, '5130', 'Repair Parts Expense', 'expense'),
              ($1, '1320', 'Gold Inventory', 'asset')
       RETURNING id, code`,
      [jbiz.rows[0].id],
    );
    const byCode = new Map(jacct.rows.map((r) => [r.code, r.id]));

    const ticket = await repairs.createRepairTicket({
      locationId: jloc.rows[0].id,
      itemDescription: "گردنبند — تعویض قفل",
      laborCharge: 1_500_000,
      vatPercent: 0,
    });
    await repairs.addRepairPart(ticket.id, {
      description: "قفل طلا",
      quantity: "1",
      unitCost: 700_000,
      charge: 1_000_000,
      source: "stock",
    });

    const result = await withTransaction((client) =>
      repairs.closeRepairTicket(client, {
        businessId: jbiz.rows[0].id,
        ticketId: ticket.id,
        paymentMethod: "cash",
      }),
    );

    expect(await linesOf(result.partsCostEntryId)).toEqual([
      { account_id: byCode.get("5130"), debit: "700000", credit: "0" },
      { account_id: byCode.get("1320"), debit: "0", credit: "700000" },
    ]);
    // VAT is 0 here, and the ledger drops all-zero lines — so the revenue
    // entry is just the cash debit against repair revenue.
    expect(await linesOf(result.revenueEntryId)).toEqual([
      { account_id: byCode.get("1100"), debit: "2500000", credit: "0" },
      { account_id: byCode.get("4800"), debit: "0", credit: "2500000" },
    ]);
  });
});
