/**
 * Phase 38 — the WooCommerce catalogue, end to end against a real database.
 *
 * What is being proved here is the thing that shipped broken, in the exact
 * form it was broken:
 *
 *   1. `/products` does not return variations, so a REST pull never had one
 *      to map. The sync now walks `products/{parent}/variations` and writes
 *      every variation as a sellable child.
 *   2. An order line carries `product_id` *and* `variation_id`, and only the
 *      variation has stock. Reading `product_id` alone — which every path did
 *      — resolved the line to the variable parent, which is created as a
 *      non-sellable container with no stock row. Revenue was posted; stock
 *      relief and COGS were silently dropped.
 *   3. The two doors disagreed: a webhook sends parent+variation, while the
 *      plugin used to send the variation in `product_id`. Both shapes must
 *      now land on the same row.
 *
 * A retail (accessories) business is used throughout, because the
 * parent/child model that makes any of this matter only exists in `items`.
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

const KEY = "ab".repeat(32);
const webhookSecret = "test-webhook-secret";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let ingest: typeof import("../src/lib/integrations/webhook-ingest-service");
let sync: typeof import("../src/lib/integrations/sync-service");
let ops: typeof import("../src/lib/integrations/woo-ops-service");
let taxonomy: typeof import("../src/lib/integrations/woo-taxonomy-service");
let connections: typeof import("../src/lib/integrations/connections-service");

const biz = { id: "", locationId: "", connectionId: "" };

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

/** A variable parent, its two variations, and one plain product. */
function variableParent(id = 10, name = "تی‌شرت") {
  return {
    id,
    type: "variable",
    name,
    sku: "TS",
    price: "",
    regular_price: "",
    sale_price: "",
    manage_stock: false,
    stock_quantity: null,
    stock_status: "instock",
    status: "publish",
    attributes: [
      { id: 1, name: "رنگ", position: 0, visible: true, variation: true, options: ["قرمز", "آبی"] },
    ],
    categories: [{ id: 7, name: "پوشاک", slug: "clothing" }],
    images: [],
  };
}

function variation(id: number, parentId: number, name: string, option: string, price: string, stock: number) {
  return {
    id,
    type: "variation",
    parent_id: parentId,
    name,
    sku: `TS-${option}`,
    price,
    regular_price: price,
    sale_price: "",
    manage_stock: true,
    stock_quantity: stock,
    stock_status: "instock",
    status: "publish",
    attributes: [{ id: 1, name: "رنگ", position: 0, visible: true, variation: true, options: [], option }],
    variation_attributes: [{ name: "رنگ", option }],
    categories: [{ id: 7, name: "پوشاک", slug: "clothing" }],
    images: [],
  };
}

/** An order line, in the shape a WooCommerce webhook sends. */
function orderBody(
  id: number,
  lines: { product_id: number; variation_id?: number; name: string; quantity: number; price: string; total: string }[],
  options: { total: string; tax?: string; billing?: Record<string, string> } = { total: "30000" },
) {
  return JSON.stringify({
    id,
    number: String(2000 + id),
    status: "processing",
    total: options.total,
    total_tax: options.tax ?? "0",
    currency: "IRT",
    date_created: new Date().toISOString(),
    payment_method: "cod",
    customer_id: 0,
    billing: options.billing ?? { first_name: "سارا", last_name: "احمدی", phone: "09123456789" },
    line_items: lines.map((line, index) => ({ id: index + 1, ...line })),
  });
}

function signedHeaders(body: string, topic: string, deliveryId: string): Headers {
  return new Headers({
    "x-wc-webhook-signature": wooWebhookSignature(body, webhookSecret),
    "x-wc-webhook-delivery-id": deliveryId,
    "x-wc-webhook-topic": topic,
  });
}

async function deliver(body: string, topic: string) {
  return ingest.handleWooCommerceWebhook(
    biz.connectionId,
    body,
    signedHeaders(body, topic, `d-${randomUUID()}`),
  );
}

/** Insert a chart of accounts the retail posting rules need, by code. */
async function seedAccounts(codes: [string, string, string][]) {
  for (const [code, name, type] of codes) {
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [biz.id, code, name, type],
    );
  }
}

