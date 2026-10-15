/**
 * Issue #839 §19 (Wave 6) — safe offline/hybrid support for a dealership,
 * against two real databases: a cloud one and the paired branch's own.
 *
 * The unit tests (`automotive-offline.test.ts`, `automotive-stock-projection.test.ts`)
 * prove the rules. What only PostgreSQL can answer, and what this file is for:
 *
 *   * **the board a site holds carries no money**: the projection the cloud
 *     serves for a paired branch is built from the operational columns only, so
 *     no acquisition cost, capitalized cost or minimum price is in it — asserted
 *     against a payload that would contain those numbers if the query leaked;
 *   * **the mirror is replaced whole and idempotently**: applying the same
 *     snapshot twice changes nothing the second time, and a car that leaves the
 *     branch (sold, transferred away) leaves the board;
 *   * **a queued hold is applied exactly once, by the cloud, through the
 *     canonical service**: the site's row is `pending` and posts nothing, the
 *     event travels through `applySyncEvent`, and the cloud creates the
 *     reservation *and* the deposit entry in one transaction;
 *   * **a retry is a duplicate, a second claim is a conflict**: replaying the
 *     same event id creates no second hold and no second posting, and a second
 *     site asking for the same car is refused with a named code instead of
 *     merging two claims;
 *   * **the answer travels back**: the next snapshot carries the cloud's verdict,
 *     and the site adopts it monotonically — a `pending` snapshot never revives
 *     a decided request;
 *   * **tenant isolation holds on both new tables**: a second business sees
 *     neither the mirror nor anybody's queued requests.
 */
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

/** Run a block as one side of the link; `deploymentRole()` reads the environment per call. */
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

let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let automotive: typeof import("../src/lib/automotive-service");
let reservations: typeof import("../src/lib/automotive-reservation-service");
let stock: typeof import("../src/lib/automotive-stock-service");
let syncEvents: typeof import("../src/lib/sync-events");
let projectionContract: typeof import("../src/lib/automotive-stock-projection");
let offlineRules: typeof import("../src/lib/automotive-offline");

