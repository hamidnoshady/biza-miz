// GH #1567 Phase 6D — the fashion consignment accounting contract, against a
// real database. Every row of the contract table in src/lib/fashion-consignment.ts
// is asserted here as GL account balances and consigned on-hand:
//   receive → memorandum only; sale → Dr cash / Cr VAT / Cr 2110 / Cr 4700, no
//   COGS; customer return → restock + reclass; void → exact reversal; return to
//   owner → quantity only; settlement → Dr 2110 / Cr cash; expiry/close gates.
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
let consignment: typeof import("../src/lib/fashion-consignment-service");
let sizePacks: typeof import("../src/lib/fashion-size-pack-service");
let onlineSale: typeof import("../src/lib/retail-online-sale-service");

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
  databaseName = `pos_consignment_${randomUUID().replaceAll("-", "")}`;
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
  consignment = await import("../src/lib/fashion-consignment-service");
  sizePacks = await import("../src/lib/fashion-size-pack-service");
  onlineSale = await import("../src/lib/retail-online-sale-service");
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
    lines: [{ itemId: s, quantity: "5", unitCost: UNIT_COST }],
  }));
  const actor = { businessId: tenant.businessId, userId: tenant.userId };
  return { tenant, actor, styleId: created.item.id, s, m, l };
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

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    const code = (error as { code?: string }).code;
    // A pg error's code is its SQLSTATE; the meaningful part is its message.
    return code && !/^[0-9A-Z]{5}$/.test(code) ? code : (error as Error).message;
  }
}