beforeAll(async () => {
  databaseName = `pos_woo_cat_${randomUUID().replaceAll("-", "")}`;

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
  taxonomy = await import("../src/lib/integrations/woo-taxonomy-service");
  connections = await import("../src/lib/integrations/connections-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Boutique', $1, 'accessories') RETURNING id",
    [`woo-cat-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

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

describe("the catalogue: every product type lands in the right row", () => {
  it("writes a variable parent as a container and each variation as a sellable child", async () => {
    const connection = (await connections.getConnection(biz.id, biz.connectionId))!;

    await sync.upsertProductFromWoo(connection, biz.locationId, variableParent(10));
    await sync.upsertProductFromWoo(connection, biz.locationId, variation(11, 10, "تی‌شرت", "قرمز", "15000", 4));
    await sync.upsertProductFromWoo(connection, biz.locationId, variation(12, 10, "تی‌شرت", "آبی", "16000", 6));

    const { rows } = await db.query<{ remote_id: string; kind: string; name: string; quantity: string | null; unit_price: string | null }>(
      // item_stock.quantity is numeric; ::text renders '4.000000000'. The
      // test compares numbers, not the store's own formatting of them.
      `SELECT m.remote_id, i.kind, i.name, s.quantity::text, s.unit_price::text
         FROM integration_mappings m
         JOIN items i ON i.id = m.local_id
         LEFT JOIN item_stock s ON s.item_id = i.id
        WHERE m.connection_id = $1 AND m.entity_type = 'product'
        ORDER BY m.remote_id`,
      [biz.connectionId],
    );

    expect(rows.map((r) => r.remote_id)).toEqual(["10", "11", "12"]);
    // The parent is a container: no stock row, no price of its own.
    expect(rows[0]).toMatchObject({ kind: "variant_parent", quantity: null, unit_price: null });
    // Each variation is sellable, with its own stock and its own price —
    // 15,000 toman = 150,000 rial.
    expect(rows[1]).toMatchObject({ kind: "variant_child" });
    expect(Number(rows[1].quantity)).toBe(4);
    expect(Number(rows[1].unit_price)).toBe(150000); // 15,000 toman
    expect(rows[2]).toMatchObject({ kind: "variant_child" });
    expect(Number(rows[2].quantity)).toBe(6);
    expect(Number(rows[2].unit_price)).toBe(160000);

    // The parent link survives, which is what a later push needs.
    const parent = await db.query<{ parent_item_id: string }>(
      `SELECT i.parent_item_id::text FROM integration_mappings m JOIN items i ON i.id = m.local_id
        WHERE m.connection_id = $1 AND m.remote_id = '11'`,
      [biz.connectionId],
    );
    const parentItem = await db.query<{ local_id: string }>(
      `SELECT local_id::text FROM integration_mappings WHERE connection_id = $1 AND remote_id = '10'`,
      [biz.connectionId],
    );
    expect(parent.rows[0].parent_item_id).toBe(parentItem.rows[0].local_id);

    // And the variation carries its attribute, so the two rows are
    // distinguishable in a list rather than both being «تی‌شرت».
    const attributes = await db.query<{ name: string; value: string }>(
      `SELECT a.name, a.value FROM item_variant_attributes a
         JOIN integration_mappings m ON m.local_id = a.item_id
        WHERE m.connection_id = $1 AND m.remote_id = '11'`,
      [biz.connectionId],
    );
    expect(attributes.rows).toEqual([{ name: "رنگ", value: "قرمز" }]);
  });

  it("gives a variation a name that says which one it is", async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT i.name FROM integration_mappings m JOIN items i ON i.id = m.local_id
        WHERE m.connection_id = $1 AND m.remote_id = '12'`,
      [biz.connectionId],
    );
    expect(rows[0].name).toBe("تی‌شرت • رنگ: آبی");
  });

  it("records every store-driven price change in the immutable history (issue #924 F07)", async () => {
    const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
    const remoteId = "31";
    // First delivery: the opening price has no "old" value.
    await sync.upsertProductFromWoo(connection, biz.locationId, variation(31, 10, "تی‌شرت", "زرد", "20000", 2));
    // The store changes its price; the second delivery must log old → new.
    await sync.upsertProductFromWoo(connection, biz.locationId, variation(31, 10, "تی‌شرت", "زرد", "21000", 2));

    const { rows } = await db.query<{
      old_price: string | null;
      new_price: string | null;
      source: string;
      reason: string | null;
    }>(
      `SELECT h.old_price::text, h.new_price::text, h.source, h.reason
         FROM product_price_history h
         JOIN integration_mappings m ON m.local_id = h.item_id
        WHERE m.connection_id = $1 AND m.remote_id = $2 AND h.price_kind = 'sale'
        ORDER BY h.created_at, h.new_price`,
      [biz.connectionId, remoteId],
    );

    expect(rows).toEqual([
      { old_price: null, new_price: "200000", source: "sync", reason: "woocommerce_product_created" },
      { old_price: "200000", new_price: "210000", source: "sync", reason: "woocommerce_product_sync" },
    ]);
  });

  it("has an answer for every product type, including one it has never heard of", async () => {
    const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
    const shapes: [string, string][] = [
      ["grouped", "variant_parent"],
      ["external", "simple"],
      ["bundle", "simple"],
      ["mystery-extension", "simple"],
    ];
    let id = 20;
    for (const [type, kind] of shapes) {
      await sync.upsertProductFromWoo(connection, biz.locationId, {
        ...variableParent(id, `${type} product`),
        type,
      });
      const { rows } = await db.query<{ kind: string }>(
        `SELECT i.kind FROM integration_mappings m JOIN items i ON i.id = m.local_id
          WHERE m.connection_id = $1 AND m.remote_id = $2`,
        [biz.connectionId, String(id)],
      );
      expect(rows[0]?.kind).toBe(kind);
      id += 1;
    }

    // An external product is sold elsewhere: it gets a price, never stock.
    const external = await db.query<{ quantity: string | null }>(
      `SELECT s.quantity::text FROM integration_mappings m
         JOIN items i ON i.id = m.local_id
         LEFT JOIN item_stock s ON s.item_id = i.id
        WHERE m.connection_id = $1 AND m.remote_id = '21'`,
      [biz.connectionId],
    );
    expect(Number(external.rows[0].quantity)).toBe(0);
  });
});

