/**
 * #1567 Phase 7.3 — the epic's acceptance scenario, end to end on a freshly
 * provisioned fashion tenant:
 *
 *   "Create 100 style products with several sizes/colors, unique SKU/barcodes,
 *    edit safely … without duplicate or orphan variant rows; product creation
 *    alone does not silently post stock."
 *   "Scan a sale, exchange M→L, issue partial refund and process an unsellable
 *    damaged return; correct per-SKU stock and GL, no double posting on
 *    repeat, race or retry."
 *
 * Two branches; every product goes through the real product-creation path
 * (parse → createProductRecord), stock arrives through a posted purchase, and
 * the closing check is that fashion inventory (1374) on the ledger equals the
 * valued stock on the shelves of both branches.
 */
import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { quantityText, rialText } from "../src/lib/inventory-exact";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let productInput: typeof import("../src/lib/product-input");
let productCreation: typeof import("../src/lib/product-creation-service");
let attributes: typeof import("../src/lib/product-attributes-service");
let templates: typeof import("../src/lib/product-attribute-templates");
let itemsService: typeof import("../src/lib/items-service");
let barcodes: typeof import("../src/lib/item-barcodes-service");
let stockService: typeof import("../src/lib/retail-stock-service");
let retailInvoice: typeof import("../src/lib/retail-invoice-service");
let returns: typeof import("../src/lib/customer-return-service");

const STYLES = 100;
const SIZES = ["S", "M", "L"] as const;
const COLORS = ["مشکی", "سفید", "سرمه‌ای"] as const;
const UNIT_COST = 50_000;

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

