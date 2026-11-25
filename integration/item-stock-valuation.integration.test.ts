/**
 * GH #1567 F1 — fungible item stock valuation stays exact across every
 * movement, for every items-model trade (fashion, accessories, cosmetics …).
 *
 * The invariant under test: after any sequence of receipts, sales, transfers,
 * returns, voids, counts and write-offs, `item_stock.total_value_rial` equals
 * what the ledger carries in the trade's inventory account, and every relief
 * is measured against that live value — never a stale one. The owner's repro
 * (buy 10 @ 50,000, sell 4, write off 1 → 50,000, not 83,333) is the first
 * case. Legacy drift is never rewritten silently: only an authorised repair
 * bound to a reviewed dry-run fingerprint clears it, and it is audited.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { quantityText, rialText } from "../src/lib/inventory-exact";
import type { Industry } from "../src/lib/industries";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let retailInvoice: typeof import("../src/lib/retail-invoice-service");
let voids: typeof import("../src/lib/retail-invoice-void-service");
let stockService: typeof import("../src/lib/retail-stock-service");
let counts: typeof import("../src/lib/item-stock-count-service");
let warehouse: typeof import("../src/lib/retail-warehouse-document-service");
let returns: typeof import("../src/lib/customer-return-service");
let accessories: typeof import("../src/lib/accessories-service");
let cosmetics: typeof import("../src/lib/cosmetics-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let reconciliation: typeof import("../src/lib/item-stock-valuation-reconciliation");

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
  databaseName = `pos_stock_valuation_${randomUUID().replaceAll("-", "")}`;
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
  retailInvoice = await import("../src/lib/retail-invoice-service");
  voids = await import("../src/lib/retail-invoice-void-service");
  stockService = await import("../src/lib/retail-stock-service");
  counts = await import("../src/lib/item-stock-count-service");
  warehouse = await import("../src/lib/retail-warehouse-document-service");
  returns = await import("../src/lib/customer-return-service");
  accessories = await import("../src/lib/accessories-service");
  cosmetics = await import("../src/lib/cosmetics-service");
  provisioning = await import("../src/lib/business-provisioning");
  reconciliation = await import("../src/lib/item-stock-valuation-reconciliation");
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

interface Biz {
  id: string;
  main: string;
  branch: string;
  ownerId: string;
  industry: Industry;
  inventoryCode: string;
}

async function seed(industry: Industry, inventoryCode: string): Promise<Biz> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Shop', $1, $2) RETURNING id",
    [`shop-${randomUUID().slice(0, 8)}`, industry],
  );
  const id = bizRow.rows[0].id;
  const locRows = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Branch') RETURNING id",
    [id],
  );
  const user = await db.query<{ id: string }>(
    "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id",
    [id],
  );
  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, id, industry);
  } finally {
    client.release();
  }
  return { id, main: locRows.rows[0].id, branch: locRows.rows[1].id, ownerId: user.rows[0].id, industry, inventoryCode };
}

async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

async function sku(locationId: string, name: string): Promise<string> {
  const parent = await itemsService.createItem({ locationId, name, kind: "variant_parent" });
  const child = await itemsService.createVariantChild(parent.id, locationId, `${name} M`, null, [{ name: "سایز", value: "M" }]);
  return child.id;
}

async function purchase(b: Biz, locationId: string, itemId: string, quantity: string, unitCost: number) {
  return tx((client) => stockService.receiveItemPurchase(client, { businessId: b.id, locationId, lines: [{ itemId, quantity, unitCost }] }));
}

type LineKind = "stocked" | "accessory" | "cosmetic";

async function sell(b: Biz, locationId: string, itemId: string, quantity: string, kind: LineKind = "stocked", clientRequestId?: string) {
  return tx((client) =>
    retailInvoice.createRetailInvoice(client, {
      businessId: b.id,
      locationId,
      industry: b.industry,
      lines: [{ kind, itemId, quantity, unitPrice: 100_000, discount: 0, vatPercent: 9 }],
      tenders: [{ method: "cash" }],
      clientRequestId: clientRequestId ?? null,
    }),
  );
}

async function stock(itemId: string): Promise<{ quantity: string; unitCost: string | null; total: string | null }> {
  const { rows } = await db.query<{ quantity: string; unit_cost: string | null; total_value_rial: string | null }>(
    "SELECT quantity::text, unit_cost::text, total_value_rial::text FROM item_stock WHERE item_id=$1",
    [itemId],
  );
  return { quantity: String(Number(rows[0]?.quantity ?? 0)), unitCost: rows[0]?.unit_cost ?? null, total: rows[0]?.total_value_rial ?? null };
}

async function glNet(b: Biz, code: string): Promise<bigint> {
  const { rows } = await db.query<{ net: string }>(
    `SELECT (coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0))::text AS net
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1 AND a.code = $2`,
    [b.id, code],
  );
  return BigInt(rows[0].net);
}

async function sumCarrying(b: Biz): Promise<bigint> {
  const { rows } = await db.query<{ total: string }>(
    `SELECT coalesce(sum(s.total_value_rial),0)::text AS total
       FROM item_stock s JOIN items i ON i.id = s.item_id JOIN locations l ON l.id = i.location_id
      WHERE l.business_id = $1`,
    [b.id],
  );
  return BigInt(rows[0].total);
}

/** Subledger == GL, and every row's total agrees with quantity × average. */
async function expectTiedOut(b: Biz): Promise<void> {
  // In-transit stock sits in 1360 between ship and receive and is on no
  // shelf, so the shelves tie to the trade's inventory account alone.
  expect(await sumCarrying(b)).toBe(await glNet(b, b.inventoryCode));
  for (const locationId of [b.main, b.branch]) {
    const dry = await reconciliation.readItemStockValuationReconciliation(db as unknown as PoolClient, {
      businessId: b.id,
      locationId,
    });
    expect(dry.rows).toEqual([]);
  }
}

