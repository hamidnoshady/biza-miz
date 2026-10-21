/**
 * Issue #918 — the retail supplier-return voucher (حواله بازگشت), hardened.
 *
 * The load-bearing claims, each driven against a real migrated database:
 *
 * - a linked return credits the supplier at the INVOICE cost and relieves
 *   inventory at CARRYING value, posting an explicit variance when cost drift
 *   moved the two apart — and the journal always balances;
 * - no return posts an AP debit against no supplier (linked or explicit
 *   attribution, mismatch-safe), and the AP subledger attributes the voucher
 *   to the intended supplier;
 * - purchase/branch/tenant boundaries, per-line return ceilings and
 *   lot/serial provenance are enforced server-side in one transaction;
 * - retries are safe (same key + same payload replays; same key + changed
 *   payload conflicts; concurrent doubles collapse to one voucher) and stock
 *   decrements are lock-guarded;
 * - null costs are refused (never zeroed), money stays exact, and voucher
 *   numbers are sequential per business.
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
let apService: typeof import("../src/lib/ap-service");

const biz = { id: "", locationId: "", otherLocationId: "" };
const acct = { inventory: "", ap: "", supplierReceivable: "", cash: "", bank: "", otherIncome: "", otherExpense: "" };
const item = { none: "", batch: "", serial: "", weight: "" };
let supplier = "";

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
  databaseName = `pos_ret918_${randomUUID().replaceAll("-", "")}`;

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
  apService = await import("../src/lib/ap-service");

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
  await db.query("DELETE FROM item_supplier_return_items");
  await db.query("DELETE FROM item_supplier_returns");
  await db.query("DELETE FROM item_supplier_return_counters");
  await db.query("DELETE FROM item_stock_transfer_items");
  await db.query("DELETE FROM item_stock_transfers");
  await db.query("DELETE FROM item_purchase_items");
  await db.query("DELETE FROM item_purchases");
  await db.query("DELETE FROM item_batches");
  await db.query("DELETE FROM item_serials");
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM suppliers");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Return Co', $1, 'cosmetics') RETURNING id",
    [`ret918-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Branch') RETURNING id`,
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
  biz.otherLocationId = locRow.rows[1].id;

  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, biz.id, "cosmetics");
  } finally {
    client.release();
  }
  const accounts = await db.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts WHERE business_id = $1 AND code IN ('1350', '2100', '1210', '1100', '1120', '4900', '5900')`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1350") acct.inventory = row.id;
    if (row.code === "2100") acct.ap = row.id;
    if (row.code === "1210") acct.supplierReceivable = row.id;
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "1120") acct.bank = row.id;
    if (row.code === "4900") acct.otherIncome = row.id;
    if (row.code === "5900") acct.otherExpense = row.id;
  }
  expect(acct.inventory && acct.ap && acct.cash && acct.bank && acct.otherIncome && acct.otherExpense).toBeTruthy();

  const supplierRow = await db.query<{ id: string }>(
    "INSERT INTO suppliers (location_id, name) VALUES ($1, 'تأمین‌کننده اصلی') RETURNING id",
    [biz.locationId],
  );
  supplier = supplierRow.rows[0].id;

  item.none = (await itemsService.createItem({ locationId: biz.locationId, name: "کرم ضدآفتاب", tracking: "none" })).id;
  item.batch = (await itemsService.createItem({ locationId: biz.locationId, name: "سرم ویتامین", tracking: "batch" })).id;
  item.serial = (await itemsService.createItem({ locationId: biz.locationId, name: "ساعت مچی", tracking: "serial" })).id;
  item.weight = (await itemsService.createItem({ locationId: biz.locationId, name: "گردنبند طلا", tracking: "weight" })).id;
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

async function receive(
  lines: Parameters<typeof stockService.receiveItemPurchase>[1]["lines"],
  overrides: { supplierId?: string | null; locationId?: string } = {},
) {
  return withClient((client) =>
    stockService.receiveItemPurchase(client, {
      businessId: biz.id,
      locationId: overrides.locationId ?? biz.locationId,
      supplierId: overrides.supplierId === undefined ? supplier : overrides.supplierId,
      createdBy: null,
      lines,
    }),
  );
}

async function journalOf(sourceId: string) {
  const entry = await db.query<{ entry_id: string | null }>(
    "SELECT entry_id FROM domain_events WHERE event_type = 'retail.supplier_return' AND source_id = $1",
    [sourceId],
  );
  expect(entry.rows).toHaveLength(1);
  const { rows } = await db.query<{ account_id: string; debit: string; credit: string }>(
    // Order by the numeric columns, not the text aliases — "200000" sorts
    // above "1000000" lexically, which would scramble multi-line postings.
    "SELECT account_id, debit::text AS debit, credit::text AS credit FROM journal_lines jl WHERE entry_id = $1 ORDER BY jl.debit DESC, jl.credit DESC, jl.account_id",
    [entry.rows[0].entry_id],
  );
  // Every return posting balances — asserted on every journal read, not just
  // the cases that name their lines.
  const debit = rows.reduce((sum, l) => sum + BigInt(l.debit), 0n);
  const credit = rows.reduce((sum, l) => sum + BigInt(l.credit), 0n);
  expect(debit).toBe(credit);
  expect(debit).toBeGreaterThan(0n);
  return rows;
}

/** The supplier the AP subledger attributes a return voucher to (the canonical relation). */
async function attributedSupplierOf(returnId: string): Promise<string | null> {
  const { AP_SUPPLIER_ATTRIBUTION_SQL } = await import("../src/lib/ap-attribution");
  const { rows } = await db.query<{ supplier_id: string | null }>(
    `SELECT ap_source.supplier_id ${AP_SUPPLIER_ATTRIBUTION_SQL}
      WHERE je.business_id = $1 AND je.source_type = 'item_supplier_return' AND je.source_id = $2`,
    [biz.id, returnId],
  );
  return rows[0]?.supplier_id ?? null;
}

