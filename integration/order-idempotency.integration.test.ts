/**
 * POST /api/orders had no idempotency protection: a network retry (a proxy
 * timeout, a browser retry after a lost response) or two near-simultaneous
 * submissions for the same cart created two separate orders for what the
 * cashier believed was one submission. The offline-queue replay path already
 * solved this shape of problem with sync_events.client_event_id; this pins
 * down the same contract on createOrder's `clientRequestId`, scoped per
 * location the way order_number already is.
 *
 * What this pins down:
 *   1. two `createOrder` calls with the same `clientRequestId` for the same
 *      location return the same order id, and only one row is inserted;
 *   2. the same `clientRequestId` reused for a *different* location is a
 *      distinct order — the uniqueness is per location, not global;
 *   3. omitting `clientRequestId` behaves exactly as before — repeated calls
 *      with no id each create their own order;
 *   4. two callers racing the same `clientRequestId` concurrently (the
 *      check-then-insert window) still converge on one order, not a crash.
 *
 * Issue #913 (POS cashier audit) extends the same file with the three P0
 * release gates that need real rows:
 *   5. same key + changed payload → `request_conflict` (409), never a
 *      second interpretation of somebody's sale — with the payload
 *      fingerprint persisted next to the key (migration 0232);
 *   6. the offline queue's replay binds to the ORIGINAL payload key
 *      (one identity across POST / queue / replay), so a lost-response
 *      replay after the synchronous POST committed converges on that order;
 *   7. the monthly-order ceiling is enforced AFTER dedupe, inside one lock:
 *      a retry of the final allowed sale of the month returns the original
 *      order instead of `monthly_order_limit_exceeded`, and two concurrent
 *      genuinely-new requests cannot both slip through a one-slot ceiling.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let orderMutations: typeof import("../src/lib/order-mutations");

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

interface Shop {
  businessId: string;
  locationId: string;
  menuItemId: string;
}

async function createShop(): Promise<Shop> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [`Idempotency Test ${randomUUID().slice(0, 6)}`, `idempotency-test-${randomUUID().slice(0, 8)}`],
  );
  const businessId = biz.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = loc.rows[0].id;
  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'چای') RETURNING id",
    [locationId],
  );
  const item = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'چای کوچک', 600000) RETURNING id",
    [locationId, category.rows[0].id],
  );
  return { businessId, locationId, menuItemId: item.rows[0].id };
}

function takeaway(shop: Shop, clientRequestId?: string | null) {
  return dbLib.withTenant(shop.businessId, () =>
    orderMutations.createOrder({
      locationId: shop.locationId,
      type: "takeaway",
      discount: { type: null },
      items: [{ menuItemId: shop.menuItemId, quantity: 1 }],
      openedBy: null,
      clientRequestId,
    }),
  );
}

async function orderCount(locationId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*) FROM orders WHERE location_id = $1",
    [locationId],
  );
  return Number(rows[0].count);
}

beforeAll(async () => {
  databaseName = `pos_orderidempotency_${randomUUID().replaceAll("-", "")}`;

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
  orderMutations = await import("../src/lib/order-mutations");

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

describe("createOrder idempotency", () => {
  it("returns the same order id for a repeated clientRequestId instead of inserting a second order", async () => {
    const shop = await createShop();
    const clientRequestId = randomUUID();

    const first = await takeaway(shop, clientRequestId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await takeaway(shop, clientRequestId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.data.id).toBe(first.data.id);
    expect(second.data.orderNumber).toBe(first.data.orderNumber);
    expect(await orderCount(shop.locationId)).toBe(1);
  });

  it("stores the client_request_id on the created order", async () => {
    const shop = await createShop();
    const clientRequestId = randomUUID();

    const result = await takeaway(shop, clientRequestId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { rows } = await db.query<{ client_request_id: string | null }>(
      "SELECT client_request_id FROM orders WHERE id = $1",
      [result.data.id],
    );
    expect(rows[0].client_request_id).toBe(clientRequestId);
  });

  it("treats the same clientRequestId at a different location as a distinct order", async () => {
    const shopA = await createShop();
    const shopB = await createShop();
    const clientRequestId = randomUUID();

    const orderA = await takeaway(shopA, clientRequestId);
    const orderB = await takeaway(shopB, clientRequestId);
    expect(orderA.ok).toBe(true);
    expect(orderB.ok).toBe(true);
    if (!orderA.ok || !orderB.ok) return;

    expect(orderA.data.id).not.toBe(orderB.data.id);
    expect(await orderCount(shopA.locationId)).toBe(1);
    expect(await orderCount(shopB.locationId)).toBe(1);
  });

  it("creates a separate order each time when no clientRequestId is given, as before", async () => {
    const shop = await createShop();

    const first = await takeaway(shop);
    const second = await takeaway(shop);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.data.id).not.toBe(first.data.id);
    expect(await orderCount(shop.locationId)).toBe(2);
  });

  it("converges on one order when two concurrent calls race the same clientRequestId", async () => {
    const shop = await createShop();
    const clientRequestId = randomUUID();

    const [a, b] = await Promise.all([
      takeaway(shop, clientRequestId),
      takeaway(shop, clientRequestId),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.data.id).toBe(b.data.id);
    expect(await orderCount(shop.locationId)).toBe(1);
  });
});

describe("request fingerprint — same key, same payload or none at all (issue #913 item 1)", () => {
  it("persists a sha256 fingerprint next to the key, and none without a key", async () => {
    const shop = await createShop();
    const withKey = await takeaway(shop, randomUUID());
    const withoutKey = await takeaway(shop);
    expect(withKey.ok).toBe(true);
    expect(withoutKey.ok).toBe(true);
    if (!withKey.ok || !withoutKey.ok) return;

    const keyed = await db.query<{ request_fingerprint: string | null }>(
      "SELECT request_fingerprint FROM orders WHERE id = $1",
      [withKey.data.id],
    );
    const unkeyed = await db.query<{ request_fingerprint: string | null }>(
      "SELECT request_fingerprint FROM orders WHERE id = $1",
      [withoutKey.data.id],
    );
    expect(keyed.rows[0].request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(unkeyed.rows[0].request_fingerprint).toBeNull();
  });

  it("refuses a reused key whose payload changed — the original order stands untouched", async () => {
    const shop = await createShop();
    const key = randomUUID();

    const first = await takeaway(shop, key);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Same identity, different purchase: five teas instead of one.
    const changed = await dbLib.withTenant(shop.businessId, () =>
      orderMutations.createOrder({
        locationId: shop.locationId,
        type: "takeaway",
        discount: { type: null },
        items: [{ menuItemId: shop.menuItemId, quantity: 5 }],
        openedBy: null,
        clientRequestId: key,
      }),
    );
    expect(changed).toEqual({ ok: false, error: "request_conflict", status: 409 });

    // …and a payload change in the *discount* direction conflicts too, not
    // just a line edit: the key names one submission, not a blank cheque.
    const discounted = await dbLib.withTenant(shop.businessId, () =>
      orderMutations.createOrder({
        locationId: shop.locationId,
        type: "takeaway",
        discount: { type: "percent", value: 10 },
        items: [{ menuItemId: shop.menuItemId, quantity: 1 }],
        openedBy: null,
        clientRequestId: key,
      }),
    );
    expect(discounted).toEqual({ ok: false, error: "request_conflict", status: 409 });

    expect(await orderCount(shop.locationId)).toBe(1);
    const { rows } = await db.query<{ discount: string; quantity: string }>(
      `SELECT o.discount::text AS discount, oi.quantity::text AS quantity
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.id = $1`,
      [first.data.id],
    );
    expect(Number(rows[0].discount)).toBe(0);
    expect(Number(rows[0].quantity)).toBe(1);
  });

  it("rejects an unusable key outright rather than silently dropping it", async () => {
    const shop = await createShop();
    const result = await takeaway(shop, `  ${"x".repeat(201)}`);
    expect(result).toEqual({ ok: false, error: "invalid_client_request_id", status: 400 });
    expect(await orderCount(shop.locationId)).toBe(0);
  });
});

describe("offline-queue replay binds to the original request key (issue #913 item 1)", () => {
  it("returns the synchronously-created order instead of inserting a second one", async () => {
    const shop = await createShop();
    const key = randomUUID();

    // A user row for the replay's actor (orders.opened_by → users.id).
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash)
       VALUES ($1, 'cashier', 'صندوقچی', 'x') RETURNING id`,
      [shop.businessId],
    );
    const actor = { userId: user.rows[0].id, role: "cashier" as const };

    // The synchronous POST committed first (the response was lost).
    const direct = await takeaway(shop, key);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;

    // The queued action flushes with ITS OWN random transport id — the
    // payload carries the till's key, and the replay must dedupe on that.
    const { applySyncEvent } = await import("../src/lib/sync-events");
    const replay = await applySyncEvent(shop.locationId, actor, {
      clientEventId: randomUUID(),
      type: "order.create",
      occurredAt: new Date().toISOString(),
      payload: {
        type: "takeaway",
        items: [{ menuItemId: shop.menuItemId, quantity: 1 }],
        clientRequestId: key,
      },
    });
    expect(replay.ok).toBe(true);
    expect(replay.conflict).not.toBe(true);
    expect(await orderCount(shop.locationId)).toBe(1);

    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM orders WHERE location_id = $1",
      [shop.locationId],
    );
    expect(rows[0].id).toBe(direct.data.id);
  });

  it("still dedupes legacy queue records that predate the payload key", async () => {
    const shop = await createShop();
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash)
       VALUES ($1, 'cashier', 'صندوقچی', 'x') RETURNING id`,
      [shop.businessId],
    );
    const actor = { userId: user.rows[0].id, role: "cashier" as const };

    const { applySyncEvent } = await import("../src/lib/sync-events");
    const transportId = randomUUID();
    const event = {
      clientEventId: transportId,
      type: "order.create",
      occurredAt: new Date().toISOString(),
      payload: {
        type: "takeaway",
        items: [{ menuItemId: shop.menuItemId, quantity: 1 }],
        // no clientRequestId — a record written before issue #913
      },
    };
    const first = await applySyncEvent(shop.locationId, actor, event);
    expect(first.ok).toBe(true);
    const second = await applySyncEvent(shop.locationId, actor, event);
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(await orderCount(shop.locationId)).toBe(1);
  });
});

describe("offline replay cannot smuggle a discount past orders.discount (issue #913 item 3)", () => {
  it("refuses a waiter's queued order.create that carries a manual discount", async () => {
    const shop = await createShop();
    // A waiter: in ORDER_MUTATION_ROLES (may replay order events at all) but
    // without `orders.discount` — the preset the direct POST would bounce too.
    const waiter = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash)
       VALUES ($1, 'waiter', 'گارسون', 'x') RETURNING id`,
      [shop.businessId],
    );

    const { applySyncEvent } = await import("../src/lib/sync-events");
    const result = await applySyncEvent(
      shop.locationId,
      { userId: waiter.rows[0].id, role: "waiter" },
      {
        clientEventId: randomUUID(),
        type: "order.create",
        occurredAt: new Date().toISOString(),
        payload: {
          type: "takeaway",
          items: [{ menuItemId: shop.menuItemId, quantity: 1 }],
          discount: { type: "percent", value: 50 },
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("forbidden");
    expect(await orderCount(shop.locationId)).toBe(0);

    // The same replay WITHOUT the discount still goes through — the role
    // itself never changed, only the financial extra it may not carry.
    const plain = await applySyncEvent(
      shop.locationId,
      { userId: waiter.rows[0].id, role: "waiter" },
      {
        clientEventId: randomUUID(),
        type: "order.create",
        occurredAt: new Date().toISOString(),
        payload: {
          type: "takeaway",
          items: [{ menuItemId: shop.menuItemId, quantity: 1 }],
        },
      },
    );
    expect(plain.ok).toBe(true);
    expect(await orderCount(shop.locationId)).toBe(1);
  });
});

describe("monthly-order ceiling — dedupe first, then an atomic quota (issue #913 item 10)", () => {
  async function capOrders(shop: Shop, limit: number): Promise<void> {
    await db.query(
      `INSERT INTO business_billing_overrides (business_id, kind, target, value_int, reason, active)
       VALUES ($1, 'limit', 'monthly_order_limit', $2, 'issue-913 quota test', true)`,
      [shop.businessId, limit],
    );
  }

  it("returns the original order on retry after the limit is reached — the final sale of the month", async () => {
    const shop = await createShop();
    const key = randomUUID();

    const first = await takeaway(shop, key);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Ceiling set to exactly what has been used: no genuinely-new order left.
    await capOrders(shop, 1);

    const denied = await takeaway(shop, randomUUID());
    expect(denied).toEqual({ ok: false, error: "monthly_order_limit_exceeded", status: 403 });

    // The accepted request's own retry must NOT be refused by the quota its
    // order already consumed — the exact lost-response-after-the-last-sale bug.
    const replay = await takeaway(shop, key);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.data.id).toBe(first.data.id);
    expect(await orderCount(shop.locationId)).toBe(1);
  });

  it("lets exactly one of two concurrent new requests through a one-slot ceiling", async () => {
    const shop = await createShop();
    await capOrders(shop, 1);

    const [a, b] = await Promise.all([
      takeaway(shop, randomUUID()),
      takeaway(shop, randomUUID()),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(
      outcomes.filter((r) => !r.ok && r.error === "monthly_order_limit_exceeded"),
    ).toHaveLength(1);
    expect(await orderCount(shop.locationId)).toBe(1);
  });
});
