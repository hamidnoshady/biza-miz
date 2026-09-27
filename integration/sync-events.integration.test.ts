/**
 * End-to-end coverage for the offline-queue flush engine (Phase 5) and the
 * server-to-server sync HTTP endpoints (Phase 11/17), against a real
 * Postgres database. Before this file, only the pure conflict-classification
 * function (offline-sync.test.ts) and token-resolution (
 * server-sync-tokens.integration.test.ts) were tested directly — nothing
 * drove applySyncEvent's actual idempotency/conflict behavior against real
 * rows, and nothing called the /api/server-sync/push and /pull route
 * handlers at all. That second gap is exactly the shape of bug Phase 17 had
 * to find by manual review (a cross-business leak in these same routes), so
 * this file also proves push/pull isolation holds.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { SYNC_EVENT_REGISTRY } from "../src/lib/sync-event-registry";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_sync_test_role";
const APP_PASSWORD = "sync-test-password";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let syncEvents: typeof import("../src/lib/sync-events");
let serverSync: typeof import("../src/lib/server-sync");
let pushRoute: typeof import("../src/app/api/server-sync/push/route");
let pullRoute: typeof import("../src/app/api/server-sync/pull/route");

const bizA = {
  id: "",
  locationId: "",
  orderId: "",
  itemId: "",
  token: "token-for-a-0123456789",
};
const bizB = {
  id: "",
  locationId: "",
  orderId: "",
  itemId: "",
  token: "token-for-b-9876543210",
};

function urlFor(
  database: string,
  user?: { name: string; password: string },
): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
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
  databaseName = `pos_syncevents_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  // Connect the app modules as the unprivileged role, not the superuser this
  // repo's stock docker-compose/CI service makes the migration owner —
  // otherwise every RLS policy the push/pull isolation tests below depend on
  // would be silently bypassed, and the isolation assertions would pass
  // vacuously (see tenant-isolation.integration.test.ts's own warning about
  // exactly this).
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });
  process.env.DATABASE_URL = urlFor(databaseName, {
    name: APP_ROLE,
    password: APP_PASSWORD,
  });
  dbLib = await import("../src/lib/db");
  syncEvents = await import("../src/lib/sync-events");
  serverSync = await import("../src/lib/server-sync");
  pushRoute = await import("../src/app/api/server-sync/push/route");
  pullRoute = await import("../src/app/api/server-sync/pull/route");

  // Raw seeding/assertions use the superuser connection so fixtures for both
  // businesses can be created without being scoped to either tenant.
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  } finally {
    await maintenance.end();
  }
});

async function seedBusiness(name: string): Promise<{
  businessId: string;
  locationId: string;
  orderId: string;
  itemId: string;
}> {
  const fixture = await db.query<{
    business_id: string;
    location_id: string;
    order_id: string;
    item_id: string;
  }>(
    `
    WITH business AS (
      INSERT INTO businesses(name, slug) VALUES ($1, $2) RETURNING id
    ), location AS (
      INSERT INTO locations(business_id, name) SELECT id, 'Main' FROM business RETURNING id, business_id
    ), new_order AS (
      INSERT INTO orders(location_id, order_number, status, subtotal, total)
      SELECT id, 1, 'open', 100, 100 FROM location RETURNING id, location_id
    ), new_item AS (
      INSERT INTO order_items(location_id, order_id, name_snapshot, unit_price, quantity, status)
      SELECT location_id, id, 'Coffee', 100, 1, 'sent' FROM new_order RETURNING id
    )
    SELECT location.business_id, new_order.location_id, new_order.id order_id, new_item.id item_id
      FROM location CROSS JOIN new_order CROSS JOIN new_item
    `,
    [
      name,
      `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`,
    ],
  );
  const row = fixture.rows[0];
  return {
    businessId: row.business_id,
    locationId: row.location_id,
    orderId: row.order_id,
    itemId: row.item_id,
  };
}

beforeEach(async () => {
  await db.query("DELETE FROM sync_events");
  await db.query("DELETE FROM server_sync_tokens");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM purchases");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const a = await seedBusiness("Cafe A");
  bizA.id = a.businessId;
  bizA.locationId = a.locationId;
  bizA.orderId = a.orderId;
  bizA.itemId = a.itemId;

  const b = await seedBusiness("Cafe B");
  bizB.id = b.businessId;
  bizB.locationId = b.locationId;
  bizB.orderId = b.orderId;
  bizB.itemId = b.itemId;

  await dbLib.withTenant(bizA.id, () =>
    serverSync.setServerSyncConfig(bizA.id, {
      remoteUrl: "https://vps.example.com",
      token: bizA.token,
      enabled: true,
    }),
  );
  await dbLib.withTenant(bizB.id, () =>
    serverSync.setServerSyncConfig(bizB.id, {
      remoteUrl: "https://vps.example.com",
      token: bizB.token,
      enabled: true,
    }),
  );
});

describe("applySyncEvent — idempotency and conflict resolution against real rows", () => {
  it("replaying the same client_event_id is a no-op that returns the original outcome", async () => {
    const clientEventId = randomUUID();
    const event = {
      clientEventId,
      type: "order_item.status" as const,
      occurredAt: new Date().toISOString(),
      payload: { itemId: bizA.itemId, status: "preparing" },
    };

    const first = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "u1", role: "kitchen" },
        event,
      ),
    );
    expect(first).toMatchObject({ ok: true });

    const second = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "u1", role: "kitchen" },
        event,
      ),
    );
    expect(second).toMatchObject({ ok: true, duplicate: true });

    const { rows } = await dbLib.withTenant(bizA.id, () =>
      dbLib.query<{ status: string }>(
        "SELECT status FROM order_items WHERE id = $1",
        [bizA.itemId],
      ),
    );
    expect(rows[0].status).toBe("preparing");

    const { rows: seRows } = await db.query<{ count: string }>(
      "SELECT count(*)::text FROM sync_events WHERE location_id = $1 AND client_event_id = $2",
      [bizA.locationId, clientEventId],
    );
    expect(seRows[0].count).toBe("1");
  });

  it("never reports an ambiguous, unmarked inbox event as successfully applied", async () => {
    const clientEventId = randomUUID();
    const occurredAt = new Date().toISOString();
    await dbLib.withTenant(bizA.id, () =>
      dbLib.query(
        `INSERT INTO sync_events
           (location_id, client_event_id, event_type, payload, occurred_at, actor_user_id, actor_role)
         VALUES ($1, $2, 'order_item.status', $3, $4, 'u1', 'kitchen')`,
        [
          bizA.locationId,
          clientEventId,
          { itemId: bizA.itemId, status: "preparing" },
          occurredAt,
        ],
      ),
    );

    const replay = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "u1", role: "kitchen" },
        {
          clientEventId,
          type: "order_item.status",
          occurredAt,
          payload: { itemId: bizA.itemId, status: "preparing" },
        },
      ),
    );
    expect(replay).toMatchObject({
      ok: false,
      duplicate: true,
      error: "event_outcome_pending",
    });

    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM order_items WHERE id = $1",
      [bizA.itemId],
    );
    expect(rows[0].status).toBe("sent");
  });

  it("a stale transition is flagged as a conflict and never mutates the row", async () => {
    // Legitimately progress sent -> preparing -> ready first (two kitchen bumps).
    await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "u1", role: "kitchen" },
        {
          clientEventId: randomUUID(),
          type: "order_item.status",
          occurredAt: new Date().toISOString(),
          payload: { itemId: bizA.itemId, status: "preparing" },
        },
      ),
    );
    await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "u1", role: "kitchen" },
        {
          clientEventId: randomUUID(),
          type: "order_item.status",
          occurredAt: new Date().toISOString(),
          payload: { itemId: bizA.itemId, status: "ready" },
        },
      ),
    );

    // A second device's queued "preparing" arrives after the item already reached "ready".
    const stale = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "u2", role: "kitchen" },
        {
          clientEventId: randomUUID(),
          type: "order_item.status",
          occurredAt: new Date().toISOString(),
          payload: { itemId: bizA.itemId, status: "preparing" },
        },
      ),
    );
    expect(stale).toMatchObject({ ok: false, conflict: true });

    const { rows } = await dbLib.withTenant(bizA.id, () =>
      dbLib.query<{ status: string }>(
        "SELECT status FROM order_items WHERE id = $1",
        [bizA.itemId],
      ),
    );
    expect(rows[0].status).toBe("ready");
  });

  it("a location can only mutate its own business's item, never another's", async () => {
    const result = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "u1", role: "kitchen" },
        {
          clientEventId: randomUUID(),
          type: "order_item.status",
          occurredAt: new Date().toISOString(),
          // bizB's item id, under bizA's location/tenant scope.
          payload: { itemId: bizB.itemId, status: "preparing" },
        },
      ),
    );
    expect(result).toMatchObject({ ok: false, error: "item_not_found" });

    const { rows } = await dbLib.withTenant(bizB.id, () =>
      dbLib.query<{ status: string }>(
        "SELECT status FROM order_items WHERE id = $1",
        [bizB.itemId],
      ),
    );
    expect(rows[0].status).toBe("sent");
  });
});

function pushRequest(token: string, events: unknown[]): NextRequest {
  return new NextRequest("http://localhost/api/server-sync/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ events }),
  });
}

function pullRequest(token: string, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/server-sync/pull${query}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

function statusEvent(locationId: string, itemId: string, status: string) {
  return {
    clientEventId: randomUUID(),
    type: "order_item.status",
    occurredAt: new Date().toISOString(),
    payload: { itemId, status },
    locationId,
    actorUserId: "remote-user",
    actorRole: "kitchen",
  };
}

describe("versioned transactional domain-event registry", () => {
  async function actorForBusiness(
    businessId: string,
    locationId: string,
    role: "owner" | "manager" | "cashier" = "owner",
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users(id,business_id,location_id,role,full_name,password_hash,is_active)
       VALUES($1,$2,$3,$4,'Sync Actor','test-hash',true)`,
      [id, businessId, locationId, role],
    );
    return id;
  }

  it("routes every registered transactional handler and terminally rejects invalid payloads without effects", async () => {
    const actorId = await actorForBusiness(bizA.id, bizA.locationId);
    const definitions = SYNC_EVENT_REGISTRY.filter(
      (entry) => !("legacy" in entry && entry.legacy),
    );
    for (const definition of definitions) {
      const clientEventId = randomUUID();
      const result = await dbLib.withTenant(bizA.id, () =>
        syncEvents.applySyncEvent(
          bizA.locationId,
          { userId: actorId, role: "owner" },
          {
            clientEventId,
            type: definition.type,
            occurredAt: new Date().toISOString(),
            payload: {},
          },
          "remote",
          { schemaVersion: definition.schemaVersion },
        ),
      );
      expect(result, definition.type).toMatchObject({
        ok: false,
        deadLettered: true,
      });
      expect(result.error, definition.type).toMatch(/^invalid_/);
      const effect = await db.query<{
        status: string;
        effect_type: string | null;
      }>(
        "SELECT status,effect_type FROM sync_domain_effects WHERE client_event_id=$1",
        [clientEventId],
      );
      expect(effect.rows, definition.type).toEqual([
        { status: "dead_lettered", effect_type: null },
      ]);
    }
  });

  it("dead-letters an unknown event version without storing its payload in diagnostics", async () => {
    const actorId = await actorForBusiness(bizA.id, bizA.locationId);
    const secret = `card-secret-${randomUUID()}`;
    const result = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        {
          clientEventId: randomUUID(),
          type: "order.payment.completed",
          occurredAt: new Date().toISOString(),
          payload: { orderId: bizA.orderId, method: "card", reference: secret },
        },
        "remote",
        { schemaVersion: 999 },
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      deadLettered: true,
      error: "unknown_event_version",
    });

    const diagnostics = await dbLib.withTenant(bizA.id, () =>
      serverSync.getSyncDomainDiagnostics(bizA.id),
    );
    expect(diagnostics.counts.openDeadLetters).toBe(1);
    expect(diagnostics.deadLetters[0].payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);

    // Requeue is not allowed to hide a still-invalid event as "resolved".
    // Reconciliation dead-letters it again and reopens the same payload-free
    // diagnostic row with an incremented retry counter.
    await dbLib.withTenant(bizA.id, () =>
      serverSync.updateSyncDeadLetter(
        bizA.id,
        diagnostics.deadLetters[0].id,
        "retry",
        actorId,
        "retry unknown version",
      ),
    );
    await dbLib.withTenant(bizA.id, () =>
      syncEvents.reconcileDeferredSyncEvents(bizA.id, 10),
    );
    const retried = await dbLib.withTenant(bizA.id, () =>
      serverSync.getSyncDomainDiagnostics(bizA.id),
    );
    expect(retried.counts.openDeadLetters).toBe(1);
    expect(retried.deadLetters[0]).toMatchObject({
      status: "open",
      retryCount: 1,
    });
    expect(JSON.stringify(retried)).not.toContain(secret);
  });

  it("applies a purchase draft and inbox/effect atomically, deduping an ambiguous retry", async () => {
    const actorId = await actorForBusiness(bizA.id, bizA.locationId);
    const inventoryItemId = randomUUID();
    await db.query(
      `INSERT INTO inventory_items(id,location_id,name,unit,purchase_unit_factor,is_active)
       VALUES($1,$2,'Flour','g',1,true)`,
      [inventoryItemId, bizA.locationId],
    );
    const clientEventId = randomUUID();
    const event = {
      clientEventId,
      type: "inventory.purchase.created",
      occurredAt: new Date().toISOString(),
      payload: {
        items: [
          {
            inventoryItemId,
            purchaseQty: "100.000000000",
            totalCost: "9007199254740993",
          },
        ],
      },
    };

    const injected = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        event,
        "remote",
        { schemaVersion: 1, failureInjection: "after_domain_effect" },
      ),
    );
    expect(injected).toMatchObject({
      ok: false,
      error: "injected_sync_failure_after_domain_effect",
    });
    expect(
      (
        await db.query("SELECT 1 FROM purchases WHERE location_id=$1", [
          bizA.locationId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.query("SELECT 1 FROM sync_events WHERE client_event_id=$1", [
          clientEventId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT 1 FROM sync_domain_effects WHERE client_event_id=$1",
          [clientEventId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT 1 FROM sync_event_dead_letters WHERE client_event_id=$1",
          [clientEventId],
        )
      ).rowCount,
    ).toBe(0);

    const first = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        event,
        "remote",
        { schemaVersion: 1 },
      ),
    );
    expect(first.ok).toBe(true);
    const second = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        event,
        "remote",
        { schemaVersion: 1 },
      ),
    );
    expect(second).toMatchObject({ ok: true, duplicate: true });
    const purchases = await db.query<{ total: string }>(
      "SELECT total::text FROM purchases WHERE location_id=$1",
      [bizA.locationId],
    );
    expect(purchases.rows).toEqual([{ total: "9007199254740993" }]);
    const effects = await db.query<{ status: string }>(
      "SELECT status FROM sync_domain_effects WHERE client_event_id=$1",
      [clientEventId],
    );
    expect(effects.rows).toEqual([{ status: "applied" }]);
  });

  it("defers a missing payment prerequisite without a partial payment or journal", async () => {
    const actorId = await actorForBusiness(bizA.id, bizA.locationId);
    const missingOrderId = randomUUID();
    const result = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        {
          clientEventId: randomUUID(),
          type: "order.payment.completed",
          occurredAt: new Date().toISOString(),
          payload: { orderId: missingOrderId, method: "cash" },
        },
        "remote",
        { schemaVersion: 1 },
      ),
    );
    expect(result).toMatchObject({ ok: false, deferred: true });
    expect(
      (
        await db.query("SELECT 1 FROM payments WHERE order_id=$1", [
          missingOrderId,
        ])
      ).rowCount,
    ).toBe(0);
    const state = await db.query<{ status: string }>(
      "SELECT status FROM sync_domain_effects WHERE client_event_id=$1",
      [result.clientEventId],
    );
    expect(state.rows[0].status).toBe("deferred");
  });

  it("dead-letters a forged actor role without applying a domain effect", async () => {
    const actorId = await actorForBusiness(bizA.id, bizA.locationId, "cashier");
    const inventoryItemId = randomUUID();
    await db.query(
      `INSERT INTO inventory_items(id,location_id,name,unit,purchase_unit_factor,is_active)
       VALUES($1,$2,'Role scoped item','unit',1,true)`,
      [inventoryItemId, bizA.locationId],
    );
    const clientEventId = randomUUID();
    const result = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "manager" },
        {
          clientEventId,
          type: "inventory.purchase.created",
          occurredAt: new Date().toISOString(),
          payload: {
            items: [{ inventoryItemId, purchaseQty: "1", totalCost: "100" }],
          },
        },
        "remote",
        { schemaVersion: 1 },
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      deadLettered: true,
      error: "actor_identity_mismatch",
    });
    expect(
      (
        await db.query("SELECT 1 FROM purchases WHERE location_id=$1", [
          bizA.locationId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT status FROM sync_domain_effects WHERE client_event_id=$1",
          [clientEventId],
        )
      ).rows[0].status,
    ).toBe("dead_lettered");
  });

  it("dead-letters a revoked or cross-location site device before any domain mutation", async () => {
    const actorId = await actorForBusiness(bizA.id, bizA.locationId);
    const device = await db.query<{ id: string }>(
      `INSERT INTO site_devices(business_id,location_id,display_name,status,revoked_at)
       VALUES($1,$2,'Revoked sync device','revoked',now()) RETURNING id`,
      [bizA.id, bizA.locationId],
    );
    const clientEventId = randomUUID();
    const result = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        {
          clientEventId,
          type: "inventory.waste.recorded",
          occurredAt: new Date().toISOString(),
          payload: {
            inventoryItemId: randomUUID(),
            quantity: "1",
            reason: "spoilage",
          },
        },
        "remote",
        { schemaVersion: 1, siteDeviceId: device.rows[0].id },
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      deadLettered: true,
      error: "site_identity_mismatch",
    });
    expect(
      (
        await db.query(
          "SELECT 1 FROM inventory_events WHERE idempotency_key=$1",
          [`waste:${clientEventId}`],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("never treats an unexpected handler failure as a terminal dead letter", async () => {
    const actorId = await actorForBusiness(bizA.id, bizA.locationId);
    const clientEventId = randomUUID();
    const result = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        {
          clientEventId,
          type: "accounting.manual_journal.reversed",
          occurredAt: new Date().toISOString(),
          payload: { entryId: "not-a-uuid" },
        },
        "remote",
        { schemaVersion: 1 },
      ),
    );
    // PostgreSQL 22P02 is an infrastructure/input-boundary failure that rolls
    // back fully. Only validated payload/domain errors may be terminal.
    expect(result).toMatchObject({ ok: false, error: "22P02" });
    expect(result).not.toHaveProperty("deadLettered", true);
    expect(
      (
        await db.query("SELECT 1 FROM sync_events WHERE client_event_id=$1", [
          clientEventId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT 1 FROM sync_event_dead_letters WHERE client_event_id=$1",
          [clientEventId],
        )
      ).rowCount,
    ).toBe(0);
  });
});

describe("runServerPush — remote outcomes", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function seedPushEvent(): Promise<string> {
    const clientEventId = randomUUID();
    const result = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "u1", role: "kitchen" },
        {
          clientEventId,
          type: "order_item.status",
          occurredAt: new Date().toISOString(),
          payload: { itemId: bizA.itemId, status: "preparing" },
        },
      ),
    );
    expect(result.ok).toBe(true);
    return clientEventId;
  }

  it("advances only after the remote confirms the matching domain outcome", async () => {
    const clientEventId = await seedPushEvent();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [{ clientEventId, ok: true }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await dbLib.withTenant(bizA.id, () =>
      serverSync.runServerPush(bizA.id),
    );
    expect(result).toEqual({ status: "ok", pushed: 1 });
    const state = await dbLib.withTenant(bizA.id, () =>
      serverSync.getServerSyncState(bizA.id),
    );
    expect(state.lastPushedEventId).toBeGreaterThan(0);
  });

  it("does not advance past a remote apply failure", async () => {
    const clientEventId = await seedPushEvent();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { clientEventId, ok: false, error: "event_outcome_pending" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await dbLib.withTenant(bizA.id, () =>
      serverSync.runServerPush(bizA.id),
    );
    expect(result).toEqual({
      status: "error",
      error: "remote_apply_failed: event_outcome_pending",
    });
    const state = await dbLib.withTenant(bizA.id, () =>
      serverSync.getServerSyncState(bizA.id),
    );
    expect(state.lastPushedEventId).toBeNull();
  });
});

describe("/api/server-sync/push and /pull — cross-business isolation", () => {
  it("applies a batch scoped entirely to the token's own business", async () => {
    const res = await pushRoute.POST(
      pushRequest(bizA.token, [
        statusEvent(bizA.locationId, bizA.itemId, "preparing"),
      ]),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ ok: true });
  });

  it("rejects a batch mixing two businesses' locations, applying nothing", async () => {
    const res = await pushRoute.POST(
      pushRequest(bizA.token, [
        statusEvent(bizA.locationId, bizA.itemId, "preparing"),
        statusEvent(bizB.locationId, bizB.itemId, "preparing"),
      ]),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("mixed_business_locations");

    const { rows: aRows } = await db.query<{ status: string }>(
      "SELECT status FROM order_items WHERE id = $1",
      [bizA.itemId],
    );
    const { rows: bRows } = await db.query<{ status: string }>(
      "SELECT status FROM order_items WHERE id = $1",
      [bizB.itemId],
    );
    expect(aRows[0].status).toBe("sent");
    expect(bRows[0].status).toBe("sent");
  });

  it("rejects business A's token pushing events for business B's location", async () => {
    const res = await pushRoute.POST(
      pushRequest(bizA.token, [
        statusEvent(bizB.locationId, bizB.itemId, "preparing"),
      ]),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("location_business_mismatch");
  });

  it("pull never returns another business's events, even when both have some", async () => {
    // Pull only ever serves events that originated locally on this server
    // (origin='local', the default) — events ingested via push are tagged
    // 'remote' and are never bounced back (see the test below).
    await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "u1", role: "kitchen" },
        {
          clientEventId: randomUUID(),
          type: "order_item.status",
          occurredAt: new Date().toISOString(),
          payload: { itemId: bizA.itemId, status: "preparing" },
        },
      ),
    );
    await dbLib.withTenant(bizB.id, () =>
      syncEvents.applySyncEvent(
        bizB.locationId,
        { userId: "u1", role: "kitchen" },
        {
          clientEventId: randomUUID(),
          type: "order_item.status",
          occurredAt: new Date().toISOString(),
          payload: { itemId: bizB.itemId, status: "preparing" },
        },
      ),
    );

    const pulledA = await (await pullRoute.GET(pullRequest(bizA.token))).json();
    const pulledB = await (await pullRoute.GET(pullRequest(bizB.token))).json();

    expect(pulledA.events).toHaveLength(1);
    expect(pulledA.events[0].locationId).toBe(bizA.locationId);
    expect(pulledB.events).toHaveLength(1);
    expect(pulledB.events[0].locationId).toBe(bizB.locationId);
  });

  it("never bounces a remote-origin event back out on the next pull", async () => {
    // Simulates business A having pulled an event that originated on the peer server.
    await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "peer", role: "kitchen" },
        {
          clientEventId: randomUUID(),
          type: "order_item.status",
          occurredAt: new Date().toISOString(),
          payload: { itemId: bizA.itemId, status: "preparing" },
        },
        "remote",
      ),
    );

    const pulled = await (await pullRoute.GET(pullRequest(bizA.token))).json();
    expect(pulled.events).toHaveLength(0);
  });

  it("rejects an unknown or missing bearer token", async () => {
    const res = await pushRoute.POST(
      pushRequest("not-a-real-token", [
        statusEvent(bizA.locationId, bizA.itemId, "preparing"),
      ]),
    );
    expect(res.status).toBe(401);
  });
});

describe("runServerPull — dead letters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records a poison event as a dead letter, still advances past it, and leaves other events unaffected", async () => {
    const goodEventId = randomUUID();
    const poisonEventId = randomUUID();
    const remoteEvents = [
      {
        id: 10,
        clientEventId: poisonEventId,
        type: "order_item.status",
        occurredAt: new Date().toISOString(),
        payload: { itemId: bizA.itemId, status: "preparing" },
        // Malformed on purpose: sync_events.location_id is a uuid column, so
        // applySyncEvent's own INSERT throws before dispatch ever runs —
        // exactly the "poison event" this dead-letter path exists for.
        locationId: "not-a-real-location-id",
        actorUserId: "remote-user",
        actorRole: "kitchen",
      },
      {
        id: 11,
        clientEventId: goodEventId,
        type: "order_item.status",
        occurredAt: new Date().toISOString(),
        payload: { itemId: bizA.itemId, status: "preparing" },
        locationId: bizA.locationId,
        actorUserId: "remote-user",
        actorRole: "kitchen",
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ events: remoteEvents }), {
            status: 200,
          }),
      ),
    );

    const result = await dbLib.withTenant(bizA.id, () =>
      serverSync.runServerPull(bizA.id),
    );
    expect(result).toMatchObject({ status: "ok", pulled: 2 });

    // The batch kept going past the poison event and applied the good one.
    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM order_items WHERE id = $1",
      [bizA.itemId],
    );
    expect(rows[0].status).toBe("preparing");

    const diagnostics = await dbLib.withTenant(bizA.id, () =>
      serverSync.getSyncDomainDiagnostics(bizA.id),
    );
    const deadLetters = diagnostics.deadLetters.filter(
      (letter) => letter.source === "server_pull",
    );
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      remoteEventId: 10,
      clientEventId: poisonEventId,
      eventType: "order_item.status",
      status: "open",
    });

    // The high-water mark can advance only because the canonical row holds the
    // full replay envelope. Retrying replays it (and leaves it open when the
    // input is still malformed); an explicit discard remains available and
    // carries a resolver/audit note.
    const resolverId = randomUUID();
    await db.query(
      `INSERT INTO users(id,business_id,location_id,role,full_name,password_hash,is_active)
       VALUES($1,$2,$3,'owner','Dead-letter resolver','x',true)`,
      [resolverId, bizA.id, bizA.locationId],
    );
    await dbLib.withTenant(bizA.id, () =>
      serverSync.updateSyncDeadLetter(
        bizA.id,
        deadLetters[0].id,
        "retry",
        resolverId,
        "retry after checking upstream",
      ),
    );
    const afterRetry = await dbLib.withTenant(bizA.id, () =>
      serverSync.getSyncDomainDiagnostics(bizA.id),
    );
    expect(
      afterRetry.deadLetters.find((letter) => letter.id === deadLetters[0].id),
    ).toMatchObject({ status: "open", retryCount: 1 });
    await dbLib.withTenant(bizA.id, () =>
      serverSync.updateSyncDeadLetter(
        bizA.id,
        deadLetters[0].id,
        "discard",
        resolverId,
        "invalid remote location confirmed",
      ),
    );
    const discarded = await db.query<{
      status: string;
      resolution_note: string | null;
      resolved_by: string | null;
    }>(
      `SELECT status,resolution_note,resolved_by::text
         FROM sync_event_dead_letters WHERE id=$1`,
      [deadLetters[0].id],
    );
    expect(discarded.rows[0]).toEqual({
      status: "discarded",
      resolution_note: "invalid remote location confirmed",
      resolved_by: resolverId,
    });

    const state = await dbLib.withTenant(bizA.id, () =>
      serverSync.getServerSyncState(bizA.id),
    );
    expect(state.lastPulledEventId).toBe(11);
  });

  it("scopes dead letters to their own business", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              events: [
                {
                  id: 20,
                  clientEventId: randomUUID(),
                  type: "order_item.status",
                  occurredAt: new Date().toISOString(),
                  payload: { itemId: bizB.itemId, status: "preparing" },
                  locationId: "not-a-real-location-id",
                  actorUserId: "remote-user",
                  actorRole: "kitchen",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    await dbLib.withTenant(bizB.id, () => serverSync.runServerPull(bizB.id));

    const bDeadLetters = await dbLib.withTenant(bizB.id, async () =>
      (await serverSync.getSyncDomainDiagnostics(bizB.id)).deadLetters.filter(
        (letter) => letter.source === "server_pull",
      ),
    );
    const aDeadLetters = await dbLib.withTenant(bizA.id, async () =>
      (await serverSync.getSyncDomainDiagnostics(bizA.id)).deadLetters.filter(
        (letter) => letter.source === "server_pull",
      ),
    );
    expect(bDeadLetters).toHaveLength(1);
    expect(aDeadLetters).toHaveLength(0);
  });
});

describe("legacy REMOTE_SYNC_TOKEN fallback — usage is flagged", () => {
  const LEGACY_TOKEN = "legacy-shared-secret-0123456789";
  const originalEnv = process.env.REMOTE_SYNC_TOKEN;
  const originalAllowLegacy = process.env.ALLOW_LEGACY_SYNC_TOKEN;

  beforeEach(async () => {
    process.env.REMOTE_SYNC_TOKEN = LEGACY_TOKEN;
    // Phase 24 Wave 1 denies the shared legacy token by default — this suite
    // is specifically exercising the opt-in fallback, so it has to opt in.
    process.env.ALLOW_LEGACY_SYNC_TOKEN = "1";
    // This test is specifically about the business that has NOT configured
    // its own per-business token yet, so remove the one seeded by the outer
    // beforeEach.
    await db.query("DELETE FROM server_sync_tokens WHERE business_id = $1", [
      bizB.id,
    ]);
  });

  afterEach(() => {
    process.env.REMOTE_SYNC_TOKEN = originalEnv;
    process.env.ALLOW_LEGACY_SYNC_TOKEN = originalAllowLegacy;
  });

  it("records legacyTokenLastUsedAt when push authenticates via the legacy token", async () => {
    const before = await dbLib.withTenant(bizB.id, () =>
      serverSync.getServerSyncState(bizB.id),
    );
    expect(before.legacyTokenLastUsedAt).toBeNull();

    const res = await pushRoute.POST(
      pushRequest(LEGACY_TOKEN, [
        statusEvent(bizB.locationId, bizB.itemId, "preparing"),
      ]),
    );
    expect(res.status).toBe(200);

    const after = await dbLib.withTenant(bizB.id, () =>
      serverSync.getServerSyncState(bizB.id),
    );
    expect(after.legacyTokenLastUsedAt).not.toBeNull();
  });

  it("records legacyTokenLastUsedAt when pull authenticates via the legacy token", async () => {
    const res = await pullRoute.GET(
      pullRequest(LEGACY_TOKEN, `?businessId=${bizB.id}`),
    );
    expect(res.status).toBe(200);

    const after = await dbLib.withTenant(bizB.id, () =>
      serverSync.getServerSyncState(bizB.id),
    );
    expect(after.legacyTokenLastUsedAt).not.toBeNull();
  });

  it("does not flag legacy usage for a business still using its own per-business token", async () => {
    await pushRoute.POST(
      pushRequest(bizA.token, [
        statusEvent(bizA.locationId, bizA.itemId, "preparing"),
      ]),
    );
    const state = await dbLib.withTenant(bizA.id, () =>
      serverSync.getServerSyncState(bizA.id),
    );
    expect(state.legacyTokenLastUsedAt).toBeNull();
  });
});