describe("attribution and valuation", () => {
  it("links the purchase and its supplier: stock out, AP debited at invoice cost, inventory relieved at carrying value", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);

    const result = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: purchase.id,
        settlementMethod: "accounts_payable",
        reason: "کالای معیوب",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.none, quantity: "4" }],
      }),
    );
    expect(result.value).toBe("200000");
    expect(result.supplierCredit).toBe("200000");
    expect(result.variance).toBe("0");
    expect(result.returnNumber).toBe(1);

    // The line records the exact receipt line it relieves.
    const { rows: retLines } = await db.query<{ purchase_item_id: string | null; value_rial: string; supplier_credit_rial: string }>(
      "SELECT purchase_item_id::text, value_rial::text, supplier_credit_rial::text FROM item_supplier_return_items WHERE return_id = $1",
      [result.id],
    );
    expect(retLines).toHaveLength(1);
    expect(retLines[0].purchase_item_id).not.toBeNull();
    expect(retLines[0].value_rial).toBe("200000");
    expect(retLines[0].supplier_credit_rial).toBe("200000");

    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.none]);
    expect(stock.rows[0].quantity).toBe("6.000000000");

    expect(await journalOf(result.id)).toEqual([
      { account_id: acct.ap, debit: "200000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "200000" },
    ]);

    // The intended supplier's AP statement carries this voucher.
    expect(await attributedSupplierOf(result.id)).toBe(supplier);
  });

  it("posts an explicit loss variance when carrying value drifted above the invoice cost", async () => {
    // Bought 10 @ 500k, running cost now 600k (a second receipt at 700k) —
    // the issue's own example: return 2 → 1m supplier credit vs 1.2m relief.
    const first = await receive([{ itemId: item.none, quantity: "10", unitCost: 500_000 }]);
    await receive([{ itemId: item.none, quantity: "10", unitCost: 700_000 }]);

    const result = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: first.id,
        settlementMethod: "accounts_payable",
        reason: "مغایرت با سفارش",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.none, quantity: "2" }],
      }),
    );
    expect(result.supplierCredit).toBe("1000000");
    expect(result.value).toBe("1200000");
    expect(result.variance).toBe("200000");

    expect(await journalOf(result.id)).toEqual([
      { account_id: acct.ap, debit: "1000000", credit: "0" },
      { account_id: acct.otherExpense, debit: "200000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "1200000" },
    ]);
    expect(await attributedSupplierOf(result.id)).toBe(supplier);
  });

  it("posts an explicit gain variance when the invoice cost exceeds carrying value", async () => {
    const first = await receive([{ itemId: item.none, quantity: "10", unitCost: 500_000 }]);
    await receive([{ itemId: item.none, quantity: "10", unitCost: 300_000 }]);

    const result = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: first.id,
        settlementMethod: "accounts_payable",
        reason: "مغایرت با سفارش",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.none, quantity: "2" }],
      }),
    );
    expect(result.supplierCredit).toBe("1000000");
    expect(result.value).toBe("800000");
    expect(result.variance).toBe("-200000");

    expect(await journalOf(result.id)).toEqual([
      { account_id: acct.ap, debit: "1000000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "800000" },
      { account_id: acct.otherIncome, debit: "0", credit: "200000" },
    ]);
  });

  it("refuses an AP return against no supplier, and attributes a deliberately unlinked return to its explicit supplier", async () => {
    const noSupplier = await receive([{ itemId: item.none, quantity: "5", unitCost: 10_000 }], { supplierId: null });

    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: noSupplier.id,
          settlementMethod: "accounts_payable",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.none, quantity: "1" }],
        }),
      ),
    ).rejects.toThrow(/بدون تأمین‌کنندهٔ مشخص/);

    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          settlementMethod: "accounts_payable",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.none, quantity: "1" }],
        }),
      ),
    ).rejects.toThrow(/بدون تأمین‌کنندهٔ مشخص/);

    // The explicit unlinked policy: a named supplier, credit = carrying.
    const direct = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        supplierId: supplier,
        settlementMethod: "accounts_payable",
        reason: "برگشت مستقیم",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.none, quantity: "1" }],
      }),
    );
    expect(direct.supplierCredit).toBe(direct.value);
    expect(direct.variance).toBe("0");
    expect(await attributedSupplierOf(direct.id)).toBe(supplier);
  });

  it("settles cash without a supplier, and numbers vouchers sequentially per business", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 20_000 }], { supplierId: null });

    const first = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: purchase.id,
        settlementMethod: "cash",
        reason: "نقدی",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.none, quantity: "1" }],
      }),
    );
    expect(await journalOf(first.id)).toEqual([
      { account_id: acct.cash, debit: "20000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "20000" },
    ]);

    const second = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: purchase.id,
        settlementMethod: "cash",
        reason: "نقدی",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.none, quantity: "1" }],
      }),
    );
    expect(first.returnNumber).toBe(1);
    expect(second.returnNumber).toBe(2);
  });

  it("posts a bank refund to clearing, not AP or a second payment voucher", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "5", unitCost: 10_000 }], { supplierId: null });
    const result = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id,
        settlementMethod: "bank", reason: "بازپرداخت بانکی", idempotencyKey: randomUUID(),
        lines: [{ itemId: item.none, quantity: "2" }],
      }),
    );
    expect(await journalOf(result.id)).toEqual([
      { account_id: acct.bank, debit: "20000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "20000" },
    ]);
    const bankBalance = await db.query<{ amount: string }>(
      "SELECT COALESCE(SUM(debit - credit), 0)::text AS amount FROM journal_lines WHERE account_id = $1",
      [acct.bank],
    );
    expect(bankBalance.rows[0].amount).toBe("20000");
    const payments = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ap_payments WHERE business_id = $1",
      [biz.id],
    );
    expect(payments.rows[0].count).toBe("0");
  });

  it("tenant-fences supporting-file links and keeps unlinking separate from deleting the Media Library asset", async () => {
    await receive([{ itemId: item.none, quantity: "2", unitCost: 10_000 }], { supplierId: null });
    const returned = await withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: null,
      settlementMethod: "cash", reason: "سند پشتیبان", idempotencyKey: randomUUID(),
      lines: [{ itemId: item.none, quantity: "1" }],
    }));
    let foreignBusinessId = "";
    let ownAssetId = "";
    let foreignAssetId = "";
    try {
      ownAssetId = (await db.query<{ id: string }>(
        `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
         VALUES ($1, 'document', 'support.pdf', 'application/pdf', 12, $2, repeat('a', 64)) RETURNING id`,
        [biz.id, `returns/${biz.id}/${randomUUID()}`],
      )).rows[0].id;
      await db.query(
        `INSERT INTO item_supplier_return_attachments (business_id, return_id, media_asset_id)
         VALUES ($1, $2, $3)`,
        [biz.id, returned.id, ownAssetId],
      );
      await db.query(
        `INSERT INTO item_supplier_return_attachments (business_id, return_id, media_asset_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [biz.id, returned.id, ownAssetId],
      );
      const linkCount = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM item_supplier_return_attachments WHERE business_id=$1 AND return_id=$2",
        [biz.id, returned.id],
      );
      expect(linkCount.rows[0].count).toBe("1");

      foreignBusinessId = (await db.query<{ id: string }>(
        "INSERT INTO businesses (name, slug, industry) VALUES ('Other Co', $1, 'cosmetics') RETURNING id",
        [`ret918-other-${randomUUID().slice(0, 8)}`],
      )).rows[0].id;
      foreignAssetId = (await db.query<{ id: string }>(
        `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
         VALUES ($1, 'document', 'foreign.pdf', 'application/pdf', 12, $2, repeat('b', 64)) RETURNING id`,
        [foreignBusinessId, `returns/${foreignBusinessId}/${randomUUID()}`],
      )).rows[0].id;
      await expect(db.query(
        `INSERT INTO item_supplier_return_attachments (business_id, return_id, media_asset_id)
         VALUES ($1, $2, $3)`,
        [biz.id, returned.id, foreignAssetId],
      )).rejects.toMatchObject({ code: "23503" });

      await db.query(
        "DELETE FROM item_supplier_return_attachments WHERE business_id=$1 AND return_id=$2 AND media_asset_id=$3",
        [biz.id, returned.id, ownAssetId],
      );
      const assetStillExists = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM media_assets WHERE id=$1", [ownAssetId]);
      expect(assetStillExists.rows[0].count).toBe("1");
    } finally {
      if (ownAssetId) await db.query("DELETE FROM media_assets WHERE id=$1", [ownAssetId]);
      if (foreignAssetId) await db.query("DELETE FROM media_assets WHERE id=$1", [foreignAssetId]);
      if (foreignBusinessId) await db.query("DELETE FROM businesses WHERE id=$1", [foreignBusinessId]);
    }
  });

  it("keeps AP statements, aging, GL control, and register-to-journal drill-through aligned through linked, unlinked, reversed and replayed returns", async () => {
    const linkedPurchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);
    const linkedKey = randomUUID();
    const createLinked = () => withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: linkedPurchase.id,
      settlementMethod: "accounts_payable", reason: "برگشت مرتبط", idempotencyKey: linkedKey,
      lines: [{ itemId: item.none, quantity: "2" }],
    }));
    const linked = await createLinked();
    expect((await createLinked()).duplicate).toBe(true);
    const duplicates = await db.query<{ returns: string; sourceEvents: string }>(
      `SELECT (SELECT count(*)::text FROM item_supplier_returns WHERE business_id=$1 AND idempotency_key=$2) AS returns,
              (SELECT count(*)::text FROM domain_events WHERE business_id=$1 AND event_type='retail.supplier_return' AND source_id=$3) AS "sourceEvents"`,
      [biz.id, linkedKey, linked.id],
    );
    expect(duplicates.rows[0]).toEqual({ returns: "1", sourceEvents: "1" });

    async function assertAccounting(returnIds: string[]) {
      const statement = await apService.getSupplierStatement(biz.id, supplier);
      const today = (await db.query<{ today: string }>("SELECT current_date::text AS today")).rows[0].today;
      const aging = await apService.getApAging(biz.id, today);
      const supplierBalance = statement.at(-1)?.balance ?? 0;
      const supplierAging = aging.rows.find((row) => row.supplierId === supplier);
      expect(supplierAging?.total ?? 0).toBe(supplierBalance);

      const control = await db.query<{ net: string }>(
        `SELECT COALESCE(SUM(jl.credit-jl.debit),0)::text AS net
           FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
          WHERE je.business_id=$1 AND jl.account_id=$2`,
        [biz.id, acct.ap],
      );
      expect(Number(control.rows[0].net)).toBe(aging.totals.total);

      for (const returnId of returnIds) {
        expect(statement.some((line) => line.itemSupplierReturnId === returnId)).toBe(true);
        const drillThrough = await db.query<{
          return_number: string;
          status: string;
          reversal_entry_id: string | null;
          journal_id: string;
          posting_kind: string;
        }>(
          `SELECT r.return_number::text, r.status::text, r.reversal_entry_id,
                  je.id AS journal_id, je.posting_kind
             FROM item_supplier_returns r
             JOIN journal_entries je ON je.business_id=r.business_id
               AND je.source_type='item_supplier_return' AND je.source_id=r.id
            WHERE r.business_id=$1 AND r.id=$2
            ORDER BY je.created_at, je.id`,
          [biz.id, returnId],
        );
        expect(drillThrough.rows.length).toBeGreaterThanOrEqual(1);
        expect(drillThrough.rows.every((row) => row.return_number && row.journal_id)).toBe(true);
        if (drillThrough.rows[0].status === "reversed") {
          expect(drillThrough.rows.some((row) => row.journal_id === drillThrough.rows[0].reversal_entry_id)).toBe(true);
        }
      }
      return { statementBalance: supplierBalance, controlNet: Number(control.rows[0].net), agingTotal: aging.totals.total };
    }

    const linkedSnapshot = await assertAccounting([linked.id]);
    expect(linkedSnapshot.statementBalance).toBe(400_000);

    // Direct/unlinked return names the supplier explicitly; its AP debit must
    // still appear in that supplier's statement and aging rather than vanish
    // into an unattributed bucket.
    await receive([{ itemId: item.none, quantity: "5", unitCost: 70_000 }], { supplierId: null });
    const unlinked = await withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: null, supplierId: supplier,
      settlementMethod: "accounts_payable", reason: "برگشت بدون خرید مبنا", idempotencyKey: randomUUID(),
      lines: [{ itemId: item.none, quantity: "1" }],
    }));
    const unlinkedSnapshot = await assertAccounting([linked.id, unlinked.id]);
    expect(unlinkedSnapshot.statementBalance).toBeLessThan(linkedSnapshot.statementBalance);

    const reversal = await withClient((client) => stockService.reverseItemSupplierReturn(client, {
      businessId: biz.id, returnId: linked.id, reason: "اصلاح حسابرسی‌شده", idempotencyKey: randomUUID(), actorId: null,
    }));
    expect(reversal.reversalEntryId).toBeTruthy();
    const reversedSnapshot = await assertAccounting([linked.id, unlinked.id]);
    expect(reversedSnapshot.statementBalance).toBeGreaterThan(unlinkedSnapshot.statementBalance);
  });

  it("handles a partial purchase return as an AP credit adjustment, reconciled without an AP payment", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "5", unitCost: 10_000 }]);
    const result = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id,
        settlementMethod: "accounts_payable", reason: "برگشت بخشی از خرید", idempotencyKey: randomUUID(),
        lines: [{ itemId: item.none, quantity: "2" }],
      }),
    );
    expect(await journalOf(result.id)).toEqual([
      { account_id: acct.ap, debit: "20000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "20000" },
    ]);
    const reconciliation = await db.query<{ ap_net: string; inventory_net: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN jl.account_id = $2 THEN jl.credit - jl.debit ELSE 0 END),0)::text AS ap_net,
         COALESCE(SUM(CASE WHEN jl.account_id = $3 THEN jl.debit - jl.credit ELSE 0 END),0)::text AS inventory_net
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id WHERE je.business_id = $1`,
      [biz.id, acct.ap, acct.inventory],
    );
    expect(reconciliation.rows[0]).toEqual({ ap_net: "30000", inventory_net: "30000" });
    const remaining = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.none]);
    expect(remaining.rows[0].quantity).toBe("3.000000000");
    const payments = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ap_payments WHERE business_id = $1 AND supplier_id = $2",
      [biz.id, supplier],
    );
    expect(payments.rows[0].count).toBe("0");
  });
});

