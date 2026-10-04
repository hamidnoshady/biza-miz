/**
 * Issue #770 — WooCommerce and Eshobe CMS sales/refunds for batch-tracked
 * cosmetics, against a real database.
 *
 * Before this change each adapter carried its own "read item_stock.unit_cost,
 * decrement item_stock.quantity, post COGS" copy, so a batch-tracked item sold
 * through a website bypassed FEFO, could sell expired stock, never touched
 * `item_batches` and posted a shelf-average COGS. These tests pin the fixed
 * behaviour:
 *
 *   - a Woo order for a batch item allocates FEFO, persists the allocation on
 *     the order line, decrements exactly those lots and posts exact COGS;
 *   - expired stock is refused (the import fails and can be retried);
 *   - a Woo refund restores the ORIGINAL lot, reverses exactly the value that
 *     came back, and a replayed delivery restores nothing twice;
 *   - a variation refund maps to the variation, symmetrically with the sale;
 *   - a CMS paid order goes through the same engine, and a CMS refund runs
 *     through the retail reversal path (not F&B's amendment engine): entries
 *     mirrored, exact lots restored, order voided.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";
import { wooWebhookSignature } from "../src/lib/integrations/webhook-signature";
import type { CmsOrder } from "../src/lib/cms/types";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const KEY = "ab".repeat(32);
const WOO_SECRET = "online-batch-woo-secret";
const CMS_SECRET = "online-batch-cms-secret";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let wooIngest: typeof import("../src/lib/integrations/webhook-ingest-service");
let cmsIngest: typeof import("../src/lib/cms/order-ingest-service");
let cosmetics: typeof import("../src/lib/cosmetics-service");
let itemsService: typeof import("../src/lib/items-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", locationId: "", wooConnectionId: "", cmsConnectionId: "", siteId: "" };

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

function wooHeaders(body: string, topic: string, deliveryId: string): Headers {
  return new Headers({
    "x-wc-webhook-signature": wooWebhookSignature(body, WOO_SECRET),
    "x-wc-webhook-delivery-id": deliveryId,
    "x-wc-webhook-topic": topic,
  });
}

function wooOrder(id: number, productId: number, quantity: number, price: string, variationId?: number) {
  const total = String(Number(price) * quantity);
  return JSON.stringify({
    id,
    number: String(2000 + id),
    status: "processing",
    total,
    total_tax: "0",
    currency: "IRT",
    date_created: new Date().toISOString(),
    payment_method: "cod",
    line_items: [
      {
        id: 1,
        name: "کرم ضدآفتاب",
        product_id: productId,
        ...(variationId ? { variation_id: variationId } : {}),
        quantity,
        price,
        total,
      },
    ],
    billing: { first_name: "مینا", last_name: "کاظمی" },
  });
}

function wooRefund(id: number, parentId: number, productId: number, quantity: number, price: string, variationId?: number) {
  return JSON.stringify({
    id,
    parent_id: parentId,
    date_created: new Date().toISOString(),
    amount: String(Number(price) * quantity),
    total_tax: "0",
    reason: "return",
    line_items: [
      {
        product_id: productId,
        ...(variationId ? { variation_id: variationId } : {}),
        quantity: -quantity,
        total: String(-Number(price) * quantity),
      },
    ],
  });
}

function cmsOrder(id: string, product: string, quantity: number, unitPrice: number, status: CmsOrder["status"]): CmsOrder {
  return {
    id,
    reference: `CMS-${id}`,
    status,
    product,
    productTitle: "کرم ضدآفتاب",
    quantity,
    unitPrice,
    total: unitPrice * quantity,
    currency: "IRT",
    buyer: { name: "سارا", phone: "09120000000", email: null, note: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  databaseName = `pos_online_batch_${randomUUID().replaceAll("-", "")}`;
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
  process.env.ESHOBE_CMS_WEBHOOK_SECRET = CMS_SECRET;

  dbLib = await import("../src/lib/db");
  wooIngest = await import("../src/lib/integrations/webhook-ingest-service");
  cmsIngest = await import("../src/lib/cms/order-ingest-service");
  cosmetics = await import("../src/lib/cosmetics-service");
  itemsService = await import("../src/lib/items-service");
  provisioning = await import("../src/lib/business-provisioning");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Online Cosmetics', $1, 'cosmetics') RETURNING id",
    [`online-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = loc.rows[0].id;

  const seedClient = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(seedClient, biz.id, "cosmetics");
  } finally {
    seedClient.release();
  }

  const cipher = (value: string) => encryptSecret(value, Buffer.from(KEY, "hex"));
  const wooConn = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
     VALUES ($1, $2, 'Store', 'https://shop.example.com', $3, $4, $5, 'toman', true, true, true, true, true)
     RETURNING id`,
    [biz.id, biz.locationId, cipher("ck"), cipher("cs"), cipher(WOO_SECRET)],
  );
  biz.wooConnectionId = wooConn.rows[0].id;

  biz.siteId = `site-${randomUUID()}`;
  const cmsConn = await db.query<{ id: string }>(
    `INSERT INTO eshobe_cms_connections (business_id, site_id, site_domain, base_url, api_key_ciphertext)
     VALUES ($1, $2, 'shop.test', 'https://cms.test', $3) RETURNING id`,
    [biz.id, biz.siteId, cipher("eshobe_key")],
  );
  biz.cmsConnectionId = cmsConn.rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  delete process.env.ESHOBE_CMS_WEBHOOK_SECRET;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
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

/** A batch-tracked item with two lots; the earlier-expiring one is FEFO-first. */
async function batchItem(name: string, remoteId: string): Promise<string> {
  const item = await itemsService.createItem({
    locationId: biz.locationId,
    name,
    kind: "simple",
    tracking: "batch",
  });
  await withTransaction((client) =>
    cosmetics.receiveBatch(client, {
      itemId: item.id,
      batchNumber: "EARLY",
      expiryDate: "2030-01-01",
      quantity: "5",
      unitCost: 10_000,
    }),
  );
  await withTransaction((client) =>
    cosmetics.receiveBatch(client, {
      itemId: item.id,
      batchNumber: "LATE",
      expiryDate: "2031-01-01",
      quantity: "5",
      unitCost: 20_000,
    }),
  );
  await db.query(
    `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
     VALUES ($1, $2, 'product', $3, $4)`,
    [biz.id, biz.wooConnectionId, remoteId, item.id],
  );
  return item.id;
}

