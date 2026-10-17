/**
 * Issue #988 — the durable evidence behind a blocked Hybrid install, against a
 * real PostgreSQL.
 *
 * The reported failure was not the gate: `runServerSyncTick()` has always
 * refused to run master-data sync, push or pull while the IAM control plane has
 * not converged, and that stays. The failure was that nothing recorded it. A
 * real install ran like that for nine days — 1 092 gated ticks, one
 * `console.error` line apiece, and every health surface reading healthy.
 *
 * So this suite is about the record, not the gate:
 *  - a gated tick writes one row per `(business_id, site_device_id)` and counts
 *    itself, while `pending_outbox` says how much the till has queued behind it;
 *  - consecutive ticks extend the same episode instead of opening a new one,
 *    and `first_blocked_at` — the "blocked since" an operator reads — does not
 *    move;
 *  - the alert fires once per episode, not once per tick;
 *  - a converged install (and one that has simply stopped talking to a cloud)
 *    closes the episode, and a block that comes back can alert again;
 *  - RLS isolates it per business, like every other tenant table.
 *
 * The unit tests beside the pure module cover the counting rules; what needs a
 * database is that the SQL implements them, that the sync tick calls them, and
 * that the fleet read (`listSiteDevices`) surfaces the result per device.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let blockLib: typeof import("../src/lib/iam/operational-sync-block");
let healthLib: typeof import("../src/lib/iam/operational-sync-health");
let syncLib: typeof import("../src/lib/server-sync");
let deviceLib: typeof import("../src/lib/site-device-service");
let settingsLib: typeof import("../src/lib/settings");

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

interface Tenant {
  businessId: string;
  locationId: string;
  deviceId: string;
}

async function createTenant(name: string): Promise<Tenant> {
  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, `${name}-${randomUUID().slice(0, 8)}`],
  );
  const businessId = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id`,
    [businessId, "مرکزی"],
  );
  const locationId = location.rows[0].id;
  await db.query(
    `UPDATE businesses SET default_location_id = $2 WHERE id = $1`,
    [businessId, locationId],
  ).catch(() => undefined);
  const device = await db.query<{ id: string }>(
    `INSERT INTO site_devices (business_id, location_id, display_name, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [businessId, locationId, `${name} صندوق`],
  );
  return { businessId, locationId, deviceId: device.rows[0].id };
}

/** One local sync event waiting to be pushed, as the till would have left it. */
async function queueLocalEvent(tenant: Tenant): Promise<void> {
  await db.query(
    `INSERT INTO sync_events
       (location_id, scope, origin, event_type, client_event_id, payload, occurred_at, applied_at)
     VALUES ($1, 'location', 'local', 'order.updated', $2::uuid, $3::jsonb, now(), now())`,
    [tenant.locationId, randomUUID(), JSON.stringify({ orderId: randomUUID() })],
  );
}

async function readRow(tenant: Tenant): Promise<{
  status: string;
  consecutive_blocked_ticks: number;
  total_blocked_ticks: number;
  episodes_blocked: number;
  first_blocked_at: string | null;
  last_error: string | null;
  last_code: string | null;
  pending_outbox: number;
  alerted_at: string | null;
} | null> {
  const { rows } = await dbLib.withTenant(tenant.businessId, () =>
    dbLib.query<any>(
      `SELECT status,consecutive_blocked_ticks,total_blocked_ticks,episodes_blocked,
              first_blocked_at::text,last_error,last_code,pending_outbox,alerted_at::text
         FROM iam_operational_sync_block_state
        WHERE business_id = $1 AND site_device_id = $2`,
      [tenant.businessId, tenant.deviceId],
    ),
  );
  return rows[0] ?? null;
}