describe("boundaries, provenance and ceilings", () => {
  it("rejects unrelated, cross-branch and foreign purchases, and supplier mismatches", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);
    const otherItem = await itemsService.createItem({ locationId: biz.locationId, name: "کرم شب", tracking: "none" });
    await receive([{ itemId: otherItem.id, quantity: "5", unitCost: 10_000 }]);

    // Same tenant, unrelated purchase: this item was never on it.
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: otherItem.id, quantity: "1" }],
        }),
      ),
    ).rejects.toThrow(/در خریدِ انتخاب‌شده وجود ندارد/);

    // Same tenant, other branch's purchase.
    const branchItem = await itemsService.createItem({ locationId: biz.otherLocationId, name: "کرم ضدآفتاب", tracking: "none" });
    const branchPurchase = await receive([{ itemId: branchItem.id, quantity: "5", unitCost: 10_000 }], {
      locationId: biz.otherLocationId,
    });
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: branchPurchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.none, quantity: "1" }],
        }),
      ),
    ).rejects.toThrow(/متعلق به انبار جاری نیست/);

    // Another tenant's purchase id: existence is never confirmed.
    const foreignBiz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Foreign', $1, 'cosmetics') RETURNING id",
      [`foreign-${randomUUID().slice(0, 8)}`],
    );
    const foreignLoc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'F') RETURNING id",
      [foreignBiz.rows[0].id],
    );
    const foreignPurchase = await db.query<{ id: string }>(
      "INSERT INTO item_purchases (business_id, location_id, total) VALUES ($1, $2, 0) RETURNING id",
      [foreignBiz.rows[0].id, foreignLoc.rows[0].id],
    );
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: foreignPurchase.rows[0].id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.none, quantity: "1" }],
        }),
      ),
    ).rejects.toThrow(/خریدِ مبنا یافت نشد/);

    // An explicit supplier that disagrees with the purchase is a mismatch.
    const otherSupplier = (
      await db.query<{ id: string }>(
        "INSERT INTO suppliers (location_id, name) VALUES ($1, 'تأمین‌کننده دوم') RETURNING id",
        [biz.locationId],
      )
    ).rows[0].id;
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          supplierId: otherSupplier,
          settlementMethod: "accounts_payable",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.none, quantity: "1" }],
        }),
      ),
    ).rejects.toThrow(/یکی نیست/);

    // A cancelled purchase is not returnable.
    await db.query("UPDATE item_purchases SET status = 'cancelled' WHERE id = $1", [purchase.id]);
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.none, quantity: "1" }],
        }),
      ),
    ).rejects.toThrow(/لغو شده/);
  });

  it("never lets prior plus current returns exceed what the purchase received", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);
    const returning = (quantity: string, key = randomUUID()) =>
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: key,
          lines: [{ itemId: item.none, quantity }],
        }),
      );

    await returning("6");
    // A second receipt tops the shelf back up, so the next refusal is the
    // receipt ceiling — not the shelf.
    await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);
    await expect(returning("5")).rejects.toThrow(/بیشتر می‌شود/);
    // …but the exact remainder still goes.
    await returning("4");

    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.none]);
    expect(stock.rows[0].quantity).toBe("10.000000000");
  });

  it("aggregates same-SKU lines within one voucher against the ceiling", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "5", unitCost: 50_000 }]);
    // Shelf holds more than the receipt, so the refusal is the ceiling.
    await receive([{ itemId: item.none, quantity: "5", unitCost: 50_000 }]);
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [
            { itemId: item.none, quantity: "3" },
            { itemId: item.none, quantity: "3" },
          ],
        }),
      ),
    ).rejects.toThrow(/بیشتر می‌شود/);
  });

  it("requires the exact receipt line when one purchase received the SKU at different costs", async () => {
    const purchase = await receive([
      { itemId: item.none, quantity: "5", unitCost: 40_000 },
      { itemId: item.none, quantity: "5", unitCost: 60_000 },
    ]);
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.none, quantity: "2" }],
        }),
      ),
    ).rejects.toThrow(/چند بهای مختلف/);

    const { rows: receiptLines } = await db.query<{ id: string; unit_cost: string }>(
      "SELECT id, unit_cost::text FROM item_purchase_items WHERE purchase_id = $1 ORDER BY unit_cost",
      [purchase.id],
    );
    const result = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: purchase.id,
        settlementMethod: "cash",
        reason: "تست",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.none, quantity: "2", purchaseItemId: receiptLines[1].id }],
      }),
    );
    // The credit follows the NAMED receipt line (60k), not the average.
    expect(result.supplierCredit).toBe("120000");
  });

  it("rejects stock shortages even inside the receipt ceiling", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);
    // A concurrent sale drained the shelf after receipt (simulated directly —
    // the guard must hold whatever moved the stock).
    await db.query("UPDATE item_stock SET quantity = 3 WHERE item_id = $1", [item.none]);
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.none, quantity: "4" }],
        }),
      ),
    ).rejects.toThrow(/موجودی کافی نیست/);
  });

  it("keeps weight items on their own path", async () => {
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.weight, quantity: "1" }],
        }),
      ),
    ).rejects.toThrow(/وزنی/);
  });
});

