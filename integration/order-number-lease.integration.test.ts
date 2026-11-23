/**
 * Migration 0318 — one order-number authority.
 *
 * The live defect this pins: a till rang up a bill as #820, the cloud stored
 * the same bill as #821 because each side advanced its own counter and the
 * receiving side silently took "this side's next" when the sender's number was
 * taken. These assertions are the acceptance evidence:
 *
 *   * the cloud's per-location sequence is the only source of numbers;
 *   * leasing a block moves that sequence, and a cloud-created order can never
 *     land inside a block another install reserved;
 *   * the till mints inside its block, exhausts it, and asks for the next one;
 *   * a pulled order keeps its number verbatim, and a genuine collision is an
 *     alert plus a dead letter — never a rewrite.
 *
 * Runs against a fresh database as the unprivileged runtime role (like
 * `hybrid-sync-recovery.integration.test.ts`), so the RLS assertions are not
 * vacuous.
 */
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const APP_ROLE = "pos_order_number_role";
const APP_PASSWORD = "order-number-password";
const SITE_TOKEN = `POS1-${randomUUID()}`;

let databaseName: string;
let owner: Client;
let dbLib: typeof import("../src/lib/db");
let orderNumbers: typeof import("../src/lib/order-number-service");
let syncEvents: typeof import("../src/lib/sync-events");
let leaseRoute: typeof import("../src/app/api/server-sync/order-number-lease/route");

function urlFor(db: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${db}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_order_number_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  orderNumbers = await import("../src/lib/order-number-service");
  syncEvents = await import("../src/lib/sync-events");
  leaseRoute = await import("../src/app/api/server-sync/order-number-lease/route");

  owner = new Client({ connectionString: urlFor(databaseName) });
  await owner.connect();
}, 180_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await owner?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await dropAppRole(maintenance, APP_ROLE);
  } finally {
    await maintenance.end();
  }
});

interface Shop {
  businessId: string;
  locationId: string;
  ownerId: string;
  siteDeviceId: string;
}

