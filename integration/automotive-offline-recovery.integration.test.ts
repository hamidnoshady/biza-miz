/**
 * Issue #839 §19 — the four defects the continuation review found in the offline
 * path, tested against two real databases and a real HTTP push.
 *
 * Each test names the failure it exists to prevent, because each of them was a
 * *plausible-looking* success before:
 *
 *  1. **a cancellation nothing can overtake**. Cancelling used to flip a row and
 *     leave the queued command executable, so the counter read «لغوشده» while the
 *     cloud went on and held the car. Two situations are tested apart, with the
 *     push in flight as the barrier: cancellation *before* any delivery attempt
 *     retracts the event locally (and the stub cloud receives nothing, ever), and
 *     cancellation *during* an attempt becomes a command the cloud answers — with
 *     the hold released through the canonical reservation service, refunds and
 *     journal included, or recorded as never applied.
 *  2. **every answer, not the newest page**. The feed carried
 *     `ORDER BY requested_at DESC LIMIT 200`; a request older than that window
 *     never had its answer delivered. The tests page a 300-request branch with the
 *     keyset cursors and assert that an unanswered request older than hundreds of
 *     settled ones is still delivered on the first page.
 *  3. **the queue tells the truth about a duplicate**. `ON CONFLICT DO NOTHING`
 *     swallowed two different situations; the API now reports the row the database
 *     actually holds, including when a different open request for the same car won.
 *  4. **the desk can reach the work**. The board's list is keyset-paged with its own
 *     counters, so a filter for old pending work reaches rows the first page does
 *     not carry.
 *
 * The push runs for real (`runServerPush`) against a stub central server in this
 * process: that is what makes the delivery stamp, the retraction and the race
 * observable rather than simulated.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let serverDb: string;
let localDb: string;

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

const globalForPg = globalThis as unknown as { pgPool?: Pool };

async function useDatabase(name: string): Promise<void> {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(name);
}

async function createDatabase(name: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(name), quiet: true });
}

async function dropDatabase(name: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
}

async function asRole<T>(
  role: "central" | "site",
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.DEPLOYMENT_ROLE;
  process.env.DEPLOYMENT_ROLE = role;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.DEPLOYMENT_ROLE;
    else process.env.DEPLOYMENT_ROLE = previous;
  }
}

// ---------------------------------------------------------------------------
// The stub central server: it records what a push actually delivers, and can be
// held open so a test can act *while* a delivery is in flight.
// ---------------------------------------------------------------------------

interface PushedEvent {
  clientEventId: string;
  type: string;
  payload: Record<string, unknown>;
}

interface StubCentral {
  port: number;
  /** Every batch this server has accepted, in order. */
  batches: PushedEvent[][];
  /** All events received, flattened. */
  events: PushedEvent[];
  /** Resolve to release a held response; set by `holdNextResponse`. */
  release: () => void;
  /** Resolves once a request has arrived and its response is being held. */
  waitForHold: () => Promise<void>;
  holdNextResponse: () => void;
  close: () => Promise<void>;
}

async function startStubCentral(): Promise<StubCentral> {
  const batches: PushedEvent[][] = [];
  const events: PushedEvent[] = [];
  let release: (() => void) | null = null;
  let heldGate: Promise<void> = Promise.resolve();
  let signalHeld: (() => void) | null = null;
  let holdNext = false;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          events?: PushedEvent[];
        };
        const batch = body.events ?? [];
        batches.push(batch);
        events.push(...batch);
        if (holdNext) {
          holdNext = false;
          heldGate = new Promise<void>((resolveHeld) => {
            signalHeld = resolveHeld;
          });
          await heldGate;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            results: batch.map((event) => ({
              clientEventId: event.clientEventId,
              ok: true,
            })),
          }),
        );
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("stub server has no port");

  return {
    port: address.port,
    batches,
    events,
    release: () => {
      const held = signalHeld;
      signalHeld = null;
      release = null;
      held?.();
    },
    waitForHold: async () => {
      while (!signalHeld)
        await new Promise((resolve) => setTimeout(resolve, 5));
    },
    holdNextResponse: () => {
      holdNext = true;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let automotive: typeof import("../src/lib/automotive-service");
let stock: typeof import("../src/lib/automotive-stock-service");
let syncEvents: typeof import("../src/lib/sync-events");
let serverSync: typeof import("../src/lib/server-sync");
let settings: typeof import("../src/lib/settings");

beforeAll(async () => {
  serverDb = `pos_auto_rec_srv_${randomUUID().replaceAll("-", "")}`;
  localDb = `pos_auto_rec_loc_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(serverDb);
  await createDatabase(localDb);

  await useDatabase(serverDb);
  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  automotive = await import("../src/lib/automotive-service");
  stock = await import("../src/lib/automotive-stock-service");
  syncEvents = await import("../src/lib/sync-events");
  serverSync = await import("../src/lib/server-sync");
  settings = await import("../src/lib/settings");
}, 300_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  await dropDatabase(serverDb);
  await dropDatabase(localDb);
});

async function seedPairedIdentity(input: {
  businessId: string;
  locationId: string;
  name: string;
  userId: string;
}): Promise<void> {
  await dbLib.withoutTenantScope("platform", () =>
    dbLib.query(
      `INSERT INTO businesses (id, name, slug, industry) VALUES ($1, $2, $3, 'automotive')
         ON CONFLICT (id) DO NOTHING`,
      [input.businessId, input.name, `rec-${input.businessId.slice(0, 8)}`],
    ),
  );
  await dbLib.withoutTenantScope("platform", () =>
    dbLib.query(
      `INSERT INTO locations (id, business_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [input.locationId, input.businessId, input.name],
    ),
  );
  await dbLib.withoutTenantScope("platform", () =>
    dbLib.query(
      `INSERT INTO users (id, business_id, location_id, role, full_name, password_hash)
       VALUES ($1, $2, $3, 'owner', 'مالک شعبه', 'x') ON CONFLICT (id) DO NOTHING`,
      [input.userId, input.businessId, input.locationId],
    ),
  );
}

function futureDate(days = 30): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function postingCount(
  businessId: string,
  sourceType: string,
): Promise<number> {
  const { rows } = await dbLib.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = $2`,
    [businessId, sourceType],
  );
  return Number(rows[0].n);
}

interface EventFacts {
  eventId: string;
  pushedAt: Date | null;
  dispatchAttemptedAt: Date | null;
  retractedAt: Date | null;
  retractedReason: string | null;
}

async function eventFacts(
  locationId: string,
  clientEventId: string,
): Promise<EventFacts | null> {
  const { rows } = await dbLib.query<EventFacts>(
    `SELECT id::text AS "eventId", pushed_at AS "pushedAt", dispatch_attempted_at AS "dispatchAttemptedAt",
            retracted_at AS "retractedAt", retracted_reason AS "retractedReason"
       FROM sync_events
      WHERE location_id = $1 AND client_event_id = $2`,
    [locationId, clientEventId],
  );
  return rows[0] ?? null;
}

/** Point this install's push at the stub, so `runServerPush` is the real thing. */
async function configurePush(
  businessId: string,
  locationId: string,
  port: number,
): Promise<void> {
  await settings.setSetting(
    businessId,
    settings.SETTING_KEYS.serverSyncConfig,
    {
      enabled: true,
      remoteUrl: `http://127.0.0.1:${port}`,
      token: "POS1-stub-token-0000000000000000",
      locationId,
      batchSize: 100,
    },
  );
  await settings.setSetting(businessId, settings.SETTING_KEYS.serverSyncState, {
    lastPushedEventId: 0,
    lastPulledEventId: 0,
    lastPushSuccessAt: null,
    lastPullSuccessAt: null,
    lastPushError: null,
    lastPullError: null,
    pushFailures: 0,
    pullFailures: 0,
    pushNextAttemptAt: null,
    pullNextAttemptAt: null,
  });
}