describe("an order line resolves to the row that holds the stock", () => {
  beforeAll(async () => {
    // The accounts the retail posting rules look up by code: bank clearing,
    // VAT, and the accessories trade's own revenue / COGS / inventory —
    // the same accounts a counter sale of the same item would post to.
    await seedAccounts([
      ["1120", "Card clearing", "asset"],
      ["2200", "VAT Payable", "liability"],
      ["1340", "Accessory inventory", "asset"],
      ["4560", "Accessory sales revenue", "revenue"],
      ["5140", "Accessory COGS", "expense"],
    ]);
  });

  it("relieves the variation's stock and posts COGS — not the parent's", async () => {
    // Give both variations a cost basis, the way a goods receipt would.
    // Without one the retail rule is "no cost, no COGS" — the same rule a
    // counter sale follows — and no stock would move.
    await db.query(
      `UPDATE item_stock SET unit_cost = 100000
        WHERE item_id IN (SELECT local_id FROM integration_mappings
                           WHERE connection_id = $1 AND remote_id IN ('11', '12'))`,
      [biz.connectionId],
    );

    // A variation line, in the exact shape a WooCommerce webhook sends:
    // product_id = the parent, variation_id = the sellable child.
    const body = orderBody(101, [
      { product_id: 10, variation_id: 11, name: "تی‌شرت • رنگ: قرمز", quantity: 2, price: "15000", total: "30000" },
    ], { total: "30000" });

    const res = await deliver(body, "order.created");
    expect(res.status).toBe(200);

    const orderItem = await db.query<{ item_id: string; name_snapshot: string }>(
      `SELECT oi.item_id::text, oi.name_snapshot FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.location_id = $1`,
      [biz.locationId],
    );
    expect(orderItem.rowCount).toBe(1);

    const variationItem = await db.query<{ local_id: string }>(
      `SELECT local_id::text FROM integration_mappings WHERE connection_id = $1 AND remote_id = '11'`,
      [biz.connectionId],
    );
    // The line points at the variation — the pre-Phase-38 code pointed it at
    // the parent, which is why no stock moved.
    expect(orderItem.rows[0].item_id).toBe(variationItem.rows[0].local_id);

    const stock = await db.query<{ quantity: string }>(
      `SELECT s.quantity::text FROM item_stock s
        WHERE s.item_id = (SELECT local_id FROM integration_mappings
                            WHERE connection_id = $1 AND remote_id = '11')`,
      [biz.connectionId],
    );
    expect(Number(stock.rows[0].quantity)).toBe(2); // 4 − 2

    const cogs = await db.query<{ debit: string }>(
      `SELECT jl.debit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND je.source_type = 'woocommerce_order' AND je.posting_kind = 'cogs'`,
      [biz.id],
    );
    expect(cogs.rows[0].debit).toBe("200000"); // 2 × 100,000 rial
  });

  it("lands the plugin's shape on the same row as the webhook's", async () => {
    // The plugin used to send the variation's id in `product_id` (because
    // `WC_Order_Item_Product::get_product()` returns the variation). It now
    // sends both ids, but an older plugin's payload must still resolve.
    const body = orderBody(102, [
      { product_id: 12, name: "تی‌شرت • رنگ: آبی", quantity: 1, price: "16000", total: "16000" },
    ], { total: "16000" });

    const res = await deliver(body, "order.created");
    expect(res.status).toBe(200);

    const line = await db.query<{ item_id: string }>(
      `SELECT oi.item_id::text FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.location_id = $1 ORDER BY oi.created_at DESC LIMIT 1`,
      [biz.locationId],
    );
    const blue = await db.query<{ local_id: string }>(
      `SELECT local_id::text FROM integration_mappings WHERE connection_id = $1 AND remote_id = '12'`,
      [biz.connectionId],
    );
    expect(line.rows[0].item_id).toBe(blue.rows[0].local_id);

    const stock = await db.query<{ quantity: string }>(
      `SELECT s.quantity::text FROM item_stock s
        WHERE s.item_id = (SELECT local_id FROM integration_mappings
                            WHERE connection_id = $1 AND remote_id = '12')`,
      [biz.connectionId],
    );
    expect(Number(stock.rows[0].quantity)).toBe(5); // 6 − 1
  });

  it("creates the sellable child when a variation has never been synced", async () => {
    // An order for a variation this app has never seen, from a store whose
    // catalogue is only partly synced. The parent is mapped; the child is not.
    await sync.upsertProductFromWoo(
      (await connections.getConnection(biz.id, biz.connectionId))!,
      biz.locationId,
      variableParent(30, "شال"),
    );
    const body = orderBody(103, [
      { product_id: 30, variation_id: 31, name: "شال • رنگ: سبز", quantity: 1, price: "20000", total: "20000" },
    ], { total: "20000" });

    const res = await deliver(body, "order.created");
    expect(res.status).toBe(200);

    // The variation now exists, mapped under its parent.
    const child = await db.query<{ local_id: string; kind: string }>(
      `SELECT m.local_id::text, i.kind FROM integration_mappings m
         JOIN items i ON i.id = m.local_id
        WHERE m.connection_id = $1 AND m.remote_id = '31'`,
      [biz.connectionId],
    );
    expect(child.rows[0]).toMatchObject({ kind: "variant_child" });

    // And the line points at it, not at the parent.
    const line = await db.query<{ item_id: string }>(
      `SELECT oi.item_id::text FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.location_id = $1 ORDER BY oi.created_at DESC LIMIT 1`,
      [biz.locationId],
    );
    expect(line.rows[0].item_id).toBe(child.rows[0].local_id);
  });

  it("links the buyer, so the sale shows up in the customer record", async () => {
    const body = orderBody(104, [
      { product_id: 10, variation_id: 11, name: "تی‌شرت", quantity: 1, price: "15000", total: "15000" },
    ], {
      total: "15000",
      billing: { first_name: "مریم", last_name: "کریمی", phone: "0912 345 6789", email: "maryam@example.com" },
    });

    const res = await deliver(body, "order.created");
    expect(res.status).toBe(200);

    const order = await db.query<{ customer_id: string }>(
      `SELECT customer_id::text FROM orders WHERE location_id = $1 ORDER BY opened_at DESC LIMIT 1`,
      [biz.locationId],
    );
    expect(order.rows[0].customer_id).toBeTruthy();

    // Canonical +98… form, which is what the CRM keys duplicate detection,
    // segments and sending on. A phone that arrived with spaces must not
    // become a second person.
    const customer = await db.query<{ phone_e164: string | null; email: string | null; consent: boolean }>(
      `SELECT phone_e164, email, marketing_consent AS consent FROM parties WHERE id = $1`,
      [order.rows[0].customer_id],
    );
    expect(customer.rows[0].phone_e164).toBe("+989123456789");
    expect(customer.rows[0].email).toBe("maryam@example.com");
    // Buying something is not permission to market to someone.
    expect(customer.rows[0].consent).toBe(false);
  });

  it("records revenue for an unmapped line without inventing stock movement", async () => {
    const before = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM orders WHERE location_id = $1", [biz.locationId]);
    const body = orderBody(105, [
      { product_id: 999, name: "کالای ناشناس", quantity: 1, price: "5000", total: "5000" },
    ], { total: "5000" });

    const res = await deliver(body, "order.created");
    expect(res.status).toBe(200);

    const after = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM orders WHERE location_id = $1", [biz.locationId]);
    expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count) + 1);

    const line = await db.query<{ item_id: string | null; name_snapshot: string }>(
      `SELECT oi.item_id::text, oi.name_snapshot FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.location_id = $1 ORDER BY oi.created_at DESC LIMIT 1`,
      [biz.locationId],
    );
    expect(line.rows[0]).toMatchObject({ item_id: null, name_snapshot: "کالای ناشناس" });
  });
});

