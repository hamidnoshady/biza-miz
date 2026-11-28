/**
 * #1567 Phase 4 — omnichannel for a fashion tenant, on the canonical
 * WooCommerce connector (no fashion fork).
 *
 *   4.1 a size × colour variable product syncs as one non-sellable style
 *       (variant_parent) plus one sellable SKU per variation, each carrying
 *       BOTH typed attributes, linked to its parent; a re-sync updates in
 *       place rather than duplicating.
 *   4.2 an outbound push is a bounded, whitelisted patch keyed by remote ids
 *       (no binaries, no unknown fields), deduplicated per product.
 *   4.4 an online order relieves the exact size/colour SKU and posts to the
 *       FASHION accounts (4584 revenue, 5184 COGS, 1374 inventory); a store
 *       re-delivery, a refund re-delivery and a cancellation are each applied
 *       once; a partial refund restocks and reverses COGS on the same SKU.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";
import { wooWebhookSignature } from "../src/lib/integrations/webhook-signature";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "cd".repeat(32);
const webhookSecret = "fashion-webhook-secret";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let ingest: typeof import("../src/lib/integrations/webhook-ingest-service");
let sync: typeof import("../src/lib/integrations/sync-service");
let ops: typeof import("../src/lib/integrations/woo-ops-service");
let connections: typeof import("../src/lib/integrations/connections-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", locationId: "", connectionId: "" };

const SIZES = ["S", "M", "L"] as const;
const COLOURS = ["مشکی", "سرمه‌ای"] as const;
const PARENT_ID = 500;

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

/** Remote id of the variation for one size/colour cell: 501..506. */
function variationId(size: (typeof SIZES)[number], colour: (typeof COLOURS)[number]): number {
  return PARENT_ID + 1 + SIZES.indexOf(size) * COLOURS.length + COLOURS.indexOf(colour);
}

function styleParent() {
  return {
    id: PARENT_ID,
    type: "variable",
    name: "مانتو کتان",
    sku: "MNT-100",
    price: "",
    regular_price: "",
    sale_price: "",
    manage_stock: false,
    stock_quantity: null,
    stock_status: "instock",
    status: "publish",
    attributes: [
      { id: 1, name: "سایز", position: 0, visible: true, variation: true, options: [...SIZES] },
      { id: 2, name: "رنگ", position: 1, visible: true, variation: true, options: [...COLOURS] },
    ],
    categories: [{ id: 7, name: "پوشاک زنانه", slug: "women" }],
    images: [],
  };
}

function styleVariation(size: (typeof SIZES)[number], colour: (typeof COLOURS)[number], price = "90000", stock = 10) {
  return {
    id: variationId(size, colour),
    type: "variation",
    parent_id: PARENT_ID,
    name: "مانتو کتان",
    sku: `MNT-100-${size}-${COLOURS.indexOf(colour)}`,
    price,
    regular_price: price,
    sale_price: "",
    manage_stock: true,
    stock_quantity: stock,
    stock_status: "instock",
    status: "publish",
    attributes: [
      { id: 1, name: "سایز", position: 0, visible: true, variation: true, options: [], option: size },
      { id: 2, name: "رنگ", position: 1, visible: true, variation: true, options: [], option: colour },
    ],
    variation_attributes: [
      { name: "سایز", option: size },
      { name: "رنگ", option: colour },
    ],
    categories: [{ id: 7, name: "پوشاک زنانه", slug: "women" }],
    images: [],
  };
}

function wooOrder(id: number, size: (typeof SIZES)[number], colour: (typeof COLOURS)[number], quantity: number) {
  const total = String(90000 * quantity);
  return {
    id,
    number: String(3000 + id),
    status: "processing",
    total,
    total_tax: "0",
    currency: "IRT",
    date_created: new Date().toISOString(),
    payment_method: "cod",
    customer_id: 0,
    billing: { first_name: "نگار", last_name: "رضایی", phone: "09121112233" },
    line_items: [
      {
        id: 1,
        name: `مانتو کتان • سایز: ${size}، رنگ: ${colour}`,
        product_id: PARENT_ID,
        variation_id: variationId(size, colour),
        quantity,
        price: "90000",
        total,
      },
    ],
  };
}