async function batchQuantity(itemId: string, batchNumber: string): Promise<string> {
  const { rows } = await db.query<{ quantity: string }>(
    "SELECT quantity::text FROM item_batches WHERE item_id = $1 AND batch_number = $2",
    [itemId, batchNumber],
  );
  return rows[0]?.quantity ?? "0";
}

async function stockQuantity(itemId: string): Promise<string> {
  const { rows } = await db.query<{ quantity: string }>(
    "SELECT quantity::text FROM item_stock WHERE item_id = $1",
    [itemId],
  );
  return rows[0]?.quantity ?? "0";
}

async function latestCogsEntry(sourceType: string, postingKind: string) {
  const { rows } = await db.query<{ id: string; total: string }>(
    `SELECT e.id, COALESCE(SUM(l.debit), 0)::text AS total
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.business_id = $1 AND e.source_type = $2 AND e.posting_kind = $3
      GROUP BY e.id ORDER BY max(e.posted_at) DESC LIMIT 1`,
    [biz.id, sourceType, postingKind],
  );
  return rows[0] ?? null;
}

describe("WooCommerce batch sales", () => {
  it("allocates FEFO, persists the allocation and posts exact batch COGS", async () => {
    const itemId = await batchItem("کرم روز", "501");
    const body = wooOrder(4001, 501, 3, "60000");
    const res = await wooIngest.handleWooCommerceWebhook(
      biz.wooConnectionId,
      body,
      wooHeaders(body, "order.created", `d-${randomUUID()}`),
    );
    expect(res.status).toBe(200);

    // 3 units: all from EARLY (2030), at its own 10,000 cost.
    expect(await batchQuantity(itemId, "EARLY")).toBe("2.000000000");
    expect(await batchQuantity(itemId, "LATE")).toBe("5.000000000");
    expect(await stockQuantity(itemId)).toBe("7.000000000");

    const allocations = await db.query<{ batch_number: string; quantity: string; cost_value: string }>(
      `SELECT a.batch_number, a.quantity::text, a.cost_value::text
         FROM order_item_batch_allocations a
         JOIN order_items oi ON oi.id = a.order_item_id
         JOIN orders o ON o.id = oi.order_id
        WHERE o.location_id = $1 AND a.item_id = $2`,
      [biz.locationId, itemId],
    );
    expect(allocations.rows).toEqual([{ batch_number: "EARLY", quantity: "3.000000000", cost_value: "30000" }]);

    // 3 × 10,000 — the lots' own cost, not the 15,000 shelf average.
    const cogs = await latestCogsEntry("woocommerce_order", "cogs");
    expect(cogs?.total).toBe("30000");
  });

  it("refuses to sell an expired-only item over Woo, leaving stock untouched", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ضدآفتاب منقضی",
      kind: "simple",
      tracking: "batch",
    });
    await withTransaction((client) =>
      cosmetics.receiveBatch(client, {
        itemId: item.id,
        batchNumber: "EXPIRED",
        expiryDate: "2020-01-01",
        quantity: "4",
        unitCost: 10_000,
      }),
    );
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', '502', $3)`,
      [biz.id, biz.wooConnectionId, item.id],
    );

    const body = wooOrder(4002, 502, 1, "60000");
    const res = await wooIngest.handleWooCommerceWebhook(
      biz.wooConnectionId,
      body,
      wooHeaders(body, "order.created", `d-${randomUUID()}`),
    );
    // The import fails and the sender may retry — it must never sell expired stock.
    expect(res.status).toBe(500);
    expect(await batchQuantity(item.id, "EXPIRED")).toBe("4.000000000");
    expect(await stockQuantity(item.id)).toBe("4.000000000");
  });

  it("restores the original lot on a Woo refund, reverses its exact value, and is idempotent", async () => {
    const itemId = await batchItem("کرم شب", "503");
    const orderBody = wooOrder(4003, 503, 2, "60000");
    await wooIngest.handleWooCommerceWebhook(
      biz.wooConnectionId,
      orderBody,
      wooHeaders(orderBody, "order.created", `d-${randomUUID()}`),
    );
    expect(await batchQuantity(itemId, "EARLY")).toBe("3.000000000");

    const refundBody = wooRefund(9003, 4003, 503, 1, "60000");
    const res = await wooIngest.handleWooCommerceWebhook(
      biz.wooConnectionId,
      refundBody,
      wooHeaders(refundBody, "refund.created", `d-${randomUUID()}`),
    );
    expect(res.status).toBe(200);

    // Back into EARLY — the lot the sale actually consumed.
    expect(await batchQuantity(itemId, "EARLY")).toBe("4.000000000");
    expect(await stockQuantity(itemId)).toBe("9.000000000");
    const cogsReversal = await latestCogsEntry("woocommerce_refund", "cogs_reversal");
    expect(cogsReversal?.total).toBe("10000");

    const { rows: restored } = await db.query<{ restored_quantity: string }>(
      `SELECT a.restored_quantity::text FROM order_item_batch_allocations a
         JOIN order_items oi ON oi.id = a.order_item_id
        WHERE a.item_id = $1`,
      [itemId],
    );
    expect(restored[0].restored_quantity).toBe("1.000000000");

    // A replay of the same refund delivery must not restore twice.
    await wooIngest.handleWooCommerceWebhook(
      biz.wooConnectionId,
      refundBody,
      wooHeaders(refundBody, "refund.created", `d-${randomUUID()}`),
    );
    expect(await batchQuantity(itemId, "EARLY")).toBe("4.000000000");
  });

  it("maps a variation refund to the variation, symmetrically with the sale", async () => {
    // Two sellable rows: the parent (never the sold row) and the variation.
    const parent = await itemsService.createItem({
      locationId: biz.locationId,
      name: "رژ لب",
      kind: "variant_parent",
    });
    const child = await itemsService.createVariantChild(parent.id, biz.locationId, "رژ لب — قرمز", null, [
      { name: "رنگ", value: "قرمز" },
    ]);
    await withTransaction((client) =>
      cosmetics.receiveStock(child.id, { quantity: "5", unitCost: 30_000 }, client),
    );
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', '601', $3), ($1, $2, 'product', '602', $4)`,
      [biz.id, biz.wooConnectionId, parent.id, child.id],
    );

    const orderBody = wooOrder(4004, 601, 2, "100000", 602);
    const orderRes = await wooIngest.handleWooCommerceWebhook(
      biz.wooConnectionId,
      orderBody,
      wooHeaders(orderBody, "order.created", `d-${randomUUID()}`),
    );
    expect(orderRes.status).toBe(200);
    expect(await stockQuantity(child.id)).toBe("3.000000000");
    // The parent never held stock: the variation is the sellable row.
    expect(await stockQuantity(parent.id)).toBe("0");

    const refundBody = wooRefund(9004, 4004, 601, 1, "100000", 602);
    const res = await wooIngest.handleWooCommerceWebhook(
      biz.wooConnectionId,
      refundBody,
      wooHeaders(refundBody, "refund.created", `d-${randomUUID()}`),
    );
    expect(res.status).toBe(200);

    // The variation is restored; the parent — which holds no stock for this
    // sale and was never sold — is untouched.
    expect(await stockQuantity(child.id)).toBe("4.000000000");
    expect(await stockQuantity(parent.id)).toBe("0");
  });
});

