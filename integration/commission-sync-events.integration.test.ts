/**
 * Business-scope sync events for commission payouts (issue #869).
 *
 * A payout and the reversal of one move business-wide money, so each is recorded
 * as a sync event with business scope and no location. The app modules connect as
 * the unprivileged application role, so row-level security applies to every read
 * and write below (a superuser would bypass it, and the isolation checks would pass
 * for the wrong reason). These tests check that:
 *   - the event is written in the transaction that moves the money, and is undone
 *     with it when that transaction fails;
 *   - a retried request and a doubly delivered event each land once;
 *   - a desktop that receives the pulled event applies it once, and a replayed copy
 *     of it is refused and changes no money;
 *   - a business-wide feed carries the event, and another business can neither read
 *     it nor write one into this business;
 *   - only the cloud records one (a site refuses).
 */
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import type { CommissionActor } from "../src/lib/commission-settlement-service";
import { PERMISSIONS } from "../src/lib/permissions";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_commission_sync_role";
const APP_PASSWORD = "commission-sync-test-password";
const PAYOUT_EVENT = "commission.payout.recorded" as const;
const REVERSAL_EVENT = "commission.payout.reversed" as const;

let databaseName = "";
let db: Client;
let dbLib: typeof import("../src/lib/db");
let settlement: typeof import("../src/lib/commission-settlement-service");
let commissionService: typeof import("../src/lib/commission-service");
let businessDay: typeof import("../src/lib/business-day-service");
let syncEvents: typeof import("../src/lib/sync-events");
let syncOutbox: typeof import("../src/lib/sync-outbox");
let serverSync: typeof import("../src/lib/server-sync");
let pullRoute: typeof import("../src/app/api/server-sync/pull/route");

const previousDeploymentRole = process.env.DEPLOYMENT_ROLE;

