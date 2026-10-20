/**
 * Phase 23 (issue #118) — the WooCommerce webhook ingest path end-to-end
 * against a real database: a signed `order.created` delivery becomes a
 * completed delivery order + online payment + a balanced revenue journal
 * entry, a re-delivery is a no-op, an unsigned delivery is refused, and a
 * `refund.created` posts a balanced refund entry.
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

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let ingest: typeof import("../src/lib/integrations/webhook-ingest-service");
let connections: typeof import("../src/lib/integrations/connections-service");

const KEY = "ab".repeat(32);
const webhookSecret = "test-webhook-secret";

const biz = { id: "", locationId: "", connectionId: "", menuItemId: "", inventoryItemId: "" };

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

function orderPayload(id: number, total: string, totalTax: string) {
  return JSON.stringify({
    id,
    number: String(1000 + id),
    status: "processing",
    total,
    total_tax: totalTax,
    currency: "IRT",
    date_created: new Date().toISOString(),
    payment_method: "cod",
    line_items: [{ id: 1, name: "پیتزا", product_id: 1, quantity: 2, price: String(Number(total) / 2), total }],
    billing: { first_name: "علی", last_name: "محمدی" },
  });
}

beforeAll(async () => {
  databaseName = `pos_woo_${randomUUID().replaceAll("-", "")}`;

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
  connections = await import("../src/lib/integrations/connections-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Woo Store', $1) RETURNING id",
    [`woo-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  await db.query(
    `INSERT INTO accounts (business_id, code, name, type) VALUES
       ($1, '1100', 'Cash', 'asset'),
       ($1, '1120', 'Card clearing', 'asset'),
       ($1, '1200', 'Accounts Receivable', 'asset'),
       ($1, '1300', 'Inventory', 'asset'),
       ($1, '4330', 'Delivery', 'revenue'),
       ($1, '2200', 'VAT Payable', 'liability'),
       ($1, '4400', 'Sales Returns', 'revenue'),
       ($1, '5100', 'COGS', 'expense')`,
    [biz.id],
  );

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

  // A product→recipe mapping for the ingest's COGS path: WooCommerce product
  // #1 maps to a local menu item whose recipe consumes 0.5 units of a
  // 5,000-rial flour lot per unit sold.
  const invRow = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit, avg_cost, carrying_value_rial)
     VALUES ($1, 'آرد', 'unit', 5000, 50000) RETURNING id`,
    [biz.locationId],
  );
  biz.inventoryItemId = invRow.rows[0].id;
  const menuRow = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, name, price) VALUES ($1, 'پیتزا', '10000') RETURNING id`,
    [biz.locationId],
  );
  biz.menuItemId = menuRow.rows[0].id;
  await db.query(
    "INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 0.5)",
    [biz.menuItemId, biz.inventoryItemId],
  );
  await db.query(
    `INSERT INTO inventory_lots
       (location_id, inventory_item_id, remaining_qty, unit_cost, original_quantity, original_value_rial, remaining_value_rial)
     VALUES ($1, $2, 10, 5000, 10, 50000, 50000)`,
    [biz.locationId, biz.inventoryItemId],
  );
  await db.query(
    `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
     VALUES ($1, $2, 'product', '1', $3)`,
    [biz.id, biz.connectionId, biz.menuItemId],
  );
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

function signedHeaders(body: string, topic: string, deliveryId: string): Headers {
  return new Headers({
    "x-wc-webhook-signature": wooWebhookSignature(body, webhookSecret),
    "x-wc-webhook-delivery-id": deliveryId,
    "x-wc-webhook-topic": topic,
  });
}

describe("WooCommerce webhook ingest", () => {
  it("imports an order: completed delivery order + online payment + balanced revenue entry", async () => {
    const body = orderPayload(1, "10000", "1000"); // 10,000 toman = 100,000 rial, 1,000 toman tax
    const res = await ingest.handleWooCommerceWebhook(biz.connectionId, body, signedHeaders(body, "order.created", `d-${randomUUID()}`));
    expect(res.status).toBe(200);

    const orders = await db.query<{ id: string; type: string; status: string; total: string; tax: string; subtotal: string }>(
      "SELECT id, type, status, total, tax, subtotal FROM orders WHERE location_id = $1",
      [biz.locationId],
    );
    expect(orders.rowCount).toBe(1);
    expect(orders.rows[0]).toMatchObject({ type: "delivery", status: "completed", total: "100000", tax: "10000", subtotal: "90000" });

    const payments = await db.query("SELECT method, amount FROM payments WHERE order_id = $1", [orders.rows[0].id]);
    expect(payments.rows).toEqual([{ method: "online", amount: "100000" }]);

    const entry = await db.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE business_id = $1 AND source_type = 'woocommerce_order' AND posting_kind = 'revenue'",
      [biz.id],
    );
    expect(entry.rowCount).toBe(1);
    const lines = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit, jl.credit FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY jl.debit DESC`,
      [entry.rows[0].id],
    );
    expect(lines.rows).toEqual([
      { code: "1120", debit: "100000", credit: "0" },
      { code: "4330", debit: "0", credit: "90000" },
      { code: "2200", debit: "0", credit: "10000" },
    ]);

    const mapping = await db.query(
      "SELECT 1 FROM integration_mappings WHERE connection_id = $1 AND entity_type = 'order' AND remote_id = '1'",
      [biz.connectionId],
    );
    expect(mapping.rowCount).toBe(1);

    // The mapped product deducts inventory and posts COGS exactly like a POS
    // sale: 2 units × 0.5 flour = 1 unit @ 5,000 rial.
    const movements = await db.query<{ type: string; quantity: string; cost_value_rial: string; source_type: string }>(
      `SELECT type, quantity, cost_value_rial, source_type FROM stock_movements
        WHERE inventory_item_id = $1 AND source_id = $2`,
      [biz.inventoryItemId, orders.rows[0].id],
    );
    expect(movements.rows).toEqual([{ type: "sale", quantity: "-1.000000000", cost_value_rial: "5000", source_type: "order" }]);

    const cogs = await db.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE business_id = $1 AND source_type = 'order' AND source_id = $2 AND posting_kind = 'cogs'",
      [biz.id, orders.rows[0].id],
    );
    expect(cogs.rowCount).toBe(1);
    const cogsLines = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit, jl.credit FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY jl.debit DESC`,
      [cogs.rows[0].id],
    );
    expect(cogsLines.rows).toEqual([
      { code: "5100", debit: "5000", credit: "0" },
      { code: "1300", debit: "0", credit: "5000" },
    ]);

    const event = await db.query<{ event_type: string; posting_status: string }>(
      "SELECT event_type, posting_status FROM inventory_events WHERE source_id = $1",
      [orders.rows[0].id],
    );
    expect(event.rows).toEqual([{ event_type: "sale_consumption", posting_status: "posted" }]);

    const snapshots = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM order_item_inventory_snapshots s
        JOIN order_items oi ON oi.id = s.order_item_id WHERE oi.order_id = $1`,
      [orders.rows[0].id],
    );
    expect(snapshots.rows[0].n).toBe(1);
  });

  it("is idempotent across a second delivery of the same order (order.updated)", async () => {
    const body = orderPayload(1, "10000", "1000");
    const res = await ingest.handleWooCommerceWebhook(biz.connectionId, body, signedHeaders(body, "order.updated", `d-${randomUUID()}`));
    expect(res.status).toBe(200);

    const orders = await db.query("SELECT count(*)::int AS n FROM orders WHERE location_id = $1", [biz.locationId]);
    expect(orders.rows[0].n).toBe(1);
  });

  it("refuses a delivery with an invalid signature before touching the database", async () => {
    const body = orderPayload(2, "5000", "500");
    const headers = signedHeaders(body, "order.created", `d-${randomUUID()}`);
    headers.set("x-wc-webhook-signature", wooWebhookSignature(body, "wrong-secret"));
    const res = await ingest.handleWooCommerceWebhook(biz.connectionId, body, headers);
    expect(res.status).toBe(401);

    const orders = await db.query("SELECT count(*)::int AS n FROM orders WHERE location_id = $1", [biz.locationId]);
    expect(orders.rows[0].n).toBe(1);
  });

  it("records the sale without COGS for line items whose product has no mapping", async () => {
    const body = JSON.stringify({
      id: 3,
      number: "1003",
      status: "processing",
      total: "5000",
      total_tax: "0",
      currency: "IRT",
      date_created: new Date().toISOString(),
      payment_method: "cod",
      line_items: [{ id: 1, name: "نامشخص", product_id: 999, quantity: 1, price: "5000", total: "5000" }],
      billing: { first_name: "مریم", last_name: "رضایی" },
    });
    const res = await ingest.handleWooCommerceWebhook(biz.connectionId, body, signedHeaders(body, "order.created", `d-${randomUUID()}`));
    expect(res.status).toBe(200);

    const orders = await db.query<{ id: string }>(
      `SELECT o.id FROM orders o JOIN integration_mappings m ON m.local_id = o.id
        WHERE m.connection_id = $1 AND m.entity_type = 'order' AND m.remote_id = '3'`,
      [biz.connectionId],
    );
    expect(orders.rowCount).toBe(1);
    const orderId = orders.rows[0].id;

    const cogs = await db.query(
      "SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'order' AND source_id = $2 AND posting_kind = 'cogs'",
      [biz.id, orderId],
    );
    expect(cogs.rows[0].n).toBe(0);
    const events = await db.query(
      "SELECT count(*)::int AS n FROM inventory_events WHERE source_id = $1",
      [orderId],
    );
    expect(events.rows[0].n).toBe(0);
    const movements = await db.query(
      "SELECT count(*)::int AS n FROM stock_movements WHERE source_id = $1",
      [orderId],
    );
    expect(movements.rows[0].n).toBe(0);
  });

  it("reverses inventory and COGS for a refund of a mapped order, through the customer-return path", async () => {
    const body = JSON.stringify({
      id: 77,
      parent_id: 1, // the imported order (remote order #1)
      date_created: new Date().toISOString(),
      amount: "2000",
      total_tax: "200",
      reason: "return",
      line_items: [{ product_id: 1, quantity: -1, total: "-5000" }],
    });
    const res = await ingest.handleWooCommerceWebhook(biz.connectionId, body, signedHeaders(body, "refund.created", `d-${randomUUID()}`));
    expect(res.status).toBe(200);

    const returns = await db.query<{ id: string; refund_method: string; refund_amount_rial: string }>(
      "SELECT id, refund_method, refund_amount_rial FROM customer_returns WHERE business_id = $1",
      [biz.id],
    );
    expect(returns.rowCount).toBe(1);
    expect(returns.rows[0]).toMatchObject({ refund_method: "online", refund_amount_rial: "20000" });
    const returnId = returns.rows[0].id;

    const returnLines = await db.query<{ quantity: string; disposition: string }>(
      `SELECT l.quantity::text AS quantity, l.disposition FROM customer_return_lines l WHERE l.customer_return_id = $1`,
      [returnId],
    );
    expect(returnLines.rows).toEqual([{ quantity: "1.000000000", disposition: "restockable" }]);

    // Restored: the sale consumed 1 flour @ 5,000; returning 1 unit of the
    // 2-unit order restores half → +0.5 flour @ 2,500.
    const movements = await db.query<{ type: string; quantity: string; cost_value_rial: string }>(
      `SELECT type, quantity::text AS quantity, cost_value_rial FROM stock_movements
        WHERE inventory_item_id = $1 AND source_type = 'customer_return'`,
      [biz.inventoryItemId],
    );
    expect(movements.rows).toEqual([{ type: "adjustment", quantity: "0.500000000", cost_value_rial: "2500" }]);

    const reversal = await db.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE business_id = $1 AND source_type = 'customer_return' AND posting_kind = 'cogs_reversal'",
      [biz.id],
    );
    expect(reversal.rowCount).toBe(1);
    const reversalLines = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit, jl.credit FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY jl.debit DESC`,
      [reversal.rows[0].id],
    );
    expect(reversalLines.rows).toEqual([
      { code: "1300", debit: "2500", credit: "0" },
      { code: "5100", debit: "0", credit: "2500" },
    ]);

    // Money side, same shape as before: 2,000 toman = 20,000 rial, 200 toman
    // = 2,000 rial tax → net 18,000.
    const refundEntry = await db.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE business_id = $1 AND source_type = 'customer_return' AND posting_kind = 'customer_refund'",
      [biz.id],
    );
    expect(refundEntry.rowCount).toBe(1);
    const refundLines = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit, jl.credit FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY jl.debit DESC`,
      [refundEntry.rows[0].id],
    );
    expect(refundLines.rows).toEqual([
      { code: "4400", debit: "18000", credit: "0" },
      { code: "2200", debit: "2000", credit: "0" },
      { code: "1120", debit: "0", credit: "20000" },
    ]);
  });

  it("posts a money-only refund entry when the refund cannot be tied to an imported order", async () => {
    const body = JSON.stringify({
      id: 78,
      parent_id: 999, // no order mapping
      date_created: new Date().toISOString(),
      amount: "1000",
      total_tax: "0",
      reason: "return",
    });
    const res = await ingest.handleWooCommerceWebhook(biz.connectionId, body, signedHeaders(body, "refund.created", `d-${randomUUID()}`));
    expect(res.status).toBe(200);

    const entry = await db.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE business_id = $1 AND source_type = 'woocommerce_refund'",
      [biz.id],
    );
    expect(entry.rowCount).toBe(1);
    const lines = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit, jl.credit FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY jl.debit DESC`,
      [entry.rows[0].id],
    );
    // 1,000 toman = 10,000 rial, no tax.
    expect(lines.rows).toEqual([
      { code: "4400", debit: "10000", credit: "0" },
      { code: "1120", debit: "0", credit: "10000" },
    ]);

    const returns = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM customer_returns WHERE business_id = $1",
      [biz.id],
    );
    expect(returns.rows[0].n).toBe(1); // only the resolvable refund created a return
  });
});

describe("delivery retries and unpaid orders", () => {
  /** An order body whose status is overridable, for the gate tests. */
  function orderBodyWithStatus(id: number, status: string, total = "10000", tax = "1000") {
    const payload = JSON.parse(orderPayload(id, total, tax));
    payload.status = status;
    payload.line_items[0].price = String(Number(total) / 2);
    return JSON.stringify(payload);
  }

  async function countOrders(): Promise<number> {
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE location_id = $1", [
      biz.locationId,
    ]);
    return rows[0].n;
  }

  it("retries a delivery that failed instead of treating the re-send as a duplicate", async () => {
    // The exact data-loss bug this guards: the plugin (and the scheduled
    // pull) re-send the SAME delivery id after a failure. Until the retry
    // fix, the re-delivery hit the inbox's unique key, was answered
    // "duplicate" — which the plugin counts as success — and the event was
    // gone forever: no order, no payment, no journal entry, and the failed
    // inbox row rewritten to look like a duplicate.
    const before = await countOrders();
    const deliveryId = `retry-${randomUUID()}`;

    // First attempt: a payload the ingest rejects (tax larger than total).
    const bad = orderBodyWithStatus(501, "processing", "1000", "5000");
    const first = await ingest.handleWooCommerceWebhook(
      biz.connectionId,
      bad,
      signedHeaders(bad, "order.created", deliveryId),
    );
    expect(first.status).toBe(500);
    let inbox = await db.query<{ status: string; error: string }>(
      "SELECT status, error FROM integration_webhook_events WHERE connection_id = $1 AND delivery_id = $2",
      [biz.connectionId, deliveryId],
    );
    expect(inbox.rows[0]).toMatchObject({ status: "failed" });
    expect(inbox.rows[0].error).toBe("tax_exceeds_total");
    expect(await countOrders()).toBe(before);

    // The sender's retry: same delivery id, corrected payload.
    const good = orderBodyWithStatus(501, "processing", "10000", "1000");
    const second = await ingest.handleWooCommerceWebhook(
      biz.connectionId,
      good,
      signedHeaders(good, "order.created", deliveryId),
    );
    expect(second.status).toBe(200);
    inbox = await db.query<{ status: string; error: string }>(
      "SELECT status, error FROM integration_webhook_events WHERE connection_id = $1 AND delivery_id = $2",
      [biz.connectionId, deliveryId],
    );
    expect(inbox.rows[0]).toMatchObject({ status: "processed", error: null });
    expect(await countOrders()).toBe(before + 1);

    // And a third delivery of the now-processed id is still a cheap no-op.
    const third = await ingest.handleWooCommerceWebhook(
      biz.connectionId,
      good,
      signedHeaders(good, "order.created", deliveryId),
    );
    expect(third.status).toBe(200);
    expect(await countOrders()).toBe(before + 1);
  });

  it("retries a failed plugin push the same way — the plugin's re-send is not a free pass to drop it", async () => {
    // The plugin door in particular: POS_Connector_Queue keeps its row and
    // re-pushes it with the same delivery_id after a backoff, up to eight
    // attempts. If the app answered "duplicate" after the first failure, the
    // plugin would mark_sent its row and the catalogue or sale would never
    // arrive.
    const before = await countOrders();
    const connection = await dbLib!.withTenant(biz.id, () => connections.getConnection(biz.id, biz.connectionId));
    if (!connection) throw new Error("connection not found");
    const deliveryId = `plugin-retry-${randomUUID()}`;

    const bad = JSON.parse(orderBodyWithStatus(502, "processing", "1000", "5000"));
    const first = await dbLib!.withTenant(biz.id, () =>
      ingest.ingestPluginEvent(connection, { topic: "order.created", deliveryId, payload: bad }),
    );
    expect(first.status).toBe("failed");

    const good = JSON.parse(orderBodyWithStatus(502, "processing", "10000", "1000"));
    const second = await dbLib!.withTenant(biz.id, () =>
      ingest.ingestPluginEvent(connection, { topic: "order.created", deliveryId, payload: good }),
    );
    expect(second.status).toBe("processed");
    expect(await countOrders()).toBe(before + 1);
  });

  it("does not import an unpaid order, and imports it when the store says it was paid", async () => {
    const before = await countOrders();

    // A pending cart: acknowledged so the sender does not retry it, but no
    // sale, no payment, no journal entry. Before the status gate every one
    // of these (abandoned checkouts included) landed as a completed, paid
    // order with revenue.
    const pending = orderBodyWithStatus(503, "pending");
    const first = await ingest.handleWooCommerceWebhook(
      biz.connectionId,
      pending,
      signedHeaders(pending, "order.created", `pending-${randomUUID()}`),
    );
    expect(first.status).toBe(200);
    expect(await countOrders()).toBe(before);
    const mapping = await db.query(
      "SELECT 1 FROM integration_mappings WHERE connection_id = $1 AND entity_type = 'order' AND remote_id = '503'",
      [biz.connectionId],
    );
    expect(mapping.rowCount).toBe(0);

    // The same order, paid — a different delivery, because the event that
    // moved it to a paid state is a different thing that happened.
    const paid = orderBodyWithStatus(503, "processing");
    const second = await ingest.handleWooCommerceWebhook(
      biz.connectionId,
      paid,
      signedHeaders(paid, "order.created", `paid-${randomUUID()}`),
    );
    expect(second.status).toBe(200);
    expect(await countOrders()).toBe(before + 1);

    // Cancelled and failed orders are not sales either.
    for (const status of ["cancelled", "failed", "on-hold"]) {
      const body = orderBodyWithStatus(504, status);
      const res = await ingest.handleWooCommerceWebhook(
        biz.connectionId,
        body,
        signedHeaders(body, "order.created", `${status}-${randomUUID()}`),
      );
      expect(res.status).toBe(200);
    }
    expect(await countOrders()).toBe(before + 1);

    // But a refunded order WAS a sale — its refund arrives as its own event.
    const refunded = orderBodyWithStatus(505, "refunded");
    const res = await ingest.handleWooCommerceWebhook(
      biz.connectionId,
      refunded,
      signedHeaders(refunded, "order.updated", `refunded-${randomUUID()}`),
    );
    expect(res.status).toBe(200);
    expect(await countOrders()).toBe(before + 2);
  });
});