async function writeOff(b: Biz, locationId: string, itemId: string, quantity: string) {
  const parsed = warehouse.parseRetailWarehouseDocumentLines("issue", [{ itemId, quantity }]);
  return tx((client) =>
    warehouse.createRetailWarehouseDocumentInTransaction(client, {
      businessId: b.id,
      locationId,
      kind: parsed.kind,
      recipient: "ضایعات — آسیب‌دیده",
      lines: parsed.lines,
      createdBy: null,
    }),
  );
}

describe("F1 — owner repro and the full movement chain (fashion)", () => {
  it("buy 10 @ 50,000, sell 4, write off 1 relieves 50,000 — not 83,333", async () => {
    const b = await seed("fashion_apparel", "1374");
    const m = await sku(b.main, "پیراهن");
    await purchase(b, b.main, m, "10", 50_000);
    await sell(b, b.main, m, "4");
    expect(await stock(m)).toEqual({ quantity: "6", unitCost: "50000", total: "300000" });
    const issue = await writeOff(b, b.main, m, "1");
    expect(issue.totalValue).toBe("50000");
    expect(await stock(m)).toEqual({ quantity: "5", unitCost: "50000", total: "250000" });
    expect(await glNet(b, "1374")).toBe(250_000n);
    await expectTiedOut(b);
  });

  it("multi-cost purchases, transfer, return, void, count and write-off tie out to the GL", async () => {
    const b = await seed("fashion_apparel", "1374");
    const main = await sku(b.main, "شلوار");
    const branch = await sku(b.branch, "شلوار");
    await purchase(b, b.main, main, "10", 50_000);
    await purchase(b, b.main, main, "10", 60_000);
    expect(await stock(main)).toEqual({ quantity: "20", unitCost: "55000", total: "1100000" });

    // Sale at the moving average.
    const sale = await sell(b, b.main, main, "5");
    expect(await stock(main)).toMatchObject({ quantity: "15", total: "825000" });
    await expectTiedOut(b);

    // Transfer 5 to the branch: in transit, then received at the exact value.
    const transfer = await tx((client) =>
      stockService.createItemTransfer(client, {
        businessId: b.id,
        sourceLocationId: b.main,
        destinationLocationId: b.branch,
        idempotencyKey: randomUUID(),
        lines: [{ sourceItemId: main, destinationItemId: branch, quantity: "5" }],
      }),
    );
    await tx((client) => stockService.shipItemTransfer(client, { businessId: b.id, transferId: transfer.id, actorId: "" }));
    expect(await stock(main)).toMatchObject({ quantity: "10", total: "550000" });
    expect(await glNet(b, "1360")).toBe(275_000n);
    await expectTiedOut(b);
    await tx((client) => stockService.receiveItemTransfer(client, { businessId: b.id, transferId: transfer.id, actorId: "" }));
    expect(await stock(branch)).toEqual({ quantity: "5", unitCost: "55000", total: "275000" });
    await expectTiedOut(b);

    // A later, dearer purchase moves the average; a return still re-enters the
    // value the sale relieved (55,000), not today's average.
    await purchase(b, b.main, main, "10", 70_000);
    expect(await stock(main)).toMatchObject({ quantity: "20", total: "1250000" });
    const { rows: lines } = await db.query<{ id: string }>("SELECT id FROM order_items WHERE order_id=$1", [sale.orderId]);
    await tx((client) =>
      returns.createCustomerReturn(client, {
        businessId: b.id,
        locationId: b.main,
        orderId: sale.orderId,
        refundMethod: "cash",
        refundAmount: rialText("109000"),
        reason: "F1",
        idempotencyKey: randomUUID(),
        createdBy: b.ownerId,
        lines: [{ orderItemId: lines[0].id, quantity: quantityText("1"), disposition: "restockable" }],
      }),
    );
    expect(await stock(main)).toMatchObject({ quantity: "21", total: "1305000" });
    await expectTiedOut(b);

    // Void a whole invoice: its exact COGS value comes back with the units.
    const second = await sell(b, b.main, main, "2");
    const afterSecond = await stock(main);
    await tx((client) =>
      voids.voidRetailInvoice(client, { businessId: b.id, locationId: b.main, orderId: second.orderId, actorId: b.ownerId, reason: "F1 void" }),
    );
    expect(afterSecond.quantity).toBe("19");
    // Back to exactly the pre-sale value: 21 units, 1,305,000.
    expect(await stock(main)).toMatchObject({ quantity: "21", total: "1305000" });
    await expectTiedOut(b);

    // Count shortage and a damaged write-off, each at the live carrying value.
    const count = await tx((client) =>
      counts.createItemStockCount(client, { businessId: b.id, locationId: b.main, lines: [{ itemId: main, countedQty: "20" }], createdBy: null }),
    );
    expect(BigInt(count.shortage)).toBeGreaterThan(0n);
    await expectTiedOut(b);
    await writeOff(b, b.main, main, "1");
    await expectTiedOut(b);

    // Reversing the count puts back exactly what it relieved.
    await tx((client) => counts.reverseItemStockCount(client, { businessId: b.id, locationId: b.main, countId: count.id, createdBy: null }));
    await expectTiedOut(b);
  });

  it("rounding pennies of a non-integer average are never lost (1 @ 100 + 1 @ 101)", async () => {
    const b = await seed("fashion_apparel", "1374");
    const m = await sku(b.main, "جوراب");
    await purchase(b, b.main, m, "1", 100);
    await purchase(b, b.main, m, "1", 101);
    expect(await stock(m)).toMatchObject({ quantity: "2", total: "201" });
    await sell(b, b.main, m, "1");
    await sell(b, b.main, m, "1");
    expect(await stock(m)).toMatchObject({ quantity: "0", total: "0" });
    expect(await glNet(b, "1374")).toBe(0n);
    expect(await glNet(b, "5184")).toBe(201n);
  });
});

