/**
 * ESH-121 / issue #1000 — the blocked-sync badge, end to end, on an install
 * that was upgraded from the pre-#988 schema.
 *
 * `integration/hybrid-operational-sync-block.integration.test.ts` proves the
 * record itself against a database created at HEAD. That is not the shape the
 * reported install had: it was running when 0228 (and 0301) did not exist yet,
 * and the question asked on #1000 is whether such an install — upgraded in
 * place, with its business, device and queued sales intact — actually *shows*
 * the block on the surface the owner looks at. Reading the table directly
 * cannot answer that: the badge's whole failure mode was a healthy-looking
 * installation whose gate was closed.
 *
 * So this suite:
 *  - builds the database at the migration just before #988's table
 *    (`0228_iam_operational_sync_block_state.sql`), the way an old install
 *    sits, with a business, a paired site device and three local sales queued
 *    for push;
 *  - applies every remaining migration and checks the upgrade was additive:
 *    the block table appears, and nothing the install already had is lost;
 *  - calls the real `GET /api/connection/status` handler and reads the badge's
 *    own fields (`operationalBlock`, `health.operationalBlock`, `sync`,
 *    `outboundPending`) — only `withTenantScope`/`requireMember` are mocked, so
 *    the route body, the SQL and the JSON are the production ones;
 *  - repeats the request after the gate lifts and expects the same badge to
 *    say the install is healthy again while the queued sales are still there
 *    (a recovered gate has not pushed them yet — that is a separate fact).
 *
 * The block is recorded through `recordOperationalSyncBlocked()`, the exact
 * function the gated tick calls (0228's recorder); the tick→recorder pairing
 * itself is covered by the suite named above.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

/** #988's table; everything before this filename is the old install's schema. */
const OPERATIONAL_BLOCK_MIGRATION = "0228_iam_operational_sync_block_state.sql";

const session = vi.hoisted(() => ({ businessId: "", sub: "" }));

vi.mock("../src/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth")>();
  const { runInTenantScope, businessScope } = await import("../src/lib/tenant-context");
  return {
    ...actual,
    // The real wrapper does two things: establish the RLS scope from the
    // session and run the handler inside it. Only the cookie half is replaced.
    withTenantScope:
      (handler: (...args: never[]) => Promise<Response>) =>
      async (...args: never[]) =>
        runInTenantScope(businessScope(session.businessId, null, session.sub), () =>
          handler(...args),
        ),
    requireMember: async () => ({
      session: { businessId: session.businessId, sub: session.sub, role: "owner" },
      membership: { userId: session.sub, businessId: session.businessId },
      error: null,
    }),
  };
});

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let oldMigrationsDir: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let blockLib: typeof import("../src/lib/iam/operational-sync-block");
let syncLib: typeof import("../src/lib/server-sync");
let settingsLib: typeof import("../src/lib/settings");
let statusRoute: typeof import("../src/app/api/connection/status/route");

const install = { businessId: "", locationId: "", deviceId: "" };

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

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ present: string | null }>(
    `SELECT to_regclass($1)::text AS present`,
    [`public.${name}`],
  );
  return rows[0]?.present !== null;
}