describe("batch-tracked returns", () => {
  async function batchPurchase() {
    return receive([
      { itemId: item.batch, quantity: "5", unitCost: 10_000, batchNumber: "LOT-A", expiryDate: "2030-01-01" },
      { itemId: item.batch, quantity: "5", unitCost: 20_000, batchNumber: "LOT-B", expiryDate: "2031-01-01" },
    ]);
  }

  async function batchIdOf(lot: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM item_batches WHERE item_id = $1 AND batch_number = $2",
      [item.batch, lot],
    );
    return rows[0].id;
  }

  it("relieves named lots at their own cost across multiple lines and keeps the rollup synchronised", async () => {
    const purchase = await batchPurchase();
    const lotA = await batchIdOf("LOT-A");
    const lotB = await batchIdOf("LOT-B");
    const result = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: purchase.id,
        settlementMethod: "accounts_payable",
        reason: "تست",
        idempotencyKey: randomUUID(),
        lines: [
          { itemId: item.batch, quantity: "2", batchId: lotA },
          { itemId: item.batch, quantity: "3", batchId: lotB },
        ],
      }),
    );
    expect(result.supplierCredit).toBe("80000");
    expect(result.value).toBe("80000");

    const lots = await db.query<{ batch_number: string; quantity: string }>(
      "SELECT batch_number, quantity::text FROM item_batches WHERE item_id = $1 ORDER BY batch_number",
      [item.batch],
    );
    expect(lots.rows).toEqual([
      { batch_number: "LOT-A", quantity: "3.000000000" },
      { batch_number: "LOT-B", quantity: "2.000000000" },
    ]);
    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.batch]);
    expect(stock.rows[0].quantity).toBe("5.000000000");
    expect(await journalOf(result.id)).toHaveLength(2);
  });

  it("refuses foreign, depleted and costless lots", async () => {
    const purchase = await batchPurchase();
    const otherPurchase = await receive([
      { itemId: item.batch, quantity: "4", unitCost: 30_000, batchNumber: "LOT-C", expiryDate: "2032-01-01" },
    ]);

    // A lot from another receipt is not this purchase's to return.
    const lotC = await batchIdOf("LOT-C");
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.batch, quantity: "1", batchId: lotC }],
        }),
      ),
    ).rejects.toThrow(/از خریدِ انتخاب‌شده دریافت نشده/);
    expect(otherPurchase.id).toBeTruthy();

    // A lot of another item.
    const otherBatchItem = await itemsService.createItem({ locationId: biz.locationId, name: "کرم دیگر", tracking: "batch" });
    await receive([{ itemId: otherBatchItem.id, quantity: "4", unitCost: 5_000, batchNumber: "LOT-X" }]);
    const { rows: foreignLot } = await db.query<{ id: string }>(
      "SELECT id FROM item_batches WHERE item_id = $1",
      [otherBatchItem.id],
    );
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.batch, quantity: "1", batchId: foreignLot[0].id }],
        }),
      ),
    ).rejects.toThrow(/متعلق به کالای انتخاب‌شده نیست/);

    // A depleted lot.
    const lotA = await batchIdOf("LOT-A");
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.batch, quantity: "99", batchId: lotA }],
        }),
      ),
    ).rejects.toThrow(/موجودی بچ کافی نیست/);

    // A lot with no recorded cost is refused — never silently zero-valued.
    await db.query("UPDATE item_batches SET unit_cost = NULL WHERE item_id = $1 AND batch_number = 'LOT-A'", [item.batch]);
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.batch, quantity: "1", batchId: lotA }],
        }),
      ),
    ).rejects.toThrow(/بهای تمام‌شده/);
  });
});

