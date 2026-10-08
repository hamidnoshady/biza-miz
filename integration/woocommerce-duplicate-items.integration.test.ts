/**
 * Dashboard audit F13 — "two identical rows for one SKU, with different
 * quantities". How a second local item can appear for ONE remote product,
 * proved against a real database, plus the read-only diagnostic that tells an
 * owner which of their duplicate SKU groups are that bug and which are an
 * ordinary variant family.
 *
 * The cause reproduced here: product creation was check-then-insert. The
 * mapping was read, found missing, and an item inserted — with nothing
 * serialising two deliveries of the same product (WooCommerce fires
 * `product.created` and `product.updated` for one save, and the plugin queue,
 * the manual catalogue pull and an order's variation stub all reach the same
 * code). Both inserted an item, and the second mapping upsert
 * (`ON CONFLICT … DO UPDATE SET local_id`) silently re-pointed the mapping at
 * its own row, orphaning the first: same name, same SKU, and a stock snapshot
 * frozen at whatever the store said at that instant — five beside six.
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
const webhookSecret = "dup-webhook-secret";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let ingest: typeof import("../src/lib/integrations/webhook-ingest-service");
let sync: typeof import("../src/lib/integrations/sync-service");
let connections: typeof import("../src/lib/integrations/connections-service");
let report: typeof import("../src/lib/duplicate-items-report");

const biz = { id: "", locationId: "", connectionId: "", otherBizId: "" };

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

function simpleProduct(id: number, sku: string, stock: number) {
  return {
    id,
    type: "simple",
    name: "کرم مرطوب‌کننده",
    sku,
    price: "100000",
    regular_price: "100000",
    sale_price: "",
    manage_stock: true,
    stock_quantity: stock,
    stock_status: "instock",
    status: "publish",
    attributes: [],
    categories: [],
    images: [],
  };
}

function variableParent(id: number, sku: string) {
  return {
    id,
    type: "variable",
    name: "رژ لب",
    sku,
    price: "",
    regular_price: "",
    sale_price: "",
    manage_stock: false,
    stock_quantity: null,
    stock_status: "instock",
    status: "publish",
    attributes: [{ id: 1, name: "رنگ", position: 0, visible: true, variation: true, options: ["قرمز", "صورتی"] }],
    categories: [],
    images: [],
  };
}

function variation(id: number, parentId: number, sku: string, option: string, stock: number) {
  return {
    id,
    type: "variation",
    parent_id: parentId,
    name: "رژ لب",
    // WooCommerce's REST view of a variation with no SKU of its own returns
    // the parent's — which is why a variant family legitimately shares one.
    sku,
    price: "50000",
    regular_price: "50000",
    sale_price: "",
    manage_stock: true,
    stock_quantity: stock,
    stock_status: "instock",
    status: "publish",
    attributes: [{ id: 1, name: "رنگ", position: 0, visible: true, variation: true, options: [], option }],
    variation_attributes: [{ name: "رنگ", option }],
    categories: [],
    images: [],
  };
}

async function itemsWithSku(sku: string) {
  const { rows } = await db.query<{ id: string; kind: string; quantity: string | null }>(
    `SELECT i.id::text, i.kind, s.quantity::text
       FROM items i LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.location_id = $1 AND i.sku = $2
      ORDER BY i.created_at`,
    [biz.locationId, sku],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_woo_dup_${randomUUID().replaceAll("-", "")}`;
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
  connections = await import("../src/lib/integrations/connections-service");
  report = await import("../src/lib/duplicate-items-report");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Beauty', $1, 'cosmetics') RETURNING id",
    [`woo-dup-${randomUUID().slice(0, 8)}`],
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
     VALUES ($1, $2, 'Store', 'https://beauty.example.com', $3, $4, $5, 'toman', true, true, true, false, false)
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

  // A second business with the very same SKU, which the report must never see.
  const other = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Other', $1, 'cosmetics') RETURNING id",
    [`woo-dup-o-${randomUUID().slice(0, 8)}`],
  );
  biz.otherBizId = other.rows[0].id;
  const otherLoc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Other') RETURNING id",
    [biz.otherBizId],
  );
  for (let i = 0; i < 2; i += 1) {
    await db.query(`INSERT INTO items (location_id, name, sku) VALUES ($1, 'x', 'zza06379')`, [otherLoc.rows[0].id]);
  }
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

describe("one remote product is one local item, however many deliveries race", () => {
  it("creates a single item when the same new product arrives concurrently", async () => {
    const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
    // product.created and product.updated for one save, plus a manual pull —
    // reported with five and then six on hand.
    await dbLib.withTenant(biz.id, () =>
      Promise.all([
        sync.upsertProductFromWoo(connection, biz.locationId, simpleProduct(501, "zza05023", 5)),
        sync.upsertProductFromWoo(connection, biz.locationId, simpleProduct(501, "zza05023", 6)),
        sync.upsertProductFromWoo(connection, biz.locationId, simpleProduct(501, "zza05023", 6)),
        sync.upsertProductFromWoo(connection, biz.locationId, simpleProduct(501, "zza05023", 6)),
      ]),
    );
    const rows = await itemsWithSku("zza05023");
    expect(rows).toHaveLength(1);
    const mapping = await db.query<{ local_id: string }>(
      `SELECT local_id::text FROM integration_mappings WHERE connection_id = $1 AND remote_id = '501'`,
      [biz.connectionId],
    );
    expect(mapping.rows[0].local_id).toBe(rows[0].id);
  });

  it("creates a single container and children when a variable family races", async () => {
    const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
    await dbLib.withTenant(biz.id, () =>
      Promise.all([
        sync.upsertProductFromWoo(connection, biz.locationId, variableParent(600, "LIP")),
        sync.upsertProductFromWoo(connection, biz.locationId, variableParent(600, "LIP")),
        sync.upsertProductFromWoo(connection, biz.locationId, variableParent(600, "LIP")),
      ]),
    );
    await dbLib.withTenant(biz.id, () =>
      Promise.all([
        sync.upsertProductFromWoo(connection, biz.locationId, variation(601, 600, "LIP", "قرمز", 3)),
        sync.upsertProductFromWoo(connection, biz.locationId, variation(601, 600, "LIP", "قرمز", 3)),
        sync.upsertProductFromWoo(connection, biz.locationId, variation(602, 600, "LIP", "صورتی", 2)),
      ]),
    );
    const rows = await itemsWithSku("LIP");
    expect(rows.map((r) => r.kind).sort()).toEqual(["variant_child", "variant_child", "variant_parent"]);
  });

  it("makes one variation stub when an order carries the same unmapped variation twice", async () => {
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type) VALUES
         ($1, '1120', 'Card clearing', 'asset'), ($1, '2200', 'VAT', 'liability'),
         ($1, '1350', 'Inventory', 'asset'), ($1, '4570', 'Sales', 'revenue'),
         ($1, '5150', 'COGS', 'expense'), ($1, '4100', 'Sales', 'revenue')
       ON CONFLICT DO NOTHING`,
      [biz.id],
    );
    const body = JSON.stringify({
      id: 9001,
      number: "9001",
      status: "processing",
      total: "100000",
      total_tax: "0",
      currency: "IRT",
      date_created_gmt: new Date().toISOString(),
      payment_method: "cod",
      customer_id: 0,
      billing: { first_name: "سارا", last_name: "احمدی", phone: "09123456789" },
      line_items: [
        { id: 1, product_id: 600, variation_id: 603, name: "رژ لب - بنفش", sku: "LIP-V", quantity: 1, price: "50000", total: "50000" },
        { id: 2, product_id: 600, variation_id: 603, name: "رژ لب - بنفش", sku: "LIP-V", quantity: 1, price: "50000", total: "50000" },
      ],
    });
    const response = await ingest.handleWooCommerceWebhook(
      biz.connectionId,
      body,
      new Headers({
        "x-wc-webhook-signature": wooWebhookSignature(body, webhookSecret),
        "x-wc-webhook-delivery-id": `d-${randomUUID()}`,
        "x-wc-webhook-topic": "order.created",
      }),
    );
    expect(response.status).toBeLessThan(300);
    const failed = await db.query<{ error: string | null }>(
      `SELECT error FROM integration_webhook_events WHERE connection_id = $1 AND remote_id = '9001'`,
      [biz.connectionId],
    );
    expect(failed.rows[0]?.error ?? null).toBeNull();
    const rows = await itemsWithSku("LIP-V");
    expect(rows).toHaveLength(1);
  });
});

describe("the duplicate-SKU report explains each group without writing anything", () => {
  beforeAll(async () => {
    const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
    // A race orphan, as the pre-fix code left it: an unmapped twin of 501.
    await db.query(
      `WITH i AS (INSERT INTO items (location_id, name, sku, kind) VALUES ($1, 'کرم مرطوب‌کننده', 'zza05023', 'simple') RETURNING id)
       INSERT INTO item_stock (item_id, quantity) SELECT id, 5 FROM i`,
      [biz.locationId],
    );
    // The store's own payload for 501, as the inbox recorded it.
    await db.query(
      `INSERT INTO integration_webhook_events (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status)
       VALUES ($1, $2, 'product.updated', '501', $3, $4, 'processed')`,
      [biz.id, biz.connectionId, `snap-${randomUUID()}`, JSON.stringify(simpleProduct(501, "zza05023", 6))],
    );
    // Two different store products that share one SKU.
    await dbLib.withTenant(biz.id, async () => {
      await sync.upsertProductFromWoo(connection, biz.locationId, simpleProduct(700, "zza06379", 5));
      await sync.upsertProductFromWoo(connection, biz.locationId, simpleProduct(701, "zza06379", 6));
    });
    // Two hand-made rows, two days apart.
    await db.query(
      `INSERT INTO items (location_id, name, sku, created_at) VALUES
         ($1, 'سرم', 'MANUAL-1', now() - interval '2 days'), ($1, 'سرم', 'MANUAL-1', now())`,
      [biz.locationId],
    );
    // The store re-linked as a second connection: 900 mapped from both.
    const second = await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, base_url, link_mode, link_token_hash, link_token_ciphertext,
          webhook_secret_ciphertext, currency_unit)
       VALUES ($1, $2, 'Store (plugin)', 'https://www.beauty.example.com/', 'plugin', $3, 'x', 'x', 'toman')
       RETURNING id`,
      [biz.id, biz.locationId, `hash-${randomUUID()}`],
    );
    await dbLib.withTenant(biz.id, async () => {
      await sync.upsertProductFromWoo(connection, biz.locationId, simpleProduct(900, "RELINK", 1));
      const relinked = (await connections.getConnection(biz.id, second.rows[0].id))!;
      await sync.upsertProductFromWoo(relinked, biz.locationId, simpleProduct(900, "RELINK", 1));
    });
  });

  it("classifies every kind of group and carries the provenance an owner needs", async () => {
    const before = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM items`);
    const groups = await report.findDuplicateItemGroups(biz.id);
    const after = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM items`);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const verdicts = Object.fromEntries(groups.map((g) => [g.sku, g.verdict]));
    expect(verdicts).toEqual({
      lip: "variant_family",
      "manual-1": "unmapped_duplicate",
      relink: "same_remote_mapped_twice",
      zza05023: "race_orphan",
      zza06379: "distinct_remote_records",
    });

    const race = groups.find((g) => g.sku === "zza05023")!;
    const mapped = race.members.find((m) => m.mappings.length > 0)!;
    const orphan = race.members.find((m) => m.mappings.length === 0)!;
    expect(mapped.mappings[0]).toMatchObject({ connectionId: biz.connectionId, remoteId: "501", provider: "woocommerce" });
    expect(mapped.snapshots[0]).toMatchObject({ remoteId: "501", sku: "zza05023", stockQuantity: 6 });
    expect(Number(orphan.quantity)).toBe(5);
    expect(orphan.provenance).toBe("local (no integration mapping)");

    const family = groups.find((g) => g.sku === "lip")!;
    const child = family.members.find((m) => m.kind === "variant_child")!;
    expect(child.mappings[0].remoteParentId).toBe("600");

    // And the product list can tell the twins apart.
    const { listCosmeticBoard } = await import("../src/lib/cosmetics-service");
    const board = await dbLib.withTenant(biz.id, () => listCosmeticBoard(biz.locationId));
    expect(board.find((row) => row.id === mapped.itemId)?.source).toEqual({ provider: "woocommerce", remoteId: "501" });
    expect(board.find((row) => row.id === orphan.itemId)?.source).toBeNull();
  });

  it("filters to one SKU, case-insensitively, and never reads another business", async () => {
    const one = await report.findDuplicateItemGroups(biz.id, { sku: " ZZA06379 " });
    expect(one.map((g) => g.sku)).toEqual(["zza06379"]);
    expect(one[0].members).toHaveLength(2);

    const other = await report.findDuplicateItemGroups(biz.otherBizId, { sku: "zza06379" });
    expect(other).toHaveLength(1);
    expect(other[0].verdict).toBe("unmapped_duplicate");
    const ours = new Set(one[0].members.map((m) => m.itemId));
    expect(other[0].members.some((m) => ours.has(m.itemId))).toBe(false);
  });
});