function wooRefund(id: number, orderId: number, size: (typeof SIZES)[number], colour: (typeof COLOURS)[number], quantity: number) {
  return {
    id,
    restock_items: true,
    parent_id: orderId,
    date_created: new Date().toISOString(),
    amount: String(90000 * quantity),
    total_tax: "0",
    reason: "سایز مناسب نبود",
    line_items: [
      {
        product_id: PARENT_ID,
        variation_id: variationId(size, colour),
        quantity: -quantity,
        total: String(-90000 * quantity),
      },
    ],
  };
}

async function deliver(payload: unknown, topic: string, deliveryId = `d-${randomUUID()}`) {
  const body = JSON.stringify(payload);
  const res = await ingest.handleWooCommerceWebhook(
    biz.connectionId,
    body,
    new Headers({
      "x-wc-webhook-signature": wooWebhookSignature(body, webhookSecret),
      "x-wc-webhook-delivery-id": deliveryId,
      "x-wc-webhook-topic": topic,
    }),
  );
  expect(res.status).toBe(200);
  return deliveryId;
}

async function localItem(remoteId: number): Promise<string> {
  const { rows } = await db.query<{ local_id: string }>(
    `SELECT local_id::text FROM integration_mappings
      WHERE connection_id = $1 AND entity_type = 'product' AND remote_id = $2`,
    [biz.connectionId, String(remoteId)],
  );
  expect(rows[0], `mapping for ${remoteId}`).toBeTruthy();
  return rows[0].local_id;
}

async function stockOf(itemId: string): Promise<number> {
  const { rows } = await db.query<{ quantity: string }>("SELECT quantity::text FROM item_stock WHERE item_id=$1", [itemId]);
  return rows[0] ? Number(rows[0].quantity) : 0;
}

/** Net debit−credit by account code over the business's whole ledger. */
async function net(): Promise<Map<string, bigint>> {
  const { rows } = await db.query<{ code: string; net: string }>(
    `SELECT a.code, (coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0))::text AS net
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id = je.id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1
      GROUP BY a.code`,
    [biz.id],
  );
  return new Map(rows.map((r) => [r.code, BigInt(r.net)]));
}

async function ordersFor(remoteOrderId: number): Promise<string[]> {
  const { rows } = await db.query<{ local_id: string }>(
    `SELECT local_id::text FROM integration_mappings
      WHERE connection_id = $1 AND entity_type = 'order' AND remote_id = $2`,
    [biz.connectionId, String(remoteOrderId)],
  );
  return rows.map((r) => r.local_id);
}