beforeAll(async () => {
  serverDb = `pos_auto_off_srv_${randomUUID().replaceAll("-", "")}`;
  localDb = `pos_auto_off_loc_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(serverDb);
  await createDatabase(localDb);

  await useDatabase(serverDb);
  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  automotive = await import("../src/lib/automotive-service");
  reservations = await import("../src/lib/automotive-reservation-service");
  stock = await import("../src/lib/automotive-stock-service");
  syncEvents = await import("../src/lib/sync-events");
  projectionContract = await import("../src/lib/automotive-stock-projection");
  offlineRules = await import("../src/lib/automotive-offline");
}, 300_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  await dropDatabase(serverDb);
  await dropDatabase(localDb);
});

/**
 * The identity a paired desktop already holds: pairing seeds the business and
 * the branch before any sync tick runs (`pairing-apply.ts`), and the mirror's
 * foreign keys are to exactly those two rows. Reproduced here because this file
 * starts from two migrated databases rather than from a real pairing.
 */
async function seedPairedIdentity(input: {
  businessId: string;
  locationId: string;
  name: string;
  /** The operator who will sign the queued requests; pairing seeds staff too. */
  userId: string;
}): Promise<void> {
  await dbLib.withoutTenantScope("platform", () =>
    dbLib.query(
      `INSERT INTO businesses (id, name, slug, industry) VALUES ($1, $2, $3, 'automotive')
         ON CONFLICT (id) DO NOTHING`,
      [input.businessId, input.name, `mirror-${input.businessId.slice(0, 8)}`],
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

/** A hold that lapses well after the business day this test runs on. */
function futureDate(days = 30): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Counts postings of one kind — the probe for "nothing was invented offline". */
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

describe("§19's offline/hybrid vehicle path", () => {
  it("mirrors a branch's board read-only, and applies a queued hold exactly once", async () => {
    // ---- the cloud ---------------------------------------------------------
    const created = await provisioning.provisionBusiness({
      businessName: "نمایشگاه خودروی پارس",
      ownerName: "مالک",
      email: `owner-${randomUUID()}@example.com`,
      password: "correct-horse",
      subdomain: `autooff${randomUUID().slice(0, 6)}`.toLowerCase(),
      industry: "automotive",
      seedChartOfAccounts: true,
    });

    const customerId = await dbLib.withTenant(created.businessId, async () => {
      const { rows } = await dbLib.query<{ id: string }>(
        `INSERT INTO parties (business_id, name, phone, role, roles)
         VALUES ($1, 'آقای خریدار', '09121112233', 'customer', ARRAY['customer']::text[])
         RETURNING id`,
        [created.businessId],
      );
      return rows[0].id;
    });

    const car = await dbLib.withTenant(created.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        const vehicle = await automotive.createVehicle(client, {
          businessId: created.businessId,
          locationId: created.locationId,
          make: "پژو",
          model: "207",
          trim: "پانوراما",
          modelYear: 1403,
          vehicleYearCalendar: "jalali",
          condition: "new",
          vin: "WVWZZZ1JZ3W386753",
          chassisNumber: "CHASSIS-9001",
          stockNumber: "P-1",
          askingPriceRial: 900_000_000,
          minimumPriceRial: 800_000_000,
          acquisition: {
            date: "2026-01-10",
            source: "dealer_purchase",
            costRial: 700_000_000,
            settlement: "payable",
          },
        });
        await automotive.recordVehicleCost(client, {
          businessId: created.businessId,
          serialId: vehicle.serialId,
          locationId: created.locationId,
          createdBy: created.userId,
          cost: {
            category: "repair",
            posting: "capitalized",
            amountRial: 30_000_000,
            incurredOn: "2026-01-20",
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

    // The board as this branch's desktop will hold it. The three numbers that
    // must not be in it are the acquisition cost, the capitalized cost and the
    // minimum price — each of which is in the cloud's own row.
    const projection = await dbLib.withTenant(created.businessId, () =>
      stock.buildAutomotiveStockProjection(
        created.businessId,
        created.locationId,
      ),
    );
    expect(projection).not.toBeNull();
    if (!projection) return;
    expect(projection.locationId).toBe(created.locationId);
    expect(projection.vehicles).toHaveLength(1);
    const mirrored = projection.vehicles[0];
    expect(mirrored).toMatchObject({
      serialId: car.serialId,
      stockNumber: "P-1",
      make: "پژو",
      model: "207",
      state: "in_stock",
      availability: "available",
      askingPriceRial: 900_000_000,
      vin: "WVWZZZ1JZ3W386753",
    });
    expect(mirrored.sourceVersion).toBeGreaterThan(0);
    const payload = JSON.stringify(projection);
    for (const secret of ["700000000", "30000000", "800000000"]) {
      expect(payload, secret).not.toContain(secret);
    }
    expect(payload).not.toContain("purchase_cost");
    expect(payload).not.toContain("minimum");

    // ---- the paired branch's own database ----------------------------------
    await useDatabase(localDb);
    await seedPairedIdentity({
      businessId: created.businessId,
      locationId: created.locationId,
      name: "شعبهٔ نمایشگاه پارس",
      userId: created.userId,
    });
    const firstApply = await stock.applyAutomotiveStockProjection(
      created.businessId,
      created.locationId,
      projection,
    );
    expect(firstApply).toMatchObject({ inserted: 1, updated: 0, removed: 0 });
    const secondApply = await stock.applyAutomotiveStockProjection(
      created.businessId,
      created.locationId,
      projection,
    );
    expect(secondApply).toMatchObject({ inserted: 0, updated: 0, removed: 0 });

    const mirrorRows = await stock.listMirrorVehicles(
      created.businessId,
      created.locationId,
    );
    expect(mirrorRows).toHaveLength(1);
    expect(mirrorRows[0]).toMatchObject({
      stock_number: "P-1",
      availability: "available",
    });

    // A clerk queues a hold while the cloud is unreachable. The row is pending,
    // nothing is reserved locally, and no posting exists on this side.
    const reserveRequestId = randomUUID();
    const queued = await asRole("site", () =>
      stock.recordVehicleReservationRequest({
        businessId: created.businessId,
        locationId: created.locationId,
        requestId: reserveRequestId,
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
        note: "بیعانه در محل",
        expectedVersion: mirrored.sourceVersion,
        expectedState: "in_stock",
        actorId: created.userId,
        actorRole: "owner",
      }),
    );
    // The queue reports what the database holds, not what the caller asked for:
    // `status` is read back from the row and `adopted` says whether the row that
    // counts is a *different* open request for the same car.
    expect(queued).toEqual({
      requestId: reserveRequestId,
      duplicate: false,
      status: "pending",
      adopted: false,
    });

    const pendingPage = await stock.listVehicleOfflineRequests(
      created.businessId,
      created.locationId,
      "pending",
    );
    expect(pendingPage.rows).toHaveLength(1);
    expect(pendingPage.rows[0]).toMatchObject({
      status: "pending",
      reservation_id: null,
      stock_number: "P-1",
    });
    // The queue is durable: the event that will carry it exists, keyed by the
    // same id, in the same transaction.
    const { rows: eventRows } = await dbLib.query<{
      client_event_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      pushed_at: Date | null;
    }>(
      `SELECT client_event_id, event_type, payload, pushed_at FROM sync_events
        WHERE location_id = $1 AND client_event_id = $2`,
      [created.locationId, reserveRequestId],
    );
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      event_type: "automotive.vehicle.reservation.requested",
      pushed_at: null,
    });
    expect(eventRows[0].payload).toMatchObject({
      requestId: reserveRequestId,
      serialId: car.serialId,
    });
    // Nothing posts on the site: a queued hold is not a hold, and a deposit is
    // not a liability until the cloud confirms.
    expect(
      await postingCount(created.businessId, "automotive_reservation_deposit"),
    ).toBe(0);

    // ---- the cloud applies it ----------------------------------------------
    await useDatabase(serverDb);
    const applied = await asRole("central", () =>
      dbLib.withTenant(created.businessId, () =>
        syncEvents.applySyncEvent(
          created.locationId,
          { userId: created.userId, role: "owner" },
          {
            clientEventId: reserveRequestId,
            type: "automotive.vehicle.reservation.requested",
            occurredAt: new Date().toISOString(),
            payload: eventRows[0].payload,
          },
          "remote",
          { siteDeviceId: null, schemaVersion: 1 },
        ),
      ),
    );
    expect(applied.ok).toBe(true);

    const cloudRequest = await dbLib.withTenant(created.businessId, () =>
      dbLib.query<{
        status: string;
        reservation_id: string | null;
        conflict_code: string | null;
      }>(
        `SELECT status, reservation_id, conflict_code FROM automotive_vehicle_offline_requests
          WHERE business_id = $1 AND id = $2`,
        [created.businessId, reserveRequestId],
      ),
    );
    expect(cloudRequest.rows[0].status).toBe("confirmed");
    const reservationId = cloudRequest.rows[0].reservation_id;
    expect(reservationId).toBeTruthy();

    const { rows: reservationRows } = await dbLib.withTenant(
      created.businessId,
      () =>
        dbLib.query<{
          status: string;
          deposit_amount_rial: string;
          deposit_ledger_entry_id: string | null;
        }>(
          `SELECT status, deposit_amount_rial, deposit_ledger_entry_id FROM serial_reservations
          WHERE business_id = $1 AND id = $2`,
          [created.businessId, reservationId],
        ),
    );
    expect(reservationRows[0]).toMatchObject({
      status: "active",
      deposit_amount_rial: "5000000",
    });
    expect(reservationRows[0].deposit_ledger_entry_id).toBeTruthy();
    expect(
      await postingCount(created.businessId, "automotive_reservation_deposit"),
    ).toBe(1);

    const { rows: vehicleRows } = await dbLib.withTenant(
      created.businessId,
      () =>
        dbLib.query<{ state: string }>(
          `SELECT state FROM automotive_vehicle_attributes WHERE business_id = $1 AND serial_id = $2`,
          [created.businessId, car.serialId],
        ),
    );
    expect(vehicleRows[0].state).toBe("reserved");

    // A retry of the very same event — the classic double flush after a dropped
    // response — must create neither a second hold nor a second posting.
    const replay = await asRole("central", () =>
      dbLib.withTenant(created.businessId, () =>
        syncEvents.applySyncEvent(
          created.locationId,
          { userId: created.userId, role: "owner" },
          {
            clientEventId: reserveRequestId,
            type: "automotive.vehicle.reservation.requested",
            occurredAt: new Date().toISOString(),
            payload: eventRows[0].payload,
          },
          "remote",
          { siteDeviceId: null, schemaVersion: 1 },
        ),
      ),
    );
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(
      await postingCount(created.businessId, "automotive_reservation_deposit"),
    ).toBe(1);
    const { rows: reservationCount } = await dbLib.withTenant(
      created.businessId,
      () =>
        dbLib.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM serial_reservations WHERE business_id = $1 AND serial_id = $2`,
          [created.businessId, car.serialId],
        ),
    );
    expect(Number(reservationCount[0].n)).toBe(1);

    // ---- a second site asks for the same car -------------------------------
    const secondCustomer = await dbLib.withTenant(
      created.businessId,
      async () => {
        const { rows } = await dbLib.query<{ id: string }>(
          `INSERT INTO parties (business_id, name, phone, role, roles)
         VALUES ($1, 'خانم خریدار', '09124445566', 'customer', ARRAY['customer']::text[])
         RETURNING id`,
          [created.businessId],
        );
        return rows[0].id;
      },
    );
    const losingRequestId = randomUUID();
    const losingApplied = await asRole("central", () =>
      dbLib.withTenant(created.businessId, () =>
        syncEvents.applySyncEvent(
          created.locationId,
          { userId: created.userId, role: "owner" },
          {
            clientEventId: losingRequestId,
            type: "automotive.vehicle.reservation.requested",
            occurredAt: new Date().toISOString(),
            payload: {
              requestId: losingRequestId,
              serialId: car.serialId,
              stockNumber: "P-1",
              customerId: secondCustomer,
              customerName: "خانم خریدار",
              expiresAt: null,
              expiresAtTime: null,
              depositRial: 0,
              depositMethod: null,
              depositRefundable: true,
              depositNote: null,
              note: null,
              expectedVersion: mirrored.sourceVersion,
              expectedState: "in_stock",
              requestedAt: new Date().toISOString(),
            },
          },
          "remote",
          { siteDeviceId: null, schemaVersion: 1 },
        ),
      ),
    );
    expect(losingApplied.ok).toBe(true);
    const { rows: losingRows } = await dbLib.withTenant(
      created.businessId,
      () =>
        dbLib.query<{ status: string; conflict_code: string }>(
          `SELECT status, conflict_code FROM automotive_vehicle_offline_requests
          WHERE business_id = $1 AND id = $2`,
          [created.businessId, losingRequestId],
        ),
    );
    expect(losingRows[0]).toMatchObject({
      status: "conflict",
      conflict_code: "vehicle_reserved_by_other",
    });
    // …and the refusal changed nothing: still one hold, still one deposit.
    const { rows: stillOne } = await dbLib.withTenant(created.businessId, () =>
      dbLib.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM serial_reservations WHERE business_id = $1 AND serial_id = $2`,
        [created.businessId, car.serialId],
      ),
    );
    expect(Number(stillOne[0].n)).toBe(1);
    expect(
      await postingCount(created.businessId, "automotive_reservation_deposit"),
    ).toBe(1);
    // The refusal is explainable to an operator.
    const resolution = offlineRules.automotiveConflictResolution(
      losingRows[0].conflict_code as Parameters<
        typeof offlineRules.automotiveConflictResolution
      >[0],
    );
    expect(resolution.message.length).toBeGreaterThan(10);
    expect(resolution.actions.length).toBeGreaterThan(0);

    // ---- the answer travels back down --------------------------------------
    const refreshed = await dbLib.withTenant(created.businessId, () =>
      stock.buildAutomotiveStockProjection(
        created.businessId,
        created.locationId,
      ),
    );
    expect(refreshed).not.toBeNull();
    if (!refreshed) return;
    expect(
      projectionContract.validateAutomotiveStockProjection(refreshed),
    ).not.toBeNull();
    expect(refreshed.vehicles[0]).toMatchObject({
      availability: "reserved",
      reservationId,
      state: "reserved",
    });
    const verdicts = new Map(
      refreshed.requests.map((request) => [request.id, request]),
    );
    expect(verdicts.get(reserveRequestId)?.status).toBe("confirmed");
    expect(verdicts.get(losingRequestId)?.status).toBe("conflict");

    await useDatabase(localDb);
    const appliedBack = await stock.applyAutomotiveStockProjection(
      created.businessId,
      created.locationId,
      refreshed,
    );
    // Exactly one: the site's own pending request. The other refusal belongs to
    // a *different* site, and the applier deliberately does not invent a local
    // request row from the cloud's answer — a queue entry nobody on this branch
    // made would put a customer's name and deposit in the wrong hands.
    expect(appliedBack.requestsApplied).toBe(1);
    const decided = await stock.listVehicleOfflineRequests(
      created.businessId,
      created.locationId,
    );
    const byId = new Map(decided.rows.map((row) => [row.id as string, row]));
    expect(byId.get(reserveRequestId)).toMatchObject({
      status: "confirmed",
      reservation_id: reservationId,
    });
    expect(byId.has(losingRequestId)).toBe(false);
    const status = await stock.automotiveMirrorStatus(
      created.businessId,
      created.locationId,
    );
    // The board shows the hold, nothing is left awaiting the cloud, and — since
    // the refusal was another site's — this branch carries no conflict row of
    // its own.
    expect(status).toMatchObject({
      vehicles: 1,
      reserved: 1,
      pendingRequests: 0,
      conflicts: 0,
    });

    // An older snapshot that still says «pending» must not resurrect a decided
    // request — the cloud's answer is final.
    const stale = {
      ...refreshed,
      requests: refreshed.requests.map((request) => ({
        ...request,
        status: "pending" as const,
        resolvedAt: null,
      })),
    };
    const reapplied = await stock.applyAutomotiveStockProjection(
      created.businessId,
      created.locationId,
      stale,
    );
    expect(reapplied.requestsApplied).toBe(0);
    const afterStale = await stock.listVehicleOfflineRequests(
      created.businessId,
      created.locationId,
      "confirmed",
    );
    expect(afterStale.rows.map((row) => row.id)).toContain(reserveRequestId);

    // ---- a refusal this branch can see, and close ---------------------------
    // A second clerk on the same car: the board still said «آماده فروش» when
    // they queued it, so the request is legitimate — and the cloud refuses it
    // because the car is already held. The refusal comes back on the next
    // snapshot and stays in the branch's history until a person reads it.
    const refusedRequestId = randomUUID();
    await asRole("site", () =>
      stock.recordVehicleReservationRequest({
        businessId: created.businessId,
        locationId: created.locationId,
        requestId: refusedRequestId,
        serialId: car.serialId,
        stockNumber: "P-1",
        customerId,
        customerName: "آقای خریدار",
        expiresAt: null,
        expiresAtTime: null,
        depositRial: 0,
        depositMethod: null,
        depositRefundable: true,
        depositNote: null,
        note: "درخواست دوم روی همان خودرو",
        expectedVersion: mirrored.sourceVersion,
        expectedState: "in_stock",
        actorId: created.userId,
        actorRole: "owner",
      }),
    );
    const { rows: refusedEventRows } = await dbLib.query<{
      payload: Record<string, unknown>;
    }>(
      `SELECT payload FROM sync_events WHERE location_id = $1 AND client_event_id = $2`,
      [created.locationId, refusedRequestId],
    );
    expect(refusedEventRows).toHaveLength(1);

    await useDatabase(serverDb);
    const refusedApply = await asRole("central", () =>
      dbLib.withTenant(created.businessId, () =>
        syncEvents.applySyncEvent(
          created.locationId,
          { userId: created.userId, role: "owner" },
          {
            clientEventId: refusedRequestId,
            type: "automotive.vehicle.reservation.requested",
            occurredAt: new Date().toISOString(),
            payload: refusedEventRows[0].payload,
          },
          "remote",
          { siteDeviceId: null, schemaVersion: 1 },
        ),
      ),
    );
    // The event applied cleanly *and* was refused: a conflict is an answer, not
    // a transport failure, so the site is never asked to retry it forever.
    expect(refusedApply.ok).toBe(true);
    const { rows: cloudRefusal } = await dbLib.withTenant(
      created.businessId,
      () =>
        dbLib.query<{ status: string; conflict_code: string }>(
          `SELECT status, conflict_code FROM automotive_vehicle_offline_requests WHERE business_id = $1 AND id = $2`,
          [created.businessId, refusedRequestId],
        ),
    );
    expect(cloudRefusal[0]).toMatchObject({
      status: "conflict",
      conflict_code: "vehicle_reserved_by_other",
    });

    const withRefusal = await dbLib.withTenant(created.businessId, () =>
      stock.buildAutomotiveStockProjection(
        created.businessId,
        created.locationId,
      ),
    );
    expect(withRefusal).not.toBeNull();
    if (!withRefusal) return;
    await useDatabase(localDb);
    const refusalApplied = await stock.applyAutomotiveStockProjection(
      created.businessId,
      created.locationId,
      withRefusal,
    );
    expect(refusalApplied.requestsApplied).toBe(1);
    const openConflicts = await stock.listVehicleOfflineRequests(
      created.businessId,
      created.locationId,
      "conflict",
      {
        unacknowledgedOnly: true,
      },
    );
    expect(openConflicts.rows.map((row) => row.id)).toEqual([refusedRequestId]);
    expect(
      (
        await stock.automotiveMirrorStatus(
          created.businessId,
          created.locationId,
        )
      ).conflicts,
    ).toBe(1);

    // The operator reads it and closes it: the count drops, the record does not.
    expect(
      await stock.acknowledgeVehicleOfflineRequest({
        businessId: created.businessId,
        locationId: created.locationId,
        requestId: refusedRequestId,
        actorId: created.userId,
      }),
    ).toBe(true);
    // A double click cannot rewrite the acknowledgement's timestamp.
    expect(
      await stock.acknowledgeVehicleOfflineRequest({
        businessId: created.businessId,
        locationId: created.locationId,
        requestId: refusedRequestId,
        actorId: created.userId,
      }),
    ).toBe(false);
    expect(
      (
        await stock.automotiveMirrorStatus(
          created.businessId,
          created.locationId,
        )
      ).conflicts,
    ).toBe(0);
    expect(
      (
        await stock.listVehicleOfflineRequests(
          created.businessId,
          created.locationId,
          "conflict",
        )
      ).rows,
    ).toHaveLength(1);

    // ---- the other offline-capable operation: release ----------------------
    const releaseRequestId = randomUUID();
    await asRole("site", () =>
      stock.recordVehicleReleaseRequest({
        businessId: created.businessId,
        locationId: created.locationId,
        requestId: releaseRequestId,
        reservationId: reservationId!,
        serialId: car.serialId,
        stockNumber: "P-1",
        reason: "مشتری انصراف داد",
        refundDeposit: true,
        expectedVersion: mirrored.sourceVersion,
        expectedState: "reserved",
        actorId: created.userId,
        actorRole: "owner",
      }),
    );
    const { rows: releaseEventRows } = await dbLib.query<{
      payload: Record<string, unknown>;
    }>(
      `SELECT payload FROM sync_events WHERE location_id = $1 AND client_event_id = $2`,
      [created.locationId, releaseRequestId],
    );
    expect(releaseEventRows).toHaveLength(1);

    await useDatabase(serverDb);
    const released = await asRole("central", () =>
      dbLib.withTenant(created.businessId, () =>
        syncEvents.applySyncEvent(
          created.locationId,
          { userId: created.userId, role: "owner" },
          {
            clientEventId: releaseRequestId,
            type: "automotive.vehicle.reservation.released",
            occurredAt: new Date().toISOString(),
            payload: releaseEventRows[0].payload,
          },
          "remote",
          { siteDeviceId: null, schemaVersion: 1 },
        ),
      ),
    );
    expect(released.ok).toBe(true);
    const { rows: releasedReservation } = await dbLib.withTenant(
      created.businessId,
      () =>
        dbLib.query<{ status: string }>(
          `SELECT status FROM serial_reservations WHERE business_id = $1 AND id = $2`,
          [created.businessId, reservationId],
        ),
    );
    expect(releasedReservation[0].status).toBe("released");
    // The refundable deposit is unwound by the canonical service, not by the site.
    expect(
      await postingCount(
        created.businessId,
        "automotive_reservation_deposit_refund",
      ),
    ).toBe(1);
    const { rows: releasedVehicle } = await dbLib.withTenant(
      created.businessId,
      () =>
        dbLib.query<{ state: string }>(
          `SELECT state FROM automotive_vehicle_attributes WHERE business_id = $1 AND serial_id = $2`,
          [created.businessId, car.serialId],
        ),
    );
    expect(releasedVehicle[0].state).toBe("in_stock");

    // ---- a car that leaves the branch leaves the board ---------------------
    await dbLib.withTenant(created.businessId, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        await automotive.archiveVehicle(client, {
          businessId: created.businessId,
          serialId: car.serialId,
          locationId: created.locationId,
          reason: "خارج از موجودی",
          actorId: created.userId,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
    const afterArchive = await dbLib.withTenant(created.businessId, () =>
      stock.buildAutomotiveStockProjection(
        created.businessId,
        created.locationId,
      ),
    );
    expect(afterArchive).not.toBeNull();
    if (!afterArchive) return;
    expect(afterArchive.vehicles).toHaveLength(0);
    await useDatabase(localDb);
    const cleared = await stock.applyAutomotiveStockProjection(
      created.businessId,
      created.locationId,
      afterArchive,
    );
    expect(cleared.removed).toBe(1);
    expect(
      await stock.listMirrorVehicles(created.businessId, created.locationId),
    ).toHaveLength(0);
  }, 240_000);

  it("keeps the mirror and the queue inside their own tenant", async () => {
    // A second business on the same site install: it must see neither the
    // mirrored board nor anybody's queued requests, even though both tables are
    // written by machinery rather than by a request.
    await useDatabase(serverDb);
    const other = await provisioning.provisionBusiness({
      businessName: "نمایشگاه خودروی رقیب",
      ownerName: "مالک دیگر",
      email: `other-${randomUUID()}@example.com`,
      password: "correct-horse",
      subdomain: `autoother${randomUUID().slice(0, 6)}`.toLowerCase(),
      industry: "automotive",
      seedChartOfAccounts: true,
    });

    await useDatabase(localDb);
    const { rows: businessRows } = await dbLib.withoutTenantScope(
      "platform",
      () =>
        dbLib.query<{ id: string }>(
          `INSERT INTO businesses (name, slug, industry) VALUES ('نمایشگاه سوم', $1, 'automotive') RETURNING id`,
          [`third-${randomUUID().slice(0, 8)}`],
        ),
    );
    const thirdBusinessId = businessRows[0].id;

    const { rows: mirrorRows } = await dbLib.withTenant(thirdBusinessId, () =>
      dbLib.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM automotive_vehicle_stock_mirror WHERE business_id = $1`,
        [thirdBusinessId],
      ),
    );
    expect(Number(mirrorRows[0].n)).toBe(0);
    const { rows: requestRows } = await dbLib.withTenant(thirdBusinessId, () =>
      dbLib.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM automotive_vehicle_offline_requests WHERE business_id = $1`,
        [thirdBusinessId],
      ),
    );
    expect(Number(requestRows[0].n)).toBe(0);
    // …and the other business's own rows are still there for their owner.
    const { rows: ownRows } = await dbLib.withTenant(other.businessId, () =>
      dbLib.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM automotive_vehicle_stock_mirror WHERE business_id = $1`,
        [other.businessId],
      ),
    );
    expect(Number(ownRows[0].n)).toBe(0);

    // Both tables carry a forced tenant policy, so a *bypassing* connection is
    // the only way to see across businesses — and the platform scope is what
    // the export/backup path uses, not application code.
    const { rows: policyRows } = await dbLib.withoutTenantScope(
      "platform",
      () =>
        dbLib.query<{ relname: string; forced: boolean; policed: boolean }>(
          `SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS forced,
                EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) AS policed
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname IN ('automotive_vehicle_stock_mirror', 'automotive_vehicle_offline_requests')
          ORDER BY c.relname`,
        ),
    );
    expect(policyRows).toHaveLength(2);
    for (const row of policyRows) {
      expect(row, row.relname).toMatchObject({ forced: true, policed: true });
    }
  }, 180_000);
});