// #934: real SQL invariants, not just the panel hiding a disconnected store.
describe("connection hub lifecycle and history", () => {
  async function cloneStore() {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, base_url, consumer_key_ciphertext,
          consumer_secret_ciphertext, webhook_secret_ciphertext, status, last_sync_at)
       SELECT business_id, location_id, 'Lifecycle fixture', base_url, consumer_key_ciphertext,
              consumer_secret_ciphertext, webhook_secret_ciphertext, 'paused', '2026-01-01'::timestamptz
         FROM integration_connections WHERE id = $1 RETURNING id`,
      [biz.connectionId],
    );
    return rows[0].id;
  }

  it("keeps paused status and data-sync timestamps on successful and failed probes", async () => {
    const id = await cloneStore();
    const { vi } = await import("vitest");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]"));
    try {
      expect(await dbLib!.withTenant(biz.id, () => connections.testConnection(biz.id, id))).toEqual({ ok: true });
      let row = (await db.query("SELECT * FROM integration_connections WHERE id = $1", [id])).rows[0];
      expect(row.status).toBe("paused");
      expect(row.last_sync_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(row.last_successful_test_at).not.toBeNull();
      const success = row.last_successful_test_at.toISOString();
      fetch.mockRejectedValue(new Error("sensitive upstream error with secret"));
      expect(await dbLib!.withTenant(biz.id, () => connections.testConnection(biz.id, id))).toEqual({ ok: false, error: "connection_request_failed" });
      row = (await db.query("SELECT * FROM integration_connections WHERE id = $1", [id])).rows[0];
      expect(row.status).toBe("paused");
      expect(row.last_sync_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(row.last_successful_test_at.toISOString()).toBe(success);
      expect(row.last_test_error).toBe("connection_request_failed");
    } finally { fetch.mockRestore(); }
  });

  it("atomically revokes credentials, preserves audit and queued data, and refuses resurrection", async () => {
    const id = await cloneStore();
    await db.query("INSERT INTO integration_audit_log (business_id, connection_id, action) VALUES ($1, $2, 'before_disconnect')", [biz.id, id]);
    await db.query(`INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
      VALUES ($1, $2, 'stock', '99', '{}')`, [biz.id, id]);
    const deleted = await dbLib!.withTenant(biz.id, () => connections.deleteConnection(biz.id, id, "owner-actor"));
    expect(deleted).toBe(true);
    const row = (await db.query("SELECT * FROM integration_connections WHERE id = $1", [id])).rows[0];
    expect(row.deleted_at).not.toBeNull();
    expect(row.status).toBe("paused");
    expect(row.consumer_key_ciphertext).toBeNull();
    expect(row.link_token_hash).toBeNull();
    const audit = (await db.query("SELECT action, payload FROM integration_audit_log WHERE connection_id = $1 ORDER BY id", [id])).rows;
    expect(audit.map((r) => r.action)).toEqual(["before_disconnect", "connection.deleted"]);
    expect(audit[1].payload.actorUserId).toBe("owner-actor");
    expect((await db.query("SELECT 1 FROM integration_outbox_events WHERE connection_id = $1", [id])).rowCount).toBe(1);
    expect(await dbLib!.withTenant(biz.id, () => connections.getConnection(biz.id, id))).toBeNull();
    expect(await dbLib!.withTenant(biz.id, () => connections.deleteConnection(biz.id, id))).toBe(false);
    await expect(db.query("UPDATE integration_connections SET status = 'active' WHERE id = $1", [id])).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("DELETE FROM integration_connections WHERE id = $1", [id])).rejects.toMatchObject({ code: "23503" });
    const raw = "{}";
    expect((await ingest.handleWooCommerceWebhook(id, raw, signedHeaders(raw, "order.created", randomUUID()))).status).toBe(404);
  });

  it("enforces the business/location composite FK even for a direct SQL update", async () => {
    const id = await cloneStore();
    const otherBiz = (await db.query("INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id", [`other-${randomUUID()}`])).rows[0].id;
    const otherLocation = (await db.query("INSERT INTO locations (business_id, name) VALUES ($1, 'Other branch') RETURNING id", [otherBiz])).rows[0].id;
    expect(await dbLib!.withTenant(biz.id, () => connections.updateConnection(biz.id, id, { locationId: otherLocation }))).toEqual({ ok: false, error: "invalid_location" });
    await expect(db.query("UPDATE integration_connections SET location_id = $1 WHERE id = $2", [otherLocation, id])).rejects.toMatchObject({ code: "23503" });
  });
});

it("revokes plugin credentials without violating mode checks and records rotation actor durably", async () => {
  const owner = (await db.query("INSERT INTO users (business_id, full_name, role) VALUES ($1, 'Owner', 'owner') RETURNING id", [biz.id])).rows[0].id;
  const created = await dbLib!.withTenant(biz.id, () => connections.createConnection(biz.id, owner, {
    name: "Plugin lifecycle", baseUrl: "https://plugin.example.com", linkMode: "plugin", currencyUnit: "toman", locationId: biz.locationId,
  }));
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error);
  const id = created.connection.id;
  const rotated = await dbLib!.withTenant(biz.id, () => connections.rotateLinkToken(biz.id, id, owner));
  expect(rotated.ok).toBe(true);
  const audit = (await db.query("SELECT payload FROM integration_audit_log WHERE connection_id = $1 AND action = 'connection.link_token_rotated'", [id])).rows[0];
  expect(audit.payload.actorUserId).toBe(owner);
  expect(await dbLib!.withTenant(biz.id, () => connections.deleteConnection(biz.id, id, owner))).toBe(true);
  const row = (await db.query("SELECT * FROM integration_connections WHERE id = $1", [id])).rows[0];
  expect(row.link_token_hash).toBeNull();
  expect(row.link_token_ciphertext).toBeNull();
  await expect(db.query("UPDATE integration_audit_log SET action = 'erased' WHERE connection_id = $1", [id])).rejects.toMatchObject({ code: "23514" });
});

it("uses a common masked CMS lifecycle without treating adapter/currency settings as credentials", async () => {
  const cms = await import("../src/lib/cms/connections");
  const website = await import("../src/lib/website/connection-service");
  const siteId = randomUUID();
  const save = (apiKey: string, site = siteId) => dbLib!.withTenant(biz.id, () => cms.saveCmsConnection({
    businessId: biz.id, siteId: site, siteDomain: "cms.example.com", baseUrl: "https://cms.example.com", apiKey,
  }));
  await save("eshobe_live_first");
  await db.query("UPDATE eshobe_cms_connections SET push_stock = true, site_currency = 'IRR', last_error = 'stale' WHERE business_id = $1", [biz.id]);
  await save("eshobe_live_rotated");
  const summary = await dbLib!.withTenant(biz.id, () => website.getWebsiteConnection(biz.id));
  expect(summary?.adapterKey).toBe("payload");
  expect(summary?.pushStock).toBe(true);
  expect(summary?.siteCurrency).toBe("IRR");
  expect(summary?.lastError).toBeNull();
  expect(JSON.stringify(summary)).not.toContain("eshobe_live_");
  const masked = await dbLib!.withTenant(biz.id, () => cms.listCmsConnections(biz.id));
  expect(JSON.stringify(masked)).not.toContain("eshobe_live_");
  await save("eshobe_live_other_site", randomUUID());
  expect((await dbLib!.withTenant(biz.id, () => website.getWebsiteConnection(biz.id)))?.pushStock).toBe(false);
  await dbLib!.withTenant(biz.id, () => cms.deleteCmsConnection(biz.id));
  expect(await dbLib!.withTenant(biz.id, () => website.getWebsiteConnection(biz.id))).toBeNull();
  expect(await dbLib!.withTenant(biz.id, () => cms.listCmsConnections(biz.id))).toEqual([]);
});

it("retains connection audit on disconnect but still permits explicit whole-tenant erasure", async () => {
  const businessId = (await db.query("INSERT INTO businesses (name, slug) VALUES ('Erase fixture', $1) RETURNING id", [`erase-${randomUUID()}`])).rows[0].id;
  const { rows } = await db.query(`INSERT INTO integration_connections (business_id, name, provider, base_url, consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext)
    VALUES ($1, 'Erase fixture', 'woocommerce', 'https://erase.example.com', 'encrypted', 'encrypted', 'encrypted') RETURNING id`, [businessId]);
  await db.query("INSERT INTO integration_audit_log (business_id, connection_id, action) VALUES ($1, $2, 'created')", [businessId, rows[0].id]);
  await db.query("DELETE FROM businesses WHERE id = $1", [businessId]);
  expect((await db.query("SELECT 1 FROM integration_audit_log WHERE business_id = $1", [businessId])).rowCount).toBe(0);
});