describe("Eshobe CMS batch sales and reversals", () => {
  it("imports a paid batch order through the canonical engine", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "کرم پودر",
      kind: "simple",
      tracking: "batch",
    });
    await withTransaction((client) =>
      cosmetics.receiveBatch(client, {
        itemId: item.id,
        batchNumber: "CMS-LOT",
        expiryDate: "2030-01-01",
        quantity: "4",
        unitCost: 12_000,
      }),
    );
    await db.query(
      `INSERT INTO website_product_map (business_id, local_kind, local_id, remote_id, sync_enabled)
       VALUES ($1, 'item', $2, $3, true)`,
      [biz.id, item.id, "cms-prod-1"],
    );

    const order = cmsOrder(`ord-${randomUUID()}`, "cms-prod-1", 2, 50_000, "paid");
    const res = await cmsIngest.handleCmsStoreOrderWebhook({
      siteId: biz.siteId,
      deliveryId: `del-${randomUUID()}`,
      event: "order.paid",
      order,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; orderId: string };
    expect(json.status).toBe("processed");

    expect(await batchQuantity(item.id, "CMS-LOT")).toBe("2.000000000");
    expect(await stockQuantity(item.id)).toBe("2.000000000");
    const cogs = await latestCogsEntry("cms_store_order", "cogs");
    expect(cogs?.total).toBe("24000");

    // The allocation is persisted against the line.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM order_item_batch_allocations a
         JOIN order_items oi ON oi.id = a.order_item_id
        WHERE oi.order_id = $1 AND a.item_id = $2`,
      [json.orderId, item.id],
    );
    expect(rows[0].n).toBe("1");

    // The reversal runs through the retail reversal path: entries mirrored,
    // the exact lot restored, the order voided — not F&B's amendment engine.
    const refundNotice = {
      siteId: biz.siteId,
      deliveryId: `del-${randomUUID()}`,
      event: "order.refunded" as const,
      order: { ...order, status: "refunded" as const },
    };
    const refundRes = await cmsIngest.handleCmsStoreOrderWebhook(refundNotice);
    expect(refundRes.status).toBe(200);
    const refundJson = (await refundRes.json()) as { status: string; amendmentId: string };
    expect(refundJson.status).toBe("processed");
    expect(refundJson.amendmentId).toBeTruthy();

    expect(await batchQuantity(item.id, "CMS-LOT")).toBe("4.000000000");
    expect(await stockQuantity(item.id)).toBe("4.000000000");
    const { rows: orderRows } = await db.query<{ status: string }>("SELECT status::text FROM orders WHERE id = $1", [
      json.orderId,
    ]);
    expect(orderRows[0].status).toBe("voided");

    // Both the revenue and the COGS entry were reversed, and the reversal
    // posted under the shared amendment identity.
    const { rows: reversed } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries
        WHERE business_id = $1 AND source_type = 'order_amendment' AND reversed_at IS NULL
          AND reverses_entry_id IS NOT NULL`,
      [biz.id],
    );
    expect(Number(reversed[0].n)).toBeGreaterThanOrEqual(2);

    // A replayed reversal delivery is a no-op.
    const replay = await cmsIngest.handleCmsStoreOrderWebhook({
      ...refundNotice,
      deliveryId: `del-${randomUUID()}`,
    });
    expect(replay.status).toBe(200);
    expect(await batchQuantity(item.id, "CMS-LOT")).toBe("4.000000000");
  });
});
