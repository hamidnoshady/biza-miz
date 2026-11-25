/**
 * #1567 Phase 5 — retail intelligence for a fashion tenant, on the shared
 * report and merchandising engines (no fashion fork).
 *
 *   5.1 collection / season tagging feeds sell-through; a markdown on a slow
 *       size posts to the fashion inventory account 1374
 *   5.2 per-size/colour sales, margin on POSTED COGS, dead-stock / aging and
 *       low-stock read the fashion SKUs, never the style parent
 *   5.4 every report is branch-scoped: one branch's sales never appear in
 *       another's
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { rialText } from "../src/lib/inventory-exact";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let retailInvoice: typeof import("../src/lib/retail-invoice-service");
let stockService: typeof import("../src/lib/retail-stock-service");
let brands: typeof import("../src/lib/item-brands-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let merch: typeof import("../src/lib/merchandising-service");
let tradeReports: typeof import("../src/lib/trade-reports-service");

const biz = { id: "", main: "", branch: "", ownerId: "" };

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
  databaseName = `pos_fashion_intel_${randomUUID().replaceAll("-", "")}`;
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
  stockService = await import("../src/lib/retail-stock-service");
  brands = await import("../src/lib/item-brands-service");
  provisioning = await import("../src/lib/business-provisioning");
  merch = await import("../src/lib/merchandising-service");
  tradeReports = await import("../src/lib/trade-reports-service");

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

/** A fashion business with two branches and the real fashion chart of accounts. */
async function seedFashionBusiness(): Promise<{ id: string; main: string; branch: string; ownerId: string }> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Boutique', $1, 'fashion_apparel') RETURNING id",
    [`boutique-${randomUUID().slice(0, 8)}`],
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
    await provisioning.seedChartOfAccounts(client, id, "fashion_apparel");
  } finally {
    client.release();
  }
  return { id, main: locRows.rows[0].id, branch: locRows.rows[1].id, ownerId: user.rows[0].id };
}

beforeEach(async () => {
  Object.assign(biz, await seedFashionBusiness());
});

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