async function notificationRows(tenant: Tenant): Promise<{ event_key: string; dedupe_key: string }[]> {
  const { rows } = await dbLib.withTenant(tenant.businessId, () =>
    dbLib.query<{ event_key: string; dedupe_key: string }>(
      `SELECT event_key, dedupe_key FROM notification_events WHERE business_id = $1 ORDER BY created_at`,
      [tenant.businessId],
    ),
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_iam_block_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  await maintenance.end();
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  blockLib = await import("../src/lib/iam/operational-sync-block");
  healthLib = await import("../src/lib/iam/operational-sync-health");
  syncLib = await import("../src/lib/server-sync");
  deviceLib = await import("../src/lib/site-device-service");
  settingsLib = await import("../src/lib/settings");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await db?.end().catch(() => {});
  await dbLib?.closeDatabasePool().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await maintenance.end();
});

describe("operational sync block state", () => {
  it("records one blocked tick with its reason and the queue behind it", async () => {
    const tenant = await createTenant("بلاک‌شده");
    await queueLocalEvent(tenant);
    await queueLocalEvent(tenant);

    await dbLib.withTenant(tenant.businessId, () =>
      blockLib.recordOperationalSyncBlocked(tenant.businessId, tenant.deviceId, {
        error: "events_http_403",
      }),
    );

    const row = await readRow(tenant);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("blocked");
    expect(row!.consecutive_blocked_ticks).toBe(1);
    expect(row!.total_blocked_ticks).toBe(1);
    expect(row!.episodes_blocked).toBe(1);
    expect(row!.last_code).toBe("forbidden");
    expect(row!.last_error).toBe("events_http_403");
    // The backlog is measured, not assumed: these are the two events a healthy
    // tick would have pushed.
    expect(row!.pending_outbox).toBe(2);
    expect(row!.first_blocked_at).not.toBeNull();
    // Under the threshold, so nothing has shouted yet.
    expect(row!.alerted_at).toBeNull();
  });

  it("extends the episode instead of opening a new one", async () => {
    const tenant = await createTenant("ادامه");
    const record = (error: string) =>
      dbLib.withTenant(tenant.businessId, () =>
        blockLib.recordOperationalSyncBlocked(tenant.businessId, tenant.deviceId, { error }),
      );

    await record("fetch failed");
    const opened = await readRow(tenant);
    for (let tick = 2; tick <= 5; tick += 1) await record("fetch failed");
    const row = await readRow(tenant);

    expect(row!.consecutive_blocked_ticks).toBe(5);
    expect(row!.total_blocked_ticks).toBe(5);
    expect(row!.episodes_blocked).toBe(1);
    // "Blocked since" is the start of the episode, not of the last tick — that
    // is the sentence that would have told the owner about nine days on day one.
    expect(row!.first_blocked_at).toBe(opened!.first_blocked_at);
    expect(row!.last_code).toBe("transport");
  });

  it("alerts once per episode, past the threshold and not every tick after", async () => {
    const tenant = await createTenant("هشدار");
    const threshold = healthLib.OPERATIONAL_SYNC_ALERT_AFTER_TICKS;
    for (let tick = 1; tick <= threshold + 3; tick += 1) {
      await dbLib.withTenant(tenant.businessId, () =>
        blockLib.recordOperationalSyncBlocked(tenant.businessId, tenant.deviceId, {
          error: "snapshot_http_500",
        }),
      );
    }

    const row = await readRow(tenant);
    expect(row!.consecutive_blocked_ticks).toBe(threshold + 3);
    expect(row!.alerted_at).not.toBeNull();

    const events = await notificationRows(tenant);
    expect(events).toHaveLength(1);
    expect(events[0].event_key).toBe("sync.operational_blocked");
    // Deduped on the episode, so a retry of the same outage cannot stack.
    expect(events[0].dedupe_key).toContain(tenant.deviceId);
  });

  it("lifts the record on a converged tick and keeps the episode counted", async () => {
    const tenant = await createTenant("بازیابی");
    const record = () =>
      dbLib.withTenant(tenant.businessId, () =>
        blockLib.recordOperationalSyncBlocked(tenant.businessId, tenant.deviceId, { error: "fetch failed" }),
      );
    await record();
    await record();

    const cleared = await dbLib.withTenant(tenant.businessId, () =>
      blockLib.clearOperationalSyncBlock(tenant.businessId, tenant.deviceId),
    );
    expect(cleared.recovered).toBe(true);
    expect(cleared.totalBlockedTicks).toBe(2);

    const row = await readRow(tenant);
    expect(row!.status).toBe("clear");
    expect(row!.consecutive_blocked_ticks).toBe(0);
    expect(row!.first_blocked_at).toBeNull();
    expect(row!.last_error).toBeNull();
    // The history is what makes "is this the first time?" answerable.
    expect(row!.total_blocked_ticks).toBe(2);
    expect(row!.episodes_blocked).toBe(1);

    // An idle healthy tick changes nothing at all: no row matches, no write.
    const idle = await dbLib.withTenant(tenant.businessId, () =>
      blockLib.clearOperationalSyncBlock(tenant.businessId, tenant.deviceId),
    );
    expect(idle.recovered).toBe(false);
    expect((await readRow(tenant))!.status).toBe("clear");
  });

  it("opens a new episode that can alert again after a recovery", async () => {
    const tenant = await createTenant("چندقسمت");
    const threshold = healthLib.OPERATIONAL_SYNC_ALERT_AFTER_TICKS;
    const record = () =>
      dbLib.withTenant(tenant.businessId, () =>
        blockLib.recordOperationalSyncBlocked(tenant.businessId, tenant.deviceId, { error: "fetch failed" }),
      );
    for (let tick = 1; tick <= threshold; tick += 1) await record();
    await dbLib.withTenant(tenant.businessId, () =>
      blockLib.clearOperationalSyncBlock(tenant.businessId, tenant.deviceId),
    );
    for (let tick = 1; tick <= threshold; tick += 1) await record();

    const row = await readRow(tenant);
    expect(row!.episodes_blocked).toBe(2);
    expect(row!.consecutive_blocked_ticks).toBe(threshold);
    expect(row!.total_blocked_ticks).toBe(threshold * 2);
    expect((await notificationRows(tenant))).toHaveLength(2);
  });

  it("surfaces the block per device in the fleet read", async () => {
    const tenant = await createTenant("ناوگان");
    await queueLocalEvent(tenant);
    await dbLib.withTenant(tenant.businessId, () =>
      blockLib.recordOperationalSyncBlocked(tenant.businessId, tenant.deviceId, { error: "events_http_401" }),
    );

    const [device] = await dbLib.withTenant(tenant.businessId, () =>
      deviceLib.listSiteDevices(tenant.businessId),
    );
    expect(device.operationalSyncBlocked).toBe(true);
    expect(device.operationalSyncBlockCode).toBe("unauthorized");
    expect(device.operationalSyncPendingOutbox).toBe(1);
    expect(device.operationalSyncBlockedSince).not.toBeNull();

    await dbLib.withTenant(tenant.businessId, () =>
      blockLib.clearOperationalSyncBlock(tenant.businessId, tenant.deviceId),
    );
    const [recovered] = await dbLib.withTenant(tenant.businessId, () =>
      deviceLib.listSiteDevices(tenant.businessId),
    );
    expect(recovered.operationalSyncBlocked).toBe(false);
    expect(recovered.operationalSyncPendingOutbox).toBe(0);
  });

  it("keys every read and write on the business *and* the device", async () => {
    /*
     * The row is addressed by the pair, never by a device id alone — which is
     * what stops one install's outage being read, or written, through another
     * business's handle. (Row-level security itself is verified schema-wide by
     * integration/tenant-isolation.integration.test.ts, which this table's
     * policy in migration 0228 satisfies; what is tested here is the query
     * discipline the surfaces actually use.)
     */
    const mine = await createTenant("من");
    const theirs = await createTenant("دیگری");
    await dbLib.withTenant(mine.businessId, () =>
      blockLib.recordOperationalSyncBlocked(mine.businessId, mine.deviceId, { error: "fetch failed" }),
    );

    // Another business, reading this device: nothing, not someone else's outage.
    const foreign = await dbLib.withTenant(theirs.businessId, () =>
      blockLib.readOperationalSyncBlockState(theirs.businessId, mine.deviceId),
    );
    expect(foreign).toBeNull();

    // And a write addressed at another business's device cannot land: the
    // composite FK over site_devices refuses the pair, the recorder reports the
    // failure as "nothing recorded", and the real row is untouched.
    const rejected = await dbLib.withTenant(theirs.businessId, () =>
      blockLib.recordOperationalSyncBlocked(theirs.businessId, mine.deviceId, { error: "fetch failed" }),
    );
    expect(rejected).toBeNull();
    expect((await readRow(mine))!.consecutive_blocked_ticks).toBe(1);

    // The fleet read is scoped the same way: their own install lists, and it
    // carries none of this outage.
    const theirDevices = await dbLib.withTenant(theirs.businessId, () =>
      deviceLib.listSiteDevices(theirs.businessId),
    );
    expect(theirDevices).toHaveLength(1);
    expect(theirDevices[0].id).toBe(theirs.deviceId);
    expect(theirDevices[0].operationalSyncBlocked).toBe(false);
    expect(theirDevices[0].operationalSyncBlockedSince).toBeNull();
  });

  it("reads an install that was never gated as flowing, not as unknown", async () => {
    const tenant = await createTenant("سالم");
    const snapshot = await dbLib.withTenant(tenant.businessId, () =>
      blockLib.readOperationalSyncBlockState(tenant.businessId, tenant.deviceId),
    );
    expect(snapshot).toBeNull();
    expect(
      healthLib.operationalSyncHealth({ configured: true, block: snapshot }),
    ).toMatchObject({ state: "healthy", alertDue: false });
  });

  it("gates the sync tick on the same outcome it records", async () => {
    const tenant = await createTenant("تیک");
    await syncLib.setServerSyncConfig(tenant.businessId, {
      enabled: true,
      remoteUrl: "https://cloud.invalid",
      token: `tok-${randomUUID()}`,
      siteDeviceId: tenant.deviceId,
      locationId: tenant.locationId,
    } as never);
    await dbLib.withTenant(tenant.businessId, () =>
      settingsLib.setSetting(tenant.businessId, settingsLib.SETTING_KEYS.deploymentProfile, { profile: "hybrid" }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    // The gate is closed and the block is recorded by the same call the desktop
    // would make every 30 s — the pairing step is what refuses here, which is
    // precisely the case that used to skip the tick without leaving a trace.
    const gate = await dbLib.withTenant(tenant.businessId, () =>
      syncLib.runOperationalSyncGate(tenant.businessId),
    );
    expect(gate.ready).toBe(false);
    expect(gate.reason).toBe("credential_unsettled");
    expect(gate.siteDeviceId).toBe(tenant.deviceId);
    expect(gate.error).toContain("fetch failed");

    const row = await readRow(tenant);
    expect(row).toBeNull();

    await syncLib.runServerSyncTick();
    const recorded = await readRow(tenant);
    expect(recorded!.status).toBe("blocked");
    expect(recorded!.last_code).toBe("transport");
    expect(recorded!.consecutive_blocked_ticks).toBe(1);

    // Sync switched off is not a blocked install: the tick closes the episode
    // instead of leaving a stale accusation behind.
    await syncLib.setServerSyncConfig(tenant.businessId, {
      enabled: false,
      remoteUrl: "https://cloud.invalid",
      token: `tok-${randomUUID()}`,
      siteDeviceId: tenant.deviceId,
      locationId: tenant.locationId,
    } as never);
    await syncLib.runServerSyncTick();
    expect((await readRow(tenant))!.status).toBe("clear");
  }, 60_000);
});