describe("serial-tracked returns", () => {
  async function serialPurchase() {
    return receive([
      { itemId: item.serial, quantity: "1", unitCost: 30_000_000, serials: [{ serialNumber: "SN-918-A" }] },
      { itemId: item.serial, quantity: "1", unitCost: 32_000_000, serials: [{ serialNumber: "SN-918-B" }] },
    ]);
  }

  it("returns the exact unit and moves it to the terminal state", async () => {
    const purchase = await serialPurchase();
    const result = await withClient((client) =>
      stockService.createItemSupplierReturn(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purchaseId: purchase.id,
        settlementMethod: "accounts_payable",
        reason: "خرابی از کارخانه",
        idempotencyKey: randomUUID(),
        lines: [{ itemId: item.serial, quantity: "1", serialNumber: "SN-918-A" }],
      }),
    );
    expect(result.value).toBe("30000000");
    expect(result.supplierCredit).toBe("30000000");

    const { rows: units } = await db.query<{ serial_number: string; status: string }>(
      "SELECT serial_number, status::text FROM item_serials WHERE item_id = $1 ORDER BY serial_number",
      [item.serial],
    );
    expect(units).toEqual([
      { serial_number: "SN-918-A", status: "supplier_returned" },
      { serial_number: "SN-918-B", status: "in_stock" },
    ]);

    // Returned twice is refused; sold units never go back either.
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "accounts_payable",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.serial, quantity: "1", serialNumber: "SN-918-A" }],
        }),
      ),
    ).rejects.toThrow(/قبلاً به تأمین‌کننده برگشت خورده/);

    await db.query("UPDATE item_serials SET status = 'sold' WHERE item_id = $1 AND serial_number = 'SN-918-B'", [item.serial]);
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "accounts_payable",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.serial, quantity: "1", serialNumber: "SN-918-B" }],
        }),
      ),
    ).rejects.toThrow(/قبلاً فروخته شده/);
  });

  it("proves the unit came from the purchase it names", async () => {
    await serialPurchase();
    const other = await receive([
      { itemId: item.serial, quantity: "1", unitCost: 40_000_000, serials: [{ serialNumber: "SN-918-Z" }] },
    ]);
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: other.id,
          settlementMethod: "accounts_payable",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.serial, quantity: "1", serialNumber: "SN-918-A" }],
        }),
      ),
    ).rejects.toThrow(/از خریدِ انتخاب‌شده دریافت نشده/);
  });
});

