/**
 * Phase 38 — trade-goods industries (wholesale / tools & fittings /
 * haberdashery): variant catalogue, stock at a rolling average cost, and a
 * retail-invoice sale that posts to the trade's own revenue/COGS accounts.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { TRADE_GOODS_INDUSTRIES, type TradeGoodsIndustry } from "../src/lib/trade-goods";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let tradeGoods: typeof import("../src/lib/trade-goods-service");
let retailInvoice: typeof import("../src/lib/retail-invoice-service");

const biz = { id: "", locationId: "" };
const acct = { cash: "", revenue: "", vatPayable: "", cogs: "", inventory: "" };
let trade: TradeGoodsIndustry = "wholesale";

const TRADE_ACCOUNT_CODES: Record<TradeGoodsIndustry, { revenue: string; cogs: string; inventory: string }> = {
  wholesale: { revenue: "4581", cogs: "5181", inventory: "1371" },
  tools_fittings: { revenue: "4582", cogs: "5182", inventory: "1372" },
  haberdashery: { revenue: "4583", cogs: "5183", inventory: "1373" },
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
  databaseName = `pos_trade_goods_${randomUUID().replaceAll("-", "")}`;

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
  tradeGoods = await import("../src/lib/trade-goods-service");
  retailInvoice = await import("../src/lib/retail-invoice-service");

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
  await db.query("ROLLBACK").catch(() => {});
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM promotion_applications");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM order_number_counters");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM item_variant_attributes");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Trade Goods Co', $1, $2) RETURNING id",
    [`trade-${randomUUID().slice(0, 8)}`, trade],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const codes = TRADE_ACCOUNT_CODES[trade];
  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, $2, 'Sales Revenue', 'revenue'),
            ($1, '2200', 'VAT Payable', 'liability'),
            ($1, $3, 'COGS', 'expense'),
            ($1, $4, 'Inventory', 'asset')
     RETURNING id, code`,
    [biz.id, codes.revenue, codes.cogs, codes.inventory],
  );
  const byCode: Record<string, keyof typeof acct> = {
    "1100": "cash",
    [codes.revenue]: "revenue",
    "2200": "vatPayable",
    [codes.cogs]: "cogs",
    [codes.inventory]: "inventory",
  };
  for (const row of accounts.rows) acct[byCode[row.code]] = row.id;
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

describe.each(TRADE_GOODS_INDUSTRIES)(
  "%s sale posts to its own accounts",
  (industry) => {
    beforeAll(() => {
      trade = industry;
    });

    it("writes an invoice, posts revenue+COGS and relieves stock", async () => {
      const parent = await itemsService.createItem({
        locationId: biz.locationId,
        name: "کالای شمارشی",
        kind: "variant_parent",
      });
      const child = await itemsService.createVariantChild(
        parent.id,
        biz.locationId,
        "تنوع یک",
        null,
        [{ name: "واحد", value: "عدد" }],
      );

      await tradeGoods.receiveTradeGoodsStock(child.id, { quantity: "10", unitCost: 50_000 });
      await tradeGoods.setTradeGoodsUnitPrice(child.id, 100_000);

      const invoice = await withTransaction((client) =>
        retailInvoice.createRetailInvoice(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          industry,
          lines: [
            {
              kind: "stocked",
              itemId: child.id,
              quantity: "2",
              unitPrice: 100_000,
              discount: 0,
              vatPercent: 9,
            },
          ],
          tenders: [{ method: "cash" }],
        }),
      );

      expect(invoice.total).toBe("218000");

      const stock = await tradeGoods.getStock(child.id);
      expect(Number(stock?.quantity)).toBe(8);

      const balances = await db.query<{ code: string; credit: string; debit: string }>(
        `SELECT a.code,
                coalesce(sum(jl.credit), 0)::text AS credit,
                coalesce(sum(jl.debit), 0)::text AS debit
           FROM journal_entries je
           JOIN journal_lines jl ON jl.entry_id = je.id
           JOIN accounts a ON a.id = jl.account_id
          WHERE je.business_id = $1
          GROUP BY a.code`,
        [biz.id],
      );
      const byCode = new Map(balances.rows.map((r) => [r.code, r]));

      expect(byCode.get("1100")?.debit).toBe("218000");
      expect(byCode.get(codesFor(industry).revenue)?.credit).toBe("200000");
      expect(byCode.get("2200")?.credit).toBe("18000");
      expect(byCode.get(codesFor(industry).cogs)?.debit).toBe("100000");
      expect(byCode.get(codesFor(industry).inventory)?.credit).toBe("100000");

      const events = await db.query<{ event_type: string }>(
        "SELECT event_type FROM domain_events WHERE business_id = $1 ORDER BY event_type",
        [biz.id],
      );
      expect(events.rows.map((r) => r.event_type).sort()).toEqual([`${industry}.sale_cogs`, `${industry}.sale_revenue`].sort());
    });

    it("sells the same item across two separate invoices without a duplicate-key crash", async () => {
      // Regression test: sellTradeGoodsUnits used to post its revenue/COGS
      // journal entries with `sourceId: input.itemId`. journal_entries has a
      // unique index on (business_id, source_type, source_id, posting_kind),
      // so only the *first* invoice that ever sold a given item could post;
      // a second invoice selling the same item — ordinary for stock a shop
      // expects to sell many times — threw a raw duplicate-key error.
      const parent = await itemsService.createItem({
        locationId: biz.locationId,
        name: "کالای شمارشی",
        kind: "variant_parent",
      });
      const child = await itemsService.createVariantChild(
        parent.id,
        biz.locationId,
        "تنوع یک",
        null,
        [{ name: "واحد", value: "عدد" }],
      );

      await tradeGoods.receiveTradeGoodsStock(child.id, { quantity: "10", unitCost: 50_000 });
      await tradeGoods.setTradeGoodsUnitPrice(child.id, 100_000);

      const line = {
        kind: "stocked" as const,
        itemId: child.id,
        quantity: "1",
        unitPrice: 100_000,
        discount: 0,
        vatPercent: 9,
      };

      const first = await withTransaction((client) =>
        retailInvoice.createRetailInvoice(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          industry,
          lines: [line],
          tenders: [{ method: "cash" }],
        }),
      );

      const second = await withTransaction((client) =>
        retailInvoice.createRetailInvoice(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          industry,
          lines: [line],
          tenders: [{ method: "cash" }],
        }),
      );

      expect(second.total).toBe(first.total);
      const stock = await tradeGoods.getStock(child.id);
      expect(Number(stock?.quantity)).toBe(8);

      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text FROM journal_entries WHERE business_id = $1 AND source_type = $2`,
        [biz.id, `${industry}_sale`],
      );
      expect(rows[0].count).toBe("4");
    });
  },
);

function codesFor(industry: TradeGoodsIndustry) {
  return TRADE_ACCOUNT_CODES[industry];
}
