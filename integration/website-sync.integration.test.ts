/**
 * Phase 38w (issue #381) — the one-way website sync, against a real database.
 *
 * `tenant-isolation.integration.test.ts` proves the two new tables carry RLS;
 * `src/lib/website/sync.test.ts` proves the pure decisions. What can only be
 * proven here is the queue as a whole, with the in-memory mock adapter standing
 * in for the site:
 *
 *   - an unmarked product never goes, whatever the switches say;
 *   - marking a product queues one `product.upsert`, and the drain gives it a
 *     remote id and records what was pushed;
 *   - many local changes between ticks re-arm ONE `stock.set` / `price.set`
 *     row (the coalescing UNIQUE), and the value sent is the one in the
 *     database at drain time — not any earlier one;
 *   - price and stock are two switches;
 *   - a retryable failure backs off and stays in the queue; a non-retryable
 *     one dead-letters at once; the owner's retry puts it back;
 *   - `runWebsiteSyncTick` walks every connected business and one business's
 *     mock never receives another's product.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let connection: typeof import("../src/lib/website/connection-service");
let sync: typeof import("../src/lib/website/sync-service");
let catalog: typeof import("../src/lib/website/catalog-service");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_website_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.JWT_SECRET ??= "website-sync-test-secret";
  dbLib = await import("../src/lib/db");
  connection = await import("../src/lib/website/connection-service");
  sync = await import("../src/lib/website/sync-service");
  catalog = await import("../src/lib/website/catalog-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

interface Shop {
  businessId: string;
  locationId: string;
  menuItemId: string;
  inventoryItemId: string;
  itemId: string;
}

/**
 * A café with one recipe item («قهوه», 1 unit of beans each, 10 beans on hand
 * → sellable 10) and one retail item («لیوان», 7 in stock at 300,000 ﷼).
 */