/** Debit/credit of one journal entry, by account code. */
async function entryLines(entryId: string): Promise<Array<{ code: string; debit: string; credit: string }>> {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, jl.debit::text, jl.credit::text
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = $1 ORDER BY jl.debit DESC, a.code`,
    [entryId],
  );
  return rows;
}

/** Net debit−credit by account code for the business, optionally one event type's entries. */
async function net(businessId = biz.id): Promise<Map<string, bigint>> {
  const { rows } = await db.query<{ code: string; net: string }>(
    `SELECT a.code, (coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0))::text AS net
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id = je.id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1
      GROUP BY a.code`,
    [businessId],
  );
  return new Map(rows.map((r) => [r.code, BigInt(r.net)]));
}

async function expectBalanced(businessId = biz.id): Promise<void> {
  const totals = [...(await net(businessId)).values()].reduce((a, b) => a + b, 0n);
  expect(totals).toBe(0n);
}

async function purchase(locationId: string, lines: Array<{ itemId: string; quantity: string; unitCost: number }>) {
  return tx((client) => stockService.receiveItemPurchase(client, { businessId: biz.id, locationId, lines }));
}

type CartLine = { itemId: string; quantity: string; unitPrice: number; discount?: number };

async function sell(
  locationId: string,
  lines: CartLine[],
  options: { tenders?: Array<{ method: "cash" | "bank" | "credit"; amount?: string }>; clientRequestId?: string } = {},
) {
  return tx((client) =>
    retailInvoice.createRetailInvoice(client, {
      businessId: biz.id,
      locationId,
      industry: "fashion_apparel",
      lines: lines.map((l) => ({
        kind: "stocked" as const,
        itemId: l.itemId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount ?? 0,
        vatPercent: 9,
      })),
      tenders: (options.tenders ?? [{ method: "cash" }]).map((t) =>
        t.amount ? { method: t.method, amount: rialText(t.amount) } : { method: t.method },
      ),
      clientRequestId: options.clientRequestId ?? null,
    }),
  );
}

/** One style with a child per size × colour cell, at one branch. */
async function grid(locationId: string, sizes: string[], colours: string[], name = "شومیز SH-200"): Promise<Record<string, string>> {
  const parent = await itemsService.createItem({ locationId, name, kind: "variant_parent" });
  const out: Record<string, string> = { parent: parent.id };
  for (const size of sizes) {
    for (const colour of colours) {
      const child = await itemsService.createVariantChild(parent.id, locationId, `${name} ${size} ${colour}`, null, [
        { name: "سایز", value: size },
        { name: "رنگ", value: colour },
      ]);
      out[`${size}/${colour}`] = child.id;
    }
  }
  return out;
}

async function report(key: string, locationId: string, todayIso = new Date().toISOString().slice(0, 10)): Promise<Array<Record<string, unknown>>> {
  const result = await tradeReports.runTradeReport(key, { businessId: biz.id, locationId, industry: "fashion_apparel", todayIso });
  expect(result, key).not.toBeNull();
  return (result as { rows: Array<Record<string, unknown>> }).rows;
}

describe("5.2 / 5.4 per-SKU sales, posted-COGS margin, branch scoping", () => {
  it("reports each size/colour with its own revenue and posted cost, per branch", async () => {
    const main = await grid(biz.main, ["S", "M"], ["مشکی", "سفید"]);
    const branch = await grid(biz.branch, ["M"], ["مشکی"]);
    await purchase(biz.main, [
      { itemId: main["S/مشکی"], quantity: "5", unitCost: 50_000 },
      { itemId: main["M/مشکی"], quantity: "10", unitCost: 50_000 },
      { itemId: main["M/سفید"], quantity: "10", unitCost: 60_000 },
    ]);
    await purchase(biz.branch, [{ itemId: branch["M/مشکی"], quantity: "4", unitCost: 50_000 }]);

    await sell(biz.main, [
      { itemId: main["M/مشکی"], quantity: "3", unitPrice: 100_000 },
      { itemId: main["M/سفید"], quantity: "1", unitPrice: 120_000, discount: 20_000 },
    ]);
    await sell(biz.branch, [{ itemId: branch["M/مشکی"], quantity: "1", unitPrice: 100_000 }]);

    const mainRows = await report("variant_sales", biz.main);
    const byId = new Map(mainRows.map((r) => [r.itemId as string, r]));
    expect(mainRows).toHaveLength(2); // sold SKUs only; never the style parent
    expect(byId.has(main.parent)).toBe(false);
    expect(byId.get(main["M/مشکی"])).toMatchObject({
      parentName: "شومیز SH-200",
      quantitySold: "3",
      netRevenue: 300_000,
      cogs: 150_000,
      margin: 150_000,
    });
    expect(byId.get(main["M/مشکی"])!.attributes).toEqual([
      { name: "رنگ", value: "مشکی" },
      { name: "سایز", value: "M" },
    ]);
    // Discounted line: net revenue after the line discount, cost at its own basis.
    expect(byId.get(main["M/سفید"])).toMatchObject({ quantitySold: "1", netRevenue: 100_000, cogs: 60_000, margin: 40_000 });

    // The report's cost equals what the ledger actually posted to fashion COGS.
    const posted = await net();
    const reportedCogs = [...mainRows, ...(await report("variant_sales", biz.branch))].reduce(
      (sum, r) => sum + BigInt(r.cogs as number),
      0n,
    );
    expect(posted.get("5184")).toBe(reportedCogs);

    // 5.4 branch scoping: the branch sees only its own single sale.
    const branchRows = await report("variant_sales", biz.branch);
    expect(branchRows).toHaveLength(1);
    expect(branchRows[0]).toMatchObject({ itemId: branch["M/مشکی"], quantitySold: "1", netRevenue: 100_000, cogs: 50_000 });
  });

  it("dead-stock and low-stock read fashion SKUs, valued at cost, per branch", async () => {
    const main = await grid(biz.main, ["S", "M"], ["مشکی"]);
    await purchase(biz.main, [
      { itemId: main["S/مشکی"], quantity: "5", unitCost: 50_000 },
      { itemId: main["M/مشکی"], quantity: "1", unitCost: 50_000 },
    ]);
    await sell(biz.main, [{ itemId: main["M/مشکی"], quantity: "1", unitPrice: 100_000 }]);

    // Dead = no sale (or, never sold, no receipt) in 90 days: report as of 100 days from now.
    const later = new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10);
    expect(await report("dead_stock", biz.main)).toEqual([]); // fresh stock is not dead today
    const dead = await report("dead_stock", biz.main, later);
    const deadIds = dead.map((r) => r.itemId);
    // Never sold S is dead stock worth 5 × 50,000 at cost; the parent is not a stock row.
    expect(deadIds).toContain(main["S/مشکی"]);
    expect(deadIds).not.toContain(main.parent);
    expect(dead.find((r) => r.itemId === main["S/مشکی"])).toMatchObject({ valueRial: 250_000 });
    expect(await report("dead_stock", biz.branch, later)).toEqual([]);

    const low = await report("low_stock", biz.main);
    const lowIds = low.map((r) => r.itemId);
    // M sold out → reported; S still has stock; parent never.
    expect(lowIds).toContain(main["M/مشکی"]);
    expect(lowIds).not.toContain(main.parent);
    expect(await report("low_stock", biz.branch)).toEqual([]);
  });
});

describe("5.1 collections, seasons and markdowns", () => {
  it("groups sell-through by collection/season off the fashion sale events", async () => {
    const summer = await grid(biz.main, ["M"], ["سفید"], "تاپ تابستانی");
    const winter = await grid(biz.main, ["M"], ["مشکی"], "پالتو زمستانی");
    await brands.updateItemProfile(summer["M/سفید"], { collection: "تابستان ۱۴۰۵", season: "summer" });
    await brands.updateItemProfile(winter["M/مشکی"], { collection: "زمستان ۱۴۰۵", season: "winter" });
    await purchase(biz.main, [
      { itemId: summer["M/سفید"], quantity: "5", unitCost: 40_000 },
      { itemId: winter["M/مشکی"], quantity: "5", unitCost: 200_000 },
    ]);
    await sell(biz.main, [
      { itemId: summer["M/سفید"], quantity: "2", unitPrice: 80_000 },
      { itemId: winter["M/مشکی"], quantity: "1", unitPrice: 400_000 },
    ]);

    const rows = await merch.sellThroughByCollection(biz.id, biz.main, { eventPrefix: "fashion_apparel" });
    expect(rows).toEqual([
      { collection: "زمستان ۱۴۰۵", season: "winter", quantitySold: "1", netRevenue: 400_000 },
      { collection: "تابستان ۱۴۰۵", season: "summer", quantitySold: "2", netRevenue: 160_000 },
    ]);
    expect(await merch.sellThroughByCollection(biz.id, biz.branch, { eventPrefix: "fashion_apparel" })).toEqual([]);
  });

  it("lists a slow size as a markdown candidate and posts its write-down against fashion inventory 1374", async () => {
    const style = await grid(biz.main, ["XL"], ["سرمه‌ای"], "کت رسمی");
    const xl = style["XL/سرمه‌ای"];
    await purchase(biz.main, [{ itemId: xl, quantity: "4", unitCost: 300_000 }]);
    await db.query("UPDATE item_stock SET unit_price = 900000 WHERE item_id = $1", [xl]);

    const candidates = await merch.listMarkdownCandidates(biz.id, biz.main, new Date().toISOString().slice(0, 10));
    const candidate = candidates.find((c) => c.itemId === xl);
    expect(candidate).toBeTruthy();
    expect(candidates.some((c) => c.itemId === style.parent)).toBe(false);

    const applied = await tx((client) =>
      merch.applyMarkdown(client, {
        businessId: biz.id,
        locationId: biz.main,
        itemId: xl,
        newPrice: 600_000,
        inventoryAccountCode: "1374",
        createdBy: biz.ownerId,
      }),
    );
    expect(applied.entryId).toBeTruthy();
    // Account routing only: Dr write-down expense 5170 / Cr fashion inventory 1374,
    // equal and opposite. (The amount rule itself is shared merchandising code —
    // see the checklist's "Noticed" section.)
    const lines = await entryLines(applied.entryId!);
    const dr = lines.filter((l) => l.debit !== "0");
    const cr = lines.filter((l) => l.credit !== "0");
    expect(dr.map((l) => l.code)).toEqual(["5170"]);
    expect(cr.map((l) => l.code)).toEqual(["1374"]);
    expect(dr[0].debit).toBe(cr[0].credit);
    const price = await db.query<{ unit_price: string }>("SELECT unit_price::text FROM item_stock WHERE item_id=$1", [xl]);
    expect(Number(price.rows[0].unit_price)).toBe(600_000);
    await expectBalanced();
  });
});