describe("F1 — concurrency and replay", () => {
  it("concurrent sales serialise on the row: no oversell, no value relieved twice", async () => {
    const b = await seed("fashion_apparel", "1374");
    const m = await sku(b.main, "کت");
    await purchase(b, b.main, m, "10", 50_000);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => sell(b, b.main, m, "1")));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(10);
    expect(await stock(m)).toMatchObject({ quantity: "0", total: "0" });
    expect(await glNet(b, "5184")).toBe(500_000n);
    expect(await glNet(b, "1374")).toBe(0n);
  }, 60_000);

  it("an offline replay / duplicate delivery of the same sale relieves stock and value once", async () => {
    const b = await seed("fashion_apparel", "1374");
    const m = await sku(b.main, "دامن");
    await purchase(b, b.main, m, "10", 50_000);
    const requestId = randomUUID();
    const first = await sell(b, b.main, m, "3", "stocked", requestId);
    const replay = await sell(b, b.main, m, "3", "stocked", requestId);
    expect(replay.orderId).toBe(first.orderId);
    expect(await stock(m)).toMatchObject({ quantity: "7", total: "350000" });
    await expectTiedOut(b);
  });
});

describe("F1 — every items-model trade, not only fashion", () => {
  it("accessories: sale, return and write-off keep value and GL tied", async () => {
    const b = await seed("accessories", "1340");
    const m = await sku(b.main, "کیف");
    await accessories.receiveStock(m, { quantity: "10", unitCost: 40_000 });
    await accessories.setUnitPrice(m, 100_000);
    await sell(b, b.main, m, "4", "accessory");
    expect(await stock(m)).toMatchObject({ quantity: "6", total: "240000" });
    const issue = await writeOff(b, b.main, m, "1");
    expect(issue.totalValue).toBe("40000");
    expect(await stock(m)).toMatchObject({ quantity: "5", total: "200000" });
  });

  it("cosmetics (non-batch): sale and tester relieve exact value", async () => {
    const b = await seed("cosmetics", "1350");
    const m = await sku(b.main, "رژ");
    await accessories.receiveStock(m, { quantity: "10", unitCost: 30_000 });
    await accessories.setUnitPrice(m, 100_000);
    await sell(b, b.main, m, "3", "cosmetic");
    const tester = await tx((client) => cosmetics.openTester(client, { businessId: b.id, locationId: b.main, itemId: m }));
    expect(tester.cost).toBe("30000");
    expect(await stock(m)).toMatchObject({ quantity: "6", total: "180000" });
    const issue = await writeOff(b, b.main, m, "1");
    expect(issue.totalValue).toBe("30000");
  });
});

