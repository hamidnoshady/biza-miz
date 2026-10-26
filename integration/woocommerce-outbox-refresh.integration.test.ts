/**
 * Issue #943, items 2 / 4 / 5 — the scheduled price+stock refresh, the
 * per-product push switches, the explicit retry and the missing-remotely
 * flag, against a real database.
 *
 * The refresh is the loop hazard the audit named: it used to reset ANY
 * conflicting outbox row to `pending` with zeroed attempts, which meant it
 * resurrected dead-lettered pushes every tick, rewrote payloads the plugin
 * had already leased, and turned every backoff into a per-tick hammer. What
 * is proven here is the guarded contract:
 *
 *   - steady state writes NOTHING (no loop, no churn);
 *   - a changed local value updates an open event's payload in place;
 *   - `processing` (leased), `dead` and `needs_review` rows are untouchable;
 *   - a `failed` row keeps its attempts and its backoff;
 *   - a `sent` row re-arms only for genuinely new news;
 *   - an open MANUAL price edit owns the price axis — the scheduled diff
 *     stays off it (no overwrite of a pending remote edit);
 *   - untracked shapes (external / variable parent) never get a fabricated
 *     stock push, even with a stale item_stock row (item 4);
 *   - the per-product pause stops the axis, drops its queued pushes, and
 *     resuming re-arms from the current local truth (item 4);
 *   - the human retry is the ONE path that resurrects parked events (item 5);
 *   - a complete store read that no longer sees a mapped product flags it
 *     `remoteMissing` — and any inbound payload clears the flag (item 5).
 *
 * The tests run in order and share state; each one says what it builds on.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "ab".repeat(32);

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let outbox: typeof import("../src/lib/integrations/outbox-service");
let ops: typeof import("../src/lib/integrations/woo-ops-service");
let mappings: typeof import("../src/lib/integrations/mapping-service");
let connections: typeof import("../src/lib/integrations/connections-service");
let sync: typeof import("../src/lib/integrations/sync-service");
let plugin: typeof import("../src/lib/integrations/plugin-service");

const biz = { id: "", locationId: "", connectionId: "" };
let connRow: import("../src/lib/integrations/connections-service").ConnectionRow;

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

type EventRow = {
  entity_type: string;
  status: string;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | Date;
  updated_at: string | Date;
};

async function eventsFor(remoteId: string): Promise<EventRow[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT entity_type, status, payload, attempts, last_error, next_attempt_at, updated_at
       FROM integration_outbox_events
      WHERE connection_id = $1 AND remote_id = $2
      ORDER BY entity_type`,
    [biz.connectionId, remoteId],
  );
  return rows;
}

async function setEvent(remoteId: string, entityType: string, fields: string, params: unknown[]): Promise<void> {
  await db.query(
    `UPDATE integration_outbox_events SET ${fields}
      WHERE connection_id = $1 AND remote_id = $2 AND entity_type = $3`,
    [biz.connectionId, remoteId, entityType, ...params],
  );
}

async function refresh(): Promise<void> {
  await outbox.refreshOutboxForConnection(connRow);
}

beforeAll(async () => {
  databaseName = `pos_woo_outbox_${randomUUID().replaceAll("-", "")}`;

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
  ops = await import("../src/lib/integrations/woo-ops-service");
  mappings = await import("../src/lib/integrations/mapping-service");
  connections = await import("../src/lib/integrations/connections-service");
  sync = await import("../src/lib/integrations/sync-service");
  plugin = await import("../src/lib/integrations/plugin-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Boutique', $1, 'accessories') RETURNING id",
    [`woo-outbox-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
  const connIns = await db.query<{ id: string }>(
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
      encryptSecret("wh_test", Buffer.from(KEY, "hex")),
    ],
  );
  biz.connectionId = connIns.rows[0].id;
  connRow = (await connections.getConnection(biz.id, biz.connectionId))!;

  // The subject: one simple mapped product, remote id 101, stock 5, price
  // 1000 Rial (= 100 Toman in this store's unit).
  const itemRow = await db.query<{ id: string }>(
    `INSERT INTO items (location_id, name, sku, kind) VALUES ($1, 'محصول اصلی', 'MAIN-1', 'simple') RETURNING id`,
    [biz.locationId],
  );
  await db.query(`INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, 5, 1000)`, [itemRow.rows[0].id]);
  await db.query(
    `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
     VALUES ($1, $2, 'product', '101', $3, '{"wooType":"simple","remoteManageStock":true}'::jsonb)`,
    [biz.id, biz.connectionId, itemRow.rows[0].id],
  );
}, 180_000);

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

describe("the scheduled refresh: diffs, never loops, never overwrites", () => {
  it("queues one price and one stock event for a changed product", async () => {
    await refresh();
    const events = await eventsFor("101");
    expect(events.map((e) => e.entity_type)).toEqual(["price", "stock"]);
    const price = events.find((e) => e.entity_type === "price")!;
    const stock = events.find((e) => e.entity_type === "stock")!;
    expect(price.status).toBe("pending");
    expect(price.payload).toMatchObject({ regular_price: "100" }); // 1000 Rial in a Toman store
    expect(stock.status).toBe("pending");
    // The store tracks this product, so only the quantity goes; turning
    // tracking on is the owner's opt-in (issue #1149), never the push's.
    expect(stock.payload).toMatchObject({ stock_quantity: 5 });
    expect(stock.payload).not.toHaveProperty("manage_stock");
    expect(stock.attempts).toBe(0);
  });

  it("writes NOTHING on a steady state — the tick cannot churn or loop", async () => {
    const before = await eventsFor("101");
    await refresh();
    await refresh();
    const after = await eventsFor("101");
    expect(after.map((e) => [e.entity_type, e.status, e.payload, e.attempts, String(e.updated_at)])).toEqual(
      before.map((e) => [e.entity_type, e.status, e.payload, e.attempts, String(e.updated_at)]),
    );
  });

  it("refreshes an OPEN event's payload in place when the local value moves", async () => {
    await db.query(
      `UPDATE item_stock SET quantity = 9 WHERE item_id = (SELECT id FROM items WHERE sku = 'MAIN-1')`,
    );
    await refresh();
    const stock = (await eventsFor("101")).find((e) => e.entity_type === "stock")!;
    expect(stock.payload).toMatchObject({ stock_quantity: 9 });
    expect(stock.status).toBe("pending"); // state machine untouched
    expect(stock.attempts).toBe(0);
  });

  it("never rewrites a leased (processing) event mid-delivery", async () => {
    await setEvent("101", "stock", "status = 'processing', leased_until = now() + interval '5 minutes'", []);
    await db.query(
      `UPDATE item_stock SET quantity = 11 WHERE item_id = (SELECT id FROM items WHERE sku = 'MAIN-1')`,
    );
    await refresh();
    const stock = (await eventsFor("101")).find((e) => e.entity_type === "stock")!;
    expect(stock.status).toBe("processing");
    expect(stock.payload).toMatchObject({ stock_quantity: 9 }); // what the lease carries, unchanged
  });

  it("never resurrects a dead-lettered event — a human decision outranks the tick", async () => {
    await setEvent("101", "stock", "status = 'dead', attempts = 5, leased_until = NULL", []);
    await db.query(
      `UPDATE item_stock SET quantity = 12 WHERE item_id = (SELECT id FROM items WHERE sku = 'MAIN-1')`,
    );
    await refresh();
    await refresh();
    const stock = (await eventsFor("101")).find((e) => e.entity_type === "stock")!;
    expect(stock.status).toBe("dead");
    expect(stock.attempts).toBe(5);
    expect(stock.payload).toMatchObject({ stock_quantity: 9 });
  });

  it("keeps a failed event's attempts and backoff — the refresh rides the retry, it does not reset it", async () => {
    await setEvent(
      "101",
      "stock",
      "status = 'failed', attempts = 3, next_attempt_at = now() + interval '1 hour', last_error = 'store said no'",
      [],
    );
    const before = (await eventsFor("101")).find((e) => e.entity_type === "stock")!;
    await db.query(
      `UPDATE item_stock SET quantity = 13 WHERE item_id = (SELECT id FROM items WHERE sku = 'MAIN-1')`,
    );
    await refresh();
    const stock = (await eventsFor("101")).find((e) => e.entity_type === "stock")!;
    expect(stock.payload).toMatchObject({ stock_quantity: 13 }); // the next attempt carries the fresh truth
    expect(stock.status).toBe("failed"); // still on its own retry schedule
    expect(stock.attempts).toBe(3);
    expect(String(stock.next_attempt_at)).toBe(String(before.next_attempt_at));
  });

  it("leaves the price axis alone while a MANUAL price edit is open", async () => {
    // The owner typed a store-side price; the scheduled diff derives its
    // value from Accounting and must not race the human edit — the axis
    // belongs to the manual event until it is delivered (item 2).
    await ops.enqueueOperation(biz.id, biz.connectionId, "product_update", "101", { regular_price: "250" });
    await db.query(
      `UPDATE item_stock SET unit_price = 2000 WHERE item_id = (SELECT id FROM items WHERE sku = 'MAIN-1')`,
    );
    await refresh();
    const events = await eventsFor("101");
    const price = events.find((e) => e.entity_type === "price")!;
    const manual = events.find((e) => e.entity_type === "product_update")!;
    expect(price.payload).toMatchObject({ regular_price: "100" }); // NOT the new local 200 Toman
    expect(manual.status).toBe("pending");
    expect(manual.payload).toMatchObject({ regular_price: "250" });
  });

  it("re-arms a SENT event only for genuinely new news", async () => {
    // Simulate the deliveries: the manual edit was applied and acked with
    // the local price of the moment; every event is now 'sent'.
    await setEvent("101", "product_update", "status = 'sent', sent_at = now()", []);
    await setEvent("101", "price", "status = 'sent', sent_at = now()", []);
    await setEvent("101", "stock", "status = 'sent', sent_at = now()", []);
    await mappings.mergeMappingMeta(biz.id, biz.connectionId, "product", "101", {
      stock: 13,
      priceRial: "2000",
    });

    await refresh();
    let events = await eventsFor("101");
    // Nothing moved locally since the ack: no writes, no requeue — a loop
    // here would push the same values to the store every tick forever.
    expect(events.filter((e) => e.status === "pending")).toEqual([]);

    // The local price moves again: the sent price event re-arms with the
    // new value, while the unchanged stock event stays sent.
    await db.query(
      `UPDATE item_stock SET unit_price = 3000 WHERE item_id = (SELECT id FROM items WHERE sku = 'MAIN-1')`,
    );
    await refresh();
    events = await eventsFor("101");
    const price = events.find((e) => e.entity_type === "price")!;
    const stock = events.find((e) => e.entity_type === "stock")!;
    expect(price.status).toBe("pending");
    expect(price.payload).toMatchObject({ regular_price: "300" });
    expect(price.attempts).toBe(0);
    expect(stock.status).toBe("sent");
    expect(stock.payload).toMatchObject({ stock_quantity: 13 });
  });
});

describe("stock semantics: never a fabricated tracked quantity (item 4)", () => {
  it("pushes no stock for an external product, stale item_stock row or not", async () => {
    const itemRow = await db.query<{ id: string }>(
      `INSERT INTO items (location_id, name, sku, kind) VALUES ($1, 'فروش در سایت دیگر', 'EXT-1', 'simple') RETURNING id`,
      [biz.locationId],
    );
    await db.query(`INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, 42, 5000)`, [
      itemRow.rows[0].id,
    ]);
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
       VALUES ($1, $2, 'product', '102', $3, '{"wooType":"external"}'::jsonb)`,
      [biz.id, biz.connectionId, itemRow.rows[0].id],
    );

    await refresh();
    const events = await eventsFor("102");
    expect(events.map((e) => e.entity_type)).toEqual(["price"]); // sold elsewhere: a price, never a stock figure
    expect(events[0].payload).toMatchObject({ regular_price: "500" });
  });

  it("pushes no stock for a variable parent even if a stock row exists", async () => {
    const itemRow = await db.query<{ id: string }>(
      `INSERT INTO items (location_id, name, sku, kind)
       VALUES ($1, 'والد تنوع', 'VAR-P', 'variant_parent') RETURNING id`,
      [biz.locationId],
    );
    await db.query(`INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, 7, NULL)`, [
      itemRow.rows[0].id,
    ]);
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
       VALUES ($1, $2, 'product', '103', $3, '{"wooType":"variable"}'::jsonb)`,
      [biz.id, biz.connectionId, itemRow.rows[0].id],
    );

    await refresh();
    expect(await eventsFor("103")).toEqual([]); // no price (unpriced parent), no stock (container)
  });

  it("the per-product pause stops the axis, drops its queued push, and resuming re-arms it", async () => {
    // Park the open stock event for 101 as failed, then pause the axis.
    await setEvent("101", "stock", "status = 'failed', attempts = 2", []);
    await ops.setProductPushPause(biz.id, biz.connectionId, "101", { stock: true });
    let events = await eventsFor("101");
    // The pause is real: the not-yet-sent scheduled push is gone (a pause
    // that leaves a queued value in the queue is not a pause), while the
    // price event — a different axis — is untouched.
    expect(events.map((e) => e.entity_type)).toEqual(["price", "product_update"]);

    await db.query(
      `UPDATE item_stock SET quantity = 20 WHERE item_id = (SELECT id FROM items WHERE sku = 'MAIN-1')`,
    );
    await refresh();
    events = await eventsFor("101");
    expect(events.some((e) => e.entity_type === "stock")).toBe(false); // paused: the tick stays off

    await ops.setProductPushPause(biz.id, biz.connectionId, "101", { stock: false });
    await refresh();
    events = await eventsFor("101");
    const stock = events.find((e) => e.entity_type === "stock")!;
    expect(stock.status).toBe("pending");
    expect(stock.payload).toMatchObject({ stock_quantity: 20 }); // resumed from the CURRENT local truth

    // And the pause is visible on the catalogue row the UI renders.
    const page = await sync.cataloguePageFor(biz.id, biz.connectionId, { search: "main-1" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].stockPushPaused).toBe(false);
    expect(page.rows[0].pricePushPaused).toBe(false);
    await ops.setProductPushPause(biz.id, biz.connectionId, "101", { price: true });
    const paused = await sync.cataloguePageFor(biz.id, biz.connectionId, { search: "main-1" });
    expect(paused.rows[0].pricePushPaused).toBe(true);
    await ops.setProductPushPause(biz.id, biz.connectionId, "101", { price: false });
  });
});

describe("the explicit human retry (item 5)", () => {
  it("is the one path that resurrects parked events, and it is counted", async () => {
    // The pause test paused (and so dropped) the queued price push, then
    // resumed the axis; one tick re-queues it from the still-unacked local
    // price (3000 vs the acked 2000) so this test has all three event types
    // to park and resurrect.
    await refresh();
    const rebuilt = await eventsFor("101");
    expect(rebuilt.find((e) => e.entity_type === "price")?.status).toBe("pending");

    await setEvent("101", "stock", "status = 'dead', attempts = 9, last_error = 'boom'", []);
    await setEvent("101", "product_update", "status = 'needs_review', last_error = 'human needed'", []);
    await setEvent("101", "price", "status = 'sent', sent_at = now()", []);

    const retried = await ops.retryProductQueue(biz.id, biz.connectionId, "101");
    expect(retried).toBe(2); // the dead stock push and the parked manual edit

    const events = await eventsFor("101");
    const stock = events.find((e) => e.entity_type === "stock")!;
    const manual = events.find((e) => e.entity_type === "product_update")!;
    const price = events.find((e) => e.entity_type === "price")!;
    expect(stock.status).toBe("pending");
    expect(stock.attempts).toBe(0);
    expect(stock.last_error).toBe("boom"); // the error text stays readable until a delivery clears it
    expect(manual.status).toBe("pending");
    expect(manual.attempts).toBe(0);
    expect(price.status).toBe("sent"); // a delivered push is not "failed"; retry leaves it alone

    // Nothing parked → an honest zero, not an error.
    expect(await ops.retryProductQueue(biz.id, biz.connectionId, "101")).toBe(0);
  });
});

describe("removed remote products (item 5)", () => {
  it("flags — never deletes — mappings a complete read no longer saw, and any inbound payload clears it", async () => {
    const flagged = await sync.flagProductsMissingRemotely(biz.id, biz.connectionId, ["101"]);
    expect(flagged).toBe(2); // 102 and 103 were "not seen"

    let page = await sync.cataloguePageFor(biz.id, biz.connectionId, { pageSize: 10 });
    const missing = page.rows.filter((r) => r.remoteMissing).map((r) => r.remoteId).sort();
    expect(missing).toEqual(["102", "103"]);
    // The mappings and their local rows are untouched — a flag, not a purge.
    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_mappings WHERE connection_id = $1 AND entity_type = 'product'`,
      [biz.connectionId],
    );
    expect(Number(count.rows[0].n)).toBe(3);

    // Idempotent: flagging again changes nothing.
    expect(await sync.flagProductsMissingRemotely(biz.id, biz.connectionId, ["101"])).toBe(0);

    // Seeing the product in ANY inbound payload clears the flag: the store
    // re-published it, or the earlier read was partial. Upsert the external
    // product through the real sync path.
    await sync.upsertProductFromWoo(connRow, biz.locationId, {
      id: 102,
      type: "external",
      name: "فروش در سایت دیگر",
      sku: "EXT-1",
      price: "5000",
      regular_price: "5000",
      sale_price: "",
      manage_stock: false,
      stock_quantity: null,
      stock_status: "instock",
      status: "publish",
      images: [{ id: 77, src: "https://shop.example/ext.jpg", alt: "بیرونی", position: 0 }],
    });
    page = await sync.cataloguePageFor(biz.id, biz.connectionId, { search: "ext-1" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].remoteMissing).toBe(false);
    // The image mirror landed with the shape record (issue #943, item 3).
    expect(page.rows[0].remoteImageSrc).toBe("https://shop.example/ext.jpg");
    expect(page.rows[0].remoteImageAlt).toBe("بیرونی");
  });

  it("treats an authoritative EMPTY catalogue as every mapped product missing (Codex P2)", async () => {
    // State here: 101 and 102 unflagged, 103 still flagged from the test
    // above. A complete read that saw nothing must flag the rest.
    const flagged = await sync.flagProductsMissingRemotely(biz.id, biz.connectionId, []);
    expect(flagged).toBe(2); // 101 and 102 newly flagged; 103 already was

    const page = await sync.cataloguePageFor(biz.id, biz.connectionId, { pageSize: 10 });
    expect(page.rows.filter((r) => r.remoteMissing).map((r) => r.remoteId).sort()).toEqual(["101", "102", "103"]);
    expect(page.rows).toHaveLength(3); // flagged, never deleted
    // And flagging again is a no-op.
    expect(await sync.flagProductsMissingRemotely(biz.id, biz.connectionId, [])).toBe(0);
  });
});

describe("plugin acknowledgements (Codex P1)", () => {
  it("persists the ack on the mapping, so the refresh never re-arms a delivered push", async () => {
    // Close the manual edit the retry test resurrected: an open manual
    // product_update owns its axes, and this test needs the scheduled
    // payloads themselves to move to the new local state.
    await setEvent("101", "product_update", "status = 'sent', sent_at = now()", []);
    // Give product 101 a fresh, known local state and queue its pushes.
    await db.query(
      `UPDATE item_stock SET quantity = 7, unit_price = 8000
        WHERE item_id = (SELECT id FROM items WHERE sku = 'MAIN-1')`,
    );
    await refresh();
    const queued = await db.query<{ id: string; entity_type: string }>(
      `SELECT id, entity_type FROM integration_outbox_events
        WHERE connection_id = $1 AND remote_id = '101' AND entity_type IN ('stock', 'price')
        ORDER BY entity_type`,
      [biz.connectionId],
    );
    expect(queued.rows).toHaveLength(2);

    // The plugin applies both jobs and acks them done.
    const res = await plugin.pluginAckJobs(
      connRow,
      queued.rows.map((r) => ({ id: r.id, status: "done" as const })),
    );
    expect(await res.json()).toMatchObject({ ok: true, done: 2, failed: 0 });

    const events = await eventsFor("101");
    expect(events.find((e) => e.entity_type === "stock")?.status).toBe("sent");
    expect(events.find((e) => e.entity_type === "price")?.status).toBe("sent");

    // The mapping now REMEMBERS the delivery (8000 Rial, 7 on hand)…
    const meta = await mappings.mappingMeta(biz.id, biz.connectionId, "product", "101");
    expect(meta.stock).toBe(7);
    expect(String(meta.priceRial)).toBe("8000");
    expect(meta.wooType).toBe("simple"); // …without discarding the shape record

    // …so the next ticks see a steady state and leave the sent rows alone.
    // (Before the fix this is exactly where they flipped back to pending.)
    await refresh();
    await refresh();
    const after = await eventsFor("101");
    expect(after.find((e) => e.entity_type === "stock")?.status).toBe("sent");
    expect(after.find((e) => e.entity_type === "price")?.status).toBe("sent");
  });
});

describe("who owns the number, against the real database (issue #1149)", () => {
  async function seedProduct(remoteId: string, sku: string, quantity: number, price: number, meta: string) {
    const item = await db.query<{ id: string }>(
      `INSERT INTO items (location_id, name, sku, kind) VALUES ($1, $2, $3, 'simple') RETURNING id`,
      [biz.locationId, `کالا ${sku}`, sku],
    );
    await db.query(`INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, $2, $3)`, [
      item.rows[0].id,
      quantity,
      price,
    ]);
    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
       VALUES ($1, $2, 'product', $3, $4, $5::jsonb)`,
      [biz.id, biz.connectionId, remoteId, item.rows[0].id, meta],
    );
  }

  it("never queues a stock job for a product the store does not track, and queues one once the owner opts in", async () => {
    await seedProduct("201", "UNTRACKED-1", 0, 2000, '{"wooType":"simple","remoteManageStock":false}');

    await refresh();
    expect((await eventsFor("201")).map((e) => e.entity_type)).toEqual(["price"]);

    await db.query(`UPDATE integration_connections SET manage_stock_opt_in = true WHERE id = $1`, [biz.connectionId]);
    connRow = (await connections.getConnection(biz.id, biz.connectionId))!;
    await refresh();
    const stock = (await eventsFor("201")).find((e) => e.entity_type === "stock");
    expect(stock?.payload).toMatchObject({ stock_quantity: 0, manage_stock: true });

    await db.query(`UPDATE integration_connections SET manage_stock_opt_in = false WHERE id = $1`, [biz.connectionId]);
    connRow = (await connections.getConnection(biz.id, biz.connectionId))!;
  });

  it("turning a push off skips its waiting jobs in the same statement, and turning it back on re-arms them", async () => {
    await seedProduct("202", "TRACKED-1", 4, 3000, '{"wooType":"simple","remoteManageStock":true}');
    await refresh();
    expect((await eventsFor("202")).map((e) => e.status)).toEqual(["pending", "pending"]);

    const result = await dbLib.withTenant(biz.id, () => connections.updateConnection(biz.id, biz.connectionId, { pushStock: false }));
    expect(result.ok).toBe(true);
    const after = await eventsFor("202");
    expect(after.find((e) => e.entity_type === "stock")).toMatchObject({ status: "skipped", last_error: "push_switch_off" });
    expect(after.find((e) => e.entity_type === "price")?.status).toBe("pending");

    // The store owning the numbers closes the price job too.
    await dbLib.withTenant(biz.id, () => connections.updateConnection(biz.id, biz.connectionId, { sourceOfTruth: "store" }));
    expect((await eventsFor("202")).find((e) => e.entity_type === "price")).toMatchObject({ status: "skipped", last_error: "push_switch_off" });

    // Authority back and the switch on: the next tick queues the same payload again.
    await dbLib.withTenant(biz.id, () =>
      connections.updateConnection(biz.id, biz.connectionId, { sourceOfTruth: "two_way", pushStock: true }),
    );
    connRow = (await connections.getConnection(biz.id, biz.connectionId))!;
    await refresh();
    expect((await eventsFor("202")).map((e) => e.status)).toEqual(["pending", "pending"]);
  });

  it("the plugin pull drops a job equal to the store's value, and a stale job is re-armed with the current one", async () => {
    await seedProduct("203", "EQUAL-1", 6, 4000, '{"wooType":"simple","remoteManageStock":true,"remoteStockQuantity":6}');
    await refresh();
    expect((await eventsFor("203")).find((e) => e.entity_type === "stock")?.status).toBe("pending");

    // Age the price job past the stale window.
    await db.query(
      `UPDATE integration_outbox_events SET updated_at = now() - interval '30 hours'
        WHERE connection_id = $1 AND remote_id = '203' AND entity_type = 'price'`,
      [biz.connectionId],
    );

    const pluginConn = { ...connRow, link_mode: "plugin" as const, plugin_capabilities: { jobTypes: ["stock", "price"] } };
    const pulled = await (await plugin.pluginPullJobs(pluginConn)).json();
    expect(pulled.jobs.some((j: { remoteId: string; type: string }) => j.remoteId === "203" && j.type === "stock")).toBe(false);

    const events = await eventsFor("203");
    expect(events.find((e) => e.entity_type === "stock")).toMatchObject({ status: "skipped", last_error: "equal_to_remote" });
    expect(events.find((e) => e.entity_type === "price")).toMatchObject({ status: "skipped", last_error: "stale_job" });
    // The value the store already holds is remembered as delivered, so the diff is quiet…
    await refresh();
    expect((await eventsFor("203")).find((e) => e.entity_type === "stock")?.status).toBe("skipped");
    // …while the stale price is owed a fresh attempt with today's number.
    expect((await eventsFor("203")).find((e) => e.entity_type === "price")?.status).toBe("pending");
  });
});