describe("retry safety and exact money", () => {
  it("replays same key + same payload as one voucher, and conflicts on same key + changed payload", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);
    const key = randomUUID();
    const base = {
      businessId: biz.id,
      locationId: biz.locationId,
      purchaseId: purchase.id,
      settlementMethod: "accounts_payable" as const,
      reason: "کالای معیوب",
      idempotencyKey: key,
    };

    const first = await withClient((client) =>
      stockService.createItemSupplierReturn(client, { ...base, lines: [{ itemId: item.none, quantity: "2" }] }),
    );
    expect(first.duplicate).toBe(false);

    const replay = await withClient((client) =>
      stockService.createItemSupplierReturn(client, { ...base, lines: [{ itemId: item.none, quantity: "2" }] }),
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.id).toBe(first.id);

    // Same key, changed payload: a hard conflict, never a silent voucher.
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, { ...base, lines: [{ itemId: item.none, quantity: "3" }] }),
      ),
    ).rejects.toThrow(/قبلاً با مشخصات دیگری/);

    // One voucher, one stock effect, one journal.
    const docs = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM item_supplier_returns");
    expect(docs.rows[0].n).toBe("1");
    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.none]);
    expect(stock.rows[0].quantity).toBe("8.000000000");
    const journals = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM domain_events WHERE event_type = 'retail.supplier_return'",
    );
    expect(journals.rows[0].n).toBe("1");
  });

  it("collapses two concurrent identical submissions into one voucher", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);
    const key = randomUUID();
    const payload = {
      businessId: biz.id,
      locationId: biz.locationId,
      purchaseId: purchase.id,
      settlementMethod: "accounts_payable" as const,
      reason: "رقابت همزمان",
      idempotencyKey: key,
      lines: [{ itemId: item.none, quantity: "2" }],
    };

    const attempt = async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        const result = await stockService.createItemSupplierReturn(client, payload);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    };
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const ids = new Set([a.id, b.id]);
    expect(ids.size).toBe(1);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);

    const docs = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM item_supplier_returns");
    expect(docs.rows[0].n).toBe("1");
    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.none]);
    expect(stock.rows[0].quantity).toBe("8.000000000");
  });

  it("refuses null costs, bad scales and out-of-range money instead of mis-posting", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);

    // A stock row with no cost basis (legacy/partial data).
    await db.query("UPDATE item_stock SET unit_cost = NULL WHERE item_id = $1", [item.none]);
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.none, quantity: "1" }],
        }),
      ),
    ).rejects.toThrow(/بهای تمام‌شده/);
    await db.query("UPDATE item_stock SET unit_cost = 50000 WHERE item_id = $1", [item.none]);

    // More fractional digits than numeric(24,9) stores.
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: purchase.id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: item.none, quantity: "1.1234567899" }],
        }),
      ),
    ).rejects.toThrow(/۹ رقم اعشار/);

    // Money past the bigint column (2e9 × 9e9 = 1.8e19 > 9.22e18): a caller
    // error (400), not a 500 with «out of range for type bigint».
    const rich = await itemsService.createItem({ locationId: biz.locationId, name: "کالای سنگین", tracking: "none" });
    await db.query("INSERT INTO item_stock (item_id, quantity, unit_cost) VALUES ($1, 2000000000, 9000000000)", [rich.id]);
    const richPurchase = await db.query<{ id: string }>(
      "INSERT INTO item_purchases (business_id, location_id, supplier_id, total) VALUES ($1, $2, $3, 0) RETURNING id",
      [biz.id, biz.locationId, supplier],
    );
    await db.query(
      "INSERT INTO item_purchase_items (purchase_id, item_id, quantity, unit_cost) VALUES ($1, $2, 2000000000, 9000000000)",
      [richPurchase.rows[0].id, rich.id],
    );
    await expect(
      withClient((client) =>
        stockService.createItemSupplierReturn(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          purchaseId: richPurchase.rows[0].id,
          settlementMethod: "cash",
          reason: "تست",
          idempotencyKey: randomUUID(),
          lines: [{ itemId: rich.id, quantity: "2000000000" }],
        }),
      ),
    ).rejects.toThrow(/بیش از حد مجاز/);
  });
});

