/**
 * Issue #1207 §A/§D — "automatic stock/price sync stays asynchronous and must
 * not imply a button click is needed", proved against a real database.
 *
 * The screen's copy claims the scheduled sync runs on its own. The unit suites
 * pin the words («همگام‌سازی خودکار موجودی و قیمت … بی‌نیاز از این دکمه») but not
 * the behaviour behind them: nothing so far demonstrated that a local stock or
 * price change reaches the store with **no user action at all** — no preview,
 * no confirmation, no `/api/products/publications` call, no button.
 *
 * So this file drives the scheduler's own entry point,
 * `runWooCommerceSyncTick()`, and asserts what happens to a change nobody
 * clicked:
 *
 *   - in REST mode the tick queues *and* delivers it, and the mapping's
 *     acknowledged payload moves — the same outcome a manual update would
 *     produce, without the manual update;
 *   - in plugin mode the tick still queues it, and deliberately leaves delivery
 *     to the plugin that pulls these rows (no REST credentials exist here);
 *   - a customer-disabled Website app parks the work instead of dropping it,
 *     and the next tick after re-enabling delivers it — nothing is lost while
 *     automation is paused.
 *
 * Only the scheduler is called: `requests` records every outbound HTTP call, so
 * "the store was told" and "a person told it" cannot be confused.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "cd".repeat(32);

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let outbox: typeof import("../src/lib/integrations/outbox-service");
let connections: typeof import("../src/lib/integrations/connections-service");

const biz = { id: "", locationId: "", connectionId: "", itemId: "" };
const REMOTE_ID = "101";

/** Every outbound call the scheduler makes, in order. */
const requests: { method: string; url: string; body: Record<string, unknown> | null }[] = [];

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

interface EventRow {
  entity_type: string;
  status: string;
  payload: Record<string, unknown>;
  attempts: number;
  sent_at: string | null;
}

