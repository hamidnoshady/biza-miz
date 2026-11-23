/**
 * Issue #1446 — recovery guarantees against a real, migrated database.
 *
 * The reported install had 26 operational events permanently refused, a master
 * conflict that was skipped, a heartbeat that could never satisfy RLS, and an
 * order that could name a party which is not a customer. Each assertion here
 * is the acceptance evidence for one of those, using the real app modules
 * against a disposable database.
 *
 * The app modules connect as an unprivileged role (like
 * `sync-events.integration.test.ts`) so the RLS assertions are not vacuous.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const APP_ROLE = "pos_sync_recovery_role";
const APP_PASSWORD = "sync-recovery-password";

let databaseName: string;
let owner: Client;
let dbLib: typeof import("../src/lib/db");
let syncEvents: typeof import("../src/lib/sync-events");
let serverSync: typeof import("../src/lib/server-sync");
let orderMutations: typeof import("../src/lib/order-mutations");
let masterSync: typeof import("../src/lib/master-sync-service");
let backupHybrid: typeof import("../src/lib/tenant-backup-hybrid");
let healthService: typeof import("../src/lib/sync-health-service");

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
  databaseName = `pos_sync_recovery_${randomUUID().replaceAll("-", "")}`;
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
  syncEvents = await import("../src/lib/sync-events");
  serverSync = await import("../src/lib/server-sync");
  orderMutations = await import("../src/lib/order-mutations");
  masterSync = await import("../src/lib/master-sync-service");
  backupHybrid = await import("../src/lib/tenant-backup-hybrid");
  healthService = await import("../src/lib/sync-health-service");

  owner = new Client({ connectionString: urlFor(databaseName) });
  await owner.connect();
}, 180_000);

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
  menuItemId: string;
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
  const cat = await owner.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Tea') RETURNING id",
    [locationId],
  );
  const item = await owner.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'Small tea', 600000) RETURNING id",
    [locationId, cat.rows[0].id],
  );
  const user = await owner.query<{ id: string }>(
    `INSERT INTO users (id, business_id, location_id, role, full_name, password_hash, is_active)
     VALUES ($1, $2, $3, 'owner', 'Owner', 'test-hash', true) RETURNING id`,
    [randomUUID(), businessId, locationId],
  );
  const device = await owner.query<{ id: string }>(
    "INSERT INTO site_devices (business_id, location_id, display_name) VALUES ($1, $2, 'Till') RETURNING id",
    [businessId, locationId],
  );
  return {
    businessId,
    locationId,
    menuItemId: item.rows[0].id,
    ownerId: user.rows[0].id,
    siteDeviceId: device.rows[0].id,
  };
}

async function makeParty(
  shop: Shop,
  role: "customer" | "employee" | "supplier",
  extra: { employeeUserId?: string; accountingCode?: string } = {},
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles, employee_user_id, accounting_code)
     VALUES ($1, $2, $3, ARRAY[$3]::text[], $4, $5) RETURNING id`,
    [shop.businessId, `${role}-${randomUUID().slice(0, 6)}`, role, extra.employeeUserId ?? null, extra.accountingCode ?? null],
  );
  return rows[0].id;
}

function takeaway(shop: Shop, customerId: string) {
  return dbLib.withTenant(shop.businessId, () =>
    orderMutations.createOrder({
      locationId: shop.locationId,
      type: "takeaway",
      customerId,
      discount: { type: null },
      items: [{ menuItemId: shop.menuItemId, quantity: 1 }],
      openedBy: null,
    }),
  );
}

describe("issue #1446 — tenant-backup heartbeat under FORCE RLS", () => {
  it("writes and reads its own heartbeat, and denies another tenant", async () => {
    const shop = await makeShop("Heartbeat Shop");
    const other = await makeShop("Heartbeat Other");

    await dbLib.withTenant(shop.businessId, () =>
      backupHybrid.recordHeartbeat({ businessId: shop.businessId, siteGeneration: 4 }),
    );
    const own = await dbLib.withTenant(shop.businessId, () =>
      backupHybrid.readHeartbeat(shop.businessId),
    );
    expect(own?.siteGeneration).toBe(4);

    // The same tenant cannot see another business's heartbeat…
    const crossRead = await dbLib.withTenant(other.businessId, () =>
      backupHybrid.readHeartbeat(shop.businessId),
    );
    expect(crossRead).toBeNull();

    // …and cannot write one outside its own scope (RLS WITH CHECK).
    await expect(
      dbLib.withTenant(shop.businessId, () =>
        backupHybrid.recordHeartbeat({ businessId: other.businessId, siteGeneration: 1 }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("issue #1446 — order customer-party role validation", () => {
  it("refuses a supplier or employee party, accepts it once it is a customer", async () => {
    const shop = await makeShop("Orders Shop");
    const supplier = await makeParty(shop, "supplier");
    const employee = await makeParty(shop, "employee");

    expect(await takeaway(shop, supplier)).toMatchObject({
      ok: false,
      error: "customer_role_required",
      status: 409,
    });
    expect(await takeaway(shop, employee)).toMatchObject({
      ok: false,
      error: "customer_role_required",
    });

    // A person who is both a supplier and a customer is a legitimate customer.
    await owner.query(
      "UPDATE parties SET roles = ARRAY['supplier','customer']::text[] WHERE id = $1",
      [supplier],
    );
    const accepted = await takeaway(shop, supplier);
    expect(accepted.ok).toBe(true);

    // Another business's customer is still refused outright.
    const other = await makeShop("Orders Other");
    const foreign = await makeParty(other, "customer");
    expect(await takeaway(shop, foreign)).toMatchObject({
      ok: false,
      error: "customer_not_found",
      status: 404,
    });
  });
});

describe("issue #1446 — central cached event errors become retryable, exactly once", () => {
  async function seedLegacyEvent(
    shop: Shop,
    opts: { applied?: boolean; error?: string | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO sync_events
         (location_id, client_event_id, event_type, payload, occurred_at,
          actor_user_id, actor_role, origin, scope, schema_version,
          applied_at, error, attempt_count)
       VALUES ($1, $2, 'order.create', '{}'::jsonb, now(), $3, 'owner', 'remote', 'location', 1,
               $4, $5, 1)`,
      [shop.locationId, id, shop.ownerId, opts.applied ? new Date() : null, opts.error ?? null],
    );
    return id;
  }

  it("only selects an event that never applied, and only within its business", async () => {
    const shop = await makeShop("Retry Shop");
    const appliedId = await seedLegacyEvent(shop, { applied: true, error: "customer_not_found" });
    const failedId = await seedLegacyEvent(shop, { error: "customer_not_found" });
    const other = await makeShop("Retry Other");

    const foreign = await syncEvents.requestSyncEventRetry({
      businessId: other.businessId,
      locationId: other.locationId,
      clientEventIds: [failedId],
    });
    expect(foreign.requested).toBe(0);

    const first = await dbLib.withTenant(shop.businessId, () =>
      syncEvents.requestSyncEventRetry({
        businessId: shop.businessId,
        locationId: shop.locationId,
        clientEventIds: [appliedId, failedId],
      }),
    );
    expect(first.requested).toBe(1); // the applied row is never selectable

    const again = await dbLib.withTenant(shop.businessId, () =>
      syncEvents.requestSyncEventRetry({
        businessId: shop.businessId,
        locationId: shop.locationId,
        clientEventIds: [failedId],
      }),
    );
    expect(again.requested).toBe(0); // already requested
  });

  it("re-applies a previously errored legacy event once the cause is fixed", async () => {
    const shop = await makeShop("Legacy Retry Shop");
    const clientEventId = await seedLegacyEvent(shop, { error: "customer_not_found" });

    await dbLib.withTenant(shop.businessId, () =>
      syncEvents.requestSyncEventRetry({
        businessId: shop.businessId,
        locationId: shop.locationId,
        clientEventIds: [clientEventId],
      }),
    );

    const event = {
      clientEventId,
      type: "order.create",
      occurredAt: new Date().toISOString(),
      payload: {
        type: "takeaway",
        items: [{ menuItemId: shop.menuItemId, quantity: 1 }],
        clientRequestId: randomUUID(),
      },
    };
    const applied = await dbLib.withTenant(shop.businessId, () =>
      syncEvents.applySyncEvent(
        shop.locationId,
        { userId: shop.ownerId, role: "owner" },
        event,
        "remote",
      ),
    );
    expect(applied.ok).toBe(true);

    const replayed = await dbLib.withTenant(shop.businessId, () =>
      syncEvents.applySyncEvent(
        shop.locationId,
        { userId: shop.ownerId, role: "owner" },
        event,
        "remote",
      ),
    );
    expect(replayed.ok).toBe(true);
    expect(replayed.duplicate).toBe(true);

    const { rows } = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE location_id = $1",
      [shop.locationId],
    );
    expect(rows[0].count).toBe("1");
    const stored = await owner.query<{ error: string | null; applied_at: Date | null; retry_requested_at: Date | null }>(
      "SELECT error, applied_at, retry_requested_at FROM sync_events WHERE location_id = $1 AND client_event_id = $2",
      [shop.locationId, clientEventId],
    );
    expect(stored.rows[0].error).toBeNull();
    expect(stored.rows[0].applied_at).not.toBeNull();
    expect(stored.rows[0].retry_requested_at).toBeNull();
  });
});

describe("issue #1446 — push refusal reaches a terminal, retryable dead letter", () => {
  it("dead-letters after the attempt cap without ever claiming delivery", async () => {
    const shop = await makeShop("Push Shop");
    const clientEventId = randomUUID();
    await owner.query(
      `INSERT INTO sync_events
         (location_id, client_event_id, event_type, payload, occurred_at,
          actor_user_id, actor_role, origin, scope, schema_version,
          applied_at, push_attempts)
       VALUES ($1, $2, 'order.create', '{"type":"takeaway"}'::jsonb, now(),
               $3, 'owner', 'local', 'location', 1, now(), $4)`,
      [shop.locationId, clientEventId, shop.ownerId, serverSync.MAX_PUSH_ATTEMPTS - 1],
    );
    await dbLib.withTenant(shop.businessId, () =>
      serverSync.setServerSyncConfig(shop.businessId, {
        remoteUrl: "https://central.example.com",
        token: "test-site-token",
        enabled: true,
        locationId: shop.locationId,
      }),
    );

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/server-sync/push")) {
        return new Response(
          JSON.stringify({
            // A business refusal, not a missing master row: this is the class
            // that still has to reach a terminal state (see the dependency case
            // below, which must never be quarantined).
            results: [{ clientEventId, ok: false, error: "invalid_order_type" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, requested: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await dbLib.withTenant(shop.businessId, () =>
        serverSync.runServerPush(shop.businessId),
      );
      expect(result.status).toBe("error");

      const row = await owner.query<{
        pushed_at: Date | null;
        error: string | null;
        next_push_at: Date | null;
        push_attempts: number;
      }>(
        "SELECT pushed_at, error, next_push_at, push_attempts FROM sync_events WHERE location_id = $1 AND client_event_id = $2",
        [shop.locationId, clientEventId],
      );
      expect(row.rows[0].pushed_at).toBeNull(); // never delivered
      expect(row.rows[0].error).toContain("invalid_order_type");
      expect(row.rows[0].next_push_at).toBeNull(); // no longer retried forever
      expect(row.rows[0].push_attempts).toBe(serverSync.MAX_PUSH_ATTEMPTS);

      const dead = await owner.query<{ id: number; status: string; error_code: string }>(
        "SELECT id, status, error_code FROM sync_event_dead_letters WHERE business_id = $1 AND client_event_id = $2",
        [shop.businessId, clientEventId],
      );
      expect(dead.rows[0]?.status).toBe("open");
      expect(dead.rows[0]?.error_code).toContain("invalid_order_type");

      const health = await dbLib.withTenant(shop.businessId, () =>
        healthService.getSyncHealth(shop.businessId),
      );
      expect(health.openDeadLetters).toBeGreaterThanOrEqual(1);
      expect(health.unsent).toBe(0); // a quarantined event is not "waiting to send"

      // The owner's existing retry control clears the terminal state, resets the
      // backoff and asks the central server to allow exactly this event again.
      const retried = await dbLib.withTenant(shop.businessId, () =>
        serverSync.updateSyncDeadLetter(shop.businessId, dead.rows[0].id, "retry", shop.ownerId, null),
      );
      expect(retried).toBe(true);
      const after = await owner.query<{
        error: string | null;
        push_attempts: number;
        pushed_at: Date | null;
      }>(
        "SELECT error, push_attempts, pushed_at FROM sync_events WHERE location_id = $1 AND client_event_id = $2",
        [shop.locationId, clientEventId],
      );
      expect(after.rows[0].error).toBeNull();
      expect(after.rows[0].push_attempts).toBe(0);
      expect(after.rows[0].pushed_at).toBeNull();
      const deadAfter = await owner.query<{ status: string }>(
        "SELECT status FROM sync_event_dead_letters WHERE id = $1",
        [dead.rows[0].id],
      );
      expect(deadAfter.rows[0].status).toBe("resolved");
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/api/server-sync/retry-events"),
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a missing-master-row refusal retryable and never quarantines it", async () => {
    const shop = await makeShop("Dependency Shop");
    const clientEventId = randomUUID();
    // Already at the cap: before this fix the very next refusal would have
    // dead-lettered a sale that was only waiting for its customer row.
    await owner.query(
      `INSERT INTO sync_events
         (location_id, client_event_id, event_type, payload, occurred_at,
          actor_user_id, actor_role, origin, scope, schema_version,
          applied_at, push_attempts)
       VALUES ($1, $2, 'order.create', '{"type":"takeaway"}'::jsonb, now(),
               $3, 'owner', 'local', 'location', 1, now(), $4)`,
      [shop.locationId, clientEventId, shop.ownerId, serverSync.MAX_PUSH_ATTEMPTS - 1],
    );
    await dbLib.withTenant(shop.businessId, () =>
      serverSync.setServerSyncConfig(shop.businessId, {
        remoteUrl: "https://central.example.com",
        token: `test-site-token-${clientEventId}`,
        enabled: true,
        locationId: shop.locationId,
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/api/server-sync/push")) {
          return new Response(
            JSON.stringify({
              results: [{ clientEventId, ok: false, error: "customer_not_found" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    try {
      const result = await dbLib.withTenant(shop.businessId, () =>
        serverSync.runServerPush(shop.businessId),
      );
      expect(result.status).toBe("error");

      const row = await owner.query<{
        pushed_at: Date | null;
        error: string | null;
        next_push_at: Date | null;
        push_attempts: number;
      }>(
        "SELECT pushed_at, error, next_push_at, push_attempts FROM sync_events WHERE location_id = $1 AND client_event_id = $2",
        [shop.locationId, clientEventId],
      );
      expect(row.rows[0].pushed_at).toBeNull();
      // The attempt counter is untouched: a dependency wait is not poison.
      expect(row.rows[0].push_attempts).toBe(serverSync.MAX_PUSH_ATTEMPTS - 1);
      expect(row.rows[0].error).toBeNull();
      // Offered again on the master feed's own 30 s cadence, not in 15 minutes.
      const waitMs = row.rows[0].next_push_at
        ? row.rows[0].next_push_at.getTime() - Date.now()
        : Number.NaN;
      expect(waitMs).toBeGreaterThan(0);
      expect(waitMs).toBeLessThanOrEqual(2 * 60_000);

      const dead = await owner.query<{ status: string }>(
        "SELECT status FROM sync_event_dead_letters WHERE business_id = $1 AND client_event_id = $2",
        [shop.businessId, clientEventId],
      );
      expect(dead.rows[0]?.status).toBeUndefined();

      const health = await dbLib.withTenant(shop.businessId, () =>
        healthService.getSyncHealth(shop.businessId),
      );
      expect(health.unsent).toBe(1); // still queued, honestly reported
      expect(health.openDeadLetters).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("issue #1446 — the security gate stays closed on an unreachable credential endpoint", () => {
  it("blocks operational traffic on a network failure and recovers when the endpoint answers", async () => {
    const shop = await makeShop("Gate Shop");
    await dbLib.withTenant(shop.businessId, () =>
      serverSync.setServerSyncConfig(shop.businessId, {
        remoteUrl: "https://unreachable.example.com",
        token: "test-site-token",
        enabled: true,
        locationId: shop.locationId,
        siteDeviceId: shop.siteDeviceId,
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND unreachable.example.com")),
    );
    try {
      const credential = await dbLib.withTenant(shop.businessId, () =>
        serverSync.refreshStagedSiteCredentialAttempt(shop.businessId),
      );
      expect(credential.ready).toBe(false); // never "treat fetch failure as success"

      const gate = await dbLib.withTenant(shop.businessId, () =>
        serverSync.runOperationalSyncGate(shop.businessId),
      );
      expect(gate.ready).toBe(false);
      // A transport failure of the credential probe is not a credential block
      // any more; with the whole cloud unreachable the IAM plane is what holds
      // the tick back, and it still reports why.
      expect(gate.reason).toBe("iam_failed");
      expect(gate.error ?? "").toMatch(/ENOTFOUND|fetch failed|unreachable/i);

      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(JSON.stringify({ pending: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      const recovered = await dbLib.withTenant(shop.businessId, () =>
        serverSync.refreshStagedSiteCredentialAttempt(shop.businessId),
      );
      expect(recovered.ready).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("issue #1446 — master conflict retries are bounded and never starve later changes", () => {
  it("quarantines a duplicate natural key after the bound while applying unrelated changes", async () => {
    const shop = await makeShop("Master Conflict Shop");
    const first = await makeParty(shop, "customer", { accountingCode: "C-100" });
    const second = await makeParty(shop, "customer", { accountingCode: "C-200" });
    const third = await makeParty(shop, "customer");

    // Newer than any locally stamped clock (the capture trigger stamps inserts
    // with the database's current HLC, which is a 2026 millisecond value).
    const hlc = "999999999999999.000000000000001.cloud";
    const conflicting = {
      table: "parties",
      rowId: second,
      deleted: false,
      rowHlc: hlc,
      clocks: { accounting_code: hlc },
      row: { accounting_code: "C-100" },
      writerNode: "cloud",
      locationId: null,
      txid: "42",
    };
    const unrelated = {
      table: "parties",
      rowId: third,
      deleted: false,
      rowHlc: hlc,
      clocks: { name: hlc },
      row: { name: "Renamed by the cloud" },
      writerNode: "cloud",
      locationId: null,
      txid: "42",
    };

    const outcomes: string[] = [];
    const unrelatedOutcomes: string[] = [];
    for (let attempt = 1; attempt <= masterSync.MAX_CONFLICT_ATTEMPTS; attempt += 1) {
      const result = await dbLib.withTenant(shop.businessId, () =>
        masterSync.applyMasterChanges(shop.businessId, [conflicting, unrelated]),
      );
      outcomes.push(result.outcomes[0]);
      unrelatedOutcomes.push(result.outcomes[1]);
    }
    // Bounded retries first (cursor would stop), then terminal quarantine.
    expect(outcomes.slice(0, -1).every((outcome) => outcome === "deferred")).toBe(true);
    expect(outcomes.at(-1)).toBe("conflict");
    // The unrelated change was delivered by the same page on the first attempt
    // and is an idempotent no-op on the retries — never held behind the
    // conflicted row.
    expect(unrelatedOutcomes[0]).toBe("applied");
    expect(unrelatedOutcomes.slice(1).every((outcome) => outcome === "noop")).toBe(true);

    const conflict = await owner.query<{ id: string; error_code: string; status: string; attempts: number }>(
      "SELECT id, error_code, status, attempts FROM sync_master_conflicts WHERE business_id = $1 AND row_id = $2",
      [shop.businessId, second],
    );
    expect(conflict.rows[0]).toMatchObject({ error_code: "unique_violation", status: "open" });

    // An unrelated change in the same page was applied every time, so the
    // blocked row never starved it.
    const renamed = await owner.query<{ name: string }>(
      "SELECT name FROM parties WHERE id = $1",
      [third],
    );
    expect(renamed.rows[0].name).toBe("Renamed by the cloud");

    // The report's shape: two employee parties with one employee_user_id can
    // never both be inserted, and the conflict says so instead of a bare
    // unique_violation.
    const employeeUser = randomUUID();
    await owner.query(
      `INSERT INTO users (id, business_id, location_id, role, full_name, password_hash, is_active)
       VALUES ($1, $2, $3, 'cashier', 'Employee', 'test-hash', true)`,
      [employeeUser, shop.businessId, shop.locationId],
    );
    await makeParty(shop, "employee", { employeeUserId: employeeUser });
    const incomingParty = randomUUID();
    const duplicate = await dbLib.withTenant(shop.businessId, () =>
      masterSync.applyMasterChanges(shop.businessId, [
        {
          table: "parties",
          rowId: incomingParty,
          deleted: false,
          rowHlc: hlc,
          clocks: {},
          row: {
            id: incomingParty,
            business_id: shop.businessId,
            name: "Employee (central)",
            role: "employee",
            roles: ["employee"],
            employee_user_id: employeeUser,
            is_active: true,
          },
          writerNode: "cloud",
          locationId: null,
          txid: "43",
        },
      ]),
    );
    expect(duplicate.outcomes[0]).toBe("conflict");
    const identity = await owner.query<{ error_code: string }>(
      "SELECT error_code FROM sync_master_conflicts WHERE business_id = $1 AND row_id = $2",
      [shop.businessId, incomingParty],
    );
    expect(identity.rows[0]?.error_code).toBe("employee_party_identity_conflict");

    // An operator acknowledgement is audited and closes that conflict.
    const resolved = await dbLib.withTenant(shop.businessId, () =>
      masterSync.resolveMasterConflict(
        shop.businessId,
        Number(conflict.rows[0].id),
        shop.ownerId,
        "identity reconciled out of band",
      ),
    );
    expect(resolved).toBe(true);
    const audit = await owner.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE business_id = $1 AND action = 'sync.master_conflict.resolved'",
      [shop.businessId],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    void first;
  });
});