async function makeShop(name: string): Promise<Shop> {
  const biz = await owner.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`],
  );
  const businessId = biz.rows[0].id;
  const loc = await owner.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = loc.rows[0].id;
  const user = await owner.query<{ id: string }>(
    `INSERT INTO users (id, business_id, location_id, role, full_name, password_hash, is_active)
     VALUES ($1, $2, $3, 'owner', 'Owner', 'test-hash', true) RETURNING id`,
    [randomUUID(), businessId, locationId],
  );
  const device = await owner.query<{ id: string }>(
    `INSERT INTO site_devices (business_id, location_id, display_name, status)
     VALUES ($1, $2, 'Till', 'active') RETURNING id`,
    [businessId, locationId],
  );
  return {
    businessId,
    locationId,
    ownerId: user.rows[0].id,
    siteDeviceId: device.rows[0].id,
  };
}

async function seedDeviceCredential(shop: Shop): Promise<void> {
  await owner.query(
    `INSERT INTO site_sync_credentials (site_device_id, business_id, token_hash, state)
     VALUES ($1, $2, $3, 'active')`,
    [shop.siteDeviceId, shop.businessId, createHash("sha256").update(SITE_TOKEN).digest("hex")],
  );
}

async function configureHybrid(shop: Shop): Promise<void> {
  const values: [string, unknown][] = [
    ["deployment.profile", { profile: "hybrid", pairedAt: new Date().toISOString() }],
    [
      "server_sync.config",
      {
        remoteUrl: "https://cloud.example.test",
        token: SITE_TOKEN,
        enabled: true,
        siteDeviceId: shop.siteDeviceId,
        locationId: shop.locationId,
        batchSize: 100,
      },
    ],
  ];
  for (const [key, value] of values) {
    await owner.query(
      `INSERT INTO settings (business_id, location_id, key, value) VALUES ($1, NULL, $2, $3::jsonb)`,
      [shop.businessId, key, JSON.stringify(value)],
    );
  }
}

async function allocateFromSequence(shop: Shop): Promise<number> {
  return dbLib.withTenantTransaction(shop.businessId, (client) =>
    orderNumbers.allocateSequenceOrderNumber(client, shop.locationId),
  );
}

/** An `order.state.synced` payload for a new order, with the number under test. */
function statePayload(orderId: string, orderNumber: number) {
  const now = new Date().toISOString();
  return {
    orderId,
    stateHlc: "000000000000001.000000000000001.test",
    order: {
      type: "takeaway",
      status: "open",
      orderNumber: String(orderNumber),
      tableId: null,
      customerId: null,
      guestCount: null,
      note: null,
      discountType: null,
      discountValue: null,
      subtotal: "100",
      discount: "0",
      serviceCharge: "0",
      tax: "0",
      total: "100",
      openedAt: now,
      openedBy: null,
      voidedReason: null,
      closedBy: null,
      closedAt: null,
    },
    items: [
      {
        id: randomUUID(),
        menuItemId: null,
        nameSnapshot: "Tea",
        unitPrice: "100",
        quantity: 1,
        status: "sent",
        note: null,
        sentToKitchenAt: null,
        readyAt: null,
        createdAt: now,
        voidReason: null,
        modifiers: [],
      },
    ],
  };
}

async function applyState(shop: Shop, payload: ReturnType<typeof statePayload>, clientEventId = randomUUID()) {
  return dbLib.withTenant(shop.businessId, () =>
    syncEvents.applySyncEvent(
      shop.locationId,
      { userId: shop.ownerId, role: "owner" },
      {
        clientEventId,
        type: "order.state.synced",
        occurredAt: new Date().toISOString(),
        payload: payload as unknown as Record<string, unknown>,
      },
      "remote",
    ),
  );
}

describe("the cloud sequence", () => {
  it("issues one number at a time and stays above orders that predate it", async () => {
    const shop = await makeShop("Sequence");
    expect(await allocateFromSequence(shop)).toBe(1);
    expect(await allocateFromSequence(shop)).toBe(2);

    // A sale imported/inserted outside the allocator must not be shadowed by
    // the next allocation.
    await owner.query(
      `INSERT INTO orders (location_id, order_number, type, status, total) VALUES ($1, 10, 'takeaway', 'open', 0)`,
      [shop.locationId],
    );
    expect(await allocateFromSequence(shop)).toBe(11);
    expect(await allocateFromSequence(shop)).toBe(12);
  });
});

describe("leasing a block", () => {
  it("reserves a block outside the cloud's own numbers and records it once", async () => {
    const shop = await makeShop("Lease");
    expect(await allocateFromSequence(shop)).toBe(1);

    // The till has sold up to #1 locally; its block starts at #2.
    const first = await dbLib.withTenantTransaction(shop.businessId, (client) =>
      orderNumbers.leaseOrderNumberBlock(client, {
        locationId: shop.locationId,
        siteDeviceId: shop.siteDeviceId,
        highestLocalOrderNumber: 1,
        blockSize: 200,
      }),
    );
    expect(first).toMatchObject({
      locationId: shop.locationId,
      siteDeviceId: shop.siteDeviceId,
      fromNumber: 2,
      toNumber: 201,
    });

    // The cloud's next own number is above the reserved block: a website bill
    // can never land inside a till's range.
    expect(await allocateFromSequence(shop)).toBe(202);

    const second = await dbLib.withTenantTransaction(shop.businessId, (client) =>
      orderNumbers.leaseOrderNumberBlock(client, {
        locationId: shop.locationId,
        siteDeviceId: shop.siteDeviceId,
        highestLocalOrderNumber: 1,
        blockSize: 200,
      }),
    );
    expect(second.fromNumber).toBe(203);
    expect(second.toNumber).toBe(402);

    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM order_number_lease WHERE location_id = $1",
      [shop.locationId],
    );
    expect(rows[0].n).toBe("2");
  });

  it("starts the block above a local sale that landed after the reported high-water mark", async () => {
    const shop = await makeShop("Lease High Water");
    const lease = await dbLib.withTenantTransaction(shop.businessId, (client) =>
      orderNumbers.leaseOrderNumberBlock(client, {
        locationId: shop.locationId,
        siteDeviceId: shop.siteDeviceId,
        highestLocalOrderNumber: 820,
        blockSize: 50,
      }),
    );
    expect(lease.fromNumber).toBe(821);
    expect(lease.toNumber).toBe(870);
  });
});

describe("minting inside a lease", () => {
  it("hands out the block in order, then reports exhaustion", async () => {
    const shop = await makeShop("Mint");
    const grant = await dbLib.withTenantTransaction(shop.businessId, (client) =>
      orderNumbers.leaseOrderNumberBlock(client, {
        locationId: shop.locationId,
        siteDeviceId: shop.siteDeviceId,
        blockSize: 3,
      }),
    );

    await dbLib.withTenantTransaction(shop.businessId, (client) =>
      orderNumbers.recordOrderNumberLease(client, grant, 0),
    );

    const mint = () =>
      dbLib.withTenantTransaction(shop.businessId, (client) =>
        orderNumbers.mintLeasedOrderNumber(client, { locationId: shop.locationId }),
      );
    expect(await mint()).toBe(grant.fromNumber);
    expect(await mint()).toBe(grant.fromNumber + 1);
    expect(await mint()).toBe(grant.fromNumber + 2);

    const { rows } = await owner.query<{ next_number: string; consumed_at: string | null }>(
      "SELECT next_number::text, consumed_at::text FROM order_number_lease WHERE id = $1",
      [grant.id],
    );
    expect(rows[0].next_number).toBe(String(grant.toNumber + 1));
    expect(rows[0].consumed_at).not.toBeNull();

    // No block left: refuse rather than borrow a number from a sequence this
    // install does not own.
    await expect(mint()).rejects.toMatchObject({ name: "OrderNumberLeaseExhausted" });
  });

  it("consumes an older block's tail before a freshly renewed one", async () => {
    const shop = await makeShop("Mint Renewal");
    const first = await dbLib.withTenantTransaction(shop.businessId, (client) =>
      orderNumbers.leaseOrderNumberBlock(client, {
        locationId: shop.locationId,
        siteDeviceId: shop.siteDeviceId,
        blockSize: 10,
      }),
    );
    const second = await dbLib.withTenantTransaction(shop.businessId, (client) =>
      orderNumbers.leaseOrderNumberBlock(client, {
        locationId: shop.locationId,
        siteDeviceId: shop.siteDeviceId,
        blockSize: 10,
      }),
    );
    await dbLib.withTenantTransaction(shop.businessId, async (client) => {
      await orderNumbers.recordOrderNumberLease(client, first, 0);
      await orderNumbers.recordOrderNumberLease(client, second, 0);
      // Simulate a renewal fetched at the low watermark: nine of the first
      // block are gone, the next mint must still come from its tail.
      await client.query("UPDATE order_number_lease SET next_number = $2 WHERE id = $1", [
        first.id,
        first.toNumber - 1,
      ]);
    });

    const mint = () =>
      dbLib.withTenantTransaction(shop.businessId, (client) =>
        orderNumbers.mintLeasedOrderNumber(client, { locationId: shop.locationId }),
      );
    expect(await mint()).toBe(first.toNumber - 1);
    expect(await mint()).toBe(first.toNumber);
    expect(await mint()).toBe(second.fromNumber);
  });
});

describe("renewing from the cloud", () => {
  it("records the granted block and reports the refreshed headroom", async () => {
    const shop = await makeShop("Renew");
    await configureHybrid(shop);
    orderNumbers.resetOrderNumberLeaseGate();

    const granted = {
      id: randomUUID(),
      locationId: shop.locationId,
      siteDeviceId: shop.siteDeviceId,
      fromNumber: 822,
      toNumber: 1021,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://cloud.example.test/api/server-sync/order-number-lease");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ highestLocalOrderNumber: 0 });
      return new Response(JSON.stringify({ lease: granted }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const status = await dbLib.withTenant(shop.businessId, () =>
      orderNumbers.ensureOrderNumberLease(shop.businessId),
    );
    expect(status).toMatchObject({ source: "lease", renewed: true, remaining: 200, error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { rows } = await owner.query<{ from_number: string; next_number: string }>(
      "SELECT from_number::text, next_number::text FROM order_number_lease WHERE id = $1",
      [granted.id],
    );
    expect(rows[0]).toEqual({ from_number: "822", next_number: "822" });
  });

  it("fetches one new block at the watermark, not one per call while the old tail remains", async () => {
    const shop = await makeShop("Renew Boundary");
    await configureHybrid(shop);
    orderNumbers.resetOrderNumberLeaseGate();

    const old = await dbLib.withTenantTransaction(shop.businessId, (client) =>
      orderNumbers.leaseOrderNumberBlock(client, {
        locationId: shop.locationId,
        siteDeviceId: shop.siteDeviceId,
        blockSize: 200,
      }),
    );
    await dbLib.withTenantTransaction(shop.businessId, async (client) => {
      await orderNumbers.recordOrderNumberLease(client, old, 0);
      await client.query("UPDATE order_number_lease SET next_number = $2 WHERE id = $1", [
        old.id,
        old.toNumber - 19,
      ]);
    });

    const granted = {
      id: randomUUID(),
      locationId: shop.locationId,
      siteDeviceId: shop.siteDeviceId,
      fromNumber: old.toNumber + 1,
      toNumber: old.toNumber + 200,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ lease: granted }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await dbLib.withTenant(shop.businessId, () =>
      orderNumbers.ensureOrderNumberLease(shop.businessId),
    );
    // 20 in the old block plus the new 200: both are mintable, so the next
    // call must not fetch a third block just because the oldest one is low.
    expect(first).toMatchObject({ source: "lease", renewed: true, remaining: 220 });
    const second = await dbLib.withTenant(shop.businessId, () =>
      orderNumbers.ensureOrderNumberLease(shop.businessId),
    );
    expect(second).toMatchObject({ source: "lease", renewed: false, remaining: 220 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps selling from the remaining tail when the cloud is unreachable", async () => {
    const shop = await makeShop("Renew Offline");
    await configureHybrid(shop);
    orderNumbers.resetOrderNumberLeaseGate();

    const grant = await dbLib.withTenantTransaction(shop.businessId, (client) =>
      orderNumbers.leaseOrderNumberBlock(client, {
        locationId: shop.locationId,
        siteDeviceId: shop.siteDeviceId,
        blockSize: 30,
      }),
    );
    await dbLib.withTenantTransaction(shop.businessId, async (client) => {
      await orderNumbers.recordOrderNumberLease(client, grant, 0);
      // Ten numbers left: at the low watermark, so renewal is attempted.
      await client.query("UPDATE order_number_lease SET next_number = $2 WHERE id = $1", [
        grant.id,
        grant.toNumber - 9,
      ]);
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const status = await dbLib.withTenant(shop.businessId, () =>
      orderNumbers.ensureOrderNumberLease(shop.businessId),
    );
    expect(status).toMatchObject({ source: "lease", renewed: false, remaining: 10 });
    expect(status.error).toContain("fetch failed");

    // The sales that already have numbers keep working.
    const minted = await dbLib.withTenantTransaction(shop.businessId, (client) =>
      orderNumbers.mintLeasedOrderNumber(client, { locationId: shop.locationId }),
    );
    expect(minted).toBe(grant.toNumber - 9);

    // A second attempt inside the retry window does not hammer the cloud.
    const again = await dbLib.withTenant(shop.businessId, () =>
      orderNumbers.ensureOrderNumberLease(shop.businessId),
    );
    expect(again.error).toBe("retry_later");
  });
});

describe("the allocator endpoint", () => {
  it("answers only a site device credential and grants its own branch a block", async () => {
    const shop = await makeShop("Endpoint");
    await seedDeviceCredential(shop);

    const unauthorized = await leaseRoute.POST(
      new NextRequest("http://localhost/api/server-sync/order-number-lease", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ highestLocalOrderNumber: 0 }),
      }),
    );
    expect(unauthorized.status).toBe(401);

    const response = await leaseRoute.POST(
      new NextRequest("http://localhost/api/server-sync/order-number-lease", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SITE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ highestLocalOrderNumber: 0 }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      lease: { locationId: string; siteDeviceId: string; fromNumber: number; toNumber: number };
    };
    expect(body.lease).toMatchObject({
      locationId: shop.locationId,
      siteDeviceId: shop.siteDeviceId,
      fromNumber: 1,
      toNumber: 200,
    });
  });
});

describe("pulled orders keep their number", () => {
  it("stores a free number verbatim instead of minting another", async () => {
    const shop = await makeShop("Pull Free");
    const orderId = randomUUID();
    const result = await applyState(shop, statePayload(orderId, 77));
    expect(result).toMatchObject({ ok: true });

    const { rows } = await owner.query<{ order_number: string }>(
      "SELECT order_number::text FROM orders WHERE id = $1",
      [orderId],
    );
    expect(rows[0].order_number).toBe("77");
  });

  it("dead-letters a genuine collision, alerts the owner and leaves both bills' numbers alone", async () => {
    const shop = await makeShop("Pull Collision");
    const existing = await owner.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 5, 'takeaway', 'open', 0) RETURNING id`,
      [shop.locationId],
    );
    const conflictingOrderId = randomUUID();
    const clientEventId = randomUUID();

    const result = await applyState(shop, statePayload(conflictingOrderId, 5), clientEventId);
    expect(result).toMatchObject({
      ok: false,
      deadLettered: true,
      error: "order_number_conflict",
    });

    // No rewrite: the existing bill still owns #5, and the pulled bill was not
    // invented under another number.
    const existingAfter = await owner.query<{ order_number: string }>(
      "SELECT order_number::text FROM orders WHERE id = $1",
      [existing.rows[0].id],
    );
    expect(existingAfter.rows[0].order_number).toBe("5");
    const pulled = await owner.query("SELECT 1 FROM orders WHERE id = $1", [conflictingOrderId]);
    expect(pulled.rows).toHaveLength(0);

    const deadLetter = await dbLib.withTenant(shop.businessId, () =>
      dbLib.query<{ error_code: string; source: string }>(
        `SELECT error_code, source FROM sync_event_dead_letters
          WHERE business_id = $1 AND client_event_id = $2`,
        [shop.businessId, clientEventId],
      ),
    );
    expect(deadLetter.rows).toEqual([{ error_code: "order_number_conflict", source: "domain" }]);

    const notification = await dbLib.withTenant(shop.businessId, () =>
      dbLib.query<{ event_key: string; severity: string }>(
        "SELECT event_key, severity FROM notification_events WHERE business_id = $1",
        [shop.businessId],
      ),
    );
    expect(notification.rows).toContainEqual({
      event_key: "sync.order_number_conflict",
      severity: "important",
    });
  });
});