describe("the taxonomy mirror", () => {
  it("stores categories, attribute terms and a custom taxonomy, and re-syncing replaces rather than duplicates", async () => {
    await taxonomy.replaceTerms(biz.id, biz.connectionId, "product_cat", [
      { id: 7, name: "پوشاک", slug: "clothing", parent: 0, description: "", count: 12 },
      { id: 8, name: "تی‌شرت", slug: "tshirt", parent: 7, description: "", count: 4 },
    ] as never[]);
    await taxonomy.replaceTerms(biz.id, biz.connectionId, "pa_colour", [
      { id: 5, name: "قرمز", slug: "red", parent: 0, description: "", count: 3 },
    ] as never[]);
    await taxonomy.replaceTerms(biz.id, biz.connectionId, "brand", [
      { id: 3, name: "نایک", slug: "nike", parent: 0, description: "", count: 9 },
    ] as never[]);

    let terms = await taxonomy.listTerms(biz.id, biz.connectionId);
    const taxonomies = [...new Set(terms.map((t) => t.taxonomy))].sort();
    expect(taxonomies).toEqual(["brand", "pa_colour", "product_cat"]);
    expect(terms.filter((t) => t.taxonomy === "product_cat")).toHaveLength(2);

    // Deleted in the store, so it must be gone here — a merge would leave
    // ghosts an owner cannot remove from either system.
    await taxonomy.replaceTerms(biz.id, biz.connectionId, "product_cat", [
      { id: 7, name: "پوشاک", slug: "clothing", parent: 0, description: "", count: 12 },
    ] as never[]);
    terms = await taxonomy.listTerms(biz.id, biz.connectionId, "product_cat");
    expect(terms).toHaveLength(1);

    // Products carry their terms, and the child inherits its parent's.
    const byProduct = await taxonomy.termsByRemoteId(biz.id, biz.connectionId, ["10", "11"], "product_cat");
    expect(byProduct.get("10")?.map((t) => t.name)).toEqual(["پوشاک"]);
    expect(byProduct.get("11")?.map((t) => t.name)).toEqual(["پوشاک"]);
  });
});

describe("operating the store from the app", () => {
  it("queues a product update with the variation's parent, so the push cannot 404", async () => {
    const patch = ops.sanitizeProductPatch({ regular_price: "17000", stock_quantity: 3 });
    expect(patch).toEqual({ regular_price: "17000", stock_quantity: 3 });

    await ops.enqueueOperation(biz.id, biz.connectionId, "product_update", "11", patch);

    const { rows } = await db.query<{ entity_type: string; payload: Record<string, unknown> }>(
      `SELECT entity_type, payload FROM integration_outbox_events
        WHERE connection_id = $1 AND entity_type = 'product_update'`,
      [biz.connectionId],
    );
    expect(rows).toHaveLength(1);
    // The parent id travels with the job: `products/11` is a 404 for a
    // variation, and every push to one used to walk into the dead-letter
    // queue because of it.
    expect(rows[0].payload.__parentRemoteId).toBe("10");

    // Pressing «ثبت» twice refreshes one job rather than queueing two.
    await ops.enqueueOperation(biz.id, biz.connectionId, "product_update", "11", patch);
    const after = await db.query(
      `SELECT id FROM integration_outbox_events
        WHERE connection_id = $1 AND entity_type = 'product_update'`,
      [biz.connectionId],
    );
    expect(after.rowCount).toBe(1);
  });

  it("refuses a field this channel will not write, and a bad value outright", async () => {
    // `type` would restructure the store's catalogue; it is dropped, not sent.
    expect(ops.sanitizeProductPatch({ regular_price: "10", type: "simple" })).toEqual({ regular_price: "10" });
    expect(() => ops.sanitizeProductPatch({ status: "not-a-status" })).toThrow(/invalid_product_status/);
    expect(() => ops.sanitizeProductPatch({ regular_price: "1,000" })).toThrow(/invalid_price/);
    expect(() => ops.sanitizeProductPatch({ stock_quantity: -1 })).toThrow(/invalid_stock_quantity/);
    expect(() => ops.sanitizeProductPatch({})).toThrow(/empty_patch/);
  });

  it("forces a refund through the app to be a record, never a gateway call", async () => {
    const refund = ops.sanitizeRefund({ amount: "12.5", reason: "خراب بود", api_refund: true as never });
    expect(refund.api_refund).toBe(false);
    expect(refund.amount).toBe("12.5");
    expect(() => ops.sanitizeRefund({ amount: "0" })).toThrow(/invalid_refund_amount/);
    expect(() => ops.sanitizeRefund({ amount: "abc" })).toThrow(/invalid_refund_amount/);
  });

  it("accepts only WooCommerce's own order statuses", async () => {
    expect(ops.sanitizeOrderStatus("completed")).toBe("completed");
    expect(() => ops.sanitizeOrderStatus("shipped-somewhere")).toThrow(/invalid_order_status/);
  });

  it("reads the store's orders back from the inbox the ingest wrote", async () => {
    const orders = await ops.storeOrdersFor(biz.id, biz.connectionId, 10);
    expect(orders.length).toBeGreaterThan(0);
    // Newest first, and every one of them carries the totals and status the
    // store sent.
    expect(orders[0]).toMatchObject({ remoteId: "105", status: "processing", ingestStatus: "processed" });
    expect(orders[0].localOrderNumber).not.toBeNull();
  });
});

/**
 * Issue #939 — the taxonomy mirror's write path, hardened.
 *
 * Every test here is one of the audit's findings reproduced in the exact
 * shape it shipped: a malformed snapshot that used to wipe a taxonomy, a
 * replace that used to be a non-atomic delete-then-insert, a late plugin
 * event that used to resurrect deleted terms, a variation that used to lose
 * its parent's categories in REST mode, and totals that used to count one
 * product three times.
 */
