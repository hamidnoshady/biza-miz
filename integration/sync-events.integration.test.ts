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
let kitchenTransition: typeof import("../src/lib/kitchen-item-transition");
let serverSync: typeof import("../src/lib/server-sync");
let pushRoute: typeof import("../src/app/api/server-sync/push/route");
let pullRoute: typeof import("../src/app/api/server-sync/pull/route");

const bizA = {
  id: "",
  locationId: "",
  orderId: "",
  itemId: "",
  actorId: "",
  secondActorId: "",
  token: "token-for-a-0123456789",
};
const bizB = {
  id: "",
  locationId: "",
  orderId: "",
  itemId: "",
  actorId: "",
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
  kitchenTransition = await import("../src/lib/kitchen-item-transition");
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

async function seedActor(
  businessId: string,
  locationId: string,
  role: "owner" | "kitchen" = "kitchen",
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users(id,business_id,location_id,role,full_name,password_hash,is_active)
     VALUES($1,$2,$3,$4,'Sync Actor','test-hash',true)`,
    [id, businessId, locationId, role],
  );
  return id;
}

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
  // Reopen first: `guard_order_item_mutation` (migration 0014) refuses any
  // line mutation — including this cleanup's DELETE — on an order that is no
  // longer open, and the void tests below legitimately leave one voided.
  await db.query("UPDATE orders SET status = 'open' WHERE status <> 'open'");
  // Children first: the menu/order guards read a parent row's state, and a
  // cascade would remove the parent before the child's trigger runs (#910's
  // integration file hit the same rule).
  await db.query("DELETE FROM order_item_modifiers");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM menu_item_modifier_groups");
  await db.query("DELETE FROM modifiers");
  await db.query("DELETE FROM modifier_groups");
  await db.query("DELETE FROM menu_items");
  await db.query("DELETE FROM purchases");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const a = await seedBusiness("Cafe A");
  bizA.id = a.businessId;
  bizA.locationId = a.locationId;
  bizA.orderId = a.orderId;
  bizA.itemId = a.itemId;
  bizA.actorId = await seedActor(a.businessId, a.locationId);
  bizA.secondActorId = await seedActor(a.businessId, a.locationId);

  const b = await seedBusiness("Cafe B");
  bizB.id = b.businessId;
  bizB.locationId = b.locationId;
  bizB.orderId = b.orderId;
  bizB.itemId = b.itemId;
  bizB.actorId = await seedActor(b.businessId, b.locationId);

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
        { userId: bizA.actorId, role: "kitchen" },
        event,
      ),
    );
    expect(first).toMatchObject({ ok: true });

    const second = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: bizA.actorId, role: "kitchen" },
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
         VALUES ($1, $2, 'order_item.status', $3, $4, $5, 'kitchen')`,
        [
          bizA.locationId,
          clientEventId,
          { itemId: bizA.itemId, status: "preparing" },
          occurredAt,
          bizA.actorId,
        ],
      ),
    );

    const replay = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: bizA.actorId, role: "kitchen" },
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
        { userId: bizA.actorId, role: "kitchen" },
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
        { userId: bizA.actorId, role: "kitchen" },
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
        { userId: bizA.secondActorId, role: "kitchen" },
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
        { userId: bizA.actorId, role: "kitchen" },
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
    actorUserId: locationId === bizB.locationId ? bizB.actorId : bizA.actorId,
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
      error: "forbidden",
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
        { userId: bizA.actorId, role: "kitchen" },
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

