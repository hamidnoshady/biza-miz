/**
 * Phase 27 Wave 8 — purchasing, supplier returns and transfers on the
 * `items` model.
 *
 * The load-bearing claims: a purchase receives stock and posts Debit
 * inventory / Credit AP; a supplier return reverses both; a transfer ships
 * into in-transit and receives into the destination; and the low-stock
 * report only flags variants with a reorder point set.
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
let stockService: typeof import("../src/lib/retail-stock-service");
let itemsService: typeof import("../src/lib/items-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", locationId: "", otherLocationId: "" };
const acct = { inventory: "", inTransit: "", ap: "", supplierReceivable: "" };
const item = { id: "", otherId: "" };

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
  databaseName = `pos_stock_${randomUUID().replaceAll("-", "")}`;

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
  stockService = await import("../src/lib/retail-stock-service");
  itemsService = await import("../src/lib/items-service");
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
  await db.query("DELETE FROM item_stock_transfer_items");
  await db.query("DELETE FROM item_stock_transfers");
  await db.query("DELETE FROM item_supplier_return_items");
  await db.query("DELETE FROM item_supplier_returns");
  await db.query("DELETE FROM item_purchase_items");
  await db.query("DELETE FROM item_purchases");
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Stock Co', $1, 'cosmetics') RETURNING id",
    [`stock-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Branch') RETURNING id`,
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
  biz.otherLocationId = locRow.rows[1].id;

  // Seeded from the real cosmetics template rather than hand-inserted: a
  // supplier return settled as a receivable needs 1210, which the template did
  // not carry until Phase 30, and hand-inserting the accounts is what kept that
  // gap invisible here.
  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, biz.id, "cosmetics");
  } finally {
    client.release();
  }
  const accounts = await db.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts WHERE business_id = $1 AND code IN ('1350', '1360', '2100', '1210')`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1350") acct.inventory = row.id;
    if (row.code === "1360") acct.inTransit = row.id;
    if (row.code === "2100") acct.ap = row.id;
    if (row.code === "1210") acct.supplierReceivable = row.id;
  }

  const source = await itemsService.createItem({ locationId: biz.locationId, name: "کرم ضدآفتاب", tracking: "none" });
  item.id = source.id;
  const dest = await itemsService.createItem({ locationId: biz.otherLocationId, name: "کرم ضدآفتاب", tracking: "none" });
  item.otherId = dest.id;
});

async function withClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
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

describe("retail purchasing", () => {
  it("receives stock and posts Debit inventory / Credit AP", async () => {
    await withClient((client) =>
      stockService.receiveItemPurchase(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId: item.id, quantity: "10", unitCost: 50_000 }],
      }),
    );

    const stock = await db.query<{ quantity: string; unit_cost: string }>(
      "SELECT quantity::text, unit_cost::text FROM item_stock WHERE item_id = $1",
      [item.id],
    );
    expect(Number(stock.rows[0].quantity)).toBe(10);
    expect(stock.rows[0].unit_cost).toBe("50000");

    const entry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'retail.purchase_received'",
    );
    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entry.rows[0].entry_id],
    );
    expect(lines).toEqual([
      { account_id: acct.inventory, debit: "500000", credit: "0" },
      { account_id: acct.ap, debit: "0", credit: "500000" },
    ]);
  });

  it("refuses to receive a serial item through the purchase path", async () => {
    const serial = await itemsService.createItem({ locationId: biz.locationId, name: "ساعت", tracking: "serial" });
    await expect(
      withClient((client) =>
        stockService.receiveItemPurchase(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          lines: [{ itemId: serial.id, quantity: "1", unitCost: 1_000_000 }],
        }),
      ),
    ).rejects.toThrow(/سریالی/);
  });
});

describe("supplier returns", () => {
  async function supplierId(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO suppliers (location_id, name) VALUES ($1, 'تأمین‌کننده تست') RETURNING id",
      [biz.locationId],
    );
    return rows[0].id;
  }

  it("reverses the purchase: Debit AP / Credit inventory", async () => {
    const supplier = await supplierId();
    const purchase = await withClient((client) =>
      stockService.receiveItemPurchase(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        supplierId: supplier,
        lines: [{ itemId: item.id, quantity: "10", unitCost: 50_000 }],
      }),
    );

    await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: purchase.id,
        settlementMethod: "accounts_payable",
        reason: "کالای معیوب",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.id, quantity: "4" }],
      }),
    );

    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.id]);
    expect(Number(stock.rows[0].quantity)).toBe(6);

    const entry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'retail.supplier_return'",
    );
    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entry.rows[0].entry_id],
    );
    expect(lines).toEqual([
      { account_id: acct.ap, debit: "200000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "200000" },
    ]);
  });

  it("settles as a receivable from the supplier when that is how it was agreed", async () => {
    // The other settlement `RETURN_DEBIT_CODE` offers, and the one that needed
    // «دریافتنی از تأمین‌کننده» (1210) — an account the four retail templates did
    // not carry until Phase 30, so this posting could only ever have failed with
    // `ledger_account_missing` in a real shop.
    expect(acct.supplierReceivable).not.toBe("");

    const supplier = await supplierId();
    const purchase = await withClient((client) =>
      stockService.receiveItemPurchase(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        supplierId: supplier,
        lines: [{ itemId: item.id, quantity: "10", unitCost: 50_000 }],
      }),
    );

    await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: purchase.id,
        settlementMethod: "supplier_receivable",
        reason: "کالای معیوب",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.id, quantity: "2" }],
      }),
    );

    const entry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'retail.supplier_return'",
    );
    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entry.rows[0].entry_id],
    );
    expect(lines).toEqual([
      { account_id: acct.supplierReceivable, debit: "100000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "100000" },
    ]);
  });
});

describe("transfers", () => {
  it("ships into in-transit and receives into the destination", async () => {
    await withClient((client) =>
      stockService.receiveItemPurchase(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId: item.id, quantity: "10", unitCost: 50_000 }],
      }),
    );

    const transfer = await withClient((client) =>
      stockService.createItemTransfer(client, {
        businessId: biz.id,
        sourceLocationId: biz.locationId,
        destinationLocationId: biz.otherLocationId,
        idempotencyKey: randomUUID(),
        lines: [{ sourceItemId: item.id, destinationItemId: item.otherId, quantity: "3" }],
      }),
    );
    expect(transfer.duplicate).toBe(false);

    await withClient((client) => stockService.shipItemTransfer(client, { businessId: biz.id, transferId: transfer.id, actorId: "" }));
    await withClient((client) => stockService.receiveItemTransfer(client, { businessId: biz.id, transferId: transfer.id, actorId: "" }));

    const source = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.id]);
    const dest = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.otherId]);
    expect(Number(source.rows[0].quantity)).toBe(7);
    expect(Number(dest.rows[0].quantity)).toBe(3);

    const ship = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'retail.transfer_ship'",
    );
    const { rows: shipLines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [ship.rows[0].entry_id],
    );
    expect(shipLines).toEqual([
      { account_id: acct.inTransit, debit: "150000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "150000" },
    ]);
  });
});

describe("low-stock report", () => {
  it("flags only variants under a set reorder point", async () => {
    await withClient((client) =>
      stockService.receiveItemPurchase(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId: item.id, quantity: "2", unitCost: 50_000 }],
      }),
    );
    await stockService.setReorderPoint(item.id, 5);

    const report = await stockService.lowStockReport(biz.locationId);
    expect(report).toHaveLength(1);
    expect(report[0].itemId).toBe(item.id);
    expect(report[0].level).toBe("low");
  });
});
