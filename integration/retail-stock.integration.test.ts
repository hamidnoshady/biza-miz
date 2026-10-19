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
  await db.query("DELETE FROM ap_payments");
  await db.query("DELETE FROM item_stock_transfer_items");
  await db.query("DELETE FROM item_stock_transfers");
  await db.query("DELETE FROM item_supplier_return_items");
  await db.query("DELETE FROM item_supplier_returns");
  await db.query("DELETE FROM item_purchase_items");
  await db.query("DELETE FROM item_purchases");
  await db.query("DELETE FROM item_serials");
  await db.query("DELETE FROM item_batches");
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
  it("reverses the purchase: Debit AP / Credit inventory", async () => {
    await withClient((client) =>
      stockService.receiveItemPurchase(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId: item.id, quantity: "10", unitCost: 50_000 }],
      }),
    );

    await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
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

    await withClient((client) =>
      stockService.receiveItemPurchase(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId: item.id, quantity: "10", unitCost: 50_000 }],
      }),
    );

    await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
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

describe("#915 retail purchase integrity", () => {
  const receive = (overrides: Partial<Parameters<typeof stockService.receiveItemPurchase>[1]> = {}) =>
    withClient(client => stockService.receiveItemPurchase(client, {
      businessId: biz.id, locationId: biz.locationId, idempotencyKey: randomUUID(),
      lines: [{ itemId: item.id, quantity: "2", unitCost: "9007199254740993" }], ...overrides,
    }));

  it("concurrent and lost-response retries return one exact receipt, stock and journal", async () => {
    const idempotencyKey = randomUUID();
    const receipts = await Promise.all(Array.from({ length: 5 }, () => receive({ idempotencyKey })));
    expect(new Set(receipts.map(p => p.id)).size).toBe(1);
    expect(receipts[0].total).toBe("18014398509481986");
    expect(await receive({ idempotencyKey })).toMatchObject({ id: receipts[0].id, total: receipts[0].total });
    const { rows } = await db.query(`SELECT (SELECT count(*)::int FROM item_purchases) purchases,
      (SELECT count(*)::int FROM item_purchase_items) lines,
      (SELECT quantity::text FROM item_stock WHERE item_id=$1) quantity,
      (SELECT unit_cost::text FROM item_stock WHERE item_id=$1) cost,
      (SELECT count(*)::int FROM domain_events WHERE event_type='retail.purchase_received') events,
      (SELECT count(*)::int FROM journal_lines) journal_lines`, [item.id]);
    expect(rows[0]).toEqual({ purchases: 1, lines: 1, quantity: "2.000000000", cost: "9007199254740993", events: 1, journal_lines: 2 });
    const { rows: ledger } = await db.query(`SELECT debit::text,credit::text FROM journal_lines ORDER BY debit DESC`);
    expect(ledger).toEqual([{ debit: "18014398509481986", credit: "0" }, { debit: "0", credit: "18014398509481986" }]);
  });

  it("binds a key to canonical payload, branch, tenant and operation", async () => {
    const idempotencyKey = randomUUID();
    await receive({ idempotencyKey });
    await expect(receive({ idempotencyKey, lines: [{ itemId: item.id, quantity: "3", unitCost: "9007199254740993" }] })).rejects.toThrow("idempotency_conflict");
    await expect(receive({ idempotencyKey, locationId: biz.otherLocationId, lines: [{ itemId: item.otherId, quantity: "2", unitCost: "9007199254740993" }] })).rejects.toThrow("idempotency_conflict");
    // Numeric safe costs and canonical decimal quantities are equivalent.
    const key = randomUUID();
    const first = await receive({ idempotencyKey: key, lines: [{ itemId: item.id, quantity: "1.00", unitCost: 100 }] });
    expect(await receive({ idempotencyKey: key, lines: [{ itemId: item.id, quantity: "1", unitCost: "100" }] })).toMatchObject({ ...first, duplicate: true });
  });

  it("rolls back document, stock and identity after posting failure, then retries safely", async () => {
    const idempotencyKey = randomUUID();
    await db.query(`UPDATE accounts SET code='9999' WHERE id=$1`, [acct.ap]);
    await expect(receive({ idempotencyKey })).rejects.toThrow();
    for (const table of ["item_purchases", "item_purchase_items", "item_stock", "domain_events", "retail_stock_requests", "journal_lines"]) {
      expect((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0);
    }
    await db.query(`UPDATE accounts SET code='2100' WHERE id=$1`, [acct.ap]);
    await expect(receive({ idempotencyKey })).resolves.toHaveProperty("id");
  });

  it("validates supplier aliases against active tenant and branch before inserting", async () => {
    const { rows } = await db.query(`INSERT INTO suppliers (location_id,name,is_active)
      VALUES ($1,'active',true),($1,'inactive',false),($2,'other branch',true) RETURNING id`, [biz.locationId, biz.otherLocationId]);
    await receive({ supplierId: rows[0].id });
    await expect(receive({ supplierId: rows[1].id })).rejects.toThrow("supplier_not_found");
    await expect(receive({ supplierId: rows[2].id })).rejects.toThrow("supplier_not_found");
    await expect(receive({ supplierId: randomUUID() })).rejects.toThrow("supplier_not_found");
    await expect(receive({ supplierId: "not-a-uuid" })).rejects.toThrow("invalid_uuid");
    const foreignBusiness = (await db.query(`INSERT INTO businesses (name,slug) VALUES ('Foreign',$1) RETURNING id`, [`foreign-${randomUUID()}`])).rows[0].id;
    const foreignLocation = (await db.query(`INSERT INTO locations (business_id,name) VALUES ($1,'Foreign branch') RETURNING id`, [foreignBusiness])).rows[0].id;
    const foreignSupplier = (await db.query(`INSERT INTO suppliers (location_id,name) VALUES ($1,'Foreign supplier') RETURNING id`, [foreignLocation])).rows[0].id;
    await expect(receive({ supplierId: foreignSupplier })).rejects.toThrow("supplier_not_found");
    await expect(receive({ lines: [{ itemId: item.otherId, quantity: "1", unitCost: 10 }] })).rejects.toThrow("item_not_found");
    await expect(receive({ businessId: randomUUID() })).rejects.toThrow("location_not_found");
  });

  it.each(["cash", "bank", "credit"] as const)("posts %s to the selected canonical settlement account", async settlementMethod => {
    const receipt = await receive({ settlementMethod, lines: [{ itemId: item.id, quantity: "1", unitCost: "12345" }] });
    const expected = settlementMethod === "cash" ? "1100" : settlementMethod === "bank" ? "1120" : "2100";
    const { rows } = await db.query(`SELECT a.code,jl.credit::text FROM journal_lines jl
      JOIN accounts a ON a.id=jl.account_id JOIN journal_entries je ON je.id=jl.entry_id
      WHERE je.source_id=$1 AND jl.credit>0`, [receipt.id]);
    expect(rows).toEqual([{ code: expected, credit: "12345" }]);
  });

  it("retains exact batch and multi-unit serial acquisition links across retries", async () => {
    const batch = await itemsService.createItem({ locationId: biz.locationId, name: "lot item", tracking: "batch" });
    const serial = await itemsService.createItem({ locationId: biz.locationId, name: "watch", tracking: "serial" });
    const idempotencyKey = randomUUID();
    const lines = [
      { itemId: batch.id, quantity: "2", unitCost: "9007199254740993", batchNumber: "LOT-1", expiryDate: "2030-01-01" },
      { itemId: serial.id, quantity: "2", unitCost: "9007199254740993", serials: [{ serialNumber: "A" }, { serialNumber: "B" }] },
    ];
    const [p, retry] = await Promise.all([receive({ idempotencyKey, lines }), receive({ idempotencyKey, lines })]);
    expect(p.id).toBe(retry.id);
    expect(p.total).toBe(retry.total);
    expect((await db.query(`SELECT count(*)::int n FROM item_batches`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT unit_cost::text FROM item_batches`)).rows[0].unit_cost).toBe("9007199254740993");
    expect((await db.query(`SELECT unit_cost::text FROM item_stock WHERE item_id=$1`, [batch.id])).rows[0].unit_cost).toBe("9007199254740993");
    expect((await db.query(`SELECT count(*)::int n FROM item_serials`)).rows[0].n).toBe(2);
    expect((await db.query(`SELECT count(*)::int n FROM item_purchase_serials`)).rows[0].n).toBe(2);
    const { rows: serials } = await db.query(`SELECT id FROM item_serials WHERE item_id=$1 ORDER BY serial_number`, [serial.id]);
    const returned = await withClient(c => stockService.createItemSupplierReturn(c, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: p.id, settlementMethod: "accounts_payable", reason: "defect", idempotencyKey: randomUUID(),
      lines: [{ itemId: serial.id, serialId: serials[1].id, quantity: "1" }],
    }));
    expect(returned.value).toBe("9007199254740993");
  });

  it("locks linked return ceilings, rejects unrelated acquisitions and mismatched retry payloads", async () => {
    const purchase = await receive({ lines: [{ itemId: item.id, quantity: "3", unitCost: 100 }] });
    await receive({ lines: [{ itemId: item.id, quantity: "10", unitCost: 100 }] });
    const ret = (idempotencyKey: string, quantity = "2", purchaseId = purchase.id) => withClient(c => stockService.createItemSupplierReturn(c, {
      businessId: biz.id, locationId: biz.locationId, purchaseId, settlementMethod: "accounts_payable", reason: "defect", idempotencyKey,
      lines: [{ itemId: item.id, quantity }],
    }));
    const key = randomUUID();
    const [a, b] = await Promise.all([ret(key), ret(key)]);
    expect(a.id).toBe(b.id);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    await expect(ret(key, "1")).rejects.toThrow("idempotency_conflict");
    await expect(ret(randomUUID())).rejects.toThrow("purchase_return_quantity_exceeded");
    await expect(ret(randomUUID(), "1", randomUUID())).rejects.toThrow("purchase_not_found");
    const results = await Promise.allSettled([ret(randomUUID(), "1"), ret(randomUUID(), "1")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.query(`SELECT quantity::text FROM item_stock WHERE item_id=$1`, [item.id])).rows[0].quantity).toBe("10.000000000");
  });

  it("serializes unlinked fungible returns so physical stock cannot become negative", async () => {
    await receive({ lines: [{ itemId: item.id, quantity: "3", unitCost: 100 }] });
    const ret = () => withClient(c => stockService.createItemSupplierReturn(c, {
      businessId: biz.id, locationId: biz.locationId, settlementMethod: "cash", reason: "defect", idempotencyKey: randomUUID(),
      lines: [{ itemId: item.id, quantity: "2" }],
    }));
    const results = await Promise.allSettled([ret(), ret()]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.query(`SELECT quantity::text FROM item_stock WHERE item_id=$1`, [item.id])).rows[0].quantity).toBe("1.000000000");
  });
});

it("#915 regresses canonical #826 supplier attribution, linked return and A/P settlement", async () => {
  const apService = await import("../src/lib/ap-service");
  const { rows: suppliers } = await db.query(`INSERT INTO suppliers (location_id,name) VALUES ($1,'Canonical AP supplier') RETURNING id`, [biz.locationId]);
  const supplierId = suppliers[0].id;
  const purchase = await withClient(c => stockService.receiveItemPurchase(c, {
    businessId: biz.id, locationId: biz.locationId, supplierId, settlementMethod: "credit", idempotencyKey: randomUUID(),
    lines: [{ itemId: item.id, quantity: "2", unitCost: "100" }],
  }));
  expect(await apService.listSupplierBalances(biz.id)).toEqual([expect.objectContaining({ supplierId, balance: 200 })]);
  await withClient(c => stockService.createItemSupplierReturn(c, {
    businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id, settlementMethod: "accounts_payable", reason: "defect", idempotencyKey: randomUUID(),
    lines: [{ itemId: item.id, quantity: "1" }],
  }));
  expect(await apService.listSupplierBalances(biz.id)).toEqual([expect.objectContaining({ supplierId, balance: 100 })]);
  await apService.payBill({ businessId: biz.id, locationId: biz.locationId, supplierId, method: "cash", amount: 100, clientRequestId: randomUUID(), createdBy: null });
  const statement = await apService.getSupplierStatement(biz.id, supplierId);
  expect(statement.map(line => line.sourceType).sort()).toEqual(["ap_payment", "item_purchase", "item_supplier_return"]);
  expect(statement.at(-1)?.balance).toBe(0);
});

it("#915 linked returns reject a same-SKU serial or batch acquired on another receipt", async () => {
  const serial = await itemsService.createItem({ locationId: biz.locationId, name: "watch", tracking: "serial" });
  const batch = await itemsService.createItem({ locationId: biz.locationId, name: "lot", tracking: "batch" });
  const first = await withClient(c => stockService.receiveItemPurchase(c, { businessId: biz.id, locationId: biz.locationId,
    lines: [{ itemId: serial.id, quantity: "1", unitCost: 100, serials: [{ serialNumber: "A" }] },
      { itemId: batch.id, quantity: "1", unitCost: 100, batchNumber: "LOT-A" }] }));
  await withClient(c => stockService.receiveItemPurchase(c, { businessId: biz.id, locationId: biz.locationId,
    lines: [{ itemId: serial.id, quantity: "1", unitCost: 100, serials: [{ serialNumber: "B" }] },
      { itemId: batch.id, quantity: "1", unitCost: 100, batchNumber: "LOT-B" }] }));
  const batchB = (await db.query(`SELECT id FROM item_batches WHERE item_id=$1 AND batch_number='LOT-B'`, [batch.id])).rows[0].id;
  const giveBack = (line: { itemId: string; serialNumber?: string; batchId?: string }) => withClient(c => stockService.createItemSupplierReturn(c, {
    businessId: biz.id, locationId: biz.locationId, purchaseId: first.id, settlementMethod: "accounts_payable", reason: "defect", idempotencyKey: randomUUID(),
    lines: [{ ...line, quantity: "1" }],
  }));
  await expect(giveBack({ itemId: serial.id, serialNumber: "B" })).rejects.toThrow("purchase_serial_mismatch");
  await expect(giveBack({ itemId: batch.id, batchId: batchB })).rejects.toThrow("purchase_batch_mismatch");
  await expect(withClient(c => stockService.createItemSupplierReturn(c, {
    businessId: biz.id, locationId: biz.otherLocationId, purchaseId: first.id, settlementMethod: "cash", reason: "defect", idempotencyKey: randomUUID(),
    lines: [{ itemId: item.otherId, quantity: "1" }],
  }))).rejects.toThrow("purchase_not_found");
});

it("#915 repeated retail SKU lines require an exact purchase line and enforce its own ceiling", async () => {
  const purchase = await withClient(c => stockService.receiveItemPurchase(c, { businessId: biz.id, locationId: biz.locationId,
    lines: [{ itemId: item.id, quantity: "1", unitCost: 100 }, { itemId: item.id, quantity: "3", unitCost: 200 }] }));
  const lines = (await db.query(`SELECT id FROM item_purchase_items WHERE purchase_id=$1 ORDER BY unit_cost`, [purchase.id])).rows;
  const giveBack = (quantity: string, purchaseItemId?: string) => withClient(c => stockService.createItemSupplierReturn(c, {
    businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id, settlementMethod: "cash", reason: "defect", idempotencyKey: randomUUID(),
    lines: [{ itemId: item.id, quantity, purchaseItemId }],
  }));
  await expect(giveBack("1")).rejects.toThrow("purchase_line_required");
  await expect(giveBack("2", lines[0].id)).rejects.toThrow("purchase_return_quantity_exceeded");
  await giveBack("1", lines[0].id);
  await expect(giveBack("1", lines[0].id)).rejects.toThrow("purchase_return_quantity_exceeded");
  expect((await db.query(`SELECT quantity::text FROM item_stock WHERE item_id=$1`, [item.id])).rows[0].quantity).toBe("3.000000000");
});