/** The site's own view of one queued request. */
async function siteRequest(businessId: string, requestId: string) {
  const { rows } = await dbLib.query<{
    status: string;
    outcome: Record<string, unknown> | null;
  }>(
    `SELECT status, outcome FROM automotive_vehicle_offline_requests WHERE business_id = $1 AND id = $2`,
    [businessId, requestId],
  );
  return rows[0] ?? null;
}

describe("§19's offline path after the review (Phase 4)", () => {
  it("never lets a withdrawn command reach the cloud, and answers for the ones already in flight", async () => {
    const stub = await startStubCentral();
    try {
      // ---- the cloud --------------------------------------------------------
      const created = await provisioning.provisionBusiness({
        businessName: "نمایشگاه خودروی آریا",
        ownerName: "مالک",
        email: `owner-${randomUUID()}@example.com`,
        password: "correct-horse",
        subdomain: `autorec${randomUUID().slice(0, 6)}`.toLowerCase(),
        industry: "automotive",
        seedChartOfAccounts: true,
      });

      const customerId = await dbLib.withTenant(
        created.businessId,
        async () => {
          const { rows } = await dbLib.query<{ id: string }>(
            `INSERT INTO parties (business_id, name, phone, role, roles)
           VALUES ($1, 'آقای خریدار', '09121112233', 'customer', ARRAY['customer']::text[])
           RETURNING id`,
            [created.businessId],
          );
          return rows[0].id;
        },
      );

      const car = await dbLib.withTenant(created.businessId, async () => {
        const client = await dbLib.getPool().connect();
        try {
          await client.query("BEGIN");
          const vehicle = await automotive.createVehicle(client, {
            businessId: created.businessId,
            locationId: created.locationId,
            make: "پژو",
            model: "207",
            condition: "new",
            vin: "WVWZZZ1JZ3W386753",
            chassisNumber: "CHASSIS-9001",
            stockNumber: "P-1",
            askingPriceRial: 900_000_000,
            acquisition: {
              date: "2026-01-10",
              source: "dealer_purchase",
              costRial: 700_000_000,
              settlement: "payable",
            },
          });
          await client.query("COMMIT");
          return { serialId: vehicle.serialId as string };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      });

      const projection = await dbLib.withTenant(created.businessId, () =>
        stock.buildAutomotiveStockProjection(
          created.businessId,
          created.locationId,
        ),
      );
      expect(projection).not.toBeNull();
      if (!projection) return;
      const mirrored = projection.vehicles[0];

      // ---- the paired branch ------------------------------------------------
      await useDatabase(localDb);
      await seedPairedIdentity({
        businessId: created.businessId,
        locationId: created.locationId,
        name: "شعبهٔ آریا",
        userId: created.userId,
      });
      await stock.applyAutomotiveStockProjection(
        created.businessId,
        created.locationId,
        projection,
      );
      await configurePush(created.businessId, created.locationId, stub.port);

      const queueReserve = (requestId: string) =>
        asRole("site", () =>
          stock.recordVehicleReservationRequest({
            businessId: created.businessId,
            locationId: created.locationId,
            requestId,
            serialId: car.serialId,
            stockNumber: "P-1",
            customerId,
            customerName: "آقای خریدار",
            expiresAt: futureDate(),
            expiresAtTime: null,
            depositRial: 5_000_000,
            depositMethod: "cash",
            depositRefundable: true,
            depositNote: null,
            note: null,
            expectedVersion: mirrored.sourceVersion,
            expectedState: "in_stock",
            actorId: created.userId,
            actorRole: "owner",
          }),
        );

      // ---- (a) cancelled before anything was ever sent ----------------------
      const retractedId = randomUUID();
      const queuedRetracted = await queueReserve(retractedId);
      expect(queuedRetracted).toEqual({
        requestId: retractedId,
        status: "pending",
        duplicate: false,
        adopted: false,
      });
      const beforeCancel = await eventFacts(created.locationId, retractedId);
      expect(beforeCancel).toMatchObject({
        pushedAt: null,
        dispatchAttemptedAt: null,
        retractedAt: null,
      });

      const cancelledBeforeSend = await asRole("site", () =>
        stock.cancelVehicleOfflineRequest({
          businessId: created.businessId,
          locationId: created.locationId,
          requestId: retractedId,
          actorId: created.userId,
          actorRole: "owner",
        }),
      );
      // The cancellation is *complete*: no attempt was ever made, so the queue entry
      // is retracted in the same transaction and nothing is left that could apply it.
      expect(cancelledBeforeSend).toMatchObject({
        action: "retracted",
        status: "cancelled",
        cancelled: true,
      });
      const afterCancel = await eventFacts(created.locationId, retractedId);
      expect(afterCancel?.retractedAt).not.toBeNull();
      expect(afterCancel?.dispatchAttemptedAt).toBeNull();
      expect(afterCancel?.retractedReason).toBe(
        "offline_request_cancelled_before_dispatch",
      );
      const retractedRow = await siteRequest(created.businessId, retractedId);
      expect(retractedRow?.status).toBe("cancelled");
      expect(retractedRow?.outcome).toMatchObject({
        cancelledBy: "site",
        reason: "retracted_before_dispatch",
      });

      // …and the cloud never hears about it, now or after a restart: the push is the
      // real push, and the stub receives nothing at all.
      const pushAfterRetraction = await serverSync.runServerPush(
        created.businessId,
      );
      expect(pushAfterRetraction).toMatchObject({ status: "ok", pushed: 0 });
      expect(stub.events).toHaveLength(0);
      // A retracted row is not "unsent work" either: the health counters stop seeing
      // it, or the panel would report a backlog that can never drain.
      const health = await dbLib.query<{ unsent: number }>(
        `SELECT (SELECT count(*)::int FROM sync_events se JOIN locations l ON l.id = se.location_id
                  WHERE l.business_id = $1 AND se.origin = 'local' AND se.pushed_at IS NULL
                    AND se.retracted_at IS NULL) AS unsent`,
        [created.businessId],
      );
      expect(health.rows[0].unsent).toBe(0);

      // ---- (b) cancelled while a delivery is in flight ----------------------
      const inFlightId = randomUUID();
      await queueReserve(inFlightId);
      stub.holdNextResponse();
      const push = serverSync.runServerPush(created.businessId);
      await stub.waitForHold();
      // The push has left the machine: the attempt is stamped, so no local code can
      // claim the cloud has not seen it.
      const inFlightFacts = await eventFacts(created.locationId, inFlightId);
      expect(inFlightFacts?.dispatchAttemptedAt).not.toBeNull();
      expect(inFlightFacts?.pushedAt).toBeNull();

      const cancelledInFlight = await asRole("site", () =>
        stock.cancelVehicleOfflineRequest({
          businessId: created.businessId,
          locationId: created.locationId,
          requestId: inFlightId,
          actorId: created.userId,
          actorRole: "owner",
        }),
      );
      // The honest answer: not cancelled. The row is `cancelling` and a withdrawal
      // command of its own is queued — with a different idempotency key, because the
      // request's own key belongs to the event that is already in flight.
      expect(cancelledInFlight).toMatchObject({
        action: "withdrawn",
        status: "cancelling",
        cancelled: false,
      });
      const withdrawingRow = await siteRequest(created.businessId, inFlightId);
      expect(withdrawingRow?.status).toBe("cancelling");
      const withdrawalEvent = await eventFacts(
        created.locationId,
        stock.offlineRequestWithdrawalEventKey(inFlightId),
      );
      expect(withdrawalEvent).not.toBeNull();
      expect(withdrawalEvent?.dispatchAttemptedAt).toBeNull();
      expect(withdrawalEvent?.pushedAt).toBeNull();

      stub.release();
      await push;
      expect(stub.events.map((event) => event.clientEventId)).toEqual([
        inFlightId,
      ]);

      // The withdrawal goes out on the next tick, unchanged and un-retractable
      // (nothing about "it may already be applied" is forgotten by a restart).
      const secondPush = await serverSync.runServerPush(created.businessId);
      expect(secondPush).toMatchObject({ status: "ok", pushed: 1 });
      expect(stub.events.map((event) => event.clientEventId)).toEqual([
        inFlightId,
        stock.offlineRequestWithdrawalEventKey(inFlightId),
      ]);
      const withdrawalPayload = stub.events[1].payload;
      expect(stub.events[1].type).toBe(
        "automotive.vehicle.reservation.withdrawn",
      );
      expect(withdrawalPayload).toMatchObject({
        requestId: inFlightId,
        serialId: car.serialId,
        stockNumber: "P-1",
        requestType: "reserve",
      });

      // ---- the cloud applies the reserve … ----------------------------------
      await useDatabase(serverDb);
      const reserveApplied = await asRole("central", () =>
        dbLib.withTenant(created.businessId, () =>
          syncEvents.applySyncEvent(
            created.locationId,
            { userId: created.userId, role: "owner" },
            {
              clientEventId: inFlightId,
              type: "automotive.vehicle.reservation.requested",
              occurredAt: new Date().toISOString(),
              payload: stub.events[0].payload,
            },
            "remote",
            { siteDeviceId: null, schemaVersion: 1 },
          ),
        ),
      );
      expect(reserveApplied.ok).toBe(true);
      const heldRow = await dbLib.withTenant(created.businessId, () =>
        dbLib.query<{ status: string; reservation_id: string | null }>(
          `SELECT status, reservation_id FROM automotive_vehicle_offline_requests WHERE business_id = $1 AND id = $2`,
          [created.businessId, inFlightId],
        ),
      );
      expect(heldRow.rows[0]).toMatchObject({ status: "confirmed" });
      const heldReservationId = heldRow.rows[0].reservation_id!;
      expect(
        await postingCount(
          created.businessId,
          "automotive_reservation_deposit",
        ),
      ).toBe(1);

      // ---- …then the withdrawal, which must undo it the canonical way -------
      const withdrawalApplied = await asRole("central", () =>
        dbLib.withTenant(created.businessId, () =>
          syncEvents.applySyncEvent(
            created.locationId,
            { userId: created.userId, role: "owner" },
            {
              clientEventId: stock.offlineRequestWithdrawalEventKey(inFlightId),
              type: "automotive.vehicle.reservation.withdrawn",
              occurredAt: new Date().toISOString(),
              payload: withdrawalPayload as Record<string, unknown>,
            },
            "remote",
            { siteDeviceId: null, schemaVersion: 1 },
          ),
        ),
      );
      expect(withdrawalApplied.ok).toBe(true);
      const releasedRow = await dbLib.withTenant(created.businessId, () =>
        dbLib.query<{
          status: string;
          reservation_id: string | null;
          outcome: Record<string, unknown>;
        }>(
          `SELECT status, reservation_id, outcome FROM automotive_vehicle_offline_requests WHERE business_id = $1 AND id = $2`,
          [created.businessId, inFlightId],
        ),
      );
      expect(releasedRow.rows[0].status).toBe("cancelled");
      expect(releasedRow.rows[0].outcome).toMatchObject({
        withdrawnBy: "site",
        cloudApplied: true,
        releasedReservationId: heldReservationId,
      });
      const { rows: reservationAfter } = await dbLib.withTenant(
        created.businessId,
        () =>
          dbLib.query<{ status: string }>(
            `SELECT status FROM serial_reservations WHERE business_id = $1 AND id = $2`,
            [created.businessId, heldReservationId],
          ),
      );
      // Released by the canonical service, not deleted: the refund of the refundable
      // deposit is its business, and it left its own posting as evidence.
      expect(reservationAfter[0].status).toBe("released");
      expect(
        await postingCount(
          created.businessId,
          "automotive_reservation_deposit_refund",
        ),
      ).toBe(1);
      const { rows: vehicleAfter } = await dbLib.withTenant(
        created.businessId,
        () =>
          dbLib.query<{ state: string }>(
            `SELECT state FROM automotive_vehicle_attributes WHERE business_id = $1 AND serial_id = $2`,
            [created.businessId, car.serialId],
          ),
      );
      expect(vehicleAfter[0].state).toBe("in_stock");

      // Replaying the withdrawal changes nothing — the release happened once.
      const withdrawalReplay = await asRole("central", () =>
        dbLib.withTenant(created.businessId, () =>
          syncEvents.applySyncEvent(
            created.locationId,
            { userId: created.userId, role: "owner" },
            {
              clientEventId: stock.offlineRequestWithdrawalEventKey(inFlightId),
              type: "automotive.vehicle.reservation.withdrawn",
              occurredAt: new Date().toISOString(),
              payload: withdrawalPayload as Record<string, unknown>,
            },
            "remote",
            { siteDeviceId: null, schemaVersion: 1 },
          ),
        ),
      );
      expect(withdrawalReplay.ok).toBe(true);
      expect(
        await postingCount(
          created.businessId,
          "automotive_reservation_deposit_refund",
        ),
      ).toBe(1);

      // ---- and the site settles its own row from the cloud's answer ---------
      const refreshed = await dbLib.withTenant(created.businessId, () =>
        stock.buildAutomotiveStockProjection(
          created.businessId,
          created.locationId,
        ),
      );
      expect(
        refreshed?.requests.find((request) => request.id === inFlightId)
          ?.status,
      ).toBe("cancelled");
      await useDatabase(localDb);
      expect(refreshed).not.toBeNull();
      if (!refreshed) return;
      await stock.applyAutomotiveStockProjection(
        created.businessId,
        created.locationId,
        refreshed,
      );
      const settled = await siteRequest(created.businessId, inFlightId);
      expect(settled?.status).toBe("cancelled");

      // Pressing cancel again reports the truth instead of pretending to work: the
      // cloud decided, so the row is final.
      const secondCancel = await asRole("site", () =>
        stock.cancelVehicleOfflineRequest({
          businessId: created.businessId,
          locationId: created.locationId,
          requestId: inFlightId,
          actorId: created.userId,
          actorRole: "owner",
        }),
      );
      expect(secondCancel).toMatchObject({
        action: "decided",
        status: "cancelled",
        cancelled: true,
      });

      // ---- a withdrawal for a command the cloud never received --------------
      // The site re-queues, the cloud is stopped before it applies anything, and the
      // withdrawal arrives first. The cloud must settle the request rather than wait
      // forever for a command that may never come — and the late reserve, when it
      // finally arrives, must apply nothing.
      await useDatabase(localDb);
      const lateId = randomUUID();
      await queueReserve(lateId);
      const dispatched = await serverSync.runServerPush(created.businessId);
      expect(dispatched).toMatchObject({ status: "ok" });
      const lateEvent = stub.events.find(
        (event) => event.clientEventId === lateId,
      )!;
      const lateCancel = await asRole("site", () =>
        stock.cancelVehicleOfflineRequest({
          businessId: created.businessId,
          locationId: created.locationId,
          requestId: lateId,
          actorId: created.userId,
          actorRole: "owner",
        }),
      );
      expect(lateCancel).toMatchObject({ action: "withdrawn" });
      await serverSync.runServerPush(created.businessId);
      const lateWithdrawal = stub.events.find(
        (event) =>
          event.clientEventId ===
          stock.offlineRequestWithdrawalEventKey(lateId),
      )!;
      expect(lateWithdrawal).toBeTruthy();

      await useDatabase(serverDb);
      const cloudNeverSaw = await asRole("central", () =>
        dbLib.withTenant(created.businessId, () =>
          syncEvents.applySyncEvent(
            created.locationId,
            { userId: created.userId, role: "owner" },
            {
              clientEventId: stock.offlineRequestWithdrawalEventKey(lateId),
              type: "automotive.vehicle.reservation.withdrawn",
              occurredAt: new Date().toISOString(),
              payload: lateWithdrawal.payload,
            },
            "remote",
            { siteDeviceId: null, schemaVersion: 1 },
          ),
        ),
      );
      expect(cloudNeverSaw.ok).toBe(true);
      const settledWithoutRequest = await dbLib.withTenant(
        created.businessId,
        () =>
          dbLib.query<{ status: string; outcome: Record<string, unknown> }>(
            `SELECT status, outcome FROM automotive_vehicle_offline_requests WHERE business_id = $1 AND id = $2`,
            [created.businessId, lateId],
          ),
      );
      expect(settledWithoutRequest.rows[0].status).toBe("cancelled");
      expect(settledWithoutRequest.rows[0].outcome).toMatchObject({
        cloudApplied: false,
        note: "withdrawal_arrived_before_the_request",
      });

      const lateReserve = await asRole("central", () =>
        dbLib.withTenant(created.businessId, () =>
          syncEvents.applySyncEvent(
            created.locationId,
            { userId: created.userId, role: "owner" },
            {
              clientEventId: lateId,
              type: "automotive.vehicle.reservation.requested",
              occurredAt: new Date().toISOString(),
              payload: lateEvent.payload,
            },
            "remote",
            { siteDeviceId: null, schemaVersion: 1 },
          ),
        ),
      );
      expect(lateReserve.ok).toBe(true);
      const { rows: holdCount } = await dbLib.withTenant(
        created.businessId,
        () =>
          dbLib.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM serial_reservations WHERE business_id = $1 AND serial_id = $2 AND status = 'active'`,
            [created.businessId, car.serialId],
          ),
      );
      // The car is not held: a withdrawn request is not a hold, however late the
      // command that carried it arrives.
      expect(Number(holdCount[0].n)).toBe(0);
      expect(
        await postingCount(
          created.businessId,
          "automotive_reservation_deposit",
        ),
      ).toBe(1);
    } finally {
      await stub.close();
    }
  }, 300_000);

  it("delivers every answer of a 300-request branch, not the newest page", async () => {
    const stub = await startStubCentral();
    try {
      await useDatabase(serverDb);
      const created = await provisioning.provisionBusiness({
        businessName: "نمایشگاه خودروی سپهر",
        ownerName: "مالک",
        email: `owner-${randomUUID()}@example.com`,
        password: "correct-horse",
        subdomain: `autopage${randomUUID().slice(0, 6)}`.toLowerCase(),
        industry: "automotive",
        seedChartOfAccounts: true,
      });

      const customerId = await dbLib.withTenant(
        created.businessId,
        async () => {
          const { rows } = await dbLib.query<{ id: string }>(
            `INSERT INTO parties (business_id, name, phone, role, roles)
           VALUES ($1, 'مشتری صفحه‌بندی', '09120000000', 'customer', ARRAY['customer']::text[])
           RETURNING id`,
            [created.businessId],
          );
          return rows[0].id;
        },
      );

      const car = await dbLib.withTenant(created.businessId, async () => {
        const client = await dbLib.getPool().connect();
        try {
          await client.query("BEGIN");
          const vehicle = await automotive.createVehicle(client, {
            businessId: created.businessId,
            locationId: created.locationId,
            make: "کیا",
            model: "سراتو",
            condition: "used",
            stockNumber: "S-1",
            vin: "KNALB81ABM5000099",
            chassisNumber: "PAGE-1",
            askingPriceRial: 1_200_000_000,
            acquisition: {
              date: "2026-01-05",
              source: "dealer_purchase",
              costRial: 1_000_000_000,
              settlement: "payable",
            },
          });
          await client.query("COMMIT");
          return { serialId: vehicle.serialId as string };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      });

      // 300 settled requests, each older than the next, plus five *unanswered* ones
      // that are older than every settled row. Under the old window the five would
      // have been outside `ORDER BY requested_at DESC LIMIT 200` and never answered.
      const settledIds: string[] = [];
      const openIds: string[] = [];
      await dbLib.withTenant(created.businessId, async () => {
        for (let index = 0; index < 300; index += 1) {
          const id = randomUUID();
          settledIds.push(id);
          await dbLib.query(
            `INSERT INTO automotive_vehicle_offline_requests
               (id, business_id, location_id, request_type, serial_id, stock_number, customer_id, customer_name,
                expected_version, expected_state, status, conflict_code, requested_at, resolved_at, outcome)
             VALUES ($1,$2,$3,'reserve',$4,'S-1',$5,'مشتری صفحه‌بندی',1,'in_stock',$6,$7,
                     now() - make_interval(mins => $8), now() - make_interval(mins => $9), $10::jsonb)`,
            [
              id,
              created.businessId,
              created.locationId,
              car.serialId,
              customerId,
              index % 3 === 0 ? "conflict" : "confirmed",
              index % 3 === 0 ? "vehicle_reserved_by_other" : null,
              // Settled requests are newer than the open ones, all of them.
              100 + index,
              100 + index,
              JSON.stringify({
                status: index % 3 === 0 ? "conflict" : "confirmed",
              }),
            ],
          );
        }
        for (let index = 0; index < 5; index += 1) {
          const id = randomUUID();
          openIds.push(id);
          await dbLib.query(
            `INSERT INTO automotive_vehicle_offline_requests
               (id, business_id, location_id, request_type, serial_id, stock_number, customer_id, customer_name,
                expected_version, expected_state, status, requested_at)
             VALUES ($1,$2,$3,'reserve',$4,'S-1',$5,'مشتری صفحه‌بندی',1,'in_stock','pending',
                     now() - make_interval(mins => $6))`,
            [
              id,
              created.businessId,
              created.locationId,
              // Distinct car ids: `uq_automotive_offline_request_open` allows one
              // open request per car and operation, which is the queue's own rule.
              randomUUID(),
              customerId,
              500 + index,
            ],
          );
        }
      });

      const first = await dbLib.withTenant(created.businessId, () =>
        stock.buildAutomotiveStockProjection(
          created.businessId,
          created.locationId,
        ),
      );
      expect(first).not.toBeNull();
      if (!first) return;
      // The first page carries every unanswered request, however old, and a bounded
      // page of answers.
      for (const id of openIds) {
        expect(first.requests.map((request) => request.id)).toContain(id);
      }
      expect(first.requestsHasMore).toBe(true);

      const seen = new Map<string, number>();
      for (const request of first.requests)
        seen.set(request.id, (seen.get(request.id) ?? 0) + 1);

      let cursor = first.requestsCursor;
      let openCursor = first.openRequestsCursor;
      let pages = 1;
      for (;;) {
        const page = await dbLib.withTenant(created.businessId, () =>
          stock.buildAutomotiveStockProjection(
            created.businessId,
            created.locationId,
            {
              requestsCursor: cursor,
              openRequestsCursor: openCursor,
            },
          ),
        );
        expect(page).not.toBeNull();
        if (!page) return;
        pages += 1;
        for (const request of page.requests)
          seen.set(request.id, (seen.get(request.id) ?? 0) + 1);
        cursor = page.requestsCursor;
        openCursor = page.openRequestsCursor;
        if (!page.requestsHasMore) break;
        expect(pages).toBeLessThan(10);
      }

      // Every one of the 305 requests was delivered, and not one of them twice.
      expect(seen.size).toBe(305);
      for (const [, count] of seen) expect(count).toBe(1);
      for (const id of settledIds) expect(seen.has(id)).toBe(true);
      // …including the oldest answers, which is precisely what the window dropped.
      expect(seen.has(settledIds[0])).toBe(true);
      expect(pages).toBeGreaterThan(1);

      // A cursor is an acknowledgement. Once every stream has been drained and its
      // watermark stored, asking again with those watermarks re-serves nothing: the
      // five unanswered rows were delivered when they were queued (the site holds
      // them as `pending` itself) and their *answers* arrive on the resolved stream,
      // which is the one that keeps this from being a horizon.
      const repeat = await dbLib.withTenant(created.businessId, () =>
        stock.buildAutomotiveStockProjection(
          created.businessId,
          created.locationId,
          {
            requestsCursor: cursor,
            openRequestsCursor: openCursor,
          },
        ),
      );
      expect(repeat).not.toBeNull();
      expect(repeat!.requests).toHaveLength(0);
      expect(repeat!.requestsHasMore).toBe(false);

      // …and that emptiness is the cursor's doing, not the data's: a device with no
      // stored state (a fresh install, a re-paired branch) is served the open work
      // again from the start, idempotently.
      const freshDevice = await dbLib.withTenant(created.businessId, () =>
        stock.buildAutomotiveStockProjection(
          created.businessId,
          created.locationId,
        ),
      );
      expect(freshDevice).not.toBeNull();
      expect(
        freshDevice!.requests
          .filter((request) => request.resolvedAt === null)
          .map((request) => request.id)
          .sort(),
      ).toEqual([...openIds].sort());

      // The oldest answer is reachable too — the drain above proved it, and a device
      // that lost its state (null cursors) walks to it again rather than stopping at
      // whichever page the old window would have kept.
      let walkCursor: string | null = null;
      let walkOpen: string | null = null;
      const walked = new Set<string>();
      for (let page = 0; page < 10; page += 1) {
        const answer = await dbLib.withTenant(created.businessId, () =>
          stock.buildAutomotiveStockProjection(
            created.businessId,
            created.locationId,
            {
              requestsCursor: walkCursor,
              openRequestsCursor: walkOpen,
            },
          ),
        );
        expect(answer).not.toBeNull();
        if (!answer) return;
        for (const request of answer.requests) walked.add(request.id);
        walkCursor = answer.requestsCursor;
        walkOpen = answer.openRequestsCursor;
        if (!answer.requestsHasMore) break;
      }
      expect(walked.size).toBe(305);
      expect(walked.has(settledIds[0])).toBe(true);

      // A malformed cursor is treated as absent rather than trusted or refused.
      const garbage = await dbLib.withTenant(created.businessId, () =>
        stock.buildAutomotiveStockProjection(
          created.businessId,
          created.locationId,
          {
            requestsCursor:
              "not-a-cursor'; DROP TABLE automotive_vehicle_offline_requests; --",
            openRequestsCursor: "1",
          },
        ),
      );
      expect(garbage).not.toBeNull();
      expect(garbage!.requests.length).toBeGreaterThanOrEqual(5);
      const { rows: stillThere } = await dbLib.withTenant(
        created.businessId,
        () =>
          dbLib.query<{ n: string }>(
            // Scoped to this branch: the file's earlier tests queued their own
            // requests, and an unscoped count would be comparing against those.
            `SELECT count(*)::text AS n FROM automotive_vehicle_offline_requests
              WHERE business_id = $1 AND location_id = $2`,
            [created.businessId, created.locationId],
          ),
      );
      expect(Number(stillThere[0].n)).toBe(305);
    } finally {
      await stub.close();
    }
  }, 300_000);

  it("tells the truth about a duplicate submission, and lets the desk reach old work", async () => {
    const stub = await startStubCentral();
    try {
      await useDatabase(serverDb);
      const created = await provisioning.provisionBusiness({
        businessName: "نمایشگاه خودروی مهر",
        ownerName: "مالک",
        email: `owner-${randomUUID()}@example.com`,
        password: "correct-horse",
        subdomain: `autodup${randomUUID().slice(0, 6)}`.toLowerCase(),
        industry: "automotive",
        seedChartOfAccounts: true,
      });
      const customerId = await dbLib.withTenant(
        created.businessId,
        async () => {
          const { rows } = await dbLib.query<{ id: string }>(
            `INSERT INTO parties (business_id, name, phone, role, roles)
           VALUES ($1, 'مشتری تکراری', '09123334455', 'customer', ARRAY['customer']::text[])
           RETURNING id`,
            [created.businessId],
          );
          return rows[0].id;
        },
      );
      const car = await dbLib.withTenant(created.businessId, async () => {
        const client = await dbLib.getPool().connect();
        try {
          await client.query("BEGIN");
          const vehicle = await automotive.createVehicle(client, {
            businessId: created.businessId,
            locationId: created.locationId,
            make: "تویوتا",
            model: "کرولا",
            condition: "new",
            stockNumber: "D-1",
            vin: "WVWZZZ1JZ3W386900",
            chassisNumber: "DUP-1",
            askingPriceRial: 2_000_000_000,
            acquisition: {
              date: "2026-02-01",
              source: "dealer_purchase",
              costRial: 1_800_000_000,
              settlement: "payable",
            },
          });
          await client.query("COMMIT");
          return { serialId: vehicle.serialId as string };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      });
      const projection = await dbLib.withTenant(created.businessId, () =>
        stock.buildAutomotiveStockProjection(
          created.businessId,
          created.locationId,
        ),
      );
      expect(projection).not.toBeNull();
      if (!projection) return;

      await useDatabase(localDb);
      await seedPairedIdentity({
        businessId: created.businessId,
        locationId: created.locationId,
        name: "شعبهٔ مهر",
        userId: created.userId,
      });
      await stock.applyAutomotiveStockProjection(
        created.businessId,
        created.locationId,
        projection,
      );
      await configurePush(created.businessId, created.locationId, stub.port);

      const queue = (requestId: string) =>
        asRole("site", () =>
          stock.recordVehicleReservationRequest({
            businessId: created.businessId,
            locationId: created.locationId,
            requestId,
            serialId: car.serialId,
            stockNumber: "D-1",
            customerId,
            customerName: "مشتری تکراری",
            expiresAt: futureDate(),
            expiresAtTime: null,
            depositRial: 0,
            depositMethod: null,
            depositRefundable: true,
            depositNote: null,
            note: null,
            expectedVersion: projection.vehicles[0].sourceVersion,
            expectedState: "in_stock",
            actorId: created.userId,
            actorRole: "owner",
          }),
        );

      // (1) a second submission of the same id: one row, one event, and the status
      // the database holds - not a hardcoded «pending».
      const firstId = randomUUID();
      const first = await queue(firstId);
      expect(first).toMatchObject({
        requestId: firstId,
        status: "pending",
        duplicate: false,
        adopted: false,
      });
      const repeat = await queue(firstId);
      expect(repeat).toMatchObject({
        requestId: firstId,
        status: "pending",
        duplicate: true,
        adopted: false,
      });
      const { rows: eventCount } = await dbLib.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sync_events WHERE location_id = $1 AND client_event_id = $2`,
        [created.locationId, firstId],
      );
      expect(Number(eventCount[0].n)).toBe(1);

      // (2) a *different* id for the same car while that one is open: the database
      // keeps one open request, and the API says which row counts instead of handing
      // back an id that was never written (and never queued an event).
      const secondId = randomUUID();
      const adopted = await queue(secondId);
      expect(adopted).toMatchObject({
        requestId: firstId,
        status: "pending",
        duplicate: true,
        adopted: true,
      });
      const { rows: secondEvent } = await dbLib.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sync_events WHERE location_id = $1 AND client_event_id = $2`,
        [created.locationId, secondId],
      );
      expect(Number(secondEvent[0].n)).toBe(0);
      const { rows: openRows } = await dbLib.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM automotive_vehicle_offline_requests
          WHERE business_id = $1 AND location_id = $2 AND status = 'pending'`,
        [created.businessId, created.locationId],
      );
      expect(Number(openRows[0].n)).toBe(1);

      // (3) once the cloud has answered, a re-submission reports *that* status: the
      // desk cannot be told «در انتظار تأیید» about a request that is already decided.
      await serverSync.runServerPush(created.businessId);
      expect(stub.events.map((event) => event.clientEventId)).toEqual([
        firstId,
      ]);
      await useDatabase(serverDb);
      const applied = await asRole("central", () =>
        dbLib.withTenant(created.businessId, () =>
          syncEvents.applySyncEvent(
            created.locationId,
            { userId: created.userId, role: "owner" },
            {
              clientEventId: firstId,
              type: "automotive.vehicle.reservation.requested",
              occurredAt: new Date().toISOString(),
              payload: stub.events[0].payload,
            },
            "remote",
            { siteDeviceId: null, schemaVersion: 1 },
          ),
        ),
      );
      expect(applied.ok).toBe(true);
      const answered = await dbLib.withTenant(created.businessId, () =>
        stock.buildAutomotiveStockProjection(
          created.businessId,
          created.locationId,
        ),
      );
      await useDatabase(localDb);
      expect(answered).not.toBeNull();
      if (!answered) return;
      await stock.applyAutomotiveStockProjection(
        created.businessId,
        created.locationId,
        answered,
      );
      const decidedAgain = await queue(firstId);
      expect(decidedAgain).toMatchObject({
        requestId: firstId,
        status: "confirmed",
        duplicate: true,
      });

      // (4) the board's list pages through its own history, and a filter for the
      // oldest state reaches rows the first page never carried.
      await dbLib.withTenant(created.businessId, async () => {
        for (let index = 0; index < 130; index += 1) {
          await dbLib.query(
            `INSERT INTO automotive_vehicle_offline_requests
               (id, business_id, location_id, request_type, serial_id, stock_number, customer_id, customer_name,
                expected_version, expected_state, status, requested_at, resolved_at)
             VALUES ($1,$2,$3,'reserve',$4,'D-1',$5,'مشتری تکراری',1,'in_stock','confirmed',
                     now() - make_interval(mins => $6), now() - make_interval(mins => $6))`,
            [
              randomUUID(),
              created.businessId,
              created.locationId,
              car.serialId,
              customerId,
              index,
            ],
          );
        }
        // One *pending* request older than every settled row: reachable, and counted.
        await dbLib.query(
          `INSERT INTO automotive_vehicle_offline_requests
             (id, business_id, location_id, request_type, serial_id, stock_number, customer_id, customer_name,
              expected_version, expected_state, status, requested_at)
           VALUES ($1,$2,$3,'reserve',$4,'D-1',$5,'مشتری تکراری',1,'in_stock','pending',
                   now() - interval '10 days')`,
          [
            randomUUID(),
            created.businessId,
            created.locationId,
            // A distinct car id: one open request per car and operation is the
            // queue's own rule, and this row is older than everything else.
            randomUUID(),
            customerId,
          ],
        );
      });

      const firstPage = await stock.listVehicleOfflineRequests(
        created.businessId,
        created.locationId,
      );
      // 130 settled rows inserted above, the one pending row, and the request the
      // cloud confirmed earlier. The duplicate never became a row of its own.
      expect(firstPage.total).toBe(132);
      expect(firstPage.openTotal).toBe(1);
      // Open work is never pushed off the first page, whatever the history.
      expect(
        firstPage.rows.filter((row) => row.status === "pending"),
      ).toHaveLength(1);
      expect(
        firstPage.rows.filter((row) => row.status === "pending")[0]
          .requested_at,
      ).toBeInstanceOf(Date);
      expect(firstPage.nextCursor).toBeTruthy();

      const seen = new Set<string>(
        firstPage.rows.map((row) => row.id as string),
      );
      let cursor = firstPage.nextCursor;
      let pages = 1;
      for (;;) {
        const page = await stock.listVehicleOfflineRequests(
          created.businessId,
          created.locationId,
          undefined,
          {
            cursor,
            limit: 50,
          },
        );
        pages += 1;
        for (const row of page.rows) seen.add(row.id as string);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        expect(pages).toBeLessThan(20);
      }
      expect(pages).toBeGreaterThan(1);
      // Every row the counter promised is a row the list can actually produce.
      expect(seen.size).toBe(firstPage.total);
      const pendingOnly = await stock.listVehicleOfflineRequests(
        created.businessId,
        created.locationId,
        "pending",
      );
      expect(pendingOnly.total).toBe(1);
      expect(pendingOnly.rows.map((row) => row.status)).toEqual(["pending"]);
    } finally {
      await stub.close();
    }
  }, 300_000);

  it("re-runs the migration that added the retraction shape without changing anything", async () => {
    // A forward-only migration must be safe to run twice: the runner is what every
    // upgrade path calls, and a desktop that restarts mid-upgrade runs it again.
    await runMigrations({ databaseUrl: urlFor(localDb), quiet: true });
    await useDatabase(localDb);
    const { rows } = await dbLib.query<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'sync_events' AND column_name IN ('dispatch_attempted_at', 'retracted_at')
        ORDER BY column_name`,
    );
    expect(rows.map((row) => row.column_name)).toEqual([
      "dispatch_attempted_at",
      "retracted_at",
    ]);
    expect(rows.every((row) => row.is_nullable === "YES")).toBe(true);
  }, 120_000);
});