function urlFor(database: string, user?: { name: string; password: string }): string {
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
  // A payout's business-scope event is written by the cloud only (#869).
  process.env.DEPLOYMENT_ROLE = "central";
  databaseName = `pos_commission_sync_${randomUUID().replaceAll("-", "")}`;
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

  // The app modules run as the unprivileged role; fixtures and assertions use the
  // superuser connection below, which is the only place RLS is deliberately skipped.
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  settlement = await import("../src/lib/commission-settlement-service");
  commissionService = await import("../src/lib/commission-service");
  businessDay = await import("../src/lib/business-day-service");
  syncEvents = await import("../src/lib/sync-events");
  syncOutbox = await import("../src/lib/sync-outbox");
  serverSync = await import("../src/lib/server-sync");
  pullRoute = await import("../src/app/api/server-sync/pull/route");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  if (previousDeploymentRole === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = previousDeploymentRole;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL = new Set<string>([
  PERMISSIONS.commissionView,
  PERMISSIONS.commissionCalculate,
  PERMISSIONS.commissionApprove,
  PERMISSIONS.commissionPayout,
  PERMISSIONS.commissionReverse,
]);
const CALCULATE_ONLY = new Set<string>([PERMISSIONS.commissionView, PERMISSIONS.commissionCalculate]);

interface Tenant {
  id: string;
  locationId: string;
  accounts: { cash: string; salariesPayable: string };
  sellerA: string;
  owner: CommissionActor;
  calculator: CommissionActor;
  approver: CommissionActor;
  paymaster: CommissionActor;
}

async function newTenant(): Promise<Tenant> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Sync Co', $1, 'cosmetics') RETURNING id",
    [`sync-${randomUUID().slice(0, 8)}`],
  );
  const id = biz.rows[0].id;
  const loc = await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [id]);
  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'صندوق', 'asset'), ($1, '2300', 'حقوق پرداختنی', 'liability'), ($1, '5210', 'پورسانت فروش', 'expense')
     RETURNING id, code`,
    [id],
  );
  const byCode = new Map(accounts.rows.map((row) => [row.code, row.id]));
  const user = async (name: string, role: string) =>
    (
      await db.query<{ id: string }>(
        "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, $2, $3, 'x') RETURNING id",
        [id, role, name],
      )
    ).rows[0].id;
  const sellerA = await user("فروشنده الف", "cashier");
  const ownerId = await user("مالک", "owner");
  const calculatorId = await user("مدیر فروش", "manager");
  const approverId = await user("حسابدار", "accountant");
  const paymasterId = await user("خزانه‌دار", "accountant");

  await withTenant(id, () =>
    commissionService.upsertCommissionRule(id, { employeeId: sellerA, kind: "percent", basis: "net", value: 5 }),
  );
  return {
    id,
    locationId: loc.rows[0].id,
    accounts: { cash: byCode.get("1100")!, salariesPayable: byCode.get("2300")! },
    sellerA,
    owner: { userId: ownerId, role: "owner", permissions: ALL },
    calculator: { userId: calculatorId, role: "manager", permissions: CALCULATE_ONLY },
    approver: { userId: approverId, role: "accountant", permissions: ALL },
    paymaster: { userId: paymasterId, role: "accountant", permissions: ALL },
  };
}

/** Run `fn` as the application role, inside the tenant's row-level-security scope. */
function withTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

async function accrue(tenant: Tenant, net: number): Promise<void> {
  await withTenant(tenant.id, async () => {
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await commissionService.accrueCommissionForLine(client, {
        businessId: tenant.id,
        locationId: tenant.locationId,
        employeeId: tenant.sellerA,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net, cost: null, itemId: randomUUID() },
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

async function approvedRun(tenant: Tenant) {
  return withTenant(tenant.id, async () => {
    const today = await businessDay.businessToday(tenant.id);
    const { run } = await settlement.createCommissionRun(
      tenant.id,
      tenant.calculator,
      { periodFrom: today, periodTo: today, locationId: null, employeeIds: [], title: null },
      null,
    );
    await settlement.calculateCommissionRun(tenant.id, tenant.calculator, run.id);
    await settlement.reviewCommissionRun(tenant.id, tenant.approver, run.id, null);
    await settlement.approveCommissionRun(tenant.id, tenant.approver, run.id, null);
    return settlement.releaseCommissionRun(tenant.id, tenant.paymaster, run.id, null);
  });
}

function payIn(tenant: Tenant, amount: bigint, method: "cash" | "bank" = "cash") {
  return {
    allocations: [{ employeeId: tenant.sellerA, amount }],
    paymentAccountId: null,
    method,
    paidDate: null,
    memo: null,
  };
}

async function countEvents(tenant: Tenant, eventType: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM sync_events WHERE business_id = $1 AND event_type = $2",
    [tenant.id, eventType],
  );
  return rows[0].n;
}

async function countPayouts(runId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM commission_settlement_payouts WHERE run_id = $1",
    [runId],
  );
  return rows[0].n;
}

async function countSettlementEntries(tenant: Tenant): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND source_type LIKE 'commission_payout%'",
    [tenant.id],
  );
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("a payout's business-scope event", () => {
  it("is written once, in the transaction that moves the money, with business scope and no location", async () => {
    const t = await newTenant();
    await accrue(t, 100_000); // 5,000 of commission
    const run = await approvedRun(t);

    const paid = await withTenant(t.id, () =>
      settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payIn(t, 2000n), "payout-scope-0001"),
    );

    const { rows } = await db.query<{
      scope: string;
      location_id: string | null;
      business_id: string;
      client_event_id: string;
      applied: boolean;
      origin: string;
      actor_role: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT scope, location_id, business_id, client_event_id, applied_at IS NOT NULL AS applied, origin, actor_role, payload
         FROM sync_events WHERE business_id = $1 AND event_type = $2`,
      [t.id, PAYOUT_EVENT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "business",
      location_id: null,
      business_id: t.id,
      applied: true,
      origin: "local",
      actor_role: "accountant",
    });
    // Identified by the payout itself, so a retry or a second delivery has one key.
    expect(rows[0].client_event_id).toBe(syncOutbox.syncClientEventId(`commission.payout:${paid.payout.id}`));
    expect(rows[0].payload).toMatchObject({
      payoutId: paid.payout.id,
      runId: run.id,
      runNumber: run.runNumber,
      amount: "2000",
      method: "cash",
      entryId: paid.payout.entryId,
      allocations: [{ employeeId: t.sellerA, amount: "2000" }],
    });
  });

  it("records the reversal of a payout as its own business-scope event", async () => {
    const t = await newTenant();
    await accrue(t, 100_000);
    const run = await approvedRun(t);
    const paid = await withTenant(t.id, () =>
      settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payIn(t, 5000n), "payout-reverse-0001"),
    );

    const reversed = await withTenant(t.id, () =>
      settlement.reverseCommissionPayout(t.id, t.paymaster, paid.payout.id, "اشتباه در مبلغ"),
    );

    expect(await countEvents(t, REVERSAL_EVENT)).toBe(1);
    const { rows } = await db.query<{ scope: string; location_id: string | null; payload: Record<string, unknown> }>(
      "SELECT scope, location_id, payload FROM sync_events WHERE business_id = $1 AND event_type = $2",
      [t.id, REVERSAL_EVENT],
    );
    expect(rows[0]).toMatchObject({ scope: "business", location_id: null });
    expect(rows[0].payload).toMatchObject({
      reversalId: reversed.reversal.id,
      reversedPayoutId: paid.payout.id,
      runId: run.id,
      amount: "5000",
    });
  });

  it("is undone with its payout when the transaction fails after it: no event, no payout, no journal entry", async () => {
    const t = await newTenant();
    await accrue(t, 100_000);
    const run = await approvedRun(t);

    // Fail the payout's own audit row, which is written after the event. The failure
    // is a trigger on audit_log, created by the superuser and removed afterwards.
    const trigger = `commission_sync_fail_${t.id.replaceAll("-", "")}`;
    await db.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.action = 'commission.payout.recorded' AND NEW.business_id = '${t.id}' THEN
           RAISE EXCEPTION 'injected failure after the sync event';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await db.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      await expect(
        withTenant(t.id, () => settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payIn(t, 2000n), "payout-fail-0001")),
      ).rejects.toThrow(/injected failure/);
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_log`);
      await db.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }

    expect(await countEvents(t, PAYOUT_EVENT)).toBe(0);
    expect(await countPayouts(run.id)).toBe(0);
    expect(await countSettlementEntries(t)).toBe(0);
    const { rows } = await db.query<{ status: string; paid_total: string }>(
      "SELECT status, paid_total::text FROM commission_settlement_runs WHERE id = $1",
      [run.id],
    );
    expect(rows[0]).toEqual({ status: "payable", paid_total: "0" });
  });

  it("a retried request with the same key records nothing more", async () => {
    const t = await newTenant();
    await accrue(t, 100_000);
    const run = await approvedRun(t);
    const body = payIn(t, 2000n);

    const first = await withTenant(t.id, () =>
      settlement.recordCommissionPayout(t.id, t.paymaster, run.id, body, "payout-retry-0001"),
    );
    const retry = await withTenant(t.id, () =>
      settlement.recordCommissionPayout(t.id, t.paymaster, run.id, body, "payout-retry-0001"),
    );

    expect(retry.replayed).toBe(true);
    expect(retry.payout.id).toBe(first.payout.id);
    expect(await countEvents(t, PAYOUT_EVENT)).toBe(1);
    expect(await countPayouts(run.id)).toBe(1);
  });
});

describe("delivery of a business-scope event", () => {
  it("a doubly delivered append of the same event lands once", async () => {
    const t = await newTenant();
    const input = {
      businessId: t.id,
      clientEventId: `commission.payout:${randomUUID()}`,
      eventType: PAYOUT_EVENT,
      payload: { payoutId: randomUUID(), amount: "1" },
      actorUserId: t.paymaster.userId,
      actorRole: "accountant" as const,
    };

    await withTenant(t.id, async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        await syncOutbox.appendBusinessSyncOutboxEvent(client, input);
        await syncOutbox.appendBusinessSyncOutboxEvent(client, input);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    });

    expect(await countEvents(t, PAYOUT_EVENT)).toBe(1);
  });

  it("a desktop that pulls the event through its own pull acknowledges it under a location of its business, with no error", async () => {
    const t = await newTenant();
    const clientEventId = randomUUID();
    // The shape the central pull route answers with: a business-scope event has no location.
    const remote = [
      {
        id: 1,
        txid: "1",
        locationId: null,
        clientEventId,
        type: PAYOUT_EVENT,
        occurredAt: new Date().toISOString(),
        payload: { payoutId: randomUUID(), runId: randomUUID(), amount: "2000", allocations: [] },
        actorUserId: t.paymaster.userId,
        actorRole: "accountant",
        businessId: t.id,
        siteDeviceId: null,
        schemaVersion: 1,
        origin: "cloud",
      },
    ];
    await withTenant(t.id, () =>
      serverSync.setServerSyncConfig(t.id, {
        remoteUrl: "https://vps.example.com",
        token: `pull-token-${randomUUID().replaceAll("-", "")}`,
        enabled: true,
      }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ events: remote }), { status: 200 })));
    try {
      const result = await withTenant(t.id, () => serverSync.runServerPull(t.id));
      expect(result).toMatchObject({ status: "ok", pulled: 1 });
    } finally {
      vi.unstubAllGlobals();
    }

    const { rows } = await db.query<{ status: string; effect_type: string | null }>(
      "SELECT status, effect_type FROM sync_domain_effects WHERE business_id = $1 AND client_event_id = $2",
      [t.id, clientEventId],
    );
    expect(rows).toEqual([{ status: "applied", effect_type: "cloud_owned" }]);
  });

  it("a desktop that receives the pulled event twice applies it once, and acknowledges it without applying it", async () => {
    const t = await newTenant();
    const event = {
      clientEventId: randomUUID(),
      type: PAYOUT_EVENT,
      occurredAt: new Date().toISOString(),
      payload: { payoutId: randomUUID(), runId: randomUUID(), amount: "2000", allocations: [] },
    };
    const actor = { userId: t.owner.userId, role: "owner" as const };

    const first = await withTenant(t.id, () =>
      syncEvents.applySyncEvent(t.locationId, actor, event, "remote", { pulledFromCloud: true, schemaVersion: 1 }),
    );
    const second = await withTenant(t.id, () =>
      syncEvents.applySyncEvent(t.locationId, actor, event, "remote", { pulledFromCloud: true, schemaVersion: 1 }),
    );

    expect(first).toMatchObject({ ok: true, data: { skipped: "cloud_owned" } });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM sync_domain_effects WHERE business_id = $1 AND client_event_id = $2",
      [t.id, event.clientEventId],
    );
    expect(rows[0].n).toBe(1);
    // Nothing was applied: the desktop has no run to change and no money to move.
    expect(await countSettlementEntries(t)).toBe(0);
  });

  it("a replayed copy of a payout event is refused as a terminal error and changes no money", async () => {
    const t = await newTenant();
    const event = {
      clientEventId: randomUUID(),
      type: PAYOUT_EVENT,
      occurredAt: new Date().toISOString(),
      payload: { payoutId: randomUUID(), runId: randomUUID(), amount: "2000", allocations: [] },
    };

    // A copy pushed back up, with no pulled-from-cloud mark, is a replay of money the
    // cloud already moved. It must not move it again.
    const result = await withTenant(t.id, () =>
      syncEvents.applySyncEvent(t.locationId, { userId: t.owner.userId, role: "owner" }, event, "remote", { schemaVersion: 1 }),
    );

    expect(result).toMatchObject({ ok: false, deadLettered: true, error: "business_event_not_replayable" });
    expect(await countSettlementEntries(t)).toBe(0);
  });
});

describe("who can see and write a business-scope event", () => {
  it("a business-wide feed carries the event, and another business neither reads it nor writes one into this business", async () => {
    const t = await newTenant();
    const other = await newTenant();
    await accrue(t, 100_000);
    const run = await approvedRun(t);
    await withTenant(t.id, () =>
      settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payIn(t, 2000n), "payout-feed-0001"),
    );

    // The business-wide feed (a legacy per-business token resolves with no location).
    const token = `feed-token-${randomUUID().replaceAll("-", "")}`;
    await withTenant(t.id, () =>
      serverSync.setServerSyncConfig(t.id, { remoteUrl: "https://vps.example.com", token, enabled: true }),
    );
    const response = await pullRoute.GET(
      new NextRequest("http://localhost/api/server-sync/pull?after=0&limit=200", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const body = (await response.json()) as { events: { type: string }[] };
    expect(body.events.map((event) => event.type)).toContain(PAYOUT_EVENT);

    // Another business sees none of this business's commission events.
    const seen = await withTenant(other.id, () =>
      dbLib.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM sync_events WHERE event_type LIKE 'commission.%'",
      ),
    );
    expect(seen.rows[0].n).toBe(0);

    // Nor can it write one into this business, by naming this business's id.
    await expect(
      withTenant(other.id, () =>
        dbLib.query(
          `INSERT INTO sync_events (scope, business_id, client_event_id, event_type, payload, occurred_at, actor_role, origin, schema_version)
           VALUES ('business', $1, $2, $3, '{}'::jsonb, now(), 'owner', 'local', 1)`,
          [t.id, randomUUID(), PAYOUT_EVENT],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("a branch's own pull never carries a business event, and still carries the branch's events", async () => {
    const t = await newTenant();
    await accrue(t, 100_000);
    const run = await approvedRun(t);
    await withTenant(t.id, () =>
      settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payIn(t, 2000n), "payout-branch-0001"),
    );

    // A branch's own event (a shift at this location), recorded the way a site records one.
    await db.query(
      `INSERT INTO sync_events (location_id, client_event_id, event_type, payload, occurred_at, applied_at, origin, schema_version)
       VALUES ($1, $2, 'shift.opened', '{}'::jsonb, now(), now(), 'local', 1)`,
      [t.locationId, randomUUID()],
    );

    // The branch's own credential: a site device bound to its location.
    const token = `site-token-${randomUUID().replaceAll("-", "")}`;
    const device = await db.query<{ id: string }>(
      "INSERT INTO site_devices (business_id, location_id, display_name) VALUES ($1, $2, 'Branch') RETURNING id",
      [t.id, t.locationId],
    );
    await db.query(
      "INSERT INTO site_sync_credentials (site_device_id, business_id, token_hash) VALUES ($1, $2, $3)",
      [device.rows[0].id, t.id, createHash("sha256").update(token).digest("hex")],
    );

    const response = await pullRoute.GET(
      new NextRequest("http://localhost/api/server-sync/pull?after=0&limit=200", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const types = ((await response.json()) as { events: { type: string }[] }).events.map((event) => event.type);
    expect(types).toContain("shift.opened");
    expect(types).not.toContain(PAYOUT_EVENT);
    expect(types).not.toContain(REVERSAL_EVENT);
  });

  it("a site refuses to record a business-wide event, so a payout is never made unrecorded on a branch", async () => {
    const t = await newTenant();
    const previous = process.env.DEPLOYMENT_ROLE;
    process.env.DEPLOYMENT_ROLE = "site";
    try {
      await expect(
        withTenant(t.id, async () => {
          const client = await dbLib.getPool().connect();
          try {
            await client.query("BEGIN");
            await syncOutbox.appendBusinessSyncOutboxEvent(client, {
              businessId: t.id,
              clientEventId: `commission.payout:${randomUUID()}`,
              eventType: PAYOUT_EVENT,
              payload: {},
              actorUserId: t.paymaster.userId,
              actorRole: "accountant",
            });
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          } finally {
            client.release();
          }
        }),
      ).rejects.toThrow("business_sync_event_cloud_only");
    } finally {
      process.env.DEPLOYMENT_ROLE = previous;
    }
    expect(await countEvents(t, PAYOUT_EVENT)).toBe(0);
  });
});
