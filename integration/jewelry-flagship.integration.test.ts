/**
 * Phase 27 Wave 9 — the jewelry flagship: gold buy-back, gram-denominated
 * layaway, and the customer gold account (حساب طلایی).
 *
 * The load-bearing claims: buy-back creates a scrap weight item and posts
 * Debit goldInventory / Credit cash; a layaway deposit credits the
 * customer-deposit liability and completing it recognizes revenue; the gold
 * account posts a deposit as Debit inventory / Credit customer-gold
 * liability, and a withdrawal as its reverse, with the gram balance a SUM.
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
let flagship: typeof import("../src/lib/jewelry-flagship-service");
let prices: typeof import("../src/lib/gold-prices-service");

const biz = { id: "", locationId: "" };
const acct = { goldInventory: "", cash: "", goldRevenue: "", deposit: "", goldAccount: "" };
const customer = { id: "" };

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
  databaseName = `pos_jewelry_${randomUUID().replaceAll("-", "")}`;

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
  flagship = await import("../src/lib/jewelry-flagship-service");
  prices = await import("../src/lib/gold-prices-service");

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
  await db.query("DELETE FROM gold_account_movements");
  await db.query("DELETE FROM layaway_plans");
  await db.query("DELETE FROM custom_order_tickets");
  await db.query("DELETE FROM gold_prices");
  await db.query("DELETE FROM item_weight_attributes");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Jewelry Co', $1, 'jewelry') RETURNING id",
    [`jewelry-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const custRow = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name) VALUES ($1, 'مشتری طلا') RETURNING id",
    [biz.id],
  );
  customer.id = custRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1320', 'Gold inventory', 'asset'),
            ($1, '1100', 'Cash', 'asset'),
            ($1, '4500', 'Gold sales revenue', 'revenue'),
            ($1, '2430', 'Customer deposits', 'liability'),
            ($1, '2450', 'Gold customer account', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1320") acct.goldInventory = row.id;
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "4500") acct.goldRevenue = row.id;
    if (row.code === "2430") acct.deposit = row.id;
    if (row.code === "2450") acct.goldAccount = row.id;
  }
});

describe("native jewelry barcode labels", () => {
  it("assigns a branch-locked supplied barcode atomically and refuses duplicates", async () => {
    const { createItem } = await import("../src/lib/items-service");
    const { assignBarcode } = await import("../src/lib/item-barcodes-service");
    const item = await createItem({ locationId: biz.locationId, name: "قطعه", tracking: "weight" });
    const assign = () => dbLib.withTenantTransaction(biz.id, async (client) => {
      const lock = await client.query("SELECT id FROM items WHERE id = $1 AND location_id = $2 FOR UPDATE", [item.id, biz.locationId]);
      expect(lock.rows).toHaveLength(1);
      return assignBarcode(item.id, { code: "2000000000015" }, client);
    }, { locationId: biz.locationId });
    expect((await assign()).code).toBe("2000000000015");
    await expect(assign()).rejects.toThrow("این بارکد قبلاً");
    const result = await db.query("SELECT code, location_id FROM item_barcodes WHERE item_id = $1", [item.id]);
    expect(result.rows).toEqual([{ code: "2000000000015", location_id: biz.locationId }]);
  });
  it("renders the real piece purity and exact net weight from its own branch", async () => {
    const items = await import("../src/lib/items-service");
    const { getLabelPrintData } = await import("../src/lib/printing/label-print-data");
    const { labelToPrintDocument } = await import("../src/lib/printing/document-bridge");
    const { builtInTemplate, renderPrintTemplate } = await import("../src/lib/print-template");
    const item = await items.createItem({ locationId: biz.locationId, name: "انگشتر", tracking: "weight" });
    await items.setWeightAttributes(item.id, { purity: "18", grossWeight: "3.5", netWeight: "3.123456789", unitCostPerGram: "10000" });
    await db.query("INSERT INTO item_barcodes (location_id, item_id, code) VALUES ($1, $2, $3)", [biz.locationId, item.id, "2000000000015"]);
    const data = await dbLib.withTenant(biz.id, () => getLabelPrintData({ businessId: biz.id, locationId: biz.locationId, itemId: item.id }));
    expect(data?.label.fields).toContainEqual({ label: "عیار", value: "۱۸" });
    expect(data?.label.fields).toContainEqual({ label: "وزن", value: "۳٫۱۲۳۴۵۶۷۸۹ گرم خالص" });
    const html = renderPrintTemplate(builtInTemplate("label57x40-label")!, labelToPrintDocument(data!.label));
    expect(html).toContain("۳٫۱۲۳۴۵۶۷۸۹ گرم خالص"); expect(html).toContain("2000000000015"); expect(html).toContain("<svg");
    expect(html).not.toContain("بهای خرید");
    const { rows: branches } = await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Other') RETURNING id", [biz.id]);
    expect(await dbLib.withTenant(biz.id, () => getLabelPrintData({ businessId: biz.id, locationId: branches[0].id, itemId: item.id }))).toBeNull();
  });
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

describe("buy-back", () => {
  it("creates a scrap weight item and posts Debit inventory / Credit cash", async () => {
    await prices.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 6_000_000, buyPricePerGram: 5_000_000 });

    const result = await withClient((client) =>
      flagship.buyBackGold(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        purity: "18",
        grossWeight: "10",
        karsorPercent: 2,
        buyPricePerGram: 5_000_000,
      }),
    );
    expect(result.valueRial).toBe(49_000_000);

    const weight = await db.query<{ net_weight: string; unit_cost_per_gram: string }>(
      "SELECT net_weight::text, unit_cost_per_gram::text FROM item_weight_attributes WHERE item_id = $1",
      [result.itemId],
    );
    expect(Number(weight.rows[0].net_weight)).toBe(9.8);

    const entry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'jewelry.gold_buy_back'",
    );
    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entry.rows[0].entry_id],
    );
    expect(lines).toEqual([
      { account_id: acct.goldInventory, debit: "49000000", credit: "0" },
      { account_id: acct.cash, debit: "0", credit: "49000000" },
    ]);
  });
});

describe("layaway", () => {
  it("credits the deposit liability and recognizes revenue on completion", async () => {
    const plan = await withClient((client) =>
      flagship.openLayaway(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        grams: "5",
        pricePerGram: 6_000_000,
        depositRial: 10_000_000,
      }),
    );
    expect(plan.totalValueRial).toBe(30_000_000);

    await withClient((client) => flagship.payLayaway(client, { businessId: biz.id, planId: plan.id, amount: 20_000_000 }));

    // Both payments credited the deposit liability.
    const depositEntry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'jewelry.layaway_deposit' ORDER BY created_at",
    );
    const { rows: depositLines } = await db.query<{ debit: string; credit: string }>(
      "SELECT debit, credit FROM journal_lines WHERE entry_id = ANY($1::uuid[]) ORDER BY debit DESC",
      [depositEntry.rows.map((r) => r.entry_id)],
    );
    expect(depositLines.reduce((s, l) => s + Number(l.debit), 0)).toBe(30_000_000);

    await withClient((client) => flagship.completeLayaway(client, { businessId: biz.id, planId: plan.id }));

    const complete = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'jewelry.layaway_completed'",
    );
    const { rows: completeLines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [complete.rows[0].entry_id],
    );
    expect(completeLines).toEqual([
      { account_id: acct.deposit, debit: "30000000", credit: "0" },
      { account_id: acct.goldRevenue, debit: "0", credit: "30000000" },
    ]);
  });
});

describe("gold account", () => {
  it("posts deposits and withdrawals as inventory vs customer-gold liability", async () => {
    await withClient((client) =>
      flagship.recordGoldAccountMovement(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        grams: "100",
        pricePerGram: 6_000_000,
        reason: "سپرده طلا",
        sourceType: "test",
      }),
    );
    await withClient((client) =>
      flagship.recordGoldAccountMovement(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        customerId: customer.id,
        grams: "-40",
        pricePerGram: 6_000_000,
        reason: "برداشت طلا",
        sourceType: "test",
      }),
    );

    expect((await flagship.goldAccountBalance(biz.id, customer.id)).toFixed()).toBe("60");

    const events = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'jewelry.gold_account_movement' ORDER BY created_at",
    );
    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = ANY($1::uuid[]) ORDER BY debit DESC",
      [events.rows.map((r) => r.entry_id)],
    );
    // Deposit: Debit inventory 600M / Credit gold account 600M; withdrawal reverses 240M.
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.account_id === acct.goldInventory && l.debit === "600000000")).toBe(true);
    expect(lines.some((l) => l.account_id === acct.goldAccount && l.credit === "600000000")).toBe(true);
    expect(lines.some((l) => l.account_id === acct.goldAccount && l.debit === "240000000")).toBe(true);
    expect(lines.some((l) => l.account_id === acct.goldInventory && l.credit === "240000000")).toBe(true);
  });

  it("refuses a withdrawal beyond the balance", async () => {
    await expect(
      withClient((client) =>
        flagship.recordGoldAccountMovement(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          customerId: customer.id,
          grams: "-1",
          pricePerGram: 6_000_000,
          sourceType: "test",
        }),
      ),
    ).rejects.toThrow(/حساب طلایی/);
  });
});