beforeAll(async () => {
  databaseName = `pos_fashion_omni_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  dbLib = await import("../src/lib/db");
  ingest = await import("../src/lib/integrations/webhook-ingest-service");
  sync = await import("../src/lib/integrations/sync-service");
  ops = await import("../src/lib/integrations/woo-ops-service");
  connections = await import("../src/lib/integrations/connections-service");
  provisioning = await import("../src/lib/business-provisioning");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Boutique', $1, 'fashion_apparel') RETURNING id",
    [`fashion-omni-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  // The real fashion chart of accounts (1374 / 4584 / 5184 + shared codes).
  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, biz.id, "fashion_apparel");
  } finally {
    client.release();
  }

  const connRow = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
     VALUES ($1, $2, 'Store', 'https://shop.example.com', $3, $4, $5, 'toman', true, true, true, true, true)
     RETURNING id`,
    [
      biz.id,
      biz.locationId,
      encryptSecret("ck_test", Buffer.from(KEY, "hex")),
      encryptSecret("cs_test", Buffer.from(KEY, "hex")),
      encryptSecret(webhookSecret, Buffer.from(KEY, "hex")),
    ],
  );
  biz.connectionId = connRow.rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("4.1 size × colour catalogue sync", () => {
  it("writes one non-sellable style and one sellable SKU per cell, each with both attributes", async () => {
    const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
    expect(await sync.upsertProductFromWoo(connection, biz.locationId, styleParent())).toBe("created");
    for (const size of SIZES) {
      for (const colour of COLOURS) {
        expect(await sync.upsertProductFromWoo(connection, biz.locationId, styleVariation(size, colour))).toBe("created");
      }
    }

    const parentId = await localItem(PARENT_ID);
    const parent = await db.query<{ kind: string; stock: string | null }>(
      `SELECT i.kind, s.quantity::text AS stock FROM items i LEFT JOIN item_stock s ON s.item_id = i.id WHERE i.id = $1`,
      [parentId],
    );
    expect(parent.rows[0]).toEqual({ kind: "variant_parent", stock: null });

    const children = await db.query<{ id: string; kind: string; parent_item_id: string; quantity: string; unit_price: string }>(
      `SELECT i.id::text, i.kind, i.parent_item_id::text, s.quantity::text, s.unit_price::text
         FROM items i JOIN item_stock s ON s.item_id = i.id
        WHERE i.parent_item_id = $1`,
      [parentId],
    );
    expect(children.rowCount).toBe(SIZES.length * COLOURS.length);
    for (const child of children.rows) {
      expect(child.kind).toBe("variant_child");
      expect(Number(child.quantity)).toBe(10);
      expect(Number(child.unit_price)).toBe(900000); // 90,000 toman
    }

    // Every SKU carries BOTH typed axes, and no two SKUs share a combination.
    const attrs = await db.query<{ item_id: string; combo: string }>(
      `SELECT a.item_id::text, string_agg(a.name || '=' || a.value, ';' ORDER BY a.name) AS combo
         FROM item_variant_attributes a JOIN items i ON i.id = a.item_id
        WHERE i.parent_item_id = $1
        GROUP BY a.item_id`,
      [parentId],
    );
    expect(attrs.rowCount).toBe(6);
    const combos = attrs.rows.map((r) => r.combo);
    expect(new Set(combos).size).toBe(6);
    expect(combos).toContain("رنگ=مشکی;سایز=M");

    const mBlack = await localItem(variationId("M", "مشکی"));
    expect(attrs.rows.find((r) => r.item_id === mBlack)?.combo).toBe("رنگ=مشکی;سایز=M");
  });

  it("re-syncs in place under explicit price ownership: nothing is duplicated or orphaned", async () => {
    const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
    // Explicit ownership (outbox-policy.effectivePushSwitches): while this app
    // pushes prices (`push_prices` on, ownership not `store`), a re-sync keeps
    // the locally set shelf price. A store-owned connection lets the
    // storefront's price win.
    expect(connection.source_of_truth).toBe("two_way");
    const storeOwned = { ...connection, source_of_truth: "store" as const };
    const before = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM items WHERE location_id = $1", [biz.locationId]);

    expect(await sync.upsertProductFromWoo(connection, biz.locationId, styleParent())).toBe("updated");
    expect(await sync.upsertProductFromWoo(connection, biz.locationId, styleVariation("L", "سرمه‌ای", "95000"))).toBe("updated");
    const lNavy = await localItem(variationId("L", "سرمه‌ای"));
    const kept = await db.query<{ unit_price: string }>("SELECT unit_price::text FROM item_stock WHERE item_id = $1", [lNavy]);
    expect(Number(kept.rows[0].unit_price)).toBe(900000); // local price kept
    expect(await sync.upsertProductFromWoo(storeOwned, biz.locationId, styleVariation("L", "سرمه‌ای", "95000"))).toBe("updated");

    const after = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM items WHERE location_id = $1", [biz.locationId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const orphans = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM items WHERE location_id = $1 AND kind = 'variant_child' AND parent_item_id IS NULL`,
      [biz.locationId],
    );
    expect(orphans.rows[0].n).toBe("0");

    const price = await db.query<{ unit_price: string }>("SELECT unit_price::text FROM item_stock WHERE item_id = $1", [lNavy]);
    expect(Number(price.rows[0].unit_price)).toBe(950000);

    // Put the price back for the order scenarios below.
    await sync.upsertProductFromWoo(storeOwned, biz.locationId, styleVariation("L", "سرمه‌ای", "90000"));
  });
});