async function queuedEvents(): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM sync_events WHERE origin = 'local' AND pushed_at IS NULL`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * The badge's operational segment, as `deployment-status-indicator.tsx`
 * composes it. Kept in the test on purpose: the string is what the owner reads,
 * and asserting only the numbers behind it would still pass if the badge went
 * back to saying «در حال اتصال» on a blocked install.
 */
function syncBadgeLabel(body: { operationalBlock?: { blocked?: boolean }; sync?: string }, pending: number): string {
  if (body.operationalBlock?.blocked) {
    return `سایت محلی · همگام‌سازی عملیاتی مسدود${pending ? ` · ${pending.toLocaleString("fa-IR")} در انتظار` : ""}`;
  }
  if (body.sync === "connected") return "سایت محلی · همگام با ابر";
  if (body.sync === "connecting") return "سایت محلی · در حال اتصال به ابر";
  return `سایت محلی · همگام‌سازی متوقف${pending ? ` · ${pending.toLocaleString("fa-IR")} در انتظار` : ""}`;
}

function getStatus() {
  return statusRoute.GET();
}

beforeAll(async () => {
  databaseName = `pos_esh121_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  // The old install's schema: every migration before #988's table, nothing after.
  oldMigrationsDir = mkdtempSync(join(tmpdir(), "esh121-migrations-"));
  for (const filename of readdirSync(join(process.cwd(), "migrations"))) {
    if (!/^\d{4}_.+\.sql$/.test(filename)) continue;
    if (filename >= OPERATIONAL_BLOCK_MIGRATION) continue;
    copyFileSync(join(process.cwd(), "migrations", filename), join(oldMigrationsDir, filename));
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: oldMigrationsDir, quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // The install as it existed before the upgrade: a business, its site device
  // and three local sales waiting to be pushed.
  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    ["صندوق قدیمی", `esh121-${randomUUID().slice(0, 8)}`],
  );
  install.businessId = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id`,
    [install.businessId, "مرکزی"],
  );
  install.locationId = location.rows[0].id;
  const device = await db.query<{ id: string }>(
    `INSERT INTO site_devices (business_id, location_id, display_name, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [install.businessId, install.locationId, "صندوق قدیمی"],
  );
  install.deviceId = device.rows[0].id;
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, location_id, role, full_name, email, password_hash, is_active)
     VALUES ($1, $2, 'owner', $3, $4, 'x', true) RETURNING id`,
    [install.businessId, install.locationId, "مالک", `owner-${randomUUID().slice(0, 8)}@example.invalid`],
  );
  session.sub = owner.rows[0].id;
  for (let index = 0; index < 3; index += 1) {
    await db.query(
      `INSERT INTO sync_events
         (location_id, scope, origin, event_type, client_event_id, payload, occurred_at, applied_at)
       VALUES ($1, 'location', 'local', 'order.updated', $2::uuid, $3::jsonb, now(), now())`,
      [install.locationId, randomUUID(), JSON.stringify({ orderId: randomUUID() })],
    );
  }

  // The upgrade itself — the rest of the repository's migrations, in order.
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.DEPLOYMENT_ROLE = "site";
  dbLib = await import("../src/lib/db");
  blockLib = await import("../src/lib/iam/operational-sync-block");
  syncLib = await import("../src/lib/server-sync");
  settingsLib = await import("../src/lib/settings");
  statusRoute = await import("../src/app/api/connection/status/route");

  // A paired Hybrid install, as the upgraded desktop configures itself.
  await dbLib.withTenant(install.businessId, async () => {
    await settingsLib.setSetting(install.businessId, settingsLib.SETTING_KEYS.deploymentProfile, {
      profile: "hybrid",
      pairedAt: new Date().toISOString(),
      source: "profile",
    });
    await syncLib.setServerSyncConfig(install.businessId, {
      enabled: true,
      remoteUrl: "https://cloud.invalid",
      token: `tok-${randomUUID()}`,
      siteDeviceId: install.deviceId,
      locationId: install.locationId,
    } as never);
  });

  session.businessId = install.businessId;
  // The cloud is unreachable from this suite; every route-side probe swallows
  // its own failure, and no real network leaves the test.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError("fetch failed");
  }));
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await db?.end().catch(() => {});
  await dbLib?.closeDatabasePool().catch(() => {});
  delete process.env.DEPLOYMENT_ROLE;
  process.env.DATABASE_URL = rootDatabaseUrl;
  if (oldMigrationsDir) rmSync(oldMigrationsDir, { recursive: true, force: true });
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("blocked-sync badge on an install upgraded from the pre-#988 schema (ESH-121 / #1000)", () => {
  it("upgrades additively: the block table arrives, the install's data stays", async () => {
    expect(await tableExists("iam_operational_sync_block_state")).toBe(true);
    // The queue the gate is about to be judged on, and the pairing itself,
    // survived the upgrade untouched.
    expect(await queuedEvents()).toBe(3);
    const { rows } = await db.query<{ status: string; business_id: string }>(
      `SELECT status, business_id FROM site_devices WHERE id = $1`,
      [install.deviceId],
    );
    expect(rows[0]).toMatchObject({ status: "active", business_id: install.businessId });
    // 0228's table is the only thing the old install did not have; an install
    // that never gated anything has no row, which reads as flowing, not unknown.
    expect(
      await dbLib.withTenant(install.businessId, () =>
        blockLib.readOperationalSyncBlockState(install.businessId, install.deviceId),
      ),
    ).toBeNull();
  });

  it("reports the upgraded install as healthy before the gate ever closes", async () => {
    const response = await getStatus();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile).toBe("hybrid");
    expect(body.operationalBlock).toMatchObject({ state: "healthy", blocked: false, code: null, pendingOutbox: 0 });
    expect(body.health.operationalBlock).toEqual(body.operationalBlock);
    expect(body.outboundPending).toBe(3);
    expect(syncBadgeLabel(body, body.outboundPending)).not.toContain("مسدود");
  });

  it("shows the badge blocked — with the backlog and the reason — once the gate closes", async () => {
    await dbLib.withTenant(install.businessId, () =>
      blockLib.recordOperationalSyncBlocked(install.businessId, install.deviceId, {
        error: "events_http_403",
      }),
    );

    const response = await getStatus();
    expect(response.status).toBe(200);
    const body = await response.json();

    // #988's fields, as the badge and the cloud-and-sync card read them.
    expect(body.operationalBlock).toMatchObject({
      state: "blocked",
      blocked: true,
      code: "forbidden",
      lastError: "events_http_403",
      pendingOutbox: 3,
      consecutiveBlockedTicks: 1,
      episodesBlocked: 1,
      alertDue: false,
    });
    expect(body.operationalBlock.blockedSince).toBeTruthy();
    expect(body.operationalBlock.lastBlockedAt).toBeTruthy();
    // The same verdict in the typed health model, not a second, drifting one.
    expect(body.health.operationalBlock).toEqual(body.operationalBlock);
    // A blocked install has no push error of its own — it has no push at all —
    // so before #988 this read as «در حال اتصال» forever.
    expect(body.outboundPending).toBe(3);
    expect(body.sync).toBe("paused");
    expect(syncBadgeLabel(body, body.outboundPending)).toBe(
      "سایت محلی · همگام‌سازی عملیاتی مسدود · ۳ در انتظار",
    );
  });

  it("goes back to healthy after recovery, keeping the episode and the queued sales", async () => {
    const cleared = await dbLib.withTenant(install.businessId, () =>
      blockLib.clearOperationalSyncBlock(install.businessId, install.deviceId),
    );
    expect(cleared.recovered).toBe(true);

    const response = await getStatus();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.operationalBlock).toMatchObject({
      state: "healthy",
      blocked: false,
      code: null,
      pendingOutbox: 0,
      episodesBlocked: 1,
    });
    expect(body.operationalBlock.lastRecoveredAt).toBeTruthy();
    expect(body.health.operationalBlock).toEqual(body.operationalBlock);
    // Recovery lifts the accusation, not the backlog: the three sales are still
    // queued (the tick pushes them on its own schedule), and the badge must not
    // claim they are gone.
    expect(body.outboundPending).toBe(3);
    expect(syncBadgeLabel(body, body.outboundPending)).not.toContain("مسدود");

    // And the record on disk agrees with what the surface said.
    const row = await dbLib.withTenant(install.businessId, () =>
      blockLib.readOperationalSyncBlockState(install.businessId, install.deviceId),
    );
    expect(row).toMatchObject({ status: "clear", consecutiveBlockedTicks: 0, episodesBlocked: 1 });
  });
});