describe("runServerPush — per-row delivery", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function insertLocalEvent(applied: boolean): Promise<string> {
    const clientEventId = randomUUID();
    await db.query(
      `INSERT INTO sync_events
         (location_id,client_event_id,event_type,payload,occurred_at,applied_at,actor_user_id,actor_role,origin)
       VALUES($1,$2,'order_item.status','{}'::jsonb,now(),${applied ? "now()" : "NULL"},'u1','kitchen','local')`,
      [bizA.locationId, clientEventId],
    );
    return clientEventId;
  }

  function stubRemote(
    outcome: (clientEventId: string) => Record<string, unknown>,
    seen: string[][] = [],
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          events: Array<{ clientEventId: string }>;
        };
        seen.push(body.events.map((event) => event.clientEventId));
        return new Response(
          JSON.stringify({
            results: body.events.map((event) => ({
              clientEventId: event.clientEventId,
              ...outcome(event.clientEventId),
            })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return seen;
  }

  async function pushedIds(): Promise<string[]> {
    const { rows } = await db.query<{ client_event_id: string }>(
      "SELECT client_event_id::text FROM sync_events WHERE pushed_at IS NOT NULL ORDER BY id",
    );
    return rows.map((row) => row.client_event_id);
  }

  it("keeps delivering past a deferred or failed row and re-sends only the failed one", async () => {
    const deferred = await insertLocalEvent(true);
    const failed = await insertLocalEvent(true);
    const applied = await insertLocalEvent(true);
    stubRemote((id) =>
      id === deferred
        ? { ok: false, deferred: true, error: "dependency_missing" }
        : id === failed
          ? { ok: false, error: "boom" }
          : { ok: true },
    );
    const first = await dbLib.withTenant(bizA.id, () =>
      serverSync.runServerPush(bizA.id),
    );
    expect(first).toEqual({ status: "error", error: "remote_apply_failed: boom" });
    // The central holds a deferred event and retries it itself; only the
    // failed row is still owed.
    expect(await pushedIds()).toEqual([deferred, applied]);

    // The refused row waits out its own backoff before it is offered again…
    const backoff = await db.query<{ push_attempts: number; waiting: boolean }>(
      "SELECT push_attempts, next_push_at > now() AS waiting FROM sync_events WHERE client_event_id = $1",
      [failed],
    );
    expect(backoff.rows[0]).toEqual({ push_attempts: 1, waiting: true });
    // …so move its clock on, as if the wait had passed.
    await db.query("UPDATE sync_events SET next_push_at = now() - interval '1 second' WHERE client_event_id = $1", [failed]);

    const seen = stubRemote(() => ({ ok: true }));
    const second = await dbLib.withTenant(bizA.id, () =>
      serverSync.runServerPush(bizA.id),
    );
    expect(second).toEqual({ status: "ok", pushed: 1 });
    expect(seen).toEqual([[failed]]);
    expect(await pushedIds()).toEqual([deferred, failed, applied]);
  });

  it("still delivers a lower-id row that is applied after a higher one went out", async () => {
    const late = await insertLocalEvent(false);
    const early = await insertLocalEvent(true);
    const seen = stubRemote(() => ({ ok: true }));
    await dbLib.withTenant(bizA.id, () => serverSync.runServerPush(bizA.id));
    expect(seen).toEqual([[early]]);

    await db.query(
      "UPDATE sync_events SET applied_at=now() WHERE client_event_id=$1",
      [late],
    );
    await dbLib.withTenant(bizA.id, () => serverSync.runServerPush(bizA.id));
    expect(seen).toEqual([[early], [late]]);
  });

  it("sends nothing and logs nothing when there is nothing to send", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await dbLib.withTenant(bizA.id, () =>
      serverSync.runServerPush(bizA.id),
    );
    expect(result).toEqual({ status: "ok", pushed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    const { rowCount } = await db.query(
      "SELECT 1 FROM server_sync_log WHERE business_id=$1 AND status='skipped'",
      [bizA.id],
    );
    expect(rowCount).toBe(0);
  });
});

describe("runServerPull — cursor shape", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a bigint id sent as a numeric string by an older central", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              events: [
                {
                  id: "12",
                  clientEventId: randomUUID(),
                  type: "order_item.status",
                  occurredAt: new Date().toISOString(),
                  payload: { itemId: bizA.itemId, status: "preparing" },
                  locationId: bizA.locationId,
                  actorUserId: bizA.actorId,
                  actorRole: "kitchen",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const result = await dbLib.withTenant(bizA.id, () =>
      serverSync.runServerPull(bizA.id),
    );
    expect(result).toEqual({ status: "ok", pulled: 1 });
    const state = await dbLib.withTenant(bizA.id, () =>
      serverSync.getServerSyncState(bizA.id),
    );
    expect(state.lastPulledEventId).toBe(12);
    const diagnostics = await dbLib.withTenant(bizA.id, () =>
      serverSync.getSyncDomainDiagnostics(bizA.id),
    );
    expect(
      diagnostics.deadLetters.filter((letter) => letter.source === "server_pull"),
    ).toHaveLength(0);
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
        { userId: bizA.actorId, role: "kitchen" },
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
        { userId: bizB.actorId, role: "kitchen" },
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
    // The site validates the cursor with Number.isSafeInteger; a bigint sent
    // through as a string made it dead-letter every pulled event.
    expect(typeof pulledA.events[0].id).toBe("number");
    expect(pulledB.events).toHaveLength(1);
    expect(pulledB.events[0].locationId).toBe(bizB.locationId);
  });

  it("never bounces a remote-origin event back out on the next pull", async () => {
    // Simulates business A having pulled an event that originated on the peer server.
    await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: bizA.actorId, role: "kitchen" },
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
        actorUserId: bizA.actorId,
        actorRole: "kitchen",
      },
      {
        id: 11,
        clientEventId: goodEventId,
        type: "order_item.status",
        occurredAt: new Date().toISOString(),
        payload: { itemId: bizA.itemId, status: "preparing" },
        locationId: bizA.locationId,
        actorUserId: bizA.actorId,
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
                  actorUserId: bizB.actorId,
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

describe("atomic online kitchen transition and hybrid outbox", () => {
  it("rolls back the status if the order-state outbox cannot be committed", async () => {
    const previousRole = process.env.DEPLOYMENT_ROLE;
    process.env.DEPLOYMENT_ROLE = "site";
    try {
      await db.query(`
        CREATE OR REPLACE FUNCTION fail_kitchen_state_outbox() RETURNS trigger AS $$
        BEGIN
          IF NEW.event_type = 'order.state.synced' THEN
            RAISE EXCEPTION 'injected kitchen outbox failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_kitchen_state_outbox
          BEFORE INSERT ON sync_events
          FOR EACH ROW EXECUTE FUNCTION fail_kitchen_state_outbox();
      `);

      await expect(kitchenTransition.transitionKitchenItem({
        businessId: bizA.id,
        locationId: bizA.locationId,
        itemId: bizA.itemId,
        to: "preparing",
        mayBumpKitchen: true,
        mayServe: false,
        actorUserId: bizA.actorId,
        syncActor: { userId: bizA.actorId, role: "kitchen" },
      })).rejects.toThrow("injected kitchen outbox failure");

      const { rows: rolledBack } = await db.query<{ status: string }>(
        "SELECT status FROM order_items WHERE id=$1",
        [bizA.itemId],
      );
      expect(rolledBack[0].status).toBe("sent");

      await db.query("DROP TRIGGER fail_kitchen_state_outbox ON sync_events");
      await db.query("DROP FUNCTION fail_kitchen_state_outbox()");
      const applied = await kitchenTransition.transitionKitchenItem({
        businessId: bizA.id,
        locationId: bizA.locationId,
        itemId: bizA.itemId,
        to: "preparing",
        mayBumpKitchen: true,
        mayServe: false,
        actorUserId: bizA.actorId,
        syncActor: { userId: bizA.actorId, role: "kitchen" },
      });
      expect(applied).toMatchObject({ kind: "updated" });
      const { rows: committed } = await db.query<{ status: string }>(
        "SELECT status FROM order_items WHERE id=$1",
        [bizA.itemId],
      );
      expect(committed[0].status).toBe("preparing");
      const { rows: events } = await db.query<{ payload: { items: Array<{ status: string }> } }>(
        `SELECT payload FROM sync_events
          WHERE location_id=$1 AND event_type='order.state.synced' AND actor_user_id=$2`,
        [bizA.locationId, bizA.actorId],
      );
      expect(events.at(-1)?.payload.items[0].status).toBe("preparing");
    } finally {
      await db.query("DROP TRIGGER IF EXISTS fail_kitchen_state_outbox ON sync_events");
      await db.query("DROP FUNCTION IF EXISTS fail_kitchen_state_outbox()");
      if (previousRole === undefined) delete process.env.DEPLOYMENT_ROLE;
      else process.env.DEPLOYMENT_ROLE = previousRole;
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #910 — an offline-queued line must replay its add-on ids AND counts.
//
// The till prices an add-on once per unit of its own quantity, sends
// `[{ id, quantity: 3 }]`, and stores what it showed. The replay path is a
// *second* pricing implementation (order-cart.ts resolves ids against the menu
// again), so a reducer that dropped `quantity`, or a replay that re-added the
// same event, would make the server's money diverge from the receipt the
// cashier already printed. These tests drive applySyncEvent against real rows.
// ---------------------------------------------------------------------------

async function seedMenuForOfflineReplay(locationId: string): Promise<{
  menuItemId: string;
  modifierId: string;
  groupId: string;
}> {
  const { rows: itemRows } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, name, price)
     VALUES ($1, 'لاته', 100000) RETURNING id`,
    [locationId],
  );
  const { rows: groupRows } = await db.query<{ id: string }>(
    `INSERT INTO modifier_groups (location_id, name, min_select, max_select)
     VALUES ($1, 'افزودنی‌ها', 0, 5) RETURNING id`,
    [locationId],
  );
  const { rows: modifierRows } = await db.query<{ id: string }>(
    `INSERT INTO modifiers (location_id, group_id, name, price_delta)
     VALUES ($1, $2, 'شات اضافه', 20000) RETURNING id`,
    [locationId, groupRows[0].id],
  );
  await db.query(
    `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id)
     VALUES ($1, $2)`,
    [itemRows[0].id, groupRows[0].id],
  );
  return {
    menuItemId: itemRows[0].id,
    modifierId: modifierRows[0].id,
    groupId: groupRows[0].id,
  };
}

describe("applySyncEvent — offline replay of add-on ids and quantities", () => {
  it("replays «شات ×۳» as three units and prices the line exactly as the till did", async () => {
    const actorId = await seedActor(bizA.id, bizA.locationId, "owner");
    const menu = await seedMenuForOfflineReplay(bizA.locationId);
    const event = {
      clientEventId: randomUUID(),
      type: "order.add_items" as const,
      occurredAt: new Date().toISOString(),
      payload: {
        orderId: bizA.orderId,
        items: [
          {
            menuItemId: menu.menuItemId,
            quantity: 2,
            modifiers: [{ id: menu.modifierId, quantity: 3 }],
          },
        ],
      },
    };

    const applied = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        event,
      ),
    );
    expect(applied).toMatchObject({ ok: true });

    const { rows: itemRows } = await dbLib.withTenant(bizA.id, () =>
      dbLib.query<{ id: string; quantity: number; unit_price: string }>(
        `SELECT id, quantity, unit_price FROM order_items
          WHERE order_id = $1 AND name_snapshot = 'لاته'`,
        [bizA.orderId],
      ),
    );
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0].quantity).toBe(2);

    const { rows: modifierRows } = await dbLib.withTenant(bizA.id, () =>
      dbLib.query<{
        modifier_id: string;
        name_snapshot: string;
        price_delta: string;
        quantity: number;
      }>(
        `SELECT modifier_id, name_snapshot, price_delta, quantity
           FROM order_item_modifiers WHERE order_item_id = $1`,
        [itemRows[0].id],
      ),
    );
    // The id survives the replay (not re-resolved to something else) and so
    // does the count — a reducer that flattened «×۳» to one shot would show up
    // right here.
    expect(modifierRows).toEqual([
      {
        modifier_id: menu.modifierId,
        name_snapshot: "شات اضافه",
        price_delta: "20000",
        quantity: 3,
      },
    ]);

    // (100,000 + 3 × 20,000) × 2 = 320,000 Rial on the line, and the order's
    // own persisted subtotal agrees with the number the till displayed.
    const { rows: orderRows } = await dbLib.withTenant(bizA.id, () =>
      dbLib.query<{ subtotal: string; total: string }>(
        "SELECT subtotal, total FROM orders WHERE id = $1",
        [bizA.orderId],
      ),
    );
    const lineTotal =
      Number(itemRows[0].unit_price) * itemRows[0].quantity +
      modifierRows.reduce(
        (sum, row) => sum + Number(row.price_delta) * row.quantity,
        0,
      ) *
        itemRows[0].quantity;
    expect(lineTotal).toBe(320_000);
    const storedLine = await dbLib.withTenant(bizA.id, () =>
      dbLib.query<{ amount: string }>(
        `SELECT (unit_price * quantity
                 + COALESCE((SELECT SUM(oim.price_delta * oim.quantity)
                               FROM order_item_modifiers oim
                              WHERE oim.order_item_id = oi.id), 0) * quantity)::text AS amount
           FROM order_items oi WHERE oi.id = $1`,
        [itemRows[0].id],
      ),
    );
    expect(Number(storedLine.rows[0].amount)).toBe(320_000);
    expect(Number(orderRows[0].subtotal)).toBeGreaterThanOrEqual(320_000);
  });

  it("does not re-apply a replayed event (no doubled quantity, no doubled money)", async () => {
    const actorId = await seedActor(bizA.id, bizA.locationId, "owner");
    const menu = await seedMenuForOfflineReplay(bizA.locationId);
    const clientEventId = randomUUID();
    const event = {
      clientEventId,
      type: "order.add_items" as const,
      occurredAt: new Date().toISOString(),
      payload: {
        orderId: bizA.orderId,
        items: [
          {
            menuItemId: menu.menuItemId,
            quantity: 1,
            modifiers: [{ id: menu.modifierId, quantity: 3 }],
          },
        ],
      },
    };

    const first = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        event,
      ),
    );
    expect(first.ok).toBe(true);
    expect(first.duplicate ?? false).toBe(false);

    const snapshot = async () =>
      dbLib.withTenant(bizA.id, () =>
        dbLib.query<{ item_count: string; add_on_units: string; total: string }>(
          `SELECT
             (SELECT count(*)::text FROM order_items WHERE order_id = $1) AS item_count,
             (SELECT COALESCE(SUM(oim.quantity), 0)::text
                FROM order_item_modifiers oim
                JOIN order_items oi ON oi.id = oim.order_item_id
               WHERE oi.order_id = $1) AS add_on_units,
             (SELECT total::text FROM orders WHERE id = $1) AS total`,
          [bizA.orderId],
        ),
      );
    const beforeReplay = (await snapshot()).rows[0];

    const second = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        event,
      ),
    );
    expect(second).toMatchObject({ ok: true, duplicate: true });

    // Exactly one add-on row at ×۳ — not two, not six.
    const afterReplay = (await snapshot()).rows[0];
    expect(afterReplay).toEqual(beforeReplay);
    expect(afterReplay.add_on_units).toBe("3");
  });

  it("refuses an add-on the item does not offer instead of silently dropping it", async () => {
    const actorId = await seedActor(bizA.id, bizA.locationId, "owner");
    const menu = await seedMenuForOfflineReplay(bizA.locationId);
    // An id no row in this branch answers to — an add-on deleted between the
    // device going offline and the flush, or one from another branch.
    const result = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role: "owner" },
        {
          clientEventId: randomUUID(),
          type: "order.add_items" as const,
          occurredAt: new Date().toISOString(),
          payload: {
            orderId: bizA.orderId,
            items: [
              {
                menuItemId: menu.menuItemId,
                quantity: 1,
                modifiers: [{ id: randomUUID(), quantity: 3 }],
              },
            ],
          },
        },
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_modifier");
    const { rows } = await dbLib.withTenant(bizA.id, () =>
      dbLib.query("SELECT id FROM order_items WHERE name_snapshot = 'لاته'"),
    );
    expect(rows).toHaveLength(0);
  });
});

/**
 * Issue #913 item 4 — a void arriving through sync (the peer outbox's
 * `order.state.synced`, or a legacy queued `order_item.status`) is the same
 * financial act as the route, held to the ACTOR'S effective permissions on
 * this server: `orders.void` for the bill, `orders.void_item` for a line —
 * the way an initial discount is already held to `orders.discount`.
 *
 * The distinction the gate must keep: a state that INTRODUCES a void needs
 * the key; a state that merely re-sends history (lines voided long ago —
 * states always carry every surviving line) is an ordinary edit and must
 * keep flowing, or every later edit of an order with a voided line would be
 * dead-lettered.
 */
describe("void authorization on sync events (issue #913 item 4)", () => {
  async function seedActor(
    role: "owner" | "manager" | "cashier",
    permissions: { granted?: string[]; revoked?: string[] } | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      permissions
        ? `INSERT INTO users(id, business_id, location_id, role, full_name, password_hash, is_active, permissions)
           VALUES($1, $2, $3, $4, 'Void Actor', 'test-hash', true, $5)`
        : `INSERT INTO users(id, business_id, location_id, role, full_name, password_hash, is_active)
           VALUES($1, $2, $3, $4, 'Void Actor', 'test-hash', true)`,
      permissions
        ? [id, bizA.id, bizA.locationId, role, JSON.stringify(permissions)]
        : [id, bizA.id, bizA.locationId, role],
    );
    return id;
  }

  /** Distinct, strictly-rising hybrid-logical-clock stamps (migration 0190 shape). */
  function hlcStamp(seq: number): string {
    return `000000000000001.${String(seq).padStart(15, "0")}.test`;
  }

  function statePayload(opts: {
    orderId: string;
    hlc: string;
    orderStatus: "open" | "voided";
    itemStatus?: "sent" | "voided";
    orderNumber?: string;
    itemId?: string;
    note?: string | null;
  }) {
    const now = new Date().toISOString();
    return {
      orderId: opts.orderId,
      stateHlc: opts.hlc,
      order: {
        type: "dine_in",
        status: opts.orderStatus,
        orderNumber: opts.orderNumber ?? "1",
        tableId: null,
        customerId: null,
        guestCount: 2,
        note: opts.note ?? null,
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
          id: opts.itemId ?? bizA.itemId,
          menuItemId: null,
          nameSnapshot: "Coffee",
          unitPrice: "100",
          quantity: 1,
          status: opts.itemStatus ?? "sent",
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

  async function applyState(
    actorId: string,
    role: "owner" | "manager" | "cashier",
    payload: ReturnType<typeof statePayload>,
  ) {
    return dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role },
        {
          clientEventId: randomUUID(),
          type: "order.state.synced",
          occurredAt: new Date().toISOString(),
          payload: payload as unknown as Record<string, unknown>,
        },
        "local",
      ),
    );
  }

  async function applyLegacyStatus(
    actorId: string,
    role: "owner" | "manager" | "cashier",
    payload: { itemId: string; status: string },
  ) {
    return dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: actorId, role },
        {
          clientEventId: randomUUID(),
          type: "order_item.status",
          occurredAt: new Date().toISOString(),
          payload,
        },
        "local",
      ),
    );
  }

  it("refuses a whole-order void from a member without orders.void (cashier preset), dead-lettering it with no effect", async () => {
    const cashier = await seedActor("cashier");
    const result = await applyState(
      cashier,
      "cashier",
      statePayload({ orderId: bizA.orderId, hlc: hlcStamp(1), orderStatus: "voided" }),
    );
    expect(result).toMatchObject({ ok: false, deadLettered: true, error: "forbidden" });
    const { rows } = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM orders WHERE id = $1",
      [bizA.orderId],
    );
    expect(rows[0].status).toBe("open");
  });

  it("applies a whole-order void carried by the outbox state when the actor holds orders.void", async () => {
    const owner = await seedActor("owner");
    const result = await applyState(
      owner,
      "owner",
      statePayload({ orderId: bizA.orderId, hlc: hlcStamp(2), orderStatus: "voided" }),
    );
    expect(result).toMatchObject({ ok: true });
    const { rows } = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM orders WHERE id = $1",
      [bizA.orderId],
    );
    expect(rows[0].status).toBe("voided");
  });

  it("refuses an item void whose actor had orders.void_item revoked, even while holding orders.create", async () => {
    const cashier = await seedActor("cashier", { granted: [], revoked: ["orders.void_item"] });
    const result = await applyState(
      cashier,
      "cashier",
      statePayload({
        orderId: bizA.orderId,
        hlc: hlcStamp(3),
        orderStatus: "open",
        itemStatus: "voided",
      }),
    );
    expect(result).toMatchObject({ ok: false, deadLettered: true, error: "forbidden" });
    const { rows } = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM order_items WHERE id = $1",
      [bizA.itemId],
    );
    expect(rows[0].status).toBe("sent");
  });

  it("applies an item void when the actor holds orders.void_item (cashier preset)", async () => {
    const cashier = await seedActor("cashier");
    const result = await applyState(
      cashier,
      "cashier",
      statePayload({
        orderId: bizA.orderId,
        hlc: hlcStamp(4),
        orderStatus: "open",
        itemStatus: "voided",
      }),
    );
    expect(result).toMatchObject({ ok: true });
    const { rows } = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM order_items WHERE id = $1",
      [bizA.itemId],
    );
    expect(rows[0].status).toBe("voided");
  });

  it("keeps flowing an ordinary state that merely re-sends the voided line as history, even from a member holding neither key", async () => {
    // The void first, by someone who may do it…
    const owner = await seedActor("owner");
    await applyState(
      owner,
      "owner",
      statePayload({
        orderId: bizA.orderId,
        hlc: hlcStamp(5),
        orderStatus: "open",
        itemStatus: "voided",
      }),
    );
    // …then a later edit by a member with BOTH keys revoked: the state still
    // carries the voided line (lines are never dropped from a snapshot), but
    // it introduces no new void, so it is an ordinary edit and must apply.
    const restricted = await seedActor("cashier", {
      granted: [],
      revoked: ["orders.void", "orders.void_item"],
    });
    const result = await applyState(
      restricted,
      "cashier",
      statePayload({
        orderId: bizA.orderId,
        hlc: hlcStamp(6),
        orderStatus: "open",
        itemStatus: "voided",
        note: "edited after the void",
      }),
    );
    expect(result.error).not.toBe("forbidden");
    expect(result).toMatchObject({ ok: true });
  });

  it("legacy queued order_item.status replay of a void requires orders.void_item", async () => {
    const cashier = await seedActor("cashier", { granted: [], revoked: ["orders.void_item"] });
    const result = await applyLegacyStatus(cashier, "cashier", {
      itemId: bizA.itemId,
      status: "voided",
    });
    expect(result).toMatchObject({ ok: false, error: "forbidden" });
    const { rows } = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM order_items WHERE id = $1",
      [bizA.itemId],
    );
    expect(rows[0].status).toBe("sent");
  });

  it("legacy order_item.status void from a member holding the key passes the permission gate (the pre-existing conflict classification still refuses, but never with forbidden)", async () => {
    const cashier = await seedActor("cashier");
    const result = await applyLegacyStatus(cashier, "cashier", {
      itemId: bizA.itemId,
      status: "voided",
    });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBe("forbidden");
    const { rows } = await db.query<{ status: string }>(
      "SELECT status::text AS status FROM order_items WHERE id = $1",
      [bizA.itemId],
    );
    expect(rows[0].status).toBe("sent");
  });

  it("state sync that CREATES an order writes no request key at all — pairing holds for the peer-state path", async () => {
    const owner = await seedActor("owner");
    const freshOrderId = randomUUID();
    const result = await applyState(
      owner,
      "owner",
      statePayload({
        orderId: freshOrderId,
        hlc: hlcStamp(7),
        orderStatus: "open",
        orderNumber: "77",
        itemId: randomUUID(),
      }),
    );
    expect(result).toMatchObject({ ok: true });
    const { rows } = await db.query<{ client_request_id: string | null; request_fingerprint: string | null }>(
      "SELECT client_request_id, request_fingerprint FROM orders WHERE id = $1",
      [freshOrderId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].client_request_id).toBeNull();
    expect(rows[0].request_fingerprint).toBeNull();
  });
});