async function onHandOf(lineId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT received_qty - sold_qty + customer_returned_qty + voided_qty - returned_to_owner_qty AS n
       FROM fashion_consignment_lines WHERE id = $1`, [lineId]);
  return rows[0].n;
}

describe("fashion consignment by contract (GH #1567 6D)", () => {
  let ctx: Ctx;
  let contractId: string;
  let lineM: string;
  let lineL: string;
  let firstOrder: string;
  let version: number;
  const OWNED_VALUE = BigInt(5 * UNIT_COST); // S × 5, the only owned stock

  it("receipt from the owner is a memorandum: consigned on-hand only, no item_stock, no GL", async () => {
    ctx = await seed("cs");
    const owner = await consignment.createConsignorRecord(ctx.actor, ctx.tenant.locationId, { name: "تولیدی نگار", phone: "09120000000", notes: null });
    const contract = await consignment.createContract(ctx.actor, ctx.tenant.locationId, {
      reference: "C-1401", consignorId: owner.id, startsOn: "2026-01-01", expiresOn: "2030-12-31", notes: null,
      lines: [
        { itemId: ctx.m, terms: "owner_price", ownerUnitPriceRial: 600_000, commissionBp: null, retailPriceRial: 1_000_000 },
        { itemId: ctx.l, terms: "commission", ownerUnitPriceRial: null, commissionBp: 2_500, retailPriceRial: 800_000 },
      ],
    });
    contractId = contract.id;
    lineM = contract.lines.find((l) => l.itemId === ctx.m)!.id;
    lineL = contract.lines.find((l) => l.itemId === ctx.l)!.id;
    expect(contract.status).toBe("open");

    const before = await net(ctx.tenant.businessId);
    const received = await consignment.receiveConsignedGoods(ctx.actor, ctx.tenant.locationId, contractId, {
      idempotencyKey: "receive-0001", expectedVersion: contract.version, note: null,
      lines: [{ lineId: lineM, quantity: 4 }, { lineId: lineL, quantity: 3 }],
    });
    version = received.version;
    expect([await onHandOf(lineM), await onHandOf(lineL)]).toEqual([4, 3]);
    expect([await stockOf(ctx.m), await stockOf(ctx.l)]).toEqual([0, 0]);
    expect(await net(ctx.tenant.businessId)).toEqual(before);
    expect(before.get("1374")).toBe(OWNED_VALUE);
    expect(received.outstandingRial).toBe(0);

    // Same key + same payload replays; same key + different payload conflicts; a stale version conflicts.
    const replay = await consignment.receiveConsignedGoods(ctx.actor, ctx.tenant.locationId, contractId, {
      idempotencyKey: "receive-0001", expectedVersion: contract.version, note: null,
      lines: [{ lineId: lineM, quantity: 4 }, { lineId: lineL, quantity: 3 }],
    });
    expect(replay.version).toBe(version);
    expect(await onHandOf(lineM)).toBe(4);
    expect(await codeOf(consignment.receiveConsignedGoods(ctx.actor, ctx.tenant.locationId, contractId, {
      idempotencyKey: "receive-0001", expectedVersion: version, note: null, lines: [{ lineId: lineM, quantity: 1 }],
    }))).toBe("idempotency_conflict");
    expect(await codeOf(consignment.receiveConsignedGoods(ctx.actor, ctx.tenant.locationId, contractId, {
      idempotencyKey: "receive-0002", expectedVersion: version - 1, note: null, lines: [{ lineId: lineM, quantity: 1 }],
    }))).toBe("version_conflict");
  });

  it("a sale credits the owner's share to 2110 and only the commission to 4700 — no revenue, no COGS", async () => {
    const invoice = await sell(ctx, [
      { kind: "stocked", itemId: ctx.m, quantity: "2", vatPercent: 9 },
      { kind: "stocked", itemId: ctx.l, quantity: "1", vatPercent: 9 },
    ], `cons-${randomUUID()}`);
    firstOrder = invoice.orderId;
    // M: net 2,000,000 → owner 2 × 600,000; L: net 800,000 → commission 25% = 200,000.
    const gl = await net(ctx.tenant.businessId);
    expect(gl.get("2110")).toBe(-1_800_000n);
    expect(gl.get("4700")).toBe(-1_000_000n);
    expect(gl.get("2200")).toBe(-252_000n);
    expect(gl.get("1100")).toBe(3_052_000n);
    expect(gl.get("4584") ?? 0n).toBe(0n);
    expect(gl.get("5184") ?? 0n).toBe(0n);
    expect(gl.get("1374")).toBe(OWNED_VALUE);
    expect([await onHandOf(lineM), await onHandOf(lineL)]).toEqual([2, 2]);

    const { rows } = await db.query<{ retail_snapshot: { consignment?: { ownerShare: string; commission: string } } }>(
      "SELECT retail_snapshot FROM order_items WHERE order_id = $1 ORDER BY created_at", [firstOrder]);
    expect(rows.map((r) => [r.retail_snapshot.consignment?.ownerShare, r.retail_snapshot.consignment?.commission]))
      .toEqual([["1200000", "800000"], ["600000", "200000"]]);
    const { rows: moves } = await db.query("SELECT 1 FROM fashion_consignment_movements WHERE kind = 'sale' AND order_id = $1", [firstOrder]);
    expect(moves).toHaveLength(2);

    // Below the owner's price is refused; more than on hand is refused; nothing moves.
    expect(await codeOf(sell(ctx, [{ kind: "stocked", itemId: ctx.m, quantity: "1", unitPrice: 500_000, vatPercent: 9 }])))
      .toBe("below_owner_price");
    expect(await codeOf(sell(ctx, [{ kind: "stocked", itemId: ctx.m, quantity: "3", vatPercent: 9 }]))).toBe("consignment_shortage");
    expect(await onHandOf(lineM)).toBe(2);
    expect((await net(ctx.tenant.businessId)).get("2110")).toBe(-1_800_000n);
  });

  it("owned and consigned units of one variant never mix", async () => {
    // An owned purchase into a variant holding consigned units is refused by the database.
    expect(await codeOf(tx((client) => stockService.receiveItemPurchase(client, {
      businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId,
      lines: [{ itemId: ctx.m, quantity: "1", unitCost: UNIT_COST }],
    })))).toContain("consigned_variant_owned_stock");
    // Consigned goods cannot be received into a variant the shop holds owned stock of.
    const owner = await consignment.createConsignorRecord(ctx.actor, ctx.tenant.locationId, { name: "کارگاه دوم", phone: null, notes: null });
    const other = await consignment.createContract(ctx.actor, ctx.tenant.locationId, {
      reference: "C-1402", consignorId: owner.id, startsOn: "2026-01-01", expiresOn: null, notes: null,
      lines: [{ itemId: ctx.s, terms: "commission", ownerUnitPriceRial: null, commissionBp: 3_000, retailPriceRial: 500_000 }],
    });
    expect(await codeOf(consignment.receiveConsignedGoods(ctx.actor, ctx.tenant.locationId, other.id, {
      idempotencyKey: "receive-owned-s", expectedVersion: other.version, note: null, lines: [{ lineId: other.lines[0].id, quantity: 1 }],
    }))).toBe("item_has_owned_stock");
    // An item is on at most one open contract.
    expect(await codeOf(consignment.createContract(ctx.actor, ctx.tenant.locationId, {
      reference: "C-1403", consignorId: owner.id, startsOn: "2026-01-01", expiresOn: null, notes: null,
      lines: [{ itemId: ctx.m, terms: "commission", ownerUnitPriceRial: null, commissionBp: 1_000, retailPriceRial: null }],
    }))).toBe("item_on_open_contract");
    // The owned variant still sells through the owned path (revenue + COGS), untouched by consignment.
    await sell(ctx, [{ kind: "stocked", itemId: ctx.s, quantity: "1", vatPercent: 9 }]);
    const gl = await net(ctx.tenant.businessId);
    expect(gl.get("5184")).toBe(BigInt(UNIT_COST));
    expect(gl.get("1374")).toBe(OWNED_VALUE - BigInt(UNIT_COST));
  });

  it("a customer return restocks for the owner and reverses share and commission exactly; discarded is refused", async () => {
    const { rows: lines } = await db.query<{ id: string; item_id: string }>(
      "SELECT id, item_id FROM order_items WHERE order_id = $1", [firstOrder]);
    const orderLine = (itemId: string) => lines.find((l) => l.item_id === itemId)!.id;
    const doReturn = (key: string, orderItemId: string, refund: string, disposition: "restockable" | "discarded" = "restockable") =>
      tx((client) => returns.createCustomerReturn(client, {
        businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId, orderId: firstOrder,
        refundMethod: "cash", refundAmount: rialText(refund), reason: key, idempotencyKey: key, createdBy: ctx.tenant.userId,
        lines: [{ orderItemId, quantity: quantityText("1"), disposition }],
      }));

    expect(await codeOf(doReturn("cons-discard", orderLine(ctx.l), "872000", "discarded"))).toBe("consignment_return_must_restock");
    expect(await onHandOf(lineL)).toBe(2);

    const before = await net(ctx.tenant.businessId);
    await doReturn("cons-ret-1", orderLine(ctx.m), "1090000");
    let gl = await net(ctx.tenant.businessId);
    expect(await onHandOf(lineM)).toBe(3);
    expect(gl.get("2110")! - before.get("2110")!).toBe(600_000n);
    expect(gl.get("4700")! - before.get("4700")!).toBe(400_000n);
    expect((gl.get("4400") ?? 0n) - (before.get("4400") ?? 0n)).toBe(0n);
    expect(gl.get("1100")! - before.get("1100")!).toBe(-1_090_000n);

    await doReturn("cons-ret-2", orderLine(ctx.m), "1090000");
    gl = await net(ctx.tenant.businessId);
    expect(await onHandOf(lineM)).toBe(4);
    // Both M units back: M's whole share and commission reversed; only L's sale remains.
    expect(gl.get("2110")).toBe(-600_000n);
    expect(gl.get("4700")).toBe(-200_000n);
    expect(gl.get("4400") ?? 0n).toBe(0n);
  });

  it("voiding a consigned sale reverses its entry and puts the units back on the owner's shelf", async () => {
    const before = await net(ctx.tenant.businessId);
    const invoice = await sell(ctx, [{ kind: "stocked", itemId: ctx.l, quantity: "2", vatPercent: 9 }]);
    expect(await onHandOf(lineL)).toBe(0);
    await tx((client) => voids.voidRetailInvoice(client, {
      businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId, orderId: invoice.orderId,
      actorId: ctx.tenant.userId, reason: "اشتباه صندوق",
    }));
    expect(await onHandOf(lineL)).toBe(2);
    const after = await net(ctx.tenant.businessId);
    for (const code of ["2110", "4700", "2200", "1100"]) expect(after.get(code) ?? 0n).toBe(before.get(code) ?? 0n);
  });

  it("settlement pays the owner down to the contract's outstanding payable and never beyond", async () => {
    let contract = (await consignment.getContract(ctx.actor, ctx.tenant.locationId, contractId)).contract;
    expect(contract.outstandingRial).toBe(600_000);
    expect(BigInt(-contract.outstandingRial)).toBe((await net(ctx.tenant.businessId)).get("2110"));
    expect(await codeOf(consignment.settleWithOwner(ctx.actor, ctx.tenant.locationId, contractId, {
      idempotencyKey: "settle-too-much", amountRial: 600_001, method: "cash", note: null,
    }))).toBe("settlement_exceeds_payable");
    const cashBefore = (await net(ctx.tenant.businessId)).get("1100")!;
    contract = await consignment.settleWithOwner(ctx.actor, ctx.tenant.locationId, contractId, {
      idempotencyKey: "settle-0001", amountRial: 400_000, method: "cash", note: "پرداخت آذر",
    });
    // A retry of the same settlement pays nothing twice.
    await consignment.settleWithOwner(ctx.actor, ctx.tenant.locationId, contractId, {
      idempotencyKey: "settle-0001", amountRial: 400_000, method: "cash", note: "پرداخت آذر",
    });
    const gl = await net(ctx.tenant.businessId);
    expect(contract.outstandingRial).toBe(200_000);
    expect(gl.get("2110")).toBe(-200_000n);
    expect(gl.get("1100")).toBe(cashBefore - 400_000n);
    version = contract.version;
  });

  it("after expiry nothing new is sold or taken in; unsold goods go back; close needs zero on hand", async () => {
    await db.query("UPDATE fashion_consignment_contracts SET expires_on = '2026-02-01' WHERE id = $1", [contractId]);
    expect(await codeOf(sell(ctx, [{ kind: "stocked", itemId: ctx.m, quantity: "1", vatPercent: 9 }]))).toBe("contract_expired");
    expect(await codeOf(consignment.receiveConsignedGoods(ctx.actor, ctx.tenant.locationId, contractId, {
      idempotencyKey: "receive-late", expectedVersion: version, note: null, lines: [{ lineId: lineM, quantity: 1 }],
    }))).toBe("contract_expired");
    expect((await consignment.getContract(ctx.actor, ctx.tenant.locationId, contractId)).contract.status).toBe("expired");
    expect(await codeOf(consignment.closeContract(ctx.actor, ctx.tenant.locationId, contractId, { expectedVersion: version })))
      .toBe("contract_has_stock");

    const before = await net(ctx.tenant.businessId);
    const back = await consignment.returnGoodsToOwner(ctx.actor, ctx.tenant.locationId, contractId, {
      idempotencyKey: "back-0001", expectedVersion: version, note: "پایان قرارداد",
      lines: [{ lineId: lineM, quantity: 4 }, { lineId: lineL, quantity: 2 }],
    });
    expect(back.onHand).toBe(0);
    expect(await net(ctx.tenant.businessId)).toEqual(before);
    const closed = await consignment.closeContract(ctx.actor, ctx.tenant.locationId, contractId, { expectedVersion: back.version });
    expect(closed.status).toBe("closed");
    // The payable survives the close and can still be settled.
    const settled = await consignment.settleWithOwner(ctx.actor, ctx.tenant.locationId, contractId, {
      idempotencyKey: "settle-0002", amountRial: 200_000, method: "bank", note: null,
    });
    expect(settled.outstandingRial).toBe(0);
    // Closed: the variant is free — the shop may now buy it as owned stock.
    await tx((client) => stockService.receiveItemPurchase(client, {
      businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId,
      lines: [{ itemId: ctx.m, quantity: "2", unitCost: UNIT_COST }],
    }));

    // Final reconciliation: no consignment balance left, owned stock = 1374, books balance.
    const gl = await net(ctx.tenant.businessId);
    expect(gl.get("2110") ?? 0n).toBe(0n);
    expect(gl.get("4700")).toBe(-200_000n);
    expect(gl.get("1374")).toBe(OWNED_VALUE - BigInt(UNIT_COST) + BigInt(2 * UNIT_COST));
    const { rows } = await db.query<{ v: string }>(
      "SELECT coalesce(sum(total_value_rial),0)::text AS v FROM item_stock s JOIN items i ON i.id = s.item_id WHERE i.location_id = $1",
      [ctx.tenant.locationId]);
    expect(BigInt(rows[0].v)).toBe(gl.get("1374"));
    expect([...gl.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
  });

  it("is branch- and tenant-isolated, RLS-forced, and its movement log is append-only", async () => {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه دو') RETURNING id", [ctx.tenant.businessId]);
    expect(await consignment.listContracts(ctx.actor, rows[0].id)).toEqual([]);
    expect(await codeOf(consignment.getContract(ctx.actor, rows[0].id, contractId))).toBe("contract_not_found");
    const other = await seed("co");
    expect(await codeOf(consignment.getContract(other.actor, other.tenant.locationId, contractId))).toBe("contract_not_found");
    expect(await codeOf(db.query("UPDATE fashion_consignment_movements SET note = 'x' WHERE contract_id = $1", [contractId])))
      .toContain("append-only");
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE ROLE consignment_probe NOLOGIN");
      await client.query("GRANT SELECT ON fashion_consignment_contracts, fashion_consignment_lines, fashion_consignment_movements TO consignment_probe");
      await client.query("SELECT set_config('app.business_id', $1, true)", [other.tenant.businessId]);
      await client.query("SET LOCAL ROLE consignment_probe");
      for (const table of ["fashion_consignment_contracts", "fashion_consignment_lines", "fashion_consignment_movements"]) {
        const { rows: visible } = await client.query(`SELECT 1 FROM ${table}`);
        expect(visible).toEqual([]);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("unsupported consignment combinations are refused by name (GH #1567 C5)", () => {
  async function consignedM(label: string) {
    const ctx = await seed(label);
    const owner = await consignment.createConsignorRecord(ctx.actor, ctx.tenant.locationId, { name: `امانت‌دار ${label}`, phone: null, notes: null });
    const contract = await consignment.createContract(ctx.actor, ctx.tenant.locationId, {
      reference: `C-${label}`, consignorId: owner.id, startsOn: "2026-01-01", expiresOn: null, notes: null,
      lines: [
        { itemId: ctx.m, terms: "commission", ownerUnitPriceRial: null, commissionBp: 2_000, retailPriceRial: 500_000 },
        { itemId: ctx.l, terms: "commission", ownerUnitPriceRial: null, commissionBp: 2_000, retailPriceRial: 500_000 },
      ],
    });
    const lineM = contract.lines.find((l) => l.itemId === ctx.m)!.id;
    const lineL = contract.lines.find((l) => l.itemId === ctx.l)!.id;
    const received = await consignment.receiveConsignedGoods(ctx.actor, ctx.tenant.locationId, contract.id, {
      idempotencyKey: `receive-${label}`, expectedVersion: contract.version, note: null, lines: [{ lineId: lineM, quantity: 2 }],
    });
    return { ctx, contractId: contract.id, version: received.version, lineM, lineL };
  }

  it("a size pack with a consigned component says so — in its view and at sale — instead of reporting a shortage", async () => {
    const { ctx, lineM } = await consignedM("c5pk");
    const pack = await sizePacks.saveSizePack(ctx.actor, ctx.tenant.locationId, {
      name: "بستهٔ مخلوط", barcode: null,
      components: [{ itemId: ctx.s, quantity: 1, unitPriceRial: 80_000 }, { itemId: ctx.m, quantity: 1, unitPriceRial: 80_000 }],
    });
    expect(pack.consignedComponents).toHaveLength(1);
    expect(pack.components.find((c) => c.itemId === ctx.m)!.consigned).toBe(true);
    const err = await tx((client) => sizePacks.expandSizePackInvoiceLines(client, {
      businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId, industry: "fashion_apparel",
      clientRequestId: `pk-${randomUUID()}`, createdBy: ctx.tenant.userId,
    }, [{ kind: "size_pack", packId: pack.id, quantity: 1, vatPercent: 9 }] as never)).catch((e) => e);
    expect(err.code).toBe("pack_contains_consigned");
    expect(err.detail.items).toEqual(pack.consignedComponents);
    expect(await onHandOf(lineM)).toBe(2);
    expect(await stockOf(ctx.s)).toBe(5);
    // An owned-only pack is not flagged.
    const owned = await sizePacks.saveSizePack(ctx.actor, ctx.tenant.locationId, {
      name: "بستهٔ خودی", barcode: null, components: [{ itemId: ctx.s, quantity: 1, unitPriceRial: 80_000 }],
    });
    expect(owned.consignedComponents).toEqual([]);
  });

  it("an online order line for a consigned variant is refused before any stock or revenue moves", async () => {
    const { ctx, lineM } = await consignedM("c5on");
    const before = await net(ctx.tenant.businessId);
    const err = await tx((client) => onlineSale.sellOnlineRetailLine(client, {
      locationId: ctx.tenant.locationId, orderId: randomUUID(), orderItemId: randomUUID(), itemId: ctx.m,
      quantity: "1", netRial: "500000", sourceType: "woocommerce_order", sourceId: "1001",
      occurredAt: new Date().toISOString(), remoteOccurredAt: null,
    })).catch((e) => e);
    expect(err.name).toBe("ConsignmentBlockedError");
    expect(err.code).toBe("consigned_online_sale_unsupported");
    expect(err.message).toMatch(/امانی/);
    expect(await onHandOf(lineM)).toBe(2);
    expect(await stockOf(ctx.m)).toBe(0);
    expect(await net(ctx.tenant.businessId)).toEqual(before);
  });

  it("the owned-stock guard is race-free when the variant has no item_stock row yet (consigned receipt first)", async () => {
    const { ctx, lineL } = await consignedM("c5ra");
    expect(await stockOf(ctx.l)).toBe(0);
    // A consigned-only variant need not have an item_stock row; the first owned
    // receipt then INSERTs it — the path FOR SHARE on a missing row cannot lock.
    await db.query("DELETE FROM item_stock WHERE item_id = $1 AND quantity = 0", [ctx.l]);
    const { rows: none } = await db.query("SELECT 1 FROM item_stock WHERE item_id = $1", [ctx.l]);
    expect(none).toHaveLength(0);
    // A consigned receipt of L is in flight: the line is locked and incremented, not yet committed.
    const holder = new Client({ connectionString: urlFor(databaseName) });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM fashion_consignment_lines WHERE id = $1 FOR UPDATE", [lineL]);
      await holder.query("UPDATE fashion_consignment_lines SET received_qty = received_qty + 1 WHERE id = $1", [lineL]);
      let settled = false;
      const purchase = codeOf(tx((client) => stockService.receiveItemPurchase(client, {
        businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId,
        lines: [{ itemId: ctx.l, quantity: "1", unitCost: UNIT_COST }],
      }))).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // waiting on the line, not reading a stale "no consigned units"
      await holder.query("COMMIT");
      expect(await purchase).toContain("consigned_variant_owned_stock");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
    expect(await stockOf(ctx.l)).toBe(0);
    expect(await onHandOf(lineL)).toBe(1);
  });

  it("the owned-stock guard is race-free the other way (owned purchase first)", async () => {
    const { ctx, contractId, version, lineL } = await consignedM("c5rb");
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await stockService.receiveItemPurchase(client, {
        businessId: ctx.tenant.businessId, locationId: ctx.tenant.locationId,
        lines: [{ itemId: ctx.l, quantity: "1", unitCost: UNIT_COST }],
      });
      let settled = false;
      const receipt = codeOf(consignment.receiveConsignedGoods(ctx.actor, ctx.tenant.locationId, contractId, {
        idempotencyKey: "receive-c5rb-L", expectedVersion: version, note: null, lines: [{ lineId: lineL, quantity: 1 }],
      })).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);
      await client.query("COMMIT");
      expect(await receipt).toBe("item_has_owned_stock");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    expect(await stockOf(ctx.l)).toBe(1);
    expect(await onHandOf(lineL)).toBe(0);
  });
});