async function eventsFor(remoteId: string): Promise<EventRow[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT entity_type, status, payload, attempts, sent_at
       FROM integration_outbox_events
      WHERE connection_id = $1 AND remote_id = $2
      ORDER BY entity_type`,
    [biz.connectionId, remoteId],
  );
  return rows;
}

async function mappingPayload(): Promise<Record<string, unknown>> {
  const { rows } = await db.query<{ last_pushed_payload: Record<string, unknown> | null }>(
    `SELECT last_pushed_payload FROM integration_mappings
      WHERE connection_id = $1 AND entity_type = 'product' AND remote_id = $2`,
    [biz.connectionId, REMOTE_ID],
  );
  return rows[0].last_pushed_payload ?? {};
}

/**
 * Put the pair back into a known "the store already has this" state: no queued
 * rows, and a mapping whose acknowledged payload is the given truth. Each case
 * below then changes exactly one local value and asks what the scheduler does
 * about it.
 */
async function resetQueue(acknowledged: { stock_quantity: number; regular_price: string }): Promise<void> {
  await db.query("DELETE FROM integration_outbox_events");
  await db.query(
    `UPDATE integration_mappings SET last_pushed_payload = $3::jsonb
      WHERE connection_id = $1 AND remote_id = $2`,
    [
      biz.connectionId,
      REMOTE_ID,
      // The shapes the ack writes: `stock` (a number) and `priceRial` (Rial,
      // even for a Toman store) — the diff reads exactly these.
      JSON.stringify({
        wooType: "simple",
        remoteManageStock: true,
        stock: acknowledged.stock_quantity,
        priceRial: acknowledged.regular_price,
      }),
    ],
  );
}

/** One scheduler run — exactly what the cron calls. */
async function tick(): Promise<void> {
  await outbox.runWooCommerceSyncTick();
}

/**
 * Replace the global fetch the credentialed HTTP layer uses, and answer the one
 * endpoint a stock/price push touches (`PUT products/<id>`) with the store's
 * echo. Anything else is recorded and answered generically so an unexpected
 * call fails an assertion rather than a parse.
 */
function stubStore(): void {
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ method, url, body });
    const match = url.match(/\/products\/(\d+)(\?|\/|$)/);
    const id = match ? Number(match[1]) : 0;
    return new Response(
      JSON.stringify({
        id,
        type: "simple",
        sku: "MAIN-1",
        regular_price: "120",
        stock_quantity: 7,
        manage_stock: true,
        status: "publish",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

beforeAll(async () => {
  databaseName = `pos_woo_autosync_${randomUUID().replaceAll("-", "")}`;
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
  outbox = await import("../src/lib/integrations/outbox-service");
  connections = await import("../src/lib/integrations/connections-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  biz.id = (
    await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Boutique', $1, 'accessories') RETURNING id",
      [`woo-autosync-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  biz.locationId = (
    await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [
      biz.id,
    ])
  ).rows[0].id;
  biz.connectionId = (
    await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, base_url,
          consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
          currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
       VALUES ($1, $2, 'Store', 'https://shop.example.com', $3, $4, $5, 'toman', true, true, true, true, true)
       RETURNING id`,
      [
        biz.id,
        biz.locationId,
        encryptSecret("ck", Buffer.from(KEY, "hex")),
        encryptSecret("cs", Buffer.from(KEY, "hex")),
        encryptSecret("wh", Buffer.from(KEY, "hex")),
      ],
    )
  ).rows[0].id;
  // A row nothing has ever clicked: the only reason it is here is that the
  // store already knows the product.
  biz.itemId = (
    await db.query<{ id: string }>(
      "INSERT INTO items (location_id, name, sku, kind) VALUES ($1, 'محصول اصلی', 'MAIN-1', 'simple') RETURNING id",
      [biz.locationId],
    )
  ).rows[0].id;
  await db.query("INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, 5, 1000)", [biz.itemId]);
  await db.query(
    `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
     VALUES ($1, $2, 'product', $3, $4, '{"wooType":"simple","remoteManageStock":true,"stock_quantity":5,"regular_price":"100"}'::jsonb)`,
    [biz.id, biz.connectionId, REMOTE_ID, biz.itemId],
  );
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
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

describe("a local change nobody clicked", () => {
  it("is delivered to the store by the scheduled tick alone", async () => {
    stubStore();
    requests.length = 0;
    await resetQueue({ stock_quantity: 5, regular_price: "100" });
    // The owner edits stock and price in the app; nothing else happens.
    await db.query("UPDATE item_stock SET quantity = 7, unit_price = 1200 WHERE item_id = $1", [biz.itemId]);

    await tick();

    // Every PUT is this product's two axes. The only other call is the
    // scheduler's own order pull — another path that needs no button, and not
    // a publication: nothing here previewed, confirmed or read a review token.
    const puts = requests.filter((request) => request.method === "PUT");
    expect(puts.map((request) => new URL(request.url).pathname)).toEqual([
      `/wp-json/wc/v3/products/${REMOTE_ID}`,
      `/wp-json/wc/v3/products/${REMOTE_ID}`,
    ]);
    expect(puts.some((request) => (request.body ?? {}).stock_quantity === 7)).toBe(true);
    // 1200 Rial in a Toman store.
    expect(puts.some((request) => (request.body ?? {}).regular_price === "120")).toBe(true);
    for (const request of requests.filter((entry) => entry.method !== "PUT")) {
      expect(new URL(request.url).pathname).toBe("/wp-json/wc/v3/orders");
    }

    // Both axes left the queue as acknowledged work, not "pending forever".
    const events = await eventsFor(REMOTE_ID);
    expect(events.map((event) => event.entity_type)).toEqual(["price", "stock"]);
    for (const event of events) {
      expect(event.status).toBe("sent");
      expect(event.sent_at).not.toBeNull();
      expect(event.attempts).toBe(0);
    }

    // The mapping now records what the store acknowledged, which is what the
    // next tick diffs against — the loop stays closed without a click.
    // 120 Toman acknowledged = 1200 Rial recorded, `stock` as the number it is.
    expect(await mappingPayload()).toMatchObject({ stock: 7, priceRial: "1200" });
  });

  it("is not re-sent by the next tick — automation settles instead of looping", async () => {
    requests.length = 0;
    await tick();
    await tick();
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    const events = await eventsFor(REMOTE_ID);
    expect(events.every((event) => event.status === "sent")).toBe(true);
  });

  it("leaves the work for the plugin when the store is in plugin mode, not a dead REST call", async () => {
    // Plugin mode has no REST credentials to call the store with; the plugin
    // pulls these rows itself. Automation still runs without a button — it just
    // hands off instead of pushing.
    await resetQueue({ stock_quantity: 7, regular_price: "120" });
    // The database itself refuses a `plugin` connection with no link token.
    await db.query(
      `UPDATE integration_connections
          SET link_mode = 'plugin', link_token_hash = 'hash-of-test-token', link_token_ciphertext = $2
        WHERE id = $1`,
      [biz.connectionId, encryptSecret("test-link-token", Buffer.from(KEY, "hex"))],
    );
    await db.query("UPDATE item_stock SET quantity = 11 WHERE item_id = $1", [biz.itemId]);
    requests.length = 0;

    await tick();

    expect(requests).toHaveLength(0);
    const stock = (await eventsFor(REMOTE_ID)).find((event) => event.entity_type === "stock")!;
    expect(stock.status).toBe("pending");
    expect(stock.payload).toMatchObject({ stock_quantity: 11 });
    expect(stock.sent_at).toBeNull();

    await db.query("UPDATE integration_connections SET link_mode = 'rest_api' WHERE id = $1", [biz.connectionId]);
  });

  it("parks the work while the Website app is disabled and delivers it on the next tick", async () => {
    // A customer disable must not drop a queued change: the unit exists the
    // moment the app is switched back on, with no button and no repeat edit.
    await resetQueue({ stock_quantity: 11, regular_price: "120" });
    await db.query(
      `INSERT INTO business_service_activations (business_id, service_kind, service_key, state, label)
       VALUES ($1, 'app', 'website', 'disabled_retained', 'Website')`,
      [biz.id],
    );
    await db.query("UPDATE item_stock SET quantity = 13 WHERE item_id = $1", [biz.itemId]);
    requests.length = 0;

    await tick();
    // Not even the order pull: the whole connection is skipped, and nothing is
    // queued that the reader would see as "waiting forever".
    expect(requests).toHaveLength(0);
    expect(await eventsFor(REMOTE_ID)).toEqual([]);

    await db.query(
      `UPDATE business_service_activations SET state = 'active', updated_at = now()
        WHERE business_id = $1 AND service_kind = 'app' AND service_key = 'website'`,
      [biz.id],
    );
    await tick();

    const stock = (await eventsFor(REMOTE_ID)).find((event) => event.entity_type === "stock")!;
    expect(stock.status).toBe("sent");
    expect(requests.some((request) => (request.body ?? {}).stock_quantity === 13)).toBe(true);
  });

  it("does nothing at all for a paused connection, and resumes from the same queue", async () => {
    await resetQueue({ stock_quantity: 13, regular_price: "120" });
    await db.query("UPDATE integration_connections SET status = 'paused' WHERE id = $1", [biz.connectionId]);
    await db.query("UPDATE item_stock SET quantity = 15 WHERE item_id = $1", [biz.itemId]);
    requests.length = 0;

    await tick();
    expect(requests).toHaveLength(0);
    expect(await eventsFor(REMOTE_ID)).toEqual([]);

    await db.query("UPDATE integration_connections SET status = 'active' WHERE id = $1", [biz.connectionId]);
    await tick();
    expect(requests.some((request) => (request.body ?? {}).stock_quantity === 15)).toBe(true);
    // The connection row the scheduler reads is the same one the screen shows.
    expect((await connections.getConnection(biz.id, biz.connectionId))!.status).toBe("active");
  });
});