describe("4.4 online orders, refunds and cancellations on fashion accounts", () => {
  beforeAll(async () => {
    // A cost basis on every SKU, the way a goods receipt would set it.
    await db.query(
      `UPDATE item_stock SET unit_cost = 400000
        WHERE item_id IN (SELECT id FROM items WHERE location_id = $1 AND kind = 'variant_child')`,
      [biz.locationId],
    );
  });

  it("relieves the exact size/colour SKU once, even when the store re-sends the order", async () => {
    const mBlack = await localItem(variationId("M", "مشکی"));
    const order = wooOrder(801, "M", "مشکی", 2);
    const deliveryId = await deliver(order, "order.created");
    // Same delivery again (transport retry) and a fresh delivery of the same
    // order (store re-sent it) — neither is a second sale.
    await deliver(order, "order.created", deliveryId);
    await deliver(order, "order.updated");

    expect(await ordersFor(801)).toHaveLength(1);
    expect(await stockOf(mBlack)).toBe(8);
    // No other SKU of the style moved.
    expect(await stockOf(await localItem(variationId("M", "سرمه‌ای")))).toBe(10);
    expect(await stockOf(await localItem(variationId("L", "مشکی")))).toBe(10);

    const [orderId] = await ordersFor(801);
    const line = await db.query<{ item_id: string }>("SELECT item_id::text FROM order_items WHERE order_id = $1", [orderId]);
    expect(line.rows).toEqual([{ item_id: mBlack }]);

    const gl = await net();
    expect(gl.get("4584")).toBe(-1_800_000n); // 2 × 900,000 rial, fashion revenue
    expect(gl.get("5184")).toBe(800_000n); //    2 × 400,000 rial, fashion COGS
    expect(gl.get("1374")).toBe(-800_000n); //   relieved from fashion inventory
    const cogsEntries = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_id = $2 AND posting_kind = 'cogs'`,
      [biz.id, orderId],
    );
    expect(cogsEntries.rows[0].n).toBe("1");
  });

  it("a partial refund restocks the same SKU and reverses its COGS exactly once", async () => {
    const mBlack = await localItem(variationId("M", "مشکی"));
    const refund = wooRefund(9801, 801, "M", "مشکی", 1);
    await deliver(refund, "refund.created");
    await deliver(refund, "refund.created"); // re-delivered by the store

    expect(await stockOf(mBlack)).toBe(9);
    const gl = await net();
    expect(gl.get("5184")).toBe(400_000n); // 800,000 − 400,000 recovered
    expect(gl.get("1374")).toBe(-400_000n);
    const refunds = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_mappings WHERE connection_id = $1 AND entity_type = 'refund' AND remote_id = '9801'`,
      [biz.connectionId],
    );
    expect(refunds.rows[0].n).toBe("1");
    const ledger = [...gl.values()].reduce((a, b) => a + b, 0n);
    expect(ledger).toBe(0n);
  });

  it("a cancelled order restores its SKU's stock once and the ledger stays balanced", async () => {
    const lNavy = await localItem(variationId("L", "سرمه‌ای"));
    const order = wooOrder(802, "L", "سرمه‌ای", 3);
    await deliver(order, "order.created");
    expect(await stockOf(lNavy)).toBe(7);

    await deliver({ ...order, status: "cancelled" }, "order.updated");
    await deliver({ ...order, status: "cancelled" }, "order.updated");
    expect(await stockOf(lNavy)).toBe(10);

    const gl = await net();
    // The cancelled sale's COGS is fully recovered; only the M/black net sale remains.
    expect(gl.get("5184")).toBe(400_000n);
    expect(gl.get("1374")).toBe(-400_000n);
    expect([...gl.values()].reduce((a, b) => a + b, 0n)).toBe(0n);
  });
});

describe("4.2 lightweight, bounded outbound payloads", () => {
  it("queues one whitelisted patch per SKU with its parent id and drops anything else", async () => {
    const patch = ops.sanitizeProductPatch({
      regular_price: "92000",
      stock_quantity: 9,
      images: [{ src: "data:image/png;base64,iVBORw0KGgo=" }],
      meta_data: [{ key: "_blob", value: "x".repeat(10_000) }],
      type: "simple",
    });
    expect(patch).toEqual({ regular_price: "92000", stock_quantity: 9 });
    expect(() => ops.sanitizeProductPatch({ description: "x".repeat(20_001) })).toThrow(/invalid_description/);

    const remote = String(variationId("M", "مشکی"));
    await ops.enqueueOperation(biz.id, biz.connectionId, "product_update", remote, patch);
    await ops.enqueueOperation(biz.id, biz.connectionId, "product_update", remote, { stock_quantity: 8 });

    const { rows } = await db.query<{ payload: Record<string, unknown>; bytes: number }>(
      `SELECT payload, octet_length(payload::text) AS bytes FROM integration_outbox_events
        WHERE connection_id = $1 AND entity_type = 'product_update' AND remote_id = $2`,
      [biz.connectionId, remote],
    );
    expect(rows).toHaveLength(1); // merged, not queued twice
    expect(rows[0].payload).toEqual({ regular_price: "92000", stock_quantity: 8, __parentRemoteId: String(PARENT_ID) });
    expect(rows[0].bytes).toBeLessThan(200);
  });
});