/** A valid in-store EAN-13 (prefix 20) for a running counter. */
function ean13(counter: number): string {
  const body = `20${String(counter).padStart(10, "0")}`;
  const sum = [...body].reduce((acc, digit, i) => acc + Number(digit) * (i % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

beforeAll(async () => {
  databaseName = `pos_fashion_accept_${randomUUID().replaceAll("-", "")}`;
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
  attributes = await import("../src/lib/product-attributes-service");
  templates = await import("../src/lib/product-attribute-templates");
  itemsService = await import("../src/lib/items-service");
  barcodes = await import("../src/lib/item-barcodes-service");
  stockService = await import("../src/lib/retail-stock-service");
  retailInvoice = await import("../src/lib/retail-invoice-service");
  returns = await import("../src/lib/customer-return-service");

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

function styleInput(n: number, barcodeBase: number) {
  let offset = 0;
  return {
    name: `تی‌شرت TS-${n}`,
    sku: `TS-${n}`,
    unit: "عدد",
    taxSalePercent: 9,
    sellPrice: 100_000,
    variants: SIZES.flatMap((size) =>
      COLORS.map((color, c) => ({
        sku: `TS-${n}-${size}-${c}`,
        barcode: ean13(barcodeBase + offset++),
        attributes: [
          { name: "سایز", value: size },
          { name: "رنگ", value: color },
        ],
      })),
    ),
  };
}

async function createStyle(locationId: string, n: number, barcodeBase: number) {
  const parsed = productInput.parseProductCreateInput(styleInput(n, barcodeBase));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  return productCreation.createProductRecord(locationId, parsed.data);
}

/** The variant of a created style for one size × color. */
async function variantOf(parentId: string, size: string, color: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT i.id FROM items i
       JOIN item_variant_attributes s ON s.item_id = i.id AND s.name = 'سایز' AND s.value = $2
       JOIN item_variant_attributes c ON c.item_id = i.id AND c.name = 'رنگ' AND c.value = $3
      WHERE i.parent_item_id = $1`,
    [parentId, size, color],
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

async function stockOf(itemId: string): Promise<number> {
  const { rows } = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id=$1", [itemId]);
  return rows[0] ? Number(rows[0].quantity) : 0;
}

async function net(businessId: string): Promise<Map<string, bigint>> {
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

describe("fashion acceptance: 100 styles, two branches, sale / exchange / refund / damaged return", () => {
  it(
    "reconciles per-SKU stock and GL with no double posting",
    async () => {
      // ---- 1. a new fashion tenant, two branches --------------------------------
      const tenant = await provisioning.provisionBusiness({
        businessName: "بوتیک پذیرش",
        ownerName: "مالک",
        email: `owner-accept-${randomUUID().slice(0, 8)}@example.com`,
        password: "correct-horse",
        subdomain: `accept${randomUUID().slice(0, 8)}`,
        industry: "fashion_apparel",
        seedChartOfAccounts: true,
      });
      const businessId = tenant.businessId;
      const main = tenant.locationId;
      const { rows: branchRows } = await db.query<{ id: string }>(
        "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه دو') RETURNING id",
        [businessId],
      );
      const branch = branchRows[0].id;
      // The new branch gets the same fashion attribute set the signup seeded at main.
      const garmentTemplate = templates.defaultAttributeTemplateFor("fashion_apparel")!;
      await tx((client) => attributes.applyAttributeTemplate(client, { locationId: branch, template: garmentTemplate }));

      // ---- 2. catalogue only: 100 styles × 9 SKUs, nothing posted -----------------
      const parents: string[] = [];
      for (let n = 1; n <= STYLES; n++) {
        const created = await createStyle(main, n, n * 100);
        expect(created.variants).toHaveLength(SIZES.length * COLORS.length);
        parents.push(created.item.id);
      }
      const totals = await db.query<{ parents: string; children: string; skus: string; codes: string; bad: string }>(
        `SELECT
           count(*) FILTER (WHERE kind='variant_parent')::text AS parents,
           count(*) FILTER (WHERE kind='variant_child')::text AS children,
           count(DISTINCT sku) FILTER (WHERE kind='variant_child')::text AS skus,
           (SELECT count(DISTINCT code) FROM item_barcodes WHERE location_id=$1)::text AS codes,
           count(*) FILTER (WHERE kind='variant_child' AND parent_item_id IS NULL)::text AS bad
         FROM items WHERE location_id=$1`,
        [main],
      );
      expect(totals.rows[0]).toEqual({ parents: "100", children: "900", skus: "900", codes: "900", bad: "0" });
      // No parent carries a scanner code; every child has exactly one.
      const { rows: codeOwners } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM item_barcodes b JOIN items i ON i.id=b.item_id
          WHERE b.location_id=$1 AND i.kind <> 'variant_child'`,
        [main],
      );
      expect(codeOwners[0].n).toBe("0");
      // Creation alone posts nothing and stocks nothing.
      expect((await net(businessId)).size).toBe(0);
      const { rows: stocked } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM item_stock s JOIN items i ON i.id=s.item_id
          WHERE i.location_id=$1 AND s.quantity > 0`,
        [main],
      );
      expect(stocked[0].n).toBe("0");

      // Duplicate combinations are refused before anything is written…
      const dup = styleInput(999, 900_000);
      dup.variants[1].attributes = dup.variants[0].attributes;
      const dupParsed = productInput.parseProductCreateInput(dup);
      expect(dupParsed.ok).toBe(false);
      expect(JSON.stringify(dupParsed)).toContain("duplicate_variant");
      // …and a barcode collision rolls the whole family back: no orphan rows.
      const collide = styleInput(998, 910_000);
      collide.variants[4].barcode = ean13(100); // TS-1's first SKU
      const collideParsed = productInput.parseProductCreateInput(collide);
      expect(collideParsed.ok).toBe(true);
      if (collideParsed.ok) {
        await expect(productCreation.createProductRecord(main, collideParsed.data)).rejects.toThrow();
      }
      const { rows: afterCollide } = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM items WHERE location_id=$1",
        [main],
      );
      expect(afterCollide[0].n).toBe("1000");

      // Editing a style is safe: the family keeps its nine SKUs.
      await itemsService.updateItemMeta(parents[0], { name: "تی‌شرت TS-1 (ویرایش)" });
      const { rows: family } = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM items WHERE parent_item_id=$1",
        [parents[0]],
      );
      expect(family[0].n).toBe("9");

      // ---- 3. stock in through a posted purchase; branch catalogue + transfer ----
      const mBlack = await variantOf(parents[0], "M", "مشکی");
      const lBlack = await variantOf(parents[0], "L", "مشکی");
      const sWhite = await variantOf(parents[1], "S", "سفید");
      await tx((client) =>
        stockService.receiveItemPurchase(client, {
          businessId,
          locationId: main,
          lines: [
            { itemId: mBlack, quantity: "10", unitCost: UNIT_COST },
            { itemId: lBlack, quantity: "10", unitCost: UNIT_COST },
            { itemId: sWhite, quantity: "5", unitCost: UNIT_COST },
          ],
        }),
      );
      const branchStyle = await createStyle(branch, 1, 2_000_000);
      const branchM = await variantOf(branchStyle.item.id, "M", "مشکی");
      const transfer = await tx((client) =>
        stockService.createItemTransfer(client, {
          businessId,
          sourceLocationId: main,
          destinationLocationId: branch,
          idempotencyKey: randomUUID(),
          lines: [{ sourceItemId: mBlack, destinationItemId: branchM, quantity: "3" }],
        }),
      );
      await tx((client) => stockService.shipItemTransfer(client, { businessId, transferId: transfer.id, actorId: "" }));
      await tx((client) => stockService.receiveItemTransfer(client, { businessId, transferId: transfer.id, actorId: "" }));

      // ---- 4. scan a sale ---------------------------------------------------------
      const scanned = await barcodes.lookupBarcode(main, ean13(100 + 3)); // TS-1, size M, color 0
      expect(scanned.map((m) => m.itemId)).toEqual([mBlack]);
      const saleKey = `till-1-${randomUUID()}`;
      const saleInput = {
        businessId,
        locationId: main,
        industry: "fashion_apparel" as const,
        lines: [
          { kind: "stocked" as const, itemId: scanned[0].itemId, quantity: "2", unitPrice: 100_000, discount: 0, vatPercent: 9 },
          { kind: "stocked" as const, itemId: sWhite, quantity: "1", unitPrice: 100_000, discount: 0, vatPercent: 9 },
        ],
        tenders: [{ method: "cash" as const }],
        clientRequestId: saleKey,
      };
      const sale = await tx((client) => retailInvoice.createRetailInvoice(client, saleInput));
      // The till retries (offline replay): same invoice, nothing posted twice.
      const replay = await tx((client) => retailInvoice.createRetailInvoice(client, saleInput));
      expect(replay.orderId).toBe(sale.orderId);
      const { rows: lines } = await db.query<{ id: string; item_id: string }>(
        "SELECT id, item_id FROM order_items WHERE order_id=$1",
        [sale.orderId],
      );
      const mLine = lines.find((l) => l.item_id === mBlack)!.id;
      const sLine = lines.find((l) => l.item_id === sWhite)!.id;

      const doReturn = (input: {
        key: string;
        refund: string;
        orderItemId: string;
        quantity: string;
        disposition: "restockable" | "discarded";
      }) =>
        tx((client) =>
          returns.createCustomerReturn(client, {
            businessId,
            locationId: main,
            orderId: sale.orderId,
            refundMethod: "cash",
            refundAmount: rialText(input.refund),
            reason: input.key,
            idempotencyKey: input.key,
            createdBy: tenant.userId,
            lines: [{ orderItemId: input.orderItemId, quantity: quantityText(input.quantity), disposition: input.disposition }],
          }),
        );

      // ---- 5. exchange M→L (one unit, dearer L: customer pays the difference) ----
      const exchangeReturn = { key: "exchange-m", refund: "109000", orderItemId: mLine, quantity: "1", disposition: "restockable" as const };
      const exchange = await doReturn(exchangeReturn);
      await tx((client) =>
        retailInvoice.createRetailInvoice(client, {
          businessId,
          locationId: main,
          industry: "fashion_apparel",
          lines: [{ kind: "stocked", itemId: lBlack, quantity: "1", unitPrice: 120_000, discount: 0, vatPercent: 9 }],
          tenders: [{ method: "cash" }],
          clientRequestId: `exchange-l-${randomUUID()}`,
        }),
      );
      // Repeat and race of the same return: one return, one restock, one posting.
      const [again, raced] = await Promise.all([doReturn(exchangeReturn), doReturn(exchangeReturn)]);
      expect(again.duplicate && raced.duplicate).toBe(true);
      expect(again.id).toBe(exchange.id);

      // ---- 6. partial refund (goodwill) on the second M, kept on the shelf --------
      await doReturn({ key: "partial-m", refund: "60000", orderItemId: mLine, quantity: "1", disposition: "restockable" });

      // ---- 7. unsellable damaged return of the white S ---------------------------
      await doReturn({ key: "damaged-s", refund: "109000", orderItemId: sLine, quantity: "1", disposition: "discarded" });

      // ---- 8. reconcile ------------------------------------------------------------
      // Per SKU: M 10 −3 transfer −2 sold +1 exchange +1 partial = 7; L 10 −1 = 9;
      // S white 5 −1 sold, damaged not restocked = 4; branch M = 3.
      expect(await stockOf(mBlack)).toBe(7);
      expect(await stockOf(lBlack)).toBe(9);
      expect(await stockOf(sWhite)).toBe(4);
      expect(await stockOf(branchM)).toBe(3);

      const gl = await net(businessId);
      const onHand = 7 + 9 + 4 + 3;
      expect(gl.get("1374")).toBe(BigInt(onHand * UNIT_COST));
      expect(gl.get("1360") ?? 0n).toBe(0n);
      // Units still expensed: the L sold in the exchange and the damaged S.
      expect(gl.get("5184")).toBe(BigInt(2 * UNIT_COST));
      // Cash: 327,000 sale + 130,800 L − 109,000 − 60,000 − 109,000 refunds.
      expect(gl.get("1100")).toBe(179_800n);
      const { rows: refundEntries } = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM journal_entries WHERE business_id=$1 AND posting_kind='customer_refund'",
        [businessId],
      );
      expect(refundEntries[0].n).toBe("3");
      const balance = [...gl.values()].reduce((a, b) => a + b, 0n);
      expect(balance).toBe(0n);
    },
    240_000,
  );
});