describe("the taxonomy mirror, hardened (issue #939)", () => {
  it("refuses a malformed snapshot and leaves the previous mirror untouched (TAX-02/TAX-03)", async () => {
    await taxonomy.replaceTerms(biz.id, biz.connectionId, "season", [
      { id: 61, name: "بهار", slug: "spring", parent: 0, description: "", count: 2 },
    ] as never[]);

    // One unreadable term refuses the WHOLE snapshot: applying the readable
    // rest would let a truncated payload delete whatever the truncation cut.
    await expect(
      taxonomy.replaceTerms(biz.id, biz.connectionId, "season", [
        { id: 62, name: "تابستان", slug: "summer", parent: 0, description: "", count: 1 },
        { id: 0, name: "junk" },
      ] as never[]),
    ).rejects.toThrow(/malformed_taxonomy_snapshot/);
    let terms = await taxonomy.listTerms(biz.id, biz.connectionId, "season");
    expect(terms.map((t) => t.remoteId)).toEqual(["61"]);

    // A non-array `terms` is malformed, not empty.
    await expect(
      taxonomy.replaceTerms(biz.id, biz.connectionId, "season", { nope: true } as never),
    ).rejects.toThrow(/terms_not_array/);
    terms = await taxonomy.listTerms(biz.id, biz.connectionId, "season");
    expect(terms.map((t) => t.remoteId)).toEqual(["61"]);
  });

  it("applies a valid empty snapshot — zero terms is data, not an error (TAX-03)", async () => {
    const result = await taxonomy.replaceTerms(biz.id, biz.connectionId, "season", []);
    expect(result).toMatchObject({ stored: 0, stale: false, removedTerms: 1 });
    expect(await taxonomy.listTerms(biz.id, biz.connectionId, "season")).toEqual([]);
    const states = await taxonomy.listTaxonomyStates(biz.id, biz.connectionId);
    // TAX-14: the taxonomy stays a known, successfully-synced, empty group.
    expect(states.find((s) => s.taxonomy === "season")).toMatchObject({ status: "synced", termCount: 0 });
  });

  it("dedupes a snapshot that repeats an id instead of fighting its own unique key", async () => {
    const result = await taxonomy.replaceTerms(biz.id, biz.connectionId, "season", [
      { id: 61, name: "بهار", slug: "spring", parent: 0, description: "", count: 2 },
      { id: 61, name: "بهارِ تکراری", slug: "spring-dup", parent: 0, description: "", count: 9 },
      { id: 62, name: "تابستان", slug: "summer", parent: 0, description: "", count: 1 },
    ] as never[]);
    expect(result).toMatchObject({ stored: 2, duplicates: 1 });
    const terms = await taxonomy.listTerms(biz.id, biz.connectionId, "season");
    expect(terms.map((t) => t.remoteId).sort()).toEqual(["61", "62"]);
  });

  it("takes a deleted term's product assignments with it (TAX-07)", async () => {
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', '870', $3)`,
      [biz.id, biz.connectionId, randomUUID()],
    );
    await taxonomy.replaceProductTerms(biz.id, biz.connectionId, "870", [
      { taxonomy: "season", termRemoteId: "61" },
      { taxonomy: "season", termRemoteId: "62" },
    ]);

    // The store drops term 62; the snapshot says so.
    await taxonomy.replaceTerms(biz.id, biz.connectionId, "season", [
      { id: 61, name: "بهار", slug: "spring", parent: 0, description: "", count: 2 },
    ] as never[]);

    const { rows } = await db.query<{ term_remote_id: string }>(
      `SELECT term_remote_id FROM integration_woo_product_terms
        WHERE connection_id = $1 AND remote_id = '870' AND taxonomy = 'season'
        ORDER BY term_remote_id`,
      [biz.connectionId],
    );
    expect(rows.map((r) => r.term_remote_id)).toEqual(["61"]);
    // And the surviving term's mapped count sees the mapped product.
    const terms = await taxonomy.listTerms(biz.id, biz.connectionId, "season");
    expect(terms.find((t) => t.remoteId === "61")?.mappedCount).toBe(1);
  });

  it("refuses a snapshot older than the mirror's watermark — a late event cannot resurrect deleted terms (TAX-15)", async () => {
    const newer = new Date("2026-10-12T10:00:00Z");
    const older = new Date("2026-10-12T09:00:00Z");
    await taxonomy.replaceTerms(
      biz.id,
      biz.connectionId,
      "fabric",
      [{ id: 81, name: "پنبه", slug: "cotton", parent: 0, description: "", count: 4 }],
      { snapshotAt: newer },
    );

    // A retried queue row carrying the pre-deletion tree arrives late.
    const stale = await taxonomy.replaceTerms(
      biz.id,
      biz.connectionId,
      "fabric",
      [
        { id: 81, name: "پنبه", slug: "cotton", parent: 0, description: "", count: 4 },
        { id: 80, name: "قدیمی", slug: "gone", parent: 0, description: "", count: 1 },
      ],
      { snapshotAt: older },
    );
    expect(stale.stale).toBe(true);
    const terms = await taxonomy.listTerms(biz.id, biz.connectionId, "fabric");
    expect(terms.map((t) => t.remoteId)).toEqual(["81"]);

    // The same snapshot re-applied (a retry at the same watermark) is not
    // stale — it is an idempotent no-op-ish replace, so retries stay safe.
    const same = await taxonomy.replaceTerms(
      biz.id,
      biz.connectionId,
      "fabric",
      [{ id: 81, name: "پنبهٔ نو", slug: "cotton", parent: 0, description: "", count: 4 }],
      { snapshotAt: newer },
    );
    expect(same.stale).toBe(false);
    expect((await taxonomy.listTerms(biz.id, biz.connectionId, "fabric"))[0].name).toBe("پنبهٔ نو");
  });

  it("serialises two overlapping syncs of one taxonomy into two complete snapshots, never a blend (TAX-02)", async () => {
    const snapshotA = Array.from({ length: 40 }, (_, i) => ({
      id: 200 + i, name: `الف-${i}`, slug: `a-${i}`, parent: 0, description: "", count: 0,
    }));
    const snapshotB = Array.from({ length: 40 }, (_, i) => ({
      id: 300 + i, name: `ب-${i}`, slug: `b-${i}`, parent: 0, description: "", count: 0,
    }));

    // Fired together: a scheduled pull racing a manual one. The advisory lock
    // inside replaceTerms makes them sequential; no deadlock, no interleave.
    const [a, b] = await Promise.all([
      taxonomy.replaceTerms(biz.id, biz.connectionId, "overlap", snapshotA as never[]),
      taxonomy.replaceTerms(biz.id, biz.connectionId, "overlap", snapshotB as never[]),
    ]);
    expect(a.stale).toBe(false);
    expect(b.stale).toBe(false);

    const ids = (await taxonomy.listTerms(biz.id, biz.connectionId, "overlap"))
      .map((t) => t.remoteId)
      .sort();
    const aIds = snapshotA.map((t) => String(t.id)).sort();
    const bIds = snapshotB.map((t) => String(t.id)).sort();
    // The mirror equals exactly one complete snapshot — never a union or a
    // half-applied mix of the two.
    const matchesA = JSON.stringify(ids) === JSON.stringify(aIds);
    const matchesB = JSON.stringify(ids) === JSON.stringify(bIds);
    expect(matchesA || matchesB).toBe(true);
  });

  it("reports per-taxonomy outcomes, audits failures, and keeps the canonical slug as identity (TAX-04/TAX-09)", async () => {
    const routedTo: string[] = [];
    const client = {
      listCategories: async () => [
        { id: 91, name: "نوشیدنی", slug: "drinks", parent: 0, description: "", count: 5 },
      ],
      listTags: async (): Promise<never[]> => {
        throw new Error("woocommerce_list_failed_http_500");
      },
      listAttributes: async () => [{ id: 1, slug: "colour", taxonomy: "pa_colour" }],
      listAttributeTerms: async () => [
        { id: 95, name: "قرمز", slug: "red", parent: 0, description: "", count: 2 },
      ],
      listTaxonomies: async () => [
        // TAX-09: the routing base differs from the canonical slug.
        { slug: "brand", rest_base: "brands", types: ["product"] },
        // A blog taxonomy: not for products, never mirrored.
        { slug: "category", rest_base: "categories", types: ["post"] },
      ],
      listTerms: async (route: string) => {
        routedTo.push(route);
        return [{ id: 93, name: "نایک", slug: "nike", parent: 0, description: "", count: 3, taxonomy: route }];
      },
    };

    const outcome = await taxonomy.syncTaxonomyTree(biz.id, biz.connectionId, client);

    // Truthful whole-run status: tags failed, so this is NOT a complete sync.
    expect(outcome.status).toBe("partial");
    expect(outcome.failed).toEqual(["product_tag"]);
    const byName = new Map(outcome.results.map((r) => [r.taxonomy, r]));
    expect(byName.get("product_cat")).toMatchObject({ status: "synced", terms: 1 });
    expect(byName.get("product_tag")).toMatchObject({ status: "failed", error: "woocommerce_list_failed_http_500" });
    expect(byName.get("pa_colour")).toMatchObject({ status: "synced", terms: 1 });
    expect(byName.get("brand")).toMatchObject({ status: "synced", terms: 1 });

    // The HTTP read routed by rest_base…
    expect(routedTo).toEqual(["brands"]);
    // …but the mirror stored under the canonical slug: one identity, not two.
    const brandTerms = await taxonomy.listTerms(biz.id, biz.connectionId, "brand");
    expect(brandTerms.map((t) => t.remoteId)).toEqual(["93"]);
    expect(await taxonomy.listTerms(biz.id, biz.connectionId, "brands")).toEqual([]);

    // State rows: the failed taxonomy is visible with its error, the synced
    // one carries its rest_base and a successful-sync stamp.
    const states = await taxonomy.listTaxonomyStates(biz.id, biz.connectionId);
    const tag = states.find((s) => s.taxonomy === "product_tag");
    expect(tag?.status).toBe("failed");
    expect(tag?.lastError).toContain("500");
    expect(tag?.lastSyncedAt).toBeNull();
    const brand = states.find((s) => s.taxonomy === "brand");
    expect(brand).toMatchObject({ status: "synced", restBase: "brands", termCount: 1 });
    expect(brand?.lastSyncedAt).not.toBeNull();

    // Each failure is audited, so the queue screen has something to show.
    const audits = await db.query<{ error: string | null }>(
      `SELECT error FROM integration_audit_log
        WHERE connection_id = $1 AND action = 'taxonomy.sync_failed'`,
      [biz.connectionId],
    );
    expect(audits.rowCount).toBeGreaterThan(0);
  });

  it("surfaces a wp/v2 discovery failure as a partial sync, not a silent skip (TAX-04/TAX-01)", async () => {
    const client = {
      listCategories: async () => [],
      listTags: async () => [],
      listAttributes: async () => [],
      listAttributeTerms: async () => [],
      // What the REST client throws when no WordPress application password
      // is saved: wp/v2 refuses to reuse the Woo consumer key (TAX-01).
      listTaxonomies: async (): Promise<never[]> => {
        throw new Error("wordpress_credentials_missing");
      },
      listTerms: async () => [],
    };
    const outcome = await taxonomy.syncTaxonomyTree(biz.id, biz.connectionId, client);
    expect(outcome.status).toBe("partial");
    expect(outcome.discoveryErrors).toEqual([{ stage: "taxonomies", error: "wordpress_credentials_missing" }]);
    // Core taxonomies still synced — the failure is reported, not fatal.
    expect(outcome.taxonomies).toEqual(expect.arrayContaining(["product_cat", "product_tag"]));
  });

  it("flags a snapshot beyond the storage cap as truncated instead of silently clipping (TAX-10)", async () => {
    const terms = Array.from({ length: 5001 }, (_, i) => ({
      id: 1000 + i, name: `term-${i}`, slug: `t-${i}`, parent: 0, description: "", count: 0,
    }));
    const result = await taxonomy.replaceTerms(biz.id, biz.connectionId, "huge", terms as never[]);
    expect(result).toMatchObject({ stored: 5000, truncated: true });
    const states = await taxonomy.listTaxonomyStates(biz.id, biz.connectionId);
    expect(states.find((s) => s.taxonomy === "huge")?.status).toBe("truncated");
  }, 60_000);

  it("stages chunked plugin snapshots and applies nothing until the set is complete (TAX-15)", async () => {
    const generated = new Date("2026-10-12T12:00:00Z");
    const chunk = (index: number, count: number, terms: unknown[]) =>
      taxonomy.stageTaxonomySnapshotChunk(biz.id, biz.connectionId, {
        kind: "chunk",
        taxonomy: "chunked",
        terms: terms as never[],
        generatedAt: generated,
        snapshotId: "snap-test",
        chunkIndex: index,
        chunkCount: count,
      });

    const first = await chunk(0, 2, [
      { id: 111, name: "یک", slug: "one", parent: 0, description: "", count: 0 },
    ]);
    expect(first).toMatchObject({ complete: false, applied: null, stagedChunks: 1, stale: false });
    // An incomplete set is inert: the mirror has NOT been touched.
    expect(await taxonomy.listTerms(biz.id, biz.connectionId, "chunked")).toEqual([]);

    const second = await chunk(1, 2, [
      { id: 112, name: "دو", slug: "two", parent: 0, description: "", count: 0 },
    ]);
    expect(second.complete).toBe(true);
    expect(second.applied?.stored).toBe(2);
    const terms = await taxonomy.listTerms(biz.id, biz.connectionId, "chunked");
    expect(terms.map((t) => t.remoteId).sort()).toEqual(["111", "112"]);

    // Applying cleared the stage.
    const staged = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_woo_taxonomy_snapshot_chunks WHERE connection_id = $1`,
      [biz.connectionId],
    );
    expect(Number(staged.rows[0].n)).toBe(0);

    // A chunk from an older snapshot is refused and dropped, not staged.
    const staleChunk = await taxonomy.stageTaxonomySnapshotChunk(biz.id, biz.connectionId, {
      kind: "chunk",
      taxonomy: "chunked",
      terms: [{ id: 113, name: "قدیمی", slug: "old", parent: 0, description: "", count: 0 }] as never[],
      generatedAt: new Date("2026-10-12T11:00:00Z"),
      snapshotId: "snap-old",
      chunkIndex: 0,
      chunkCount: 2,
    });
    expect(staleChunk.stale).toBe(true);
    expect((await taxonomy.listTerms(biz.id, biz.connectionId, "chunked")).map((t) => t.remoteId).sort()).toEqual([
      "111",
      "112",
    ]);
  });

  it("inherits the parent's terms for a REST variation, and an empty payload never wipes them (TAX-06)", async () => {
    // The variable parent carries the tree, exactly as /products reports it.
    await taxonomy.recordProductTermsFromPayload(biz.id, biz.connectionId, "800", {
      type: "variable",
      categories: [{ id: 701, name: "کفش", slug: "shoes" }],
      tags: [{ id: 702, name: "چرم", slug: "leather" }],
      terms: { brand: [{ id: 703, name: "اکو", slug: "ecco" }] },
    });

    // A WooCommerce REST variation resource carries NO categories/tags at
    // all — the pre-#939 code recorded it as belonging to nothing.
    await taxonomy.recordProductTermsFromPayload(biz.id, biz.connectionId, "801", {
      type: "variation",
      parent_id: 800,
    });
    let cats = await taxonomy.termsByRemoteId(biz.id, biz.connectionId, ["801"], "product_cat");
    expect(cats.get("801")?.map((c) => c.remoteId)).toEqual(["701"]);
    const brands = await taxonomy.termsByRemoteId(biz.id, biz.connectionId, ["801"], "brand");
    expect(brands.get("801")?.map((c) => c.remoteId)).toEqual(["703"]);

    // Re-recorded with an explicitly empty payload: still inherited.
    await taxonomy.recordProductTermsFromPayload(biz.id, biz.connectionId, "801", {
      type: "variation",
      parent_id: 800,
      categories: [],
      tags: [],
    });
    cats = await taxonomy.termsByRemoteId(biz.id, biz.connectionId, ["801"], "product_cat");
    expect(cats.get("801")?.map((c) => c.remoteId)).toEqual(["701"]);

    // Where the payload DOES speak for a taxonomy (plugin mode sends the
    // parent's terms explicitly), the payload wins for that taxonomy while
    // the silent ones stay inherited.
    await taxonomy.recordProductTermsFromPayload(biz.id, biz.connectionId, "801", {
      type: "variation",
      parent_id: 800,
      categories: [{ id: 704, name: "کتانی", slug: "sneaker" }],
    });
    cats = await taxonomy.termsByRemoteId(biz.id, biz.connectionId, ["801"], "product_cat");
    expect(cats.get("801")?.map((c) => c.remoteId)).toEqual(["704"]);
    const tags = await taxonomy.termsByRemoteId(biz.id, biz.connectionId, ["801"], "product_tag");
    expect(tags.get("801")?.map((c) => c.remoteId)).toEqual(["702"]);
  });

  it("prunes assignments whose product no longer has a mapping (TAX-07)", async () => {
    // An orphan: a deleted store product whose mapping row is gone.
    await db.query(
      `INSERT INTO integration_woo_product_terms (business_id, connection_id, remote_id, taxonomy, term_remote_id)
       VALUES ($1, $2, '850', 'product_cat', '91')`,
      [biz.id, biz.connectionId],
    );
    // A live one: mapping row present.
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', '851', $3)`,
      [biz.id, biz.connectionId, randomUUID()],
    );
    await db.query(
      `INSERT INTO integration_woo_product_terms (business_id, connection_id, remote_id, taxonomy, term_remote_id)
       VALUES ($1, $2, '851', 'product_cat', '91')`,
      [biz.id, biz.connectionId],
    );

    const pruned = await taxonomy.pruneOrphanProductTerms(biz.id, biz.connectionId);
    expect(pruned).toBeGreaterThan(0);

    const gone = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_woo_product_terms WHERE connection_id = $1 AND remote_id = '850'`,
      [biz.connectionId],
    );
    expect(Number(gone.rows[0].n)).toBe(0);
    const kept = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_woo_product_terms WHERE connection_id = $1 AND remote_id = '851'`,
      [biz.connectionId],
    );
    expect(Number(kept.rows[0].n)).toBe(1);
  });

  it("counts a multi-category product once per group and once overall (TAX-08)", async () => {
    // Start from a known term + assignment set for this connection.
    await db.query(`DELETE FROM integration_woo_product_terms WHERE connection_id = $1`, [biz.connectionId]);
    await taxonomy.replaceTerms(biz.id, biz.connectionId, "product_cat", [
      { id: 91, name: "نوشیدنی", slug: "drinks", parent: 0, description: "", count: 2 },
      { id: 92, name: "گرم", slug: "hot", parent: 0, description: "", count: 1 },
    ] as never[]);
    await taxonomy.replaceTerms(biz.id, biz.connectionId, "product_tag", [
      { id: 94, name: "ویژه", slug: "special", parent: 0, description: "", count: 1 },
    ] as never[]);
    // Products 10 and 11 are mapped from the catalogue tests above.
    await taxonomy.replaceProductTerms(biz.id, biz.connectionId, "10", [
      { taxonomy: "product_cat", termRemoteId: "91" },
      { taxonomy: "product_cat", termRemoteId: "92" },
      { taxonomy: "product_tag", termRemoteId: "94" },
    ]);
    await taxonomy.replaceProductTerms(biz.id, biz.connectionId, "11", [
      { taxonomy: "product_cat", termRemoteId: "91" },
    ]);

    const stats = await taxonomy.taxonomyGroupStats(biz.id, biz.connectionId);
    const cat = stats.groups.find((g) => g.taxonomy === "product_cat");
    // TWO unique products, THREE memberships — the old additive total said
    // three products under a chip labelled «محصول همگام‌شده».
    expect(cat).toMatchObject({ mappedProducts: 2, assignments: 3 });
    const tag = stats.groups.find((g) => g.taxonomy === "product_tag");
    expect(tag).toMatchObject({ mappedProducts: 1, assignments: 1 });
    // Whole-connection: product 10 sits in both groups but counts once.
    expect(stats.totals).toMatchObject({ mappedProducts: 2, assignments: 4 });

    // The per-term count stays unique per term as well.
    const terms = await taxonomy.listTerms(biz.id, biz.connectionId, "product_cat");
    expect(terms.find((t) => t.remoteId === "91")?.mappedCount).toBe(2);
    expect(terms.find((t) => t.remoteId === "92")?.mappedCount).toBe(1);
  });

  it("a partial taxonomy sync cannot hide behind a healthy catalogue stamp (TAX-04)", async () => {
    // Drive the real syncProducts against a stubbed store: categories answer,
    // tags 500, attributes answer, and the connection has no WordPress
    // application password — so the wp/v2 discovery fails clearly (TAX-01)
    // instead of silently reusing the Woo key.
    const jsonResponse = (body: unknown, totalPages = 1) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "x-wp-totalpages": String(totalPages) },
      });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/products/categories")) {
          return jsonResponse([{ id: 500, name: "نوشیدنی", slug: "drinks", parent: 0, description: "", count: 1 }]);
        }
        if (url.includes("/products/tags")) {
          return new Response("store exploded", { status: 500 });
        }
        if (url.includes("/products/attributes")) return jsonResponse([], 0);
        if (url.includes("/products")) return jsonResponse([], 0);
        return new Response("unexpected " + url, { status: 599 });
      }) as typeof fetch;

      const outcome = await sync.syncProducts(biz.id, biz.connectionId);

      // The products side is healthy…
      expect(outcome.total).toBe(0);
      // …but the taxonomy side says exactly which trees failed and why.
      expect(outcome.taxonomy?.status).toBe("partial");
      expect(outcome.taxonomy?.failed).toContain("product_tag");
      const tagResult = outcome.taxonomy?.results.find((r) => r.taxonomy === "product_tag");
      expect(tagResult).toMatchObject({ status: "failed", error: "woocommerce_list_failed_http_500" });
      expect(outcome.taxonomy?.discoveryErrors).toEqual([
        { stage: "taxonomies", error: "wordpress_credentials_missing" },
      ]);

      // The connection keeps its active status and catalogue stamp — the
      // products did sync — but `last_error` now carries the partial tree
      // instead of being cleared, so the screens that read it stop claiming
      // a complete sync.
      const conn = await db.query<{ status: string; last_error: string | null; last_catalogue_sync_at: string | null }>(
        `SELECT status, last_error, last_catalogue_sync_at::text FROM integration_connections WHERE id = $1`,
        [biz.connectionId],
      );
      expect(conn.rows[0].status).toBe("active");
      expect(conn.rows[0].last_error).toMatch(/^taxonomy_sync_partial/);
      expect(conn.rows[0].last_error).toContain("product_tag");
      expect(conn.rows[0].last_catalogue_sync_at).not.toBeNull();

      // And the audit trail carries the per-taxonomy summary.
      const audit = await db.query<{ payload: { taxonomy?: { status?: string } } }>(
        `SELECT payload FROM integration_audit_log
          WHERE connection_id = $1 AND action = 'products.synced'
          ORDER BY created_at DESC LIMIT 1`,
        [biz.connectionId],
      );
      expect(audit.rows[0]?.payload?.taxonomy?.status).toBe("partial");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("a later snapshot renames and reparents terms in place — the mirror follows the store (gate 4)", async () => {
    // Watermarks ahead of anything the earlier tests in this file stamped, so
    // the snapshots are judged by their content, not by arrival order.
    const first = new Date(Date.now() + 60_000);
    const second = new Date(Date.now() + 120_000);

    await taxonomy.replaceTerms(
      biz.id,
      biz.connectionId,
      "product_cat",
      [
        { id: 960, name: "پوشاک", slug: "clothing", parent: 0, description: "", count: 3 },
        { id: 961, name: "پیراهن", slug: "shirts", parent: 960, description: "", count: 1 },
      ] as never[],
      { snapshotAt: first },
    );
    let terms = await taxonomy.listTerms(biz.id, biz.connectionId, "product_cat");
    expect(terms.find((t) => t.remoteId === "961")?.parentRemoteId).toBe("960");

    // The store renames both terms and promotes the child to the root.
    const result = await taxonomy.replaceTerms(
      biz.id,
      biz.connectionId,
      "product_cat",
      [
        { id: 960, name: "پوشاک مردانه", slug: "mens-clothing", parent: 0, description: "", count: 3 },
        { id: 961, name: "پیراهن مردانه", slug: "mens-shirts", parent: 0, description: "", count: 1 },
      ] as never[],
      { snapshotAt: second },
    );
    expect(result).toMatchObject({ stored: 2, removedTerms: 0, stale: false });

    terms = await taxonomy.listTerms(biz.id, biz.connectionId, "product_cat");
    expect(terms).toHaveLength(2);
    expect(terms.find((t) => t.remoteId === "960")).toMatchObject({ name: "پوشاک مردانه", slug: "mens-clothing" });
    expect(terms.find((t) => t.remoteId === "961")).toMatchObject({
      name: "پیراهن مردانه",
      slug: "mens-shirts",
      parentRemoteId: null,
    });
  });
});