describe("GH #1567 F5 — embedded media is held or refused, never stored or cut", () => {
  const TINY = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  const storeProduct = (id: number, description: string, src: string) => ({
    id, type: "simple", name: `کالای ${id}`, sku: `F5-${id}`, price: "90000", regular_price: "90000", sale_price: "",
    manage_stock: false, stock_quantity: null, stock_status: "instock", status: "publish", attributes: [], categories: [],
    description, short_description: "توضیح کوتاه",
    images: [{ id: 1, src, alt: "تصویر", position: 0 }],
  });
  const metaOf = async (remoteId: number) =>
    (await db.query<{ meta: Record<string, unknown> }>(
      "SELECT last_pushed_payload AS meta FROM integration_mappings WHERE connection_id = $1 AND entity_type = 'product' AND remote_id = $2",
      [biz.connectionId, String(remoteId)],
    )).rows[0]?.meta ?? {};

  it("a store product with an inline image is mirrored as held (reason + length), never truncated or stored", async () => {
    const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
    const description = `<p>متن فروشگاه</p><img src="${TINY}">`;
    await sync.upsertProductFromWoo(connection, biz.locationId, storeProduct(99_501, description, TINY) as never);
    const meta = await metaOf(99_501);
    expect(meta).toMatchObject({
      remoteDescription: null, remoteDescriptionHeld: "embedded_media", remoteDescriptionLength: description.length,
      remoteShortDescription: "توضیح کوتاه", remoteShortDescriptionHeld: null,
      remoteImageSrc: null, remoteImageHeld: "embedded_media",
    });
    expect(JSON.stringify(meta)).not.toContain("base64");

    // Over-long store text: held whole, not cut to the bound (the old slice).
    const long = "متن ".repeat(6_000);
    await sync.upsertProductFromWoo(connection, biz.locationId, storeProduct(99_502, long, "https://shop.example.test/a.jpg") as never);
    expect(await metaOf(99_502)).toMatchObject({
      remoteDescription: null, remoteDescriptionHeld: "too_long", remoteImageSrc: "https://shop.example.test/a.jpg", remoteImageHeld: null,
    });
  });

  it("the item service refuses image-carrying catalogue text from any caller; the legacy report lists old rows without touching them", async () => {
    const items = await import("../src/lib/items-service");
    const guard = await import("../src/lib/embedded-media-guard");
    const report = await import("../src/lib/embedded-media-report-service");
    const parent = await items.createItem({ locationId: biz.locationId, name: "پیراهن F5", kind: "simple" } as never);
    await expect(items.updateItemMeta(parent.id, { longDescription: `<p>x</p><img src="${TINY}">` })).rejects.toBeInstanceOf(guard.EmbeddedMediaError);
    await expect(items.updateItemMeta(parent.id, { shortDescription: "&#100;ata&colon;image/png;base64,AAAA" })).rejects.toThrow("embedded_media");
    await expect(items.createItem({ locationId: biz.locationId, name: `x ${TINY}`, kind: "simple" } as never)).rejects.toThrow("embedded_media");
    expect((await items.getItem(parent.id))?.longDescription ?? null).toBeNull();

    // A row written before the rule: reported, never rewritten.
    const legacy = `<p>قدیمی</p><img src="${TINY}">`;
    await db.query("UPDATE items SET long_description = $2 WHERE id = $1", [parent.id, legacy]);
    const listed = await report.embeddedMediaReport(biz.id, biz.locationId);
    expect(listed).toContainEqual(expect.objectContaining({ source: "item", id: parent.id, field: "longDescription", kind: "data_uri" }));
    const other = await report.embeddedMediaReport(randomUUIDLike(), null);
    expect(other).toEqual([]);
    const after = await db.query<{ long_description: string }>("SELECT long_description FROM items WHERE id = $1", [parent.id]);
    expect(after.rows[0].long_description).toBe(legacy);
  });
});

function randomUUIDLike(): string {
  return "00000000-0000-4000-8000-00000000f5f5";
}
