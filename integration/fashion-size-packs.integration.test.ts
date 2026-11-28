// GH #1567 Phase 6C — virtual size packs against a real database.
//
// A pack owns no stock: selling it must relieve exactly the component
// variants (WAC COGS per variant), atomically, exactly once, with a snapshot
// that survives later edits; returns and voids go through the existing
// per-line services; stock and GL reconcile at the end.
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { quantityText, rialText } from "../src/lib/inventory-exact";

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
let returns: typeof import("../src/lib/customer-return-service");
let voids: typeof import("../src/lib/retail-invoice-void-service");
let packs: typeof import("../src/lib/fashion-size-pack-service");
let barcodes: typeof import("../src/lib/item-barcodes-service");

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
  databaseName = `pos_size_packs_${randomUUID().replaceAll("-", "")}`;
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
  returns = await import("../src/lib/customer-return-service");
  voids = await import("../src/lib/retail-invoice-void-service");
  packs = await import("../src/lib/fashion-size-pack-service");
  barcodes = await import("../src/lib/item-barcodes-service");
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
  const parsed = productInput.parseProductCreateInput({
    name: `پیراهن ${label}`,
    sku: `DR-${label}`,
    unit: "عدد",
    taxSalePercent: 9,
    sellPrice: 120_000,
    variants: ["S", "M", "L"].map((size) => ({
      sku: `DR-${label}-${size}`,
      barcode: ean13(),
      attributes: [{ name: "سایز", value: size }, { name: "رنگ", value: "مشکی" }],
    })),
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  const created = await productCreation.createProductRecord(tenant.locationId, parsed.data);
  const bySize = async (size: string) => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT i.id FROM items i JOIN item_variant_attributes a ON a.item_id = i.id AND a.name = 'سایز' AND a.value = $2
        WHERE i.parent_item_id = $1`,
      [created.item.id, size],
    );
    return rows[0].id;
  };
  const [s, m, l] = [await bySize("S"), await bySize("M"), await bySize("L")];
  await tx((client) => stockService.receiveItemPurchase(client, {
    businessId: tenant.businessId,
    locationId: tenant.locationId,
    lines: [
      { itemId: s, quantity: "5", unitCost: UNIT_COST },
      { itemId: m, quantity: "5", unitCost: UNIT_COST },
      { itemId: l, quantity: "3", unitCost: UNIT_COST },
    ],
  }));
  const actor = { businessId: tenant.businessId, userId: tenant.userId };
  return { tenant, actor, styleId: created.item.id, s, m, l };
}

type Ctx = Awaited<ReturnType<typeof seed>>;

/** What POST /api/sales/invoices does with pack lines, in one transaction. */
function sell(ctx: Ctx, lines: unknown[], key: string | null, locationId = ctx.tenant.locationId, industry: "fashion_apparel" | "accessories" = "fashion_apparel") {
  return tx(async (client) => {
    const plan = await packs.expandSizePackInvoiceLines(
      client,
      { businessId: ctx.tenant.businessId, locationId, industry, clientRequestId: key, createdBy: ctx.tenant.userId },
      lines as never,
    );
    const invoice = await retailInvoice.createRetailInvoice(client, {
      businessId: ctx.tenant.businessId,
      locationId,
      industry,
      lines: plan.lines,
      tenders: [{ method: "cash" }],
      clientRequestId: key,
      createdBy: ctx.tenant.userId,
    });
    await packs.recordSizePackSales(client, plan, invoice);
    return invoice;
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).constructor.name;
  }
}

describe("virtual size packs (GH #1567 6C)", () => {
  let ctx: Ctx;
  let packId: string;

  it("defines a pack whose price is the component sum and whose availability is derived", async () => {
    ctx = await seed("pk");
    const pack = await packs.saveSizePack(ctx.actor, ctx.tenant.locationId, {
      name: "بستهٔ عمده ۵تایی",
      barcode: "PACK-0001",
      components: [
        { itemId: ctx.s, quantity: 1, unitPriceRial: 80_000 },
        { itemId: ctx.m, quantity: 2, unitPriceRial: 80_000 },
        { itemId: ctx.l, quantity: 2, unitPriceRial: 85_000 },
      ],
    });
    packId = pack.id;
    expect(pack).toMatchObject({ priceRial: 410_000, pieces: 5, available: 1, version: 1 });
    // A pack owns no stock row of its own.
    const { rows } = await db.query("SELECT 1 FROM item_stock WHERE item_id = $1", [pack.id]);
    expect(rows).toHaveLength(0);

    const { rows: itemCode } = await db.query<{ code: string }>("SELECT code FROM item_barcodes WHERE item_id = $1", [ctx.s]);
    expect(await codeOf(packs.saveSizePack(ctx.actor, ctx.tenant.locationId, {
      name: "تداخل بارکد", barcode: itemCode[0].code, components: [{ itemId: ctx.s, quantity: 1, unitPriceRial: 1 }],
    }))).toBe("pack_barcode_taken");
    expect(await codeOf(packs.saveSizePack(ctx.actor, ctx.tenant.locationId, {
      name: "مادر", components: [{ itemId: ctx.styleId, quantity: 1, unitPriceRial: 1 }],
    }))).toBe("item_is_variant_parent");
    // …and the reverse: an item may not take a pack's code (a scan must be unambiguous).
    await expect(barcodes.assignBarcode(ctx.m, { code: "PACK-0001" })).rejects.toBeInstanceOf(barcodes.BarcodeConflictError);
    const scanned = await packs.lookupSizePackByBarcode(ctx.actor, ctx.tenant.locationId, "PACK-0001");
    expect(scanned?.id).toBe(pack.id);
    const matrix = await packs.styleMatrix(ctx.actor, ctx.tenant.locationId, ctx.styleId);
    expect(matrix.axes).toEqual(["رنگ", "سایز"]);
    expect(matrix.cells).toHaveLength(3);
  });

  it("refuses a shortage per variant and moves nothing", async () => {
    const err = await sell(ctx, [{ kind: "size_pack", packId, quantity: 2, vatPercent: 9 }], `short-${randomUUID()}`).catch((e) => e);
    expect(err).toBeInstanceOf(packs.SizePackError);
    expect(err.code).toBe("pack_shortage");
    expect(err.detail.shortages.map((s: { itemId: string; missing: string }) => [s.itemId, s.missing])).toEqual([[ctx.l, "1"]]);
    expect([await stockOf(ctx.s), await stockOf(ctx.m), await stockOf(ctx.l)]).toEqual([5, 5, 3]);
  });

  let firstOrder: string;
  const firstKey = `till-${randomUUID()}`;

  it("sells a pack once: per-variant relief, WAC COGS, revenue at wholesale, snapshot", async () => {
    const invoice = await sell(ctx, [{ kind: "size_pack", packId, quantity: 1, vatPercent: 9 }], firstKey);
    firstOrder = invoice.orderId;
    expect(invoice.lines.map((l) => [l.itemId, l.quantity, l.net])).toEqual([
      [ctx.s, "1", "80000"], [ctx.m, "2", "160000"], [ctx.l, "2", "170000"],
    ]);
    expect([await stockOf(ctx.s), await stockOf(ctx.m), await stockOf(ctx.l)]).toEqual([4, 3, 1]);
    const gl = await net(ctx.tenant.businessId);
    expect(gl.get("1374")).toBe(BigInt(8 * UNIT_COST));
    expect(gl.get("5184")).toBe(BigInt(5 * UNIT_COST));
    expect(gl.get("4584")).toBe(-410_000n);
    const sales = await packs.listSizePackSales(ctx.actor, ctx.tenant.locationId, { orderId: firstOrder });
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ packVersion: 1, packQuantity: 1, totalRial: 410_000, status: "sold" });
    expect(sales[0].components.map((c) => c.orderItemId)).toEqual(invoice.lines.map((l) => l.orderItemId));
  });

  it("a retry replays the original sale even after the pack's price changed; a changed request conflicts", async () => {
    const edited = await packs.saveSizePack(ctx.actor, ctx.tenant.locationId, {
      name: "بستهٔ عمده ۵تایی",
      barcode: "PACK-0001",
      components: [
        { itemId: ctx.s, quantity: 1, unitPriceRial: 90_000 },
        { itemId: ctx.m, quantity: 2, unitPriceRial: 90_000 },
        { itemId: ctx.l, quantity: 2, unitPriceRial: 90_000 },
      ],
    }, packId);
    expect(edited).toMatchObject({ version: 2, priceRial: 450_000 });
    const replay = await sell(ctx, [{ kind: "size_pack", packId, quantity: 1, vatPercent: 9 }], firstKey);
    expect(replay.orderId).toBe(firstOrder);
    expect([await stockOf(ctx.s), await stockOf(ctx.m), await stockOf(ctx.l)]).toEqual([4, 3, 1]);
    const { rows } = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM item_size_pack_sales WHERE order_id = $1", [firstOrder]);
    expect(rows[0].n).toBe("1");
    expect(await codeOf(sell(ctx, [{ kind: "size_pack", packId, quantity: 2, vatPercent: 9 }], firstKey))).toBe("RetailRequestConflictError");
    // The snapshot still says what was sold.
    const [sale] = await packs.listSizePackSales(ctx.actor, ctx.tenant.locationId, { orderId: firstOrder });
    expect(sale).toMatchObject({ packVersion: 1, totalRial: 410_000 });
    await expect(db.query("UPDATE item_size_pack_sales SET total_rial = 0 WHERE order_id = $1", [firstOrder])).rejects.toThrow(/append-only/);
  });

  let racedOrder: string;

  it("two tills racing for the last pack: exactly one sells, stock never goes negative", async () => {
    await tx((client) => stockService.receiveItemPurchase(client, {
      businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId,
      lines: [{ itemId: ctx.l, quantity: "2", unitCost: UNIT_COST }],
    }));
    // Now S4 M3 L3: exactly one more pack.
    const results = await Promise.allSettled([
      sell(ctx, [{ kind: "size_pack", packId, quantity: 1, vatPercent: 9 }], `race-a-${randomUUID()}`),
      sell(ctx, [{ kind: "size_pack", packId, quantity: 1, vatPercent: 9 }], `race-b-${randomUUID()}`),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    racedOrder = (won[0] as PromiseFulfilledResult<{ orderId: string }>).value.orderId;
    expect([await stockOf(ctx.s), await stockOf(ctx.m), await stockOf(ctx.l)]).toEqual([3, 1, 1]);
    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM item_size_pack_sales WHERE pack_id = $1", [packId]);
    expect(rows[0].n).toBe("2");
  });

  it("partial then full return per component; voiding a pack sale restores every variant", async () => {
    const [sale] = await packs.listSizePackSales(ctx.actor, ctx.tenant.locationId, { orderId: firstOrder });
    const lineOf = (itemId: string) => sale.components.find((c) => c.itemId === itemId)!.orderItemId;
    const doReturn = (key: string, lines: { orderItemId: string; quantity: string }[], refund: string) =>
      tx((client) => returns.createCustomerReturn(client, {
        businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId, orderId: firstOrder,
        refundMethod: "cash", refundAmount: rialText(refund), reason: key, idempotencyKey: key, createdBy: ctx.tenant.userId,
        lines: lines.map((l) => ({ orderItemId: l.orderItemId, quantity: quantityText(l.quantity), disposition: "restockable" as const })),
      }));
    await doReturn("pack-partial", [{ orderItemId: lineOf(ctx.m), quantity: "1" }], "87200");
    expect((await packs.listSizePackSales(ctx.actor, ctx.tenant.locationId, { orderId: firstOrder }))[0].status).toBe("partially_returned");
    await doReturn("pack-rest", [
      { orderItemId: lineOf(ctx.s), quantity: "1" },
      { orderItemId: lineOf(ctx.m), quantity: "1" },
      { orderItemId: lineOf(ctx.l), quantity: "2" },
    ], "359700");
    expect((await packs.listSizePackSales(ctx.actor, ctx.tenant.locationId, { orderId: firstOrder }))[0].status).toBe("returned");
    expect([await stockOf(ctx.s), await stockOf(ctx.m), await stockOf(ctx.l)]).toEqual([4, 3, 3]);

    await tx((client) => voids.voidRetailInvoice(client, {
      businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId, orderId: racedOrder,
      actorId: ctx.tenant.userId, reason: "لغو فروش بسته",
    }));
    expect([await stockOf(ctx.s), await stockOf(ctx.m), await stockOf(ctx.l)]).toEqual([5, 5, 5]);
    expect((await packs.listSizePackSales(ctx.actor, ctx.tenant.locationId, { orderId: racedOrder }))[0].status).toBe("voided");

    // Reconciliation: every unit back on hand at its cost, no COGS left, books balance.
    const gl = await net(ctx.tenant.businessId);
    expect(gl.get("1374")).toBe(BigInt(15 * UNIT_COST));
    expect(gl.get("5184") ?? 0n).toBe(0n);
    expect([...gl.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
  });

  it("is branch- and tenant-isolated and fashion-only", async () => {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه دو') RETURNING id", [ctx.tenant.businessId]);
    const branch = rows[0].id;
    expect(await packs.listSizePacks(ctx.actor, branch)).toEqual([]);
    expect(await codeOf(sell(ctx, [{ kind: "size_pack", packId, quantity: 1, vatPercent: 9 }], null, branch))).toBe("pack_not_found");
    const other = await seed("ot");
    expect(await codeOf(packs.getSizePack(other.actor, other.tenant.locationId, packId))).toBe("pack_not_found");
    expect(await codeOf(sell(other, [{ kind: "size_pack", packId, quantity: 1, vatPercent: 9 }], null))).toBe("pack_not_found");
    expect(await codeOf(sell(ctx, [{ kind: "size_pack", packId, quantity: 1, vatPercent: 9 }], null, ctx.tenant.locationId, "accessories"))).toBe("pack_industry_mismatch");
    // RLS: a tenant session sees no other tenant's packs, even by direct query.
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE ROLE size_pack_probe NOLOGIN");
      await client.query("GRANT SELECT ON item_size_packs TO size_pack_probe");
      await client.query("SELECT set_config('app.business_id', $1, true)", [other.tenant.businessId]);
      await client.query("SET LOCAL ROLE size_pack_probe");
      const { rows: visible } = await client.query("SELECT id FROM item_size_packs");
      expect(visible).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("one scannable code per branch, enforced by the database (GH #1567 C3)", () => {
  async function holdInOpenTransaction(sql: string, params: unknown[]): Promise<Client> {
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(sql, params);
    return holder;
  }

  it("an item barcode not yet committed makes a concurrent pack save with the same code fail on the constraint (the pre-check cannot see it)", async () => {
    const ctx = await seed("rc");
    const code = ean13();
    const holder = await holdInOpenTransaction(
      "INSERT INTO item_barcodes (location_id, item_id, code, symbology) VALUES ($1, $2, $3, 'EAN13')", [ctx.tenant.locationId, ctx.m, code]);
    try {
      const pending = codeOf(packs.saveSizePack(ctx.actor, ctx.tenant.locationId, {
        name: "بستهٔ هم‌زمان", barcode: code, components: [{ itemId: ctx.s, quantity: 1, unitPriceRial: 1 }],
      }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      await holder.query("COMMIT");
      expect(await pending).toBe("pack_barcode_taken");
    } finally {
      await holder.end();
    }
    const { rows } = await db.query("SELECT owner_kind FROM location_scan_codes WHERE location_id = $1 AND code = $2", [ctx.tenant.locationId, code]);
    expect(rows).toEqual([{ owner_kind: "item_barcode" }]);
    expect((await db.query("SELECT 1 FROM item_size_packs WHERE location_id = $1 AND barcode = $2", [ctx.tenant.locationId, code])).rows).toHaveLength(0);
  });

  it("and the reverse: a pack barcode not yet committed makes a concurrent item barcode fail with the readable conflict", async () => {
    const ctx = await seed("rv");
    const code = ean13();
    const holder = await holdInOpenTransaction(
      "INSERT INTO item_size_packs (business_id, location_id, name, barcode) VALUES ($1, $2, 'بستهٔ باز', $3)",
      [ctx.tenant.businessId, ctx.tenant.locationId, code]);
    try {
      const pending = barcodes.assignBarcode(ctx.l, { code }).then(() => "resolved", (e: unknown) => (e as Error).constructor.name);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await holder.query("COMMIT");
      expect(await pending).toBe("BarcodeConflictError");
    } finally {
      await holder.end();
    }
    expect((await db.query("SELECT 1 FROM item_barcodes WHERE location_id = $1 AND code = $2", [ctx.tenant.locationId, code])).rows).toHaveLength(0);
  });

  it("keeps the registry in step on edit and delete, and the same code is free at another branch", async () => {
    const ctx = await seed("ed");
    const first = ean13();
    const second = ean13();
    const pack = await packs.saveSizePack(ctx.actor, ctx.tenant.locationId, {
      name: "بستهٔ ویرایشی", barcode: first, components: [{ itemId: ctx.s, quantity: 1, unitPriceRial: 1 }],
    });
    await packs.saveSizePack(ctx.actor, ctx.tenant.locationId, {
      name: "بستهٔ ویرایشی", barcode: second, components: [{ itemId: ctx.s, quantity: 1, unitPriceRial: 1 }],
    }, pack.id);
    const codes = async () => (await db.query<{ code: string }>(
      "SELECT code FROM location_scan_codes WHERE owner_kind = 'size_pack' AND owner_id = $1", [pack.id])).rows.map((r) => r.code);
    expect(await codes()).toEqual([second]);
    // The released code can now go to an item.
    await barcodes.assignBarcode(ctx.m, { code: first });
    const other = await seed("ed2");
    await packs.saveSizePack(other.actor, other.tenant.locationId, {
      name: "شعبهٔ دیگر", barcode: first, components: [{ itemId: other.s, quantity: 1, unitPriceRial: 1 }],
    });
    await db.query("DELETE FROM item_barcodes WHERE item_id = $1 AND code = $2", [ctx.m, first]);
    expect((await db.query("SELECT 1 FROM location_scan_codes WHERE location_id = $1 AND code = $2", [ctx.tenant.locationId, first])).rows).toHaveLength(0);
  });

  it("migration 0334 records and clears an existing pack/item collision instead of failing, and the pack screen says so until it is saved", async () => {
    const ctx = await seed("mg");
    const { rows: [{ code }] } = await db.query<{ code: string }>("SELECT code FROM item_barcodes WHERE item_id = $1", [ctx.s]);
    // Reproduce what the old race could leave behind.
    await db.query("ALTER TABLE item_size_packs DISABLE TRIGGER item_size_packs_scan_code");
    let packId: string;
    try {
      packId = (await db.query<{ id: string }>(
        "INSERT INTO item_size_packs (business_id, location_id, name, barcode) VALUES ($1, $2, 'بستهٔ قدیمی', $3) RETURNING id",
        [ctx.tenant.businessId, ctx.tenant.locationId, code])).rows[0].id;
      await db.query("INSERT INTO item_size_pack_components (pack_id, business_id, item_id, position, quantity, unit_price_rial) VALUES ($1, $2, $3, 0, 1, 1)",
        [packId, ctx.tenant.businessId, ctx.s]);
    } finally {
      await db.query("ALTER TABLE item_size_packs ENABLE TRIGGER item_size_packs_scan_code");
    }
    await db.query(readFileSync(path.join(process.cwd(), "migrations/0334_location_scan_codes.sql"), "utf8"));

    const { rows: [pack] } = await db.query<{ barcode: string | null; version: number }>("SELECT barcode, version FROM item_size_packs WHERE id = $1", [packId]);
    expect(pack).toEqual({ barcode: null, version: 2 });
    const { rows: collisions } = await db.query("SELECT code, kept_kind, cleared_kind, cleared_name, resolved_at FROM scan_code_collisions WHERE cleared_id = $1", [packId]);
    expect(collisions).toEqual([{ code, kept_kind: "item_barcode", cleared_kind: "size_pack", cleared_name: "بستهٔ قدیمی", resolved_at: null }]);
    expect((await db.query("SELECT owner_kind FROM location_scan_codes WHERE location_id = $1 AND code = $2", [ctx.tenant.locationId, code])).rows)
      .toEqual([{ owner_kind: "item_barcode" }]);
    // The item, its stock and the ledger are untouched.
    expect(await stockOf(ctx.s)).toBe(5);

    const listed = (await packs.listSizePacks(ctx.actor, ctx.tenant.locationId)).find((p) => p.id === packId);
    expect(listed?.clearedBarcode).toBe(code);
    const fresh = ean13();
    const saved = await packs.saveSizePack(ctx.actor, ctx.tenant.locationId, {
      name: "بستهٔ قدیمی", barcode: fresh, components: [{ itemId: ctx.s, quantity: 1, unitPriceRial: 1 }],
    }, packId);
    expect(saved).toMatchObject({ barcode: fresh, clearedBarcode: null });
  });
});