describe("concurrency, rollback, reversal and legacy provenance", () => {
  it("serializes two different returns from the same purchase against the cumulative ceiling", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);
    const attempt = (key: string) => withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id,
      settlementMethod: "accounts_payable", reason: "درخواست هم‌زمان", idempotencyKey: key,
      lines: [{ itemId: item.none, quantity: "6" }],
    }));
    const outcomes = await Promise.allSettled([attempt(randomUUID()), attempt(randomUUID())]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const docs = await db.query<{ count: string; quantity: string }>(
      `SELECT count(DISTINCT r.id)::text AS count, COALESCE(SUM(li.quantity),0)::text AS quantity
         FROM item_supplier_returns r JOIN item_supplier_return_items li ON li.return_id = r.id
        WHERE r.purchase_id = $1 AND r.status = 'posted'`,
      [purchase.id],
    );
    expect(docs.rows[0]).toEqual({ count: "1", quantity: "6.000000000" });
    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.none]);
    expect(stock.rows[0].quantity).toBe("4.000000000");
  });

  it("serializes a return against a real concurrent accessory sale", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);
    const { sellAccessoryUnits } = await import("../src/lib/accessories-service");
    const returning = withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id,
      settlementMethod: "accounts_payable", reason: "هم‌زمان با فروش", idempotencyKey: randomUUID(),
      lines: [{ itemId: item.none, quantity: "7" }],
    }));
    const selling = withClient((client) => sellAccessoryUnits(client, {
      businessId: biz.id, locationId: biz.locationId, itemId: item.none,
      quantity: "7", unitPrice: 100_000, vatPercent: 0, paymentMethod: "cash",
    }));
    const outcomes = await Promise.allSettled([returning, selling]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.none]);
    expect(stock.rows[0].quantity).toBe("3.000000000");
    const negative = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM item_stock WHERE item_id = $1 AND quantity < 0", [item.none]);
    expect(negative.rows[0].count).toBe("0");
  });

  it("serializes a return against a real concurrent warehouse transfer", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "10", unitCost: 50_000 }]);
    const destinationItem = await itemsService.createItem({ locationId: biz.otherLocationId, name: "کرم مقصد", tracking: "none" });
    const transfer = await withClient((client) => stockService.createItemTransfer(client, {
      businessId: biz.id, sourceLocationId: biz.locationId, destinationLocationId: biz.otherLocationId,
      idempotencyKey: randomUUID(), lines: [{ sourceItemId: item.none, destinationItemId: destinationItem.id, quantity: "7" }],
    }));
    const returning = withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id,
      settlementMethod: "accounts_payable", reason: "هم‌زمان با انتقال", idempotencyKey: randomUUID(),
      lines: [{ itemId: item.none, quantity: "7" }],
    }));
    const shipping = withClient((client) => stockService.shipItemTransfer(client, {
      businessId: biz.id, transferId: transfer.id, actorId: "",
    }));
    const outcomes = await Promise.allSettled([returning, shipping]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id = $1", [item.none]);
    expect(stock.rows[0].quantity).toBe("3.000000000");
    const negative = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM item_stock WHERE item_id = $1 AND quantity < 0", [item.none]);
    expect(negative.rows[0].count).toBe("0");
  });

  it("rolls back a failure after stock movement, then retries as one voucher, one stock effect and one journal", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "5", unitCost: 10_000 }]);
    await db.query(`CREATE FUNCTION fail_supplier_return_posting_918() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_type = 'item_supplier_return' AND NEW.posting_kind = 'retail_supplier_return' THEN
          RAISE EXCEPTION 'injected supplier return posting failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$`);
    await db.query(`CREATE TRIGGER fail_supplier_return_posting_918 BEFORE INSERT ON journal_entries
      FOR EACH ROW EXECUTE FUNCTION fail_supplier_return_posting_918()`);
    const key = randomUUID();
    try {
      await expect(withClient((client) => stockService.createItemSupplierReturn(client, {
        businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id,
        settlementMethod: "accounts_payable", reason: "تزریق شکست", idempotencyKey: key,
        lines: [{ itemId: item.none, quantity: "2" }],
      }))).rejects.toThrow(/injected supplier return posting failure/);
      const afterRollback = await db.query<{ vouchers: string; journals: string; events: string; quantity: string }>(
        `SELECT
          (SELECT count(*)::text FROM item_supplier_returns WHERE business_id=$1) AS vouchers,
          (SELECT count(*)::text FROM journal_entries WHERE business_id=$1 AND source_type='item_supplier_return') AS journals,
          (SELECT count(*)::text FROM domain_events WHERE business_id=$1 AND event_type='retail.supplier_return') AS events,
          (SELECT quantity::text FROM item_stock WHERE item_id=$2) AS quantity`,
        [biz.id, item.none],
      );
      expect(afterRollback.rows[0]).toEqual({ vouchers: "0", journals: "0", events: "0", quantity: "5.000000000" });
    } finally {
      await db.query("DROP TRIGGER IF EXISTS fail_supplier_return_posting_918 ON journal_entries");
      await db.query("DROP FUNCTION IF EXISTS fail_supplier_return_posting_918()");
    }
    const retry = await withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id,
      settlementMethod: "accounts_payable", reason: "تزریق شکست", idempotencyKey: key,
      lines: [{ itemId: item.none, quantity: "2" }],
    }));
    const afterRetry = await db.query<{ vouchers: string; journals: string; events: string; quantity: string }>(
      `SELECT
        (SELECT count(*)::text FROM item_supplier_returns WHERE business_id=$1) AS vouchers,
        (SELECT count(*)::text FROM journal_entries WHERE business_id=$1 AND source_type='item_supplier_return') AS journals,
        (SELECT count(*)::text FROM domain_events WHERE business_id=$1 AND event_type='retail.supplier_return') AS events,
        (SELECT quantity::text FROM item_stock WHERE item_id=$2) AS quantity`,
      [biz.id, item.none],
    );
    expect(afterRetry.rows[0]).toEqual({ vouchers: "1", journals: "1", events: "1", quantity: "3.000000000" });
    expect(await journalOf(retry.id)).toHaveLength(2);
  });

  it("supports partial prior batch returns and enforces the purchase ceiling", async () => {
    const purchase = await receive([{ itemId: item.batch, quantity: "5", unitCost: 10_000, batchNumber: "B-918" }]);
    const { rows: batches } = await db.query<{ id: string }>("SELECT id FROM item_batches WHERE item_id=$1 AND batch_number='B-918'", [item.batch]);
    const returnPart = (quantity: string) => withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id,
      settlementMethod: "accounts_payable", reason: "برگشت جزئی بچ", idempotencyKey: randomUUID(),
      lines: [{ itemId: item.batch, batchId: batches[0].id, quantity }],
    }));
    await returnPart("2");
    await returnPart("2");
    // Replenish the same lot from another receipt so physical availability is
    // not the limiting check; this third attempt must hit the original
    // purchase's cumulative receipt ceiling, not the lot's current quantity.
    await db.query("UPDATE item_batches SET quantity = quantity + 2 WHERE id = $1", [batches[0].id]);
    await expect(returnPart("2")).rejects.toThrow(/مجموع برگشت‌شده/);
    const result = await db.query<{ quantity: string; returned: string }>(
      `SELECT b.quantity::text,
              (SELECT COALESCE(SUM(li.quantity),0)::text FROM item_supplier_return_items li
                JOIN item_supplier_returns r ON r.id=li.return_id WHERE r.purchase_id=$2 AND r.status='posted') AS returned
         FROM item_batches b WHERE b.id=$1`,
      [batches[0].id, purchase.id],
    );
    expect(result.rows[0]).toEqual({ quantity: "3.000000000", returned: "4.000000000" });
  });

  it("keeps returns from multiple purchases and suppliers isolated", async () => {
    const secondSupplierRow = await db.query<{ id: string }>(
      "INSERT INTO suppliers (location_id, name) VALUES ($1, 'تأمین‌کننده دوم') RETURNING id",
      [biz.locationId],
    );
    const secondSupplier = secondSupplierRow.rows[0].id;
    const firstPurchase = await receive([{ itemId: item.none, quantity: "3", unitCost: 10_000 }]);
    const secondPurchase = await receive([{ itemId: item.none, quantity: "2", unitCost: 20_000 }], { supplierId: secondSupplier });
    const makeReturn = (purchaseId: string, key: string) => withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId,
      settlementMethod: "accounts_payable", reason: "برگشت از خرید جداگانه", idempotencyKey: key,
      lines: [{ itemId: item.none, quantity: "1" }],
    }));
    const first = await makeReturn(firstPurchase.id, randomUUID());
    const second = await makeReturn(secondPurchase.id, randomUUID());
    expect(await attributedSupplierOf(first.id)).toBe(supplier);
    expect(await attributedSupplierOf(second.id)).toBe(secondSupplier);
    const amounts = await db.query<{ purchase_id: string; credit: string }>(
      `SELECT r.purchase_id, li.supplier_credit_rial::text AS credit
         FROM item_supplier_returns r JOIN item_supplier_return_items li ON li.return_id=r.id
        WHERE r.id = ANY($1::uuid[]) ORDER BY r.purchase_id`,
      [[first.id, second.id]],
    );
    expect(amounts.rows.map((row) => row.credit).sort()).toEqual(["10000", "20000"]);
  });

  it("accepts a legacy serial whose purchase_id is NULL when the selected purchase line proves receipt", async () => {
    const purchase = await receive([{
      itemId: item.serial, quantity: "1", unitCost: 25_000,
      serials: [{ serialNumber: "LEGACY-NULL-PURCHASE" }],
    }]);
    await db.query("UPDATE item_serials SET purchase_id = NULL WHERE item_id=$1 AND serial_number='LEGACY-NULL-PURCHASE'", [item.serial]);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM item_serials WHERE item_id=$1 AND serial_number='LEGACY-NULL-PURCHASE'", [item.serial]);
    const result = await withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id,
      settlementMethod: "accounts_payable", reason: "سریال قدیمی بدون شناسه خرید", idempotencyKey: randomUUID(),
      lines: [{ itemId: item.serial, serialId: rows[0].id, quantity: "1" }],
    }));
    expect(result.supplierCredit).toBe("25000");
    const returned = await db.query<{ status: string; purchase_id: string | null }>("SELECT status, purchase_id FROM item_serials WHERE id=$1", [rows[0].id]);
    expect(returned.rows[0]).toEqual({ status: "supplier_returned", purchase_id: null });
  });

  it("reverses stock, AP and the exact GL journal; marks reversed, audits and never creates a second payment", async () => {
    const purchase = await receive([{ itemId: item.none, quantity: "5", unitCost: 10_000 }]);
    const returned = await withClient((client) => stockService.createItemSupplierReturn(client, {
      businessId: biz.id, locationId: biz.locationId, purchaseId: purchase.id,
      settlementMethod: "accounts_payable", reason: "حوالهٔ اولیه", idempotencyKey: randomUUID(),
      lines: [{ itemId: item.none, quantity: "2" }],
    }));
    const reversalKey = randomUUID();
    const reverse = () => withClient((client) => stockService.reverseItemSupplierReturn(client, {
      businessId: biz.id, returnId: returned.id, reason: "ثبت اشتباه", idempotencyKey: reversalKey, actorId: null,
    }));
    const result = await reverse();
    expect(result.duplicate).toBe(false);
    expect(result.reversalEntryId).toBeTruthy();
    const replay = await reverse();
    expect(replay).toMatchObject({ duplicate: true, reversalEntryId: result.reversalEntryId });

    const state = await db.query<{ status: string; reversal_reason: string; reversal_entry_id: string; count: string }>(
      `SELECT r.status, r.reversal_reason, r.reversal_entry_id,
              (SELECT count(*)::text FROM item_supplier_return_items li WHERE li.return_id=r.id) AS count
         FROM item_supplier_returns r WHERE r.id=$1`,
      [returned.id],
    );
    expect(state.rows[0]).toMatchObject({ status: "reversed", reversal_reason: "ثبت اشتباه", reversal_entry_id: result.reversalEntryId, count: "1" });
    const stock = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id=$1", [item.none]);
    expect(stock.rows[0].quantity).toBe("5.000000000");

    const lines = await db.query<{ source_type: string; posting_kind: string; account_id: string; debit: string; credit: string }>(
      `SELECT je.source_type, je.posting_kind, jl.account_id, jl.debit::text, jl.credit::text
         FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
        WHERE je.business_id=$1 AND je.source_type='item_supplier_return' AND je.source_id=$2
        ORDER BY je.posting_kind, jl.account_id`,
      [biz.id, returned.id],
    );
    expect(lines.rows).toHaveLength(4);
    const totals = new Map<string, { debit: bigint; credit: bigint }>();
    for (const line of lines.rows) {
      const current = totals.get(line.account_id) ?? { debit: 0n, credit: 0n };
      current.debit += BigInt(line.debit);
      current.credit += BigInt(line.credit);
      totals.set(line.account_id, current);
    }
    expect(totals.get(acct.ap)).toEqual({ debit: 20_000n, credit: 20_000n });
    expect(totals.get(acct.inventory)).toEqual({ debit: 20_000n, credit: 20_000n });
    const apReconciliation = await db.query<{ net: string }>(
      "SELECT COALESCE(SUM(jl.credit-jl.debit),0)::text AS net FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.business_id=$1 AND jl.account_id=$2",
      [biz.id, acct.ap],
    );
    expect(apReconciliation.rows[0].net).toBe("50000");
    expect(await attributedSupplierOf(returned.id)).toBe(supplier);
    const noSecondPayment = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM ap_payments WHERE business_id=$1 AND supplier_id=$2", [biz.id, supplier]);
    expect(noSecondPayment.rows[0].count).toBe("0");
    const audit = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM audit_log WHERE business_id=$1 AND action='inventory.item_supplier_return.reversed' AND entity_id=$2", [biz.id, returned.id]);
    expect(audit.rows[0].count).toBe("1");
  });
});
