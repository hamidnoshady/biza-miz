// GH #1567 Phase 6E — advisory merchandising suggestions against a real
// database: a fast seller, a broken size run, an overstocked size and a dead
// line produce exactly the expected advice with its provenance; consigned
// goods are left out; the report is branch-scoped; running it (directly and
// through the assistant's read-only run_report tool) writes nothing at all.
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let productInput: typeof import("../src/lib/product-input");
let productCreation: typeof import("../src/lib/product-creation-service");
let stockService: typeof import("../src/lib/retail-stock-service");
let retailInvoice: typeof import("../src/lib/retail-invoice-service");
let consignment: typeof import("../src/lib/fashion-consignment-service");
let trade: typeof import("../src/lib/trade-reports-service");
let aiTools: typeof import("../src/lib/ai-tools");
let reports: typeof import("../src/lib/reports");

const UNIT_COST = 50_000;
let barcodeCounter = Math.floor(Math.random() * 1e8);

function ean13(): string {
  const body = `21${String(barcodeCounter++).padStart(10, "0")}`;
  const sum = [...body].reduce((acc, digit, i) => acc + Number(digit) * (i % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

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
  databaseName = `pos_merch_advice_${randomUUID().replaceAll("-", "")}`;
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
  provisioning = await import("../src/lib/business-provisioning");
  productInput = await import("../src/lib/product-input");
  productCreation = await import("../src/lib/product-creation-service");
  stockService = await import("../src/lib/retail-stock-service");
  retailInvoice = await import("../src/lib/retail-invoice-service");
  consignment = await import("../src/lib/fashion-consignment-service");
  trade = await import("../src/lib/trade-reports-service");
  aiTools = await import("../src/lib/ai-tools");
  reports = await import("../src/lib/reports");
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

async function stockOf(itemId: string): Promise<number> {
  const { rows } = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id=$1", [itemId]);
  return rows[0] ? Number(rows[0].quantity) : 0;
}

async function net(businessId: string): Promise<Map<string, bigint>> {
  const { rows } = await db.query<{ code: string; net: string }>(
    `SELECT a.code, (coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0))::text AS net
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1 GROUP BY a.code`,
    [businessId],
  );
  return new Map(rows.map((r) => [r.code, BigInt(r.net)]));
}

async function style(locationId: string, name: string, sku: string, sizes: string[], colour = "مشکی") {
  const parsed = productInput.parseProductCreateInput({
    name, sku, unit: "عدد", taxSalePercent: 9, sellPrice: 120_000,
    variants: sizes.map((size) => ({ sku: `${sku}-${size}`, barcode: ean13(), attributes: [{ name: "سایز", value: size }, { name: "رنگ", value: colour }] })),
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  const created = await productCreation.createProductRecord(locationId, parsed.data);
  const ids: Record<string, string> = {};
  for (const size of sizes) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT i.id FROM items i JOIN item_variant_attributes a ON a.item_id = i.id AND a.name = 'سایز' AND a.value = $2
        WHERE i.parent_item_id = $1`,
      [created.item.id, size],
    );
    ids[size] = rows[0].id;
  }
  return { id: created.item.id, ids };
}

async function seed(label: string) {
  const tenant = await provisioning.provisionBusiness({
    businessName: `بوتیک ${label}`,
    ownerName: "مالک",
    email: `owner-${label}-${randomUUID().slice(0, 8)}@example.com`,
    password: "correct-horse",
    subdomain: `${label}${randomUUID().slice(0, 8)}`,
    industry: "fashion_apparel",
    seedChartOfAccounts: true,
  });
  const dress = await style(tenant.locationId, `پیراهن ${label}`, `DR-${label}`, ["S", "M", "L"]);
  const coat = await style(tenant.locationId, `کت ${label}`, `CT-${label}`, ["L"], "طوسی");
  const scarf = await style(tenant.locationId, `شال ${label}`, `SC-${label}`, ["M"], "کرم");
  const actor = { businessId: tenant.businessId, userId: tenant.userId };
  return { tenant, actor, styleId: dress.id, s: dress.ids.S, m: dress.ids.M, l: dress.ids.L, coat: coat.ids.L, scarf: scarf.ids.M };
}

type Ctx = Awaited<ReturnType<typeof seed>>;

function sell(ctx: Ctx, lines: unknown[], key: string | null = null) {
  return tx((client) => retailInvoice.createRetailInvoice(client, {
    businessId: ctx.tenant.businessId,
    locationId: ctx.tenant.locationId,
    industry: "fashion_apparel",
    lines: lines as never,
    tenders: [{ method: "cash" }],
    clientRequestId: key,
    createdBy: ctx.tenant.userId,
  }));
}


async function receive(ctx: Ctx, lines: { itemId: string; quantity: string }[]) {
  await tx((client) => stockService.receiveItemPurchase(client, {
    businessId: ctx.tenant.businessId,
    locationId: ctx.tenant.locationId,
    lines: lines.map((l) => ({ ...l, unitCost: UNIT_COST })),
  }));
}

/** Every row count a write could touch, plus the GL — to prove a read writes nothing. */
async function fingerprint(businessId: string) {
  const { rows } = await db.query<{ t: string; n: string }>(
    `SELECT 'journal_entries' AS t, count(*)::text AS n FROM journal_entries WHERE business_id = $1
     UNION ALL SELECT 'domain_events', count(*)::text FROM domain_events WHERE business_id = $1
     UNION ALL SELECT 'item_stock', coalesce(sum(s.quantity), 0)::text || '@' || coalesce(max(s.updated_at)::text, '') FROM item_stock s JOIN items i ON i.id = s.item_id JOIN locations l ON l.id = i.location_id WHERE l.business_id = $1
     UNION ALL SELECT 'orders', count(*)::text FROM orders o JOIN locations l ON l.id = o.location_id WHERE l.business_id = $1
     UNION ALL SELECT 'audit_log', count(*)::text FROM audit_log WHERE business_id = $1
     UNION ALL SELECT 'items_updated', coalesce(max(i.updated_at)::text, '') FROM items i JOIN locations l ON l.id = i.location_id WHERE l.business_id = $1`,
    [businessId],
  );
  return { counts: Object.fromEntries(rows.map((r) => [r.t, r.n])), gl: Object.fromEntries([...(await net(businessId))].map(([k, v]) => [k, String(v)])) };
}

type Advice = import("../src/lib/fashion-merchandising-advice").AdviceReport;

describe("fashion advisory merchandising suggestions (GH #1567 6E)", () => {
  let ctx: Ctx;
  let advice: Advice;

  it("is a fashion-only standard report", async () => {
    expect(reports.standardReportsFor("fashion_apparel").map((r) => r.key)).toContain("fashion_merchandising_advice");
    expect(reports.standardReportsFor("haberdashery").map((r) => r.key)).not.toContain("fashion_merchandising_advice");
  });

  it("produces exactly the expected advice, with provenance, from real sales and stock", async () => {
    ctx = await seed("ma");
    // Dress: M 6 → sells 5 (fast); L 40 → sells 2 (overstock); S never stocked (size gap).
    // Coat: 5 on hand, never sells (markdown). Scarf: consigned (excluded).
    await receive(ctx, [{ itemId: ctx.m, quantity: "6" }, { itemId: ctx.l, quantity: "40" }, { itemId: ctx.coat, quantity: "5" }]);
    const owner = await consignment.createConsignorRecord(ctx.actor, ctx.tenant.locationId, { name: "کارگاه شال", phone: null, notes: null });
    const contract = await consignment.createContract(ctx.actor, ctx.tenant.locationId, {
      reference: "SC-1", consignorId: owner.id, startsOn: "2026-01-01", expiresOn: null, notes: null,
      lines: [{ itemId: ctx.scarf, terms: "commission", ownerUnitPriceRial: null, commissionBp: 2_000, retailPriceRial: 300_000 }],
    });
    await consignment.receiveConsignedGoods(ctx.actor, ctx.tenant.locationId, contract.id, {
      idempotencyKey: "scarf-in-1", expectedVersion: contract.version, note: null, lines: [{ lineId: contract.lines[0].id, quantity: 3 }],
    });
    await sell(ctx, [{ kind: "stocked", itemId: ctx.m, quantity: "5", vatPercent: 9 }]);
    await sell(ctx, [{ kind: "stocked", itemId: ctx.l, quantity: "2", vatPercent: 9 }]);
    await sell(ctx, [{ kind: "stocked", itemId: ctx.scarf, quantity: "1", vatPercent: 9 }]);

    const today = new Date().toISOString().slice(0, 10);
    const before = await fingerprint(ctx.tenant.businessId);
    advice = (await trade.runTradeReport("fashion_merchandising_advice", {
      businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId, industry: "fashion_apparel", todayIso: today,
    })) as unknown as Advice;
    expect(await fingerprint(ctx.tenant.businessId)).toEqual(before);
    // Deterministic: a second read of the same window is identical (no wall clock in the payload).
    expect(await trade.runTradeReport("fashion_merchandising_advice", {
      businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId, industry: "fashion_apparel", todayIso: today,
    })).toEqual(advice);

    expect(advice.advisory).toBe(true);
    expect(advice.window.days).toBe(56);
    expect(advice.window.to).toBe(today);
    expect(advice.summary).toEqual({ reorder: 1, size_gap: 1, overstock: 1, markdown_review: 1, excludedConsigned: 1 });
    const byItem = new Map(advice.rows.map((r) => [r.itemId, r]));
    // M: 5 in 8 weeks = 0.625/week, 1 left = 1.6 weeks → ceil(0.625 × 8 − 1) = 4.
    expect(byItem.get(ctx.m)).toMatchObject({ kind: "reorder", suggestedQuantity: 4, confidence: "medium" });
    expect(byItem.get(ctx.m)!.metrics).toMatchObject({ soldUnits: 5, onHand: 1, velocityPerWeek: 0.63, coverWeeks: 1.6, unitCostRial: UNIT_COST });
    // S: style sold 7 → 0.875/week × 8 × ⅓ = 2.33 → 2.
    expect(byItem.get(ctx.s)).toMatchObject({ kind: "size_gap", suggestedQuantity: 2 });
    expect(byItem.get(ctx.s)!.metrics.styleSoldUnits).toBe(7);
    // L: 38 left at 0.25/week = 152 weeks.
    expect(byItem.get(ctx.l)).toMatchObject({ kind: "overstock", suggestedQuantity: null });
    expect(byItem.get(ctx.l)!.metrics.coverWeeks).toBe(152);
    expect(byItem.get(ctx.coat)).toMatchObject({ kind: "markdown_review" });
    expect(byItem.get(ctx.coat)!.metrics.valueAtCostRial).toBe(5 * UNIT_COST);
    expect(byItem.has(ctx.scarf)).toBe(false);
    for (const row of advice.rows) {
      expect(row.provenance.rule).toBeTruthy();
      expect(row.provenance.formula).toBeTruthy();
      expect(row.reason).toBeTruthy();
    }
  });

  it("the assistant's read-only run_report returns the same advisory payload and writes nothing", async () => {
    const before = await fingerprint(ctx.tenant.businessId);
    const result = await aiTools.runReadTool("run_report", { key: "fashion_merchandising_advice" }, ctx.tenant.businessId, undefined, ctx.tenant.userId);
    expect(result.ok).toBe(true);
    const data = result.data as unknown as Advice & { label: string };
    expect(data.advisory).toBe(true);
    expect(data.notice).toContain("هیچ خرید");
    expect(data.rows.map((r) => [r.kind, r.itemId, r.suggestedQuantity])).toEqual(advice.rows.map((r) => [r.kind, r.itemId, r.suggestedQuantity]));
    expect(await fingerprint(ctx.tenant.businessId)).toEqual(before);
  });

  it("is branch-scoped: another branch's sales and stock never appear", async () => {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه دو') RETURNING id", [ctx.tenant.businessId]);
    const other = (await trade.runTradeReport("fashion_merchandising_advice", {
      businessId: ctx.tenant.businessId, locationId: rows[0].id, industry: "fashion_apparel",
    })) as unknown as Advice;
    expect(other.rows).toEqual([]);
    // A tenant's report never reads another tenant's branch, even if asked for it.
    const stranger = await seed("mb");
    const cross = (await trade.runTradeReport("fashion_merchandising_advice", {
      businessId: stranger.tenant.businessId, locationId: ctx.tenant.locationId, industry: "fashion_apparel",
    })) as unknown as Advice;
    expect(cross.rows).toEqual([]);
  });
});