describe("F1 — legacy drift: dry run, then authorised and audited repair only", () => {
  it("never rewrites drift silently; repair is fingerprint-bound, idempotent and audited", async () => {
    const b = await seed("fashion_apparel", "1374");
    const m = await sku(b.main, "مانتو");
    await purchase(b, b.main, m, "10", 50_000);
    await sell(b, b.main, m, "4");
    // Simulate a row written by the pre-fix code: quantity moved, value did not.
    await db.query("UPDATE item_stock SET total_value_rial = 500000 WHERE item_id = $1", [m]);

    // New movements are measured against quantity × average, and the drift is
    // carried forward untouched (500,000 − 50,000), not repaired in passing.
    const issue = await writeOff(b, b.main, m, "1");
    expect(issue.totalValue).toBe("50000");
    expect((await stock(m)).total).toBe("450000");

    const dry = await reconciliation.readItemStockValuationReconciliation(db as unknown as PoolClient, { businessId: b.id, locationId: b.main });
    expect(dry.rows).toHaveLength(1);
    expect(dry.rows[0]).toMatchObject({ itemId: m, quantity: "5.000000000", storedTotal: "450000", expectedTotal: "250000", drift: "200000" });
    expect(dry.glInventoryBalance).toBe("250000");
    expect(dry.glDifference).toBe("200000");

    // A stale or wrong fingerprint is refused; nothing changes.
    await expect(
      tx((client) =>
        reconciliation.repairItemStockValuation(client, {
          businessId: b.id, locationId: b.main, performedBy: b.ownerId, reason: "year-end clean-up",
          fingerprint: "0".repeat(64), idempotencyKey: "repair-key-1",
        }),
      ),
    ).rejects.toThrow("reconciliation_changed");
    await expect(
      tx((client) =>
        reconciliation.repairItemStockValuation(client, {
          businessId: b.id, locationId: b.main, performedBy: b.ownerId, reason: "",
          fingerprint: dry.fingerprint, idempotencyKey: "repair-key-1",
        }),
      ),
    ).rejects.toThrow("reason_required");
    expect((await stock(m)).total).toBe("450000");

    const repaired = await tx((client) =>
      reconciliation.repairItemStockValuation(client, {
        businessId: b.id, locationId: b.main, performedBy: b.ownerId, reason: "year-end clean-up",
        fingerprint: dry.fingerprint, idempotencyKey: "repair-key-1",
      }),
    );
    expect(repaired).toMatchObject({ lineCount: 1, storedTotal: "450000", repairedTotal: "250000", duplicate: false });
    expect((await stock(m)).total).toBe("250000");
    // No journal entry: the GL was right all along.
    expect(await glNet(b, "1374")).toBe(250_000n);

    const replay = await tx((client) =>
      reconciliation.repairItemStockValuation(client, {
        businessId: b.id, locationId: b.main, performedBy: b.ownerId, reason: "year-end clean-up",
        fingerprint: dry.fingerprint, idempotencyKey: "repair-key-1",
      }),
    );
    expect(replay).toMatchObject({ repairId: repaired.repairId, duplicate: true });

    const { rows: audit } = await db.query<{ lines: Array<{ itemId: string; before: string; after: string }>; performed_by: string }>(
      "SELECT lines, performed_by FROM item_stock_valuation_repairs WHERE business_id = $1",
      [b.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].performed_by).toBe(b.ownerId);
    expect(audit[0].lines).toEqual([{ itemId: m, quantity: "5.000000000", unitCost: "50000", before: "450000", after: "250000" }]);
    await expectTiedOut(b);
  });

  it("a repair is branch-scoped and cannot touch another tenant", async () => {
    const a = await seed("fashion_apparel", "1374");
    const other = await seed("fashion_apparel", "1374");
    const mine = await sku(a.main, "پالتو");
    const theirs = await sku(other.main, "پالتو");
    for (const [b, id] of [[a, mine], [other, theirs]] as const) {
      await purchase(b, b.main, id, "4", 10_000);
      await db.query("UPDATE item_stock SET total_value_rial = 99999 WHERE item_id = $1", [id]);
    }
    const dry = await reconciliation.readItemStockValuationReconciliation(db as unknown as PoolClient, { businessId: a.id, locationId: a.main });
    expect(dry.rows.map((r) => r.itemId)).toEqual([mine]);
    const branchDry = await reconciliation.readItemStockValuationReconciliation(db as unknown as PoolClient, { businessId: a.id, locationId: a.branch });
    expect(branchDry.rows).toEqual([]);
    await tx((client) =>
      reconciliation.repairItemStockValuation(client, {
        businessId: a.id, locationId: a.main, performedBy: a.ownerId, reason: "clean-up",
        fingerprint: dry.fingerprint, idempotencyKey: "repair-key-tenant",
      }),
    );
    expect((await stock(mine)).total).toBe("40000");
    expect((await stock(theirs)).total).toBe("99999");
  });
});