async function seedShop(name: string): Promise<Shop> {
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`],
  );
  const businessId = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = location.rows[0].id;

  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی') RETURNING id",
    [locationId],
  );
  const menuItem = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'قهوه', 500000) RETURNING id`,
    [locationId, category.rows[0].id],
  );
  const inventoryItem = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, 'دانهٔ قهوه', 'g') RETURNING id`,
    [locationId],
  );
  await db.query(
    `INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 1)`,
    [menuItem.rows[0].id, inventoryItem.rows[0].id],
  );
  await db.query(
    `INSERT INTO stock_movements (location_id, inventory_item_id, type, quantity) VALUES ($1, $2, 'purchase', 10)`,
    [locationId, inventoryItem.rows[0].id],
  );

  const item = await db.query<{ id: string }>(
    `INSERT INTO items (location_id, name, sku) VALUES ($1, 'لیوان', 'CUP-1') RETURNING id`,
    [locationId],
  );
  await db.query(`INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, 7, 300000)`, [item.rows[0].id]);

  return {
    businessId,
    locationId,
    menuItemId: menuItem.rows[0].id,
    inventoryItemId: inventoryItem.rows[0].id,
    itemId: item.rows[0].id,
  };
}

async function connectMock(shop: Shop, switches: { pushPrices?: boolean; pushStock?: boolean } = {}) {
  await dbLib.withTenant(shop.businessId, async () => {
    const result = await connection.connectWebsite(shop.businessId, {
      adapterKey: "mock",
      baseUrl: "",
      siteDomain: "",
      apiKey: "",
    });
    if (!result.ok) throw new Error(result.error);
    await connection.updateWebsiteSyncSettings(shop.businessId, {
      pushPrices: switches.pushPrices ?? true,
      pushStock: switches.pushStock ?? true,
      syncLocationId: shop.locationId,
    });
  });
  return connection.mockAdapterFor(shop.businessId);
}

async function outboxRows(businessId: string) {
  const { rows } = await db.query<{ kind: string; status: string; attempts: number; error: string | null; local_id: string }>(
    `SELECT kind, status, attempts, error, local_id FROM website_outbox WHERE business_id = $1 ORDER BY kind`,
    [businessId],
  );
  return rows;
}

beforeEach(async () => {
  connection.resetMockAdapters();
  await db.query("DELETE FROM business_service_activations");
  await db.query("DELETE FROM website_outbox");
  await db.query("DELETE FROM website_product_map");
  await db.query("DELETE FROM eshobe_cms_connections");
});

describe("Phase 38w — one-way website sync", () => {
  it("never sends an unmarked product, even with every switch on", async () => {
    const shop = await seedShop("Quiet");
    const mock = await connectMock(shop);

    const result = await dbLib.withTenant(shop.businessId, () => sync.syncWebsiteForBusiness(shop.businessId));
    expect(result).toEqual({ queued: 0, sent: 0, failed: 0 });
    expect(await outboxRows(shop.businessId)).toEqual([]);
    expect(mock.calls.filter((c) => c.method === "upsertProduct")).toHaveLength(0);
  });

  it("keeps website sync work queued while the Website app is disabled", async () => {
    const shop = await seedShop("Paused");
    const mock = await connectMock(shop);
    await dbLib.withTenant(shop.businessId, async () => {
      await sync.setProductSync(shop.businessId, "menu_item", shop.menuItemId, true);
      await sync.enqueueWebsiteEvent(shop.businessId, "product.upsert", "menu_item", shop.menuItemId);
    });
    await db.query(
      `INSERT INTO business_service_activations
         (business_id, service_kind, service_key, state, disabled_reason)
       VALUES ($1, 'app', 'website', 'disabled_retained', 'customer')`,
      [shop.businessId],
    );

    const result = await dbLib.withTenant(shop.businessId, () => sync.syncWebsiteForBusiness(shop.businessId));
    expect(result).toEqual({ queued: 0, sent: 0, failed: 0 });
    expect((await outboxRows(shop.businessId)).map((row) => row.status)).toEqual(["pending"]);
    expect(mock.calls.filter((call) => call.method === "upsertProduct")).toHaveLength(0);
  });

  it("marks a product → one upsert lands, the map learns the remote id and the pushed values", async () => {
    const shop = await seedShop("First");
    const mock = await connectMock(shop);

    await dbLib.withTenant(shop.businessId, async () => {
      await sync.setProductSync(shop.businessId, "menu_item", shop.menuItemId, true);
      await sync.enqueueWebsiteEvent(shop.businessId, "product.upsert", "menu_item", shop.menuItemId);
      const result = await sync.syncWebsiteForBusiness(shop.businessId);
      expect(result.sent).toBe(1);
      expect(result.failed).toBe(0);
    });

    const remote = (await mock.listProducts({ limit: 10 })).items;
    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatchObject({ title: "قهوه", priceRial: 500_000, stock: 10 });

    const map = await db.query<{ remote_id: string; last_pushed_price_rial: string; last_pushed_stock: string }>(
      `SELECT remote_id, last_pushed_price_rial::text, last_pushed_stock::text FROM website_product_map WHERE local_id = $1`,
      [shop.menuItemId],
    );
    expect(map.rows[0].remote_id).toBe(remote[0].id);
    expect(map.rows[0].last_pushed_price_rial).toBe("500000");
    expect(Number(map.rows[0].last_pushed_stock)).toBe(10);
    expect((await outboxRows(shop.businessId)).map((r) => r.status)).toEqual(["sent"]);
  });

  it("coalesces many changes into one row and sends the value in the database at drain time", async () => {
    const shop = await seedShop("Busy");
    const mock = await connectMock(shop);

    await dbLib.withTenant(shop.businessId, async () => {
      await sync.setProductSync(shop.businessId, "menu_item", shop.menuItemId, true);
      await sync.enqueueWebsiteEvent(shop.businessId, "product.upsert", "menu_item", shop.menuItemId);
      await sync.syncWebsiteForBusiness(shop.businessId);
    });

    // A busy evening: six sales and two price edits between ticks. Each one
    // would, in the app, call refresh/enqueue; here we call it after each.
    for (let i = 0; i < 6; i++) {
      await db.query(
        `INSERT INTO stock_movements (location_id, inventory_item_id, type, quantity) VALUES ($1, $2, 'sale', -1)`,
        [shop.locationId, shop.inventoryItemId],
      );
      await dbLib.withTenant(shop.businessId, async () => {
        const row = (await connection.getWebsiteConnectionRow(shop.businessId))!;
        await sync.refreshWebsiteOutbox(row);
      });
    }
    await db.query(`UPDATE menu_items SET price = 550000 WHERE id = $1`, [shop.menuItemId]);
    await db.query(`UPDATE menu_items SET price = 600000 WHERE id = $1`, [shop.menuItemId]);

    const before = await outboxRows(shop.businessId);
    // One sent upsert + ONE pending stock row, however many sales happened.
    expect(before.filter((r) => r.kind === "stock.set")).toHaveLength(1);
    expect(before.find((r) => r.kind === "stock.set")?.status).toBe("pending");

    const result = await dbLib.withTenant(shop.businessId, () => sync.syncWebsiteForBusiness(shop.businessId));
    // The tick's own fill noticed the price change → one price.set; drain sent both.
    expect(result.sent).toBe(2);

    const remote = (await mock.listProducts({ limit: 10 })).items[0];
    expect(remote.stock).toBe(4); // 10 − 6, the number NOW — not 9, the number at the first sale
    expect(remote.priceRial).toBe(600_000); // the latest price, not the intermediate one
    const stockCalls = mock.calls.filter((c) => c.method === "setProductStock");
    expect(stockCalls).toHaveLength(1);
  });

  it("keeps price and stock behind separate switches", async () => {
    const shop = await seedShop("Switches");
    const mock = await connectMock(shop, { pushPrices: false, pushStock: true });

    await dbLib.withTenant(shop.businessId, async () => {
      await sync.setProductSync(shop.businessId, "item", shop.itemId, true);
      await sync.enqueueWebsiteEvent(shop.businessId, "product.upsert", "item", shop.itemId);
      await sync.syncWebsiteForBusiness(shop.businessId);
    });
    await db.query(`UPDATE item_stock SET unit_price = 999000, quantity = 3 WHERE item_id = $1`, [shop.itemId]);

    const result = await dbLib.withTenant(shop.businessId, () => sync.syncWebsiteForBusiness(shop.businessId));
    expect(result.queued).toBe(1);
    const kinds = (await outboxRows(shop.businessId)).map((r) => r.kind).sort();
    expect(kinds).toEqual(["product.upsert", "stock.set"]);
    const remote = (await mock.listProducts({ limit: 10 })).items[0];
    expect(remote.stock).toBe(3);
    expect(remote.priceRial).toBe(300_000); // price switch off → the site keeps the old price
  });

  it("backs off a retryable failure, dead-letters a non-retryable one, and the owner's retry re-arms it", async () => {
    const shop = await seedShop("Flaky");
    const mock = await connectMock(shop);

    await dbLib.withTenant(shop.businessId, async () => {
      await sync.setProductSync(shop.businessId, "menu_item", shop.menuItemId, true);
      await sync.enqueueWebsiteEvent(shop.businessId, "product.upsert", "menu_item", shop.menuItemId);
    });

    // Site down: retryable → failed, attempts 1, still in the queue, due later.
    mock.failWith("unreachable");
    let result = await dbLib.withTenant(shop.businessId, () => sync.syncWebsiteForBusiness(shop.businessId));
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    let rows = await outboxRows(shop.businessId);
    expect(rows[0]).toMatchObject({ kind: "product.upsert", status: "failed", attempts: 1 });
    const due = await db.query<{ later: boolean }>(
      `SELECT next_attempt_at > now() AS later FROM website_outbox WHERE business_id = $1`,
      [shop.businessId],
    );
    expect(due.rows[0].later).toBe(true);

    // Bring it forward and make the site reject the write: dead at once.
    await db.query(`UPDATE website_outbox SET next_attempt_at = now() WHERE business_id = $1`, [shop.businessId]);
    mock.failWith("rejected");
    result = await dbLib.withTenant(shop.businessId, () => sync.syncWebsiteForBusiness(shop.businessId));
    expect(result.failed).toBe(1);
    rows = await outboxRows(shop.businessId);
    expect(rows[0]).toMatchObject({ status: "dead", attempts: 2 });
    const audit = await db.query(
      `SELECT 1 FROM integration_audit_log WHERE business_id = $1 AND action = 'website.outbox.dead_lettered'`,
      [shop.businessId],
    );
    expect(audit.rowCount).toBe(1);

    // The owner presses «تلاش مجدد»; the site is fine again.
    mock.failWith(null);
    const outboxId = (await db.query<{ id: string }>(`SELECT id FROM website_outbox WHERE business_id = $1`, [shop.businessId])).rows[0].id;
    const retried = await dbLib.withTenant(shop.businessId, () => sync.retryWebsiteOutboxRow(shop.businessId, outboxId));
    expect(retried).toBe(true);
    result = await dbLib.withTenant(shop.businessId, () => sync.syncWebsiteForBusiness(shop.businessId));
    expect(result.sent).toBe(1);
    expect((await outboxRows(shop.businessId))[0]).toMatchObject({ status: "sent", attempts: 0, error: null });

    const summary = await dbLib.withTenant(shop.businessId, () => catalog.summarizeWebsiteQueue(shop.businessId));
    expect(summary).toMatchObject({ pending: 0, failed: 0, dead: 0, sent24h: 1 });
  });

  it("the tick walks every connected business, and one shop's product never reaches another's site", async () => {
    const a = await seedShop("Alpha");
    const b = await seedShop("Beta");
    const mockA = await connectMock(a);
    const mockB = await connectMock(b);

    await dbLib.withTenant(a.businessId, async () => {
      await sync.setProductSync(a.businessId, "menu_item", a.menuItemId, true);
      await sync.enqueueWebsiteEvent(a.businessId, "product.upsert", "menu_item", a.menuItemId);
    });
    await dbLib.withTenant(b.businessId, async () => {
      await sync.setProductSync(b.businessId, "item", b.itemId, true);
      await sync.enqueueWebsiteEvent(b.businessId, "product.upsert", "item", b.itemId);
    });

    await sync.runWebsiteSyncTick();

    const remoteA = (await mockA.listProducts({ limit: 10 })).items;
    const remoteB = (await mockB.listProducts({ limit: 10 })).items;
    expect(remoteA.map((p) => p.title)).toEqual(["قهوه"]);
    expect(remoteB.map((p) => p.title)).toEqual(["لیوان"]);

    // Each business's queue view names only its own product. (The RLS proof
    // for the two tables — which needs a non-superuser role — is in
    // tenant-isolation.integration.test.ts; this file's pool is the superuser.)
    const seenFromA = await dbLib.withTenant(a.businessId, () => catalog.listWebsiteOutbox(a.businessId, "all"));
    expect(seenFromA.map((r) => r.productName)).toEqual(["قهوه"]);
    const seenFromB = await dbLib.withTenant(b.businessId, () => catalog.listWebsiteOutbox(b.businessId, "all"));
    expect(seenFromB.map((r) => r.productName)).toEqual(["لیوان"]);
  });

  it("the tick's own fill never re-arms a failed row — the backoff schedule stands", async () => {
    const shop = await seedShop("Patient");
    const mock = await connectMock(shop);
    await dbLib.withTenant(shop.businessId, async () => {
      await sync.setProductSync(shop.businessId, "menu_item", shop.menuItemId, true);
      await sync.enqueueWebsiteEvent(shop.businessId, "product.upsert", "menu_item", shop.menuItemId);
    });
    mock.failWith("unreachable");
    await dbLib.withTenant(shop.businessId, () => sync.syncWebsiteForBusiness(shop.businessId));
    const first = await db.query<{ next_attempt_at: string; attempts: number }>(
      `SELECT next_attempt_at, attempts FROM website_outbox WHERE business_id = $1`,
      [shop.businessId],
    );
    expect(first.rows[0].attempts).toBe(1);

    // Three more ticks while the site is still down: the row is not due, so
    // nothing is attempted and the schedule is untouched.
    for (let i = 0; i < 3; i++) {
      const result = await dbLib.withTenant(shop.businessId, () => sync.syncWebsiteForBusiness(shop.businessId));
      expect(result).toMatchObject({ sent: 0, failed: 0 });
    }
    const later = await db.query<{ next_attempt_at: string; attempts: number; status: string }>(
      `SELECT next_attempt_at, attempts, status FROM website_outbox WHERE business_id = $1`,
      [shop.businessId],
    );
    expect(later.rows[0]).toMatchObject({ attempts: 1, status: "failed" });
    expect(new Date(later.rows[0].next_attempt_at).getTime()).toBe(new Date(first.rows[0].next_attempt_at).getTime());
    expect(mock.calls.filter((c) => c.method === "upsertProduct")).toHaveLength(1);
  });
});
