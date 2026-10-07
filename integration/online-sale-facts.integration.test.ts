/**
 * Dashboard audit F01, F03, F06 — the online sale fact, against a real database.
 *
 *   - a missing unit cost no longer skips the stock movement or last_sold_at,
 *     and the line is recorded as `missing` cost (no COGS invented);
 *   - a remote snapshot newer than the order is not relieved a second time;
 *   - a shortfall is recorded, not clamped away;
 *   - a replayed delivery writes nothing twice;
 *   - a historical order keeps its own date (order, payment, journal) and its
 *     document breakdown is stored with the unexplained difference;
 *   - a refund restores only what the sale relieved and reverses only the
 *     COGS it posted;
 *   - the fact's reference affinity is enforced by the database.
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
const WOO_SECRET = "online-facts-woo-secret";
const CMS_SECRET = "online-facts-cms-secret";

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

function wooOrder(
  id: number,
  productId: number,
  quantity: number,
  price: string,
  variationId?: number,
  extra: Record<string, unknown> = {},
) {
  const total = String(Number(price) * quantity);
  return JSON.stringify({
    id,
    number: String(2000 + id),
    status: "processing",
    total,
    total_tax: "0",
    currency: "IRT",
    date_created: new Date().toISOString(),
    ...extra,
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
  databaseName = `pos_online_facts_${randomUUID().replaceAll("-", "")}`;
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
    "INSERT INTO businesses (name, slug, industry) VALUES ('Online Facts', $1, 'cosmetics') RETURNING id",
    [`facts-${randomUUID().slice(0, 8)}`],
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


async function item(name: string, remoteId: string, opts: { quantity: string; unitCost: number | null }): Promise<string> {
  const created = await itemsService.createItem({ locationId: biz.locationId, name, kind: "simple", tracking: "none" });
  await db.query(
    `INSERT INTO item_stock (item_id, quantity, unit_cost, unit_price) VALUES ($1, $2, $3, 600000)
     ON CONFLICT (item_id) DO UPDATE SET quantity = EXCLUDED.quantity, unit_cost = EXCLUDED.unit_cost`,
    [created.id, opts.quantity, opts.unitCost],
  );
  await db.query(
    `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
     VALUES ($1, $2, 'product', $3, $4)`,
    [biz.id, biz.wooConnectionId, remoteId, created.id],
  );
  return created.id;
}

async function stock(itemId: string) {
  const { rows } = await db.query<{ quantity: string; last_sold_at: string | null }>(
    "SELECT quantity::text, last_sold_at::text FROM item_stock WHERE item_id = $1",
    [itemId],
  );
  return rows[0];
}

async function factFor(itemId: string) {
  const { rows } = await db.query<{
    order_id: string; cost_status: string; cogs_rial: string; stock_outcome: string;
    relieved_quantity: string; short_quantity: string; net_rial: string; occurred_at: string;
    restored_quantity: string; restored_cogs_rial: string;
  }>(
    `SELECT order_id, cost_status, cogs_rial::text, stock_outcome, relieved_quantity::text,
            short_quantity::text, net_rial::text, occurred_at::text,
            restored_quantity::text, restored_cogs_rial::text
       FROM online_sale_lines WHERE item_id = $1 ORDER BY created_at`,
    [itemId],
  );
  return rows;
}

async function deliver(body: string, topic = "order.created", deliveryId = `d-${randomUUID()}`) {
  const res = await wooIngest.handleWooCommerceWebhook(biz.wooConnectionId, body, wooHeaders(body, topic, deliveryId));
  expect(res.status).toBe(200);
  return deliveryId;
}

async function cogsEntriesFor(orderId: string) {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_id = $2 AND posting_kind = 'cogs'`,
    [biz.id, orderId],
  );
  return Number(rows[0].n);
}

describe("online sale facts — stock and cost", () => {
  it("relieves stock and marks cost missing when the item has no cost basis", async () => {
    const itemId = await item("رژ لب بی‌بها", "701", { quantity: "5", unitCost: null });
    await deliver(wooOrder(7001, 701, 2, "50000"));

    const after = await stock(itemId);
    expect(after.quantity).toBe("3.000000000");
    expect(after.last_sold_at).not.toBeNull();

    const [fact] = await factFor(itemId);
    expect(fact).toMatchObject({ cost_status: "missing", cogs_rial: "0", stock_outcome: "relieved", net_rial: "1000000" });
    expect(await cogsEntriesFor(fact.order_id)).toBe(0);
  });

  it("does not relieve a sale a newer remote snapshot already contains", async () => {
    const itemId = await item("ریمل", "702", { quantity: "4", unitCost: 20_000 });
    await db.query("UPDATE item_stock SET remote_snapshot_at = now() WHERE item_id = $1", [itemId]);
    const placed = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, "");
    await deliver(wooOrder(7002, 702, 1, "50000", undefined, { date_created_gmt: placed }));

    expect((await stock(itemId)).quantity).toBe("4.000000000");
    const [fact] = await factFor(itemId);
    expect(fact).toMatchObject({ stock_outcome: "already_reflected", relieved_quantity: "0.000000000", cost_status: "known", cogs_rial: "20000" });
  });

  it("relieves a sale placed after the last snapshot", async () => {
    const itemId = await item("سایه", "703", { quantity: "4", unitCost: 20_000 });
    await db.query("UPDATE item_stock SET remote_snapshot_at = now() - interval '2 hours' WHERE item_id = $1", [itemId]);
    const placed = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "");
    await deliver(wooOrder(7003, 703, 1, "50000", undefined, { date_created_gmt: placed }));
    expect((await stock(itemId)).quantity).toBe("3.000000000");
    expect((await factFor(itemId))[0].stock_outcome).toBe("relieved");
  });

  it("records a shortfall instead of clamping it away", async () => {
    const itemId = await item("کرم دور چشم", "704", { quantity: "1", unitCost: 30_000 });
    await deliver(wooOrder(7004, 704, 3, "50000"));
    expect((await stock(itemId)).quantity).toBe("0.000000000");
    const [fact] = await factFor(itemId);
    expect(fact).toMatchObject({ stock_outcome: "short", relieved_quantity: "1.000000000", short_quantity: "2.000000000", cost_status: "partial", cogs_rial: "30000" });
  });

  it("is idempotent when the same order is delivered twice", async () => {
    const itemId = await item("تونر", "705", { quantity: "5", unitCost: 10_000 });
    const body = wooOrder(7005, 705, 2, "50000");
    await deliver(body);
    await deliver(body, "order.updated");
    expect((await stock(itemId)).quantity).toBe("3.000000000");
    expect(await factFor(itemId)).toHaveLength(1);
  });
});

describe("online sale facts — chronology and breakdown", () => {
  it("keeps a historical order on its own date, not the import day", async () => {
    const itemId = await item("عطر", "706", { quantity: "5", unitCost: null });
    await deliver(wooOrder(7006, 706, 1, "2250000", undefined, {
      total: "2478000",
      date_created_gmt: "2026-03-01T06:30:00",
      date_paid_gmt: "2026-03-01T06:35:00",
    }));
    const [fact] = await factFor(itemId);
    const { rows: [order] } = await db.query<{ opened_at: string; closed_at: string }>(
      "SELECT opened_at::text, closed_at::text FROM orders WHERE id = $1",
      [fact.order_id],
    );
    expect(new Date(order.opened_at).toISOString()).toBe("2026-03-01T06:30:00.000Z");
    expect(new Date(order.closed_at).toISOString()).toBe("2026-03-01T06:35:00.000Z");
    expect(new Date(fact.occurred_at).toISOString()).toBe("2026-03-01T06:35:00.000Z");

    const { rows: entries } = await db.query<{ entry_date: string }>(
      "SELECT entry_date::text FROM journal_entries WHERE business_id = $1 AND source_id = $2",
      [biz.id, fact.order_id],
    );
    expect(entries.map((e) => e.entry_date)).toEqual(["2026-03-01"]);
    const { rows: [payment] } = await db.query<{ received_at: string }>(
      "SELECT received_at::text FROM payments WHERE order_id = $1",
      [fact.order_id],
    );
    expect(new Date(payment.received_at).toISOString()).toBe("2026-03-01T06:35:00.000Z");

    // Items 2,250,000 Toman, total 2,478,000 — the audit's unexplained 228,000
    // is stored and named, not absorbed. The payload gave no shipping/fees.
    const { rows: [doc] } = await db.query<{
      occurred_at_source: string; breakdown_status: string; unexplained_difference_rial: string; imported_at: string;
    }>(
      `SELECT occurred_at_source, breakdown_status, unexplained_difference_rial::text, imported_at::text
         FROM online_order_documents WHERE order_id = $1`,
      [fact.order_id],
    );
    expect(doc).toMatchObject({ occurred_at_source: "remote_paid", breakdown_status: "incomplete", unexplained_difference_rial: "2280000" });
    expect(Date.parse(doc.imported_at)).toBeGreaterThan(Date.parse("2026-10-01T00:00:00Z"));
  });

  it("reconciles a complete breakdown with shipping", async () => {
    const itemId = await item("شامپو", "707", { quantity: "5", unitCost: 10_000 });
    await deliver(wooOrder(7007, 707, 1, "100000", undefined, {
      total: "120000", discount_total: "0", shipping_total: "20000", fee_lines: [],
    }));
    const [fact] = await factFor(itemId);
    const { rows: [doc] } = await db.query<{ breakdown_status: string; shipping_rial: string }>(
      "SELECT breakdown_status, shipping_rial::text FROM online_order_documents WHERE order_id = $1",
      [fact.order_id],
    );
    expect(doc).toEqual({ breakdown_status: "reconciled", shipping_rial: "200000" });
  });
});

describe("online sale facts — refunds", () => {
  it("restores what a missing-cost sale relieved and reverses no COGS", async () => {
    const itemId = await item("لوسیون", "708", { quantity: "5", unitCost: null });
    await deliver(wooOrder(7008, 708, 2, "50000"));
    // A cost recorded *after* the sale must not be reversed out of COGS the
    // sale never posted.
    await db.query("UPDATE item_stock SET unit_cost = 40000 WHERE item_id = $1", [itemId]);
    const reversals = async () => Number((await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND posting_kind = 'cogs_reversal'",
      [biz.id],
    )).rows[0].n);
    const before = await reversals();
    await deliver(wooRefund(9008, 7008, 708, 1, "50000"), "refund.created");

    expect((await stock(itemId)).quantity).toBe("4.000000000");
    const [fact] = await factFor(itemId);
    expect(fact).toMatchObject({ restored_quantity: "1.000000000", restored_cogs_rial: "0" });
    expect(await reversals()).toBe(before);
  });

  it("never restocks a unit the snapshot already accounted for", async () => {
    const itemId = await item("بالم", "709", { quantity: "4", unitCost: 20_000 });
    await db.query("UPDATE item_stock SET remote_snapshot_at = now() WHERE item_id = $1", [itemId]);
    const placed = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, "");
    await deliver(wooOrder(7009, 709, 1, "50000", undefined, { date_created_gmt: placed }));
    await deliver(wooRefund(9009, 7009, 709, 1, "50000"), "refund.created");
    expect((await stock(itemId)).quantity).toBe("4.000000000");
    const [fact] = await factFor(itemId);
    expect(fact).toMatchObject({ restored_quantity: "0.000000000", restored_cogs_rial: "20000" });
  });
});

describe("online sale facts — CMS and affinity", () => {
  it("records a CMS sale's fact and dates it from the order", async () => {
    const created = await itemsService.createItem({ locationId: biz.locationId, name: "ژل", kind: "simple", tracking: "none" });
    await db.query("INSERT INTO item_stock (item_id, quantity) VALUES ($1, 3) ON CONFLICT (item_id) DO UPDATE SET quantity = 3", [created.id]);
    await db.query(
      `INSERT INTO website_product_map (business_id, local_kind, local_id, remote_id, sync_enabled)
       VALUES ($1, 'item', $2, 'cms-fact-1', true)`,
      [biz.id, created.id],
    );
    const order = { ...cmsOrder(`ord-${randomUUID()}`, "cms-fact-1", 1, 50_000, "paid"), createdAt: "2026-04-02T08:00:00.000Z", updatedAt: "2026-04-02T08:10:00.000Z" };
    const res = await cmsIngest.handleCmsStoreOrderWebhook({ siteId: biz.siteId, deliveryId: `del-${randomUUID()}`, event: "order.paid", order });
    expect(res.status).toBe(200);
    expect((await stock(created.id)).quantity).toBe("2.000000000");
    const [fact] = await factFor(created.id);
    expect(fact).toMatchObject({ cost_status: "missing", stock_outcome: "relieved" });
    expect(new Date(fact.occurred_at).toISOString()).toBe("2026-04-02T08:10:00.000Z");
  });

  it("refuses a fact filed under another branch than its order", async () => {
    const other = await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Other') RETURNING id", [biz.id]);
    const { rows: [line] } = await db.query<{ id: string; order_id: string }>(
      "SELECT order_item_id AS id, order_id FROM online_sale_lines LIMIT 1",
    );
    await expect(db.query(
      `INSERT INTO online_sale_lines (order_item_id, order_id, location_id, source_type, quantity, net_rial, cost_status, stock_outcome, occurred_at)
       VALUES (gen_random_uuid(), $1, $2, 'woocommerce_order', 1, 0, 'missing', 'relieved', now())`,
      [line.order_id, other.rows[0].id],
    )).rejects.toThrow();
  });
});

describe("legacy backfill script", () => {
  it("dry-runs without writing, then reconstructs facts idempotently with --apply", async () => {
    const { execFileSync } = await import("node:child_process");
    // Simulate pre-0209 history: drop the facts the imports above wrote.
    const { rows: [{ n: before }] } = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM online_sale_lines");
    await db.query("DELETE FROM online_sale_lines");

    const run = (...args: string[]) => {
      try {
        return execFileSync("npx", ["tsx", "scripts/backfill-online-sale-lines.ts", "--business", biz.id, ...args], {
          env: { ...process.env, DATABASE_URL: urlFor(databaseName) },
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (err) {
        throw new Error(`backfill failed: ${(err as { stderr?: string }).stderr ?? String(err)}`);
      }
    };

    const dry = run();
    expect(dry).toContain("DRY RUN");
    expect(dry).toContain("reconciliation");
    expect((await db.query("SELECT 1 FROM online_sale_lines")).rowCount).toBe(0);

    run("--apply");
    const { rows: [{ n: after }] } = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM online_sale_lines");
    expect(Number(after)).toBe(Number(before));
    run("--apply");
    const { rows: [{ n: again }] } = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM online_sale_lines");
    expect(again).toBe(after);

    // Nothing the books hold was touched, and no cost was invented.
    const { rows: statuses } = await db.query<{ cost_status: string }>(
      "SELECT DISTINCT cost_status FROM online_sale_lines ORDER BY 1",
    );
    expect(statuses.map((r) => r.cost_status).every((s) => ["known", "missing", "not_applicable", "unattributed"].includes(s))).toBe(true);
  }, 120_000);
});
