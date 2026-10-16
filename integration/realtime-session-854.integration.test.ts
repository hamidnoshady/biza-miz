/**
 * Issue #854 follow-up — the live channel, under the production runtime role.
 *
 * `/ws` authenticates a socket at the upgrade (server.ts) and re-checks it
 * every 30 seconds. Three gaps were closed on it:
 *
 * - **The session.** The re-check used to ask only whether the membership was
 *   still usable, so a socket opened before «خروج» — or before the session was
 *   ended from the security center, or a support grant closed — kept
 *   receiving the business's live events for as long as it stayed open.
 * - **The business.** An all-locations connection (an owner) matched every
 *   location on the server, so on a central server hosting several businesses
 *   one business's owner received every other business's events.
 * - **The branch.** An all-locations connection received every branch of its
 *   business whatever the member's branch scope (a member limited to selected
 *   branches with no home branch heard all of them), and a pinned connection
 *   was served before anyone had asked whether the member could still act in
 *   its branch.
 *
 * All of it is driven here through realtime.ts's real registry, the real
 * `resolveSessionFromToken` → `authorize` → `actionableLocationIds` chain and
 * the real logout and support-close paths, with the library pool on a
 * purpose-created unprivileged role (the helper and reasoning of
 * authorization.integration.test.ts): row-level security is on, as in
 * production, so a read that escapes its tenant scope fails the test instead of
 * passing as the superuser would. Only the socket itself is a stand-in, and
 * `upgrade()` below does exactly what server.ts does with one.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
  }),
  headers: async () => new Headers(),
}));

const APP_ROLE = "pos_realtime_854_role";
const APP_PASSWORD = "realtime-854-password";

let databaseName: string;
/** Owner connection: seeds fixtures and reads results, bypassing RLS on purpose. */
let db: Client;

let dbLib: typeof import("../src/lib/db");
let authLib: typeof import("../src/lib/auth");
let employeeService: typeof import("../src/lib/employee-service");
let platformService: typeof import("../src/lib/platform-service");
let realtime: typeof import("../src/lib/realtime");
let logoutRoute: typeof import("../src/app/api/auth/logout/route");

function urlFor(database: string, role?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = role.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_realtime_854_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({ databaseUrl: urlFor(databaseName), roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });

  // Everything the registry, the session check, the scope and the logout
  // route read goes through the unprivileged role.
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  authLib = await import("../src/lib/auth");
  employeeService = await import("../src/lib/employee-service");
  platformService = await import("../src/lib/platform-service");
  realtime = await import("../src/lib/realtime");
  logoutRoute = await import("../src/app/api/auth/logout/route");

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
    await maintenance.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } finally {
    await maintenance.end();
  }
});

/** The slice of `ws.WebSocket` the registry uses. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly received: Array<Record<string, unknown>> = [];
  readonly send = vi.fn((payload: string) => {
    this.received.push(JSON.parse(payload) as Record<string, unknown>);
  });
  readonly close = vi.fn((code?: number, reason?: string) => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, reason);
  });
}

const sockets: FakeSocket[] = [];

beforeEach(async () => {
  cookieJar.clear();
  await db.query("DELETE FROM impersonation_grants");
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_admins");
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close(1000, "test over");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures (seeded through the owner connection)
// ---------------------------------------------------------------------------

interface Business {
  id: string;
  locationIds: string[];
}

type Scope = "all" | "selected" | "home" | "none";

interface Member {
  id: string;
  businessId: string;
  role: "owner" | "manager" | "cashier";
  /** The home branch — what a session pins its socket to — or null for none. */
  locationId: string | null;
}

async function seedBusiness(name: string, locations: number): Promise<Business> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, `realtime-854-${randomUUID().slice(0, 8)}`],
  );
  const locationIds: string[] = [];
  for (let i = 0; i < locations; i += 1) {
    const location = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id`,
      [rows[0].id, `Branch ${i + 1}`],
    );
    locationIds.push(location.rows[0].id);
  }
  return { id: rows[0].id, locationIds };
}

async function addMember(
  business: Business,
  role: Member["role"],
  locationId: string | null,
  options: { scope?: Scope; selected?: string[] } = {},
): Promise<Member> {
  const scope: Scope = options.scope ?? (locationId ? "home" : "all");
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, location_id, location_scope)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [business.id, role, `${role}-${randomUUID().slice(0, 4)}`, locationId, scope],
  );
  for (const selected of options.selected ?? []) {
    await db.query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`, [rows[0].id, selected]);
  }
  return { id: rows[0].id, businessId: business.id, role, locationId };
}

/** A sign-in the way every door does it since the third pass: a row, then a token naming it. */
async function signIn(member: Member): Promise<string> {
  const { session } = await dbLib.withTenant(member.businessId, () =>
    employeeService.createSession(member.id, member.businessId, { loginMethod: "password" }),
  );
  return authLib.signSession({
    sub: member.id,
    role: member.role,
    businessId: member.businessId,
    locationId: member.locationId,
    fullName: "Member",
    employeeSessionId: session.id,
    recentAuthAt: Math.floor(Date.now() / 1000),
  });
}

type Upgrade = { socket: FakeSocket } | { refused: 401 | 403 } | { failed: true };

/**
 * What server.ts does with an upgrade: authenticate the cookie, decide the
 * branch scope, then register the socket with both — or refuse it (401/403),
 * or answer 503 when the scope cannot be read (`failed`).
 */
async function upgrade(token: string): Promise<Upgrade> {
  const session = await authLib.resolveSessionFromToken(token);
  if (!session) return { refused: 401 };
  const scope = await realtime.resolveRealtimeScope(session).catch(() => null);
  if (!scope) return { failed: true };
  if (!scope.ok) return { refused: scope.status };
  const socket = new FakeSocket();
  sockets.push(socket);
  realtime.registerConnection(socket as unknown as WebSocket, scope.session, token, scope.locationIds);
  return { socket };
}

async function openSocket(token: string): Promise<FakeSocket> {
  const result = await upgrade(token);
  if (!("socket" in result)) throw new Error(`upgrade refused: ${JSON.stringify(result)}`);
  return result.socket;
}

/** One event per branch, so a test can read off exactly which branches a socket heard. */
function broadcastToEvery(...locationIds: string[]): void {
  for (const locationId of locationIds) {
    realtime.broadcast(locationId, { type: "order.updated", orderId: `order-${locationId}` });
  }
}

const heard = (socket: FakeSocket) =>
  socket.received.map((event) => String(event.orderId).replace("order-", ""));

function forget(...all: FakeSocket[]): void {
  for (const socket of all) socket.received.length = 0;
}

/**
 * Fires every socket's re-check, then waits until a probe sent to `locationId`
 * reaches `socket` (`reaches`) or no longer does — the observable end of that
 * re-check. The probes are then forgotten.
 */
async function recheckUntil(socket: FakeSocket, locationId: string, reaches: boolean, others: FakeSocket[] = []): Promise<void> {
  vi.advanceTimersByTime(realtime.REAUTH_INTERVAL_MS);
  await vi.waitFor(
    () => {
      const probe = { type: "order.updated", orderId: `probe-${randomUUID()}` } as const;
      realtime.broadcast(locationId, probe);
      expect(socket.received.some((event) => event.orderId === probe.orderId)).toBe(reaches);
    },
    { timeout: 10_000, interval: 50 },
  );
  forget(socket, ...others);
}

function signOut(token: string) {
  cookieJar.set(authLib.SESSION_COOKIE, token);
  return logoutRoute.POST(
    new NextRequest("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { "user-agent": "Vitest Browser", cookie: `${authLib.SESSION_COOKIE}=${token}` },
    }),
  );
}

async function lastSeen(token: string): Promise<Date | null> {
  const payload = await authLib.verifySession(token);
  const { rows } = await db.query<{ last_seen_at: Date | null }>(
    `SELECT last_seen_at FROM employee_sessions WHERE id = $1`,
    [payload!.employeeSessionId],
  );
  return rows[0]?.last_seen_at ?? null;
}

// ---------------------------------------------------------------------------

describe("live events reach only the business they belong to", () => {
  it("an owner's socket gets its own branches' events and no other business's; a cashier's only its own branch's", async () => {
    const alpha = await seedBusiness("Alpha", 2);
    const beta = await seedBusiness("Beta", 1);
    const [alphaMain, alphaSecond] = alpha.locationIds;
    const [betaMain] = beta.locationIds;

    const alphaOwner = await openSocket(await signIn(await addMember(alpha, "owner", null)));
    const betaOwner = await openSocket(await signIn(await addMember(beta, "owner", null)));
    const alphaCashier = await openSocket(await signIn(await addMember(alpha, "cashier", alphaMain)));

    realtime.broadcast(betaMain, {
      type: "inventory.low_stock",
      inventoryItemId: randomUUID(),
      name: "قهوه",
      quantity: 2,
      reorderLevel: 10,
    });
    expect(betaOwner.received).toHaveLength(1);
    expect(alphaOwner.received).toEqual([]);
    expect(alphaCashier.received).toEqual([]);

    realtime.broadcast(alphaSecond, { type: "order.created", orderId: "alpha-second-order" });
    expect(alphaOwner.received).toEqual([{ type: "order.created", orderId: "alpha-second-order" }]);
    expect(alphaCashier.received).toEqual([]);
    expect(betaOwner.received).toHaveLength(1);

    realtime.broadcast(alphaMain, { type: "table.status", tableId: "table-1", status: "occupied" });
    expect(alphaOwner.received).toHaveLength(2);
    expect(alphaCashier.received).toEqual([{ type: "table.status", tableId: "table-1", status: "occupied" }]);
    expect(betaOwner.received).toHaveLength(1);
  });
});

describe("live events follow the member's current branch access", () => {
  it("each scope hears exactly its branches across two businesses; an unauthorized pinned branch is refused at the upgrade", async () => {
    const alpha = await seedBusiness("Alpha", 3);
    const beta = await seedBusiness("Beta", 2);
    const [a1, a2, a3] = alpha.locationIds;
    const [b1, b2] = beta.locationIds;

    const owner = await openSocket(await signIn(await addMember(alpha, "owner", null)));
    const managerAll = await openSocket(await signIn(await addMember(alpha, "manager", null, { scope: "all" })));
    // Selected scope with no home branch: the case that used to hear every branch.
    const selectedNoHome = await openSocket(
      await signIn(await addMember(alpha, "manager", null, { scope: "selected", selected: [a2] })),
    );
    const homeCashier = await openSocket(await signIn(await addMember(alpha, "cashier", a1, { scope: "home" })));
    const pinnedSelectedCashier = await openSocket(
      await signIn(await addMember(alpha, "cashier", a3, { scope: "selected", selected: [a3] })),
    );
    const noneManager = await openSocket(await signIn(await addMember(alpha, "manager", null, { scope: "none" })));
    const betaSelected = await openSocket(
      await signIn(await addMember(beta, "manager", null, { scope: "selected", selected: [b2] })),
    );

    // A pinned branch the member's scope does not reach (home a1, selection a2):
    // refused before a socket ever exists, so it can never receive a1's events.
    const outsideSelection = await upgrade(
      await signIn(await addMember(alpha, "cashier", a1, { scope: "selected", selected: [a2] })),
    );
    expect(outsideSelection).toEqual({ refused: 403 });
    // Likewise a pinned branch of a `none` scope.
    expect(await upgrade(await signIn(await addMember(alpha, "cashier", a2, { scope: "none" })))).toEqual({ refused: 403 });

    broadcastToEvery(a1, a2, a3, b1, b2);
    expect(heard(owner)).toEqual([a1, a2, a3]);
    expect(heard(managerAll)).toEqual([a1, a2, a3]);
    expect(heard(selectedNoHome)).toEqual([a2]);
    expect(heard(homeCashier)).toEqual([a1]);
    expect(heard(pinnedSelectedCashier)).toEqual([a3]);
    expect(heard(noneManager)).toEqual([]);
    expect(heard(betaSelected)).toEqual([b2]);
  });

  it("an open socket follows a changed assignment: an added branch starts, a removed branch stops", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const alpha = await seedBusiness("Alpha", 3);
    const [a1, a2, a3] = alpha.locationIds;
    const member = await addMember(alpha, "manager", null, { scope: "selected", selected: [a2] });
    const socket = await openSocket(await signIn(member));

    await db.query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`, [member.id, a3]);
    await recheckUntil(socket, a3, true);
    broadcastToEvery(a1, a2, a3);
    expect(heard(socket)).toEqual([a2, a3]);
    forget(socket);

    await db.query(`DELETE FROM user_locations WHERE user_id = $1 AND location_id = $2`, [member.id, a2]);
    await recheckUntil(socket, a2, false);
    broadcastToEvery(a1, a2, a3);
    expect(heard(socket)).toEqual([a3]);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("an open socket follows a narrowed scope: `all` becomes one selected branch", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const alpha = await seedBusiness("Alpha", 3);
    const [a1, a2, a3] = alpha.locationIds;
    const member = await addMember(alpha, "manager", null, { scope: "all" });
    const socket = await openSocket(await signIn(member));
    broadcastToEvery(a1, a2, a3);
    expect(heard(socket)).toEqual([a1, a2, a3]);
    forget(socket);

    await db.query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`, [member.id, a1]);
    await db.query(`UPDATE users SET location_scope = 'selected' WHERE id = $1`, [member.id]);
    await recheckUntil(socket, a2, false);
    broadcastToEvery(a1, a2, a3);
    expect(heard(socket)).toEqual([a1]);
  });

  it("a pinned socket closes once its branch is withdrawn, and another once its membership is suspended; neither hears more", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const alpha = await seedBusiness("Alpha", 2);
    const [a1, a2] = alpha.locationIds;
    const withdrawn = await addMember(alpha, "cashier", a1, { scope: "home" });
    const suspended = await addMember(alpha, "cashier", a2, { scope: "home" });
    const withdrawnSocket = await openSocket(await signIn(withdrawn));
    const suspendedSocket = await openSocket(await signIn(suspended));

    await db.query(`UPDATE users SET location_scope = 'none' WHERE id = $1`, [withdrawn.id]);
    await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [suspended.id]);
    vi.advanceTimersByTime(realtime.REAUTH_INTERVAL_MS);
    await vi.waitFor(
      () => {
        expect(withdrawnSocket.close).toHaveBeenCalledWith(1008, "Authorization Revoked");
        expect(suspendedSocket.close).toHaveBeenCalled();
      },
      { timeout: 10_000 },
    );
    broadcastToEvery(a1, a2);
    expect(withdrawnSocket.send).not.toHaveBeenCalled();
    expect(suspendedSocket.send).not.toHaveBeenCalled();
  });

  it("a support session's socket closes once its grant is closed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const alpha = await seedBusiness("Alpha", 1);
    const [a1] = alpha.locationIds;
    await addMember(alpha, "owner", null);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO platform_admins (email, password_hash, full_name, role) VALUES ($1, 'x', 'Operator', 'support') RETURNING id`,
      [`op-${randomUUID().slice(0, 8)}@example.com`],
    );
    const adminId = rows[0].id;
    const { grant, userId, fullName } = await platformService.startImpersonation({
      adminId,
      businessId: alpha.id,
      mode: "read_only",
      reason: "بررسی مشکل گزارش‌شده توسط مشتری",
      allowedCapabilities: [],
    });
    const token = await authLib.signSession({
      sub: userId,
      role: "owner",
      businessId: alpha.id,
      locationId: null,
      fullName,
      imp: { grantId: grant.id, adminId, mode: "read_only", allowedCapabilities: grant.allowedCapabilities },
    });
    const socket = await openSocket(token);
    broadcastToEvery(a1);
    expect(heard(socket)).toEqual([a1]);
    forget(socket);

    const closed = await platformService.closeSupportSession(grant.id, { type: "operator", adminId }, { channel: "test" });
    expect(closed.status).not.toBe("not_active");
    vi.advanceTimersByTime(realtime.REAUTH_INTERVAL_MS);
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledWith(1008, "Session Ended"), { timeout: 10_000 });
    broadcastToEvery(a1);
    expect(heard(socket)).toEqual([]);
  });

  it("a failed scope read fails closed: an open socket closes and hears nothing, and a new upgrade is not accepted", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const alpha = await seedBusiness("Alpha", 2);
    const [a1, a2] = alpha.locationIds;
    const member = await addMember(alpha, "manager", null, { scope: "selected", selected: [a2] });
    const token = await signIn(member);
    const socket = await openSocket(token);
    broadcastToEvery(a1, a2);
    expect(heard(socket)).toEqual([a2]);
    forget(socket);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // A real failure of the scope read: the runtime role loses SELECT on the
    // assignment table, so reading the member's selected branches errors.
    await db.query(`REVOKE SELECT ON user_locations FROM ${APP_ROLE}`);
    try {
      vi.advanceTimersByTime(realtime.REAUTH_INTERVAL_MS);
      await vi.waitFor(() => expect(socket.close).toHaveBeenCalledWith(1011, "Authorization Check Failed"), {
        timeout: 10_000,
      });
      broadcastToEvery(a1, a2);
      expect(heard(socket)).toEqual([]);
      expect(await upgrade(token)).toEqual({ failed: true });
      expect(errors).toHaveBeenCalled();
      expect(JSON.stringify(errors.mock.calls.map((call) => call.map(String)))).not.toContain(token);
    } finally {
      await db.query(`GRANT SELECT ON user_locations TO ${APP_ROLE}`);
    }
    // Once the read works again, the same session is accepted with its scope.
    const again = await openSocket(token);
    broadcastToEvery(a1, a2);
    expect(heard(again)).toEqual([a2]);
  });
});

describe("an open socket follows its session", () => {
  it("a socket opened before «خروج» closes at its next re-check; a live session's socket stays open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const alpha = await seedBusiness("Alpha", 1);
    const [alphaMain] = alpha.locationIds;
    const ownerToken = await signIn(await addMember(alpha, "owner", null));
    const cashierToken = await signIn(await addMember(alpha, "cashier", alphaMain));
    const ownerSocket = await openSocket(ownerToken);
    const cashierSocket = await openSocket(cashierToken);

    const out = await signOut(ownerToken);
    expect(out.status).toBe(200);
    expect(await out.json()).toMatchObject({ ok: true, outcome: "revoked" });
    // The sign-out itself does not reach into the registry; the socket's own
    // re-check is what ends it, within one interval, on whichever server
    // instance holds it.
    expect(ownerSocket.close).not.toHaveBeenCalled();

    await db.query(`UPDATE employee_sessions SET last_seen_at = NULL`);
    vi.advanceTimersByTime(realtime.REAUTH_INTERVAL_MS);
    await vi.waitFor(() => expect(ownerSocket.close).toHaveBeenCalledWith(1008, "Session Ended"), { timeout: 10_000 });

    // The cashier's session is live: the same re-check authenticated its token
    // (its row's activity marker moved) and authorized it, under RLS, and the
    // socket is still open and still receiving.
    await vi.waitFor(async () => expect(await lastSeen(cashierToken)).not.toBeNull(), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(cashierSocket.close).not.toHaveBeenCalled();
    realtime.broadcast(alphaMain, { type: "order.updated", orderId: "after-sign-out" });
    expect(cashierSocket.received).toEqual([{ type: "order.updated", orderId: "after-sign-out" }]);
    expect(ownerSocket.send).not.toHaveBeenCalledWith(expect.stringContaining("after-sign-out"));
  });

  it("a socket closes once the session is ended from elsewhere, not only by «خروج»", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const alpha = await seedBusiness("Alpha", 1);
    const member = await addMember(alpha, "owner", null);
    const token = await signIn(member);
    const socket = await openSocket(token);

    // The security center's «پایان نشست» and every other revocation end the row.
    const payload = await authLib.verifySession(token);
    await employeeService.revokeSession(payload!.employeeSessionId!, alpha.id, member.id);

    vi.advanceTimersByTime(realtime.REAUTH_INTERVAL_MS);
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledWith(1008, "Session Ended"), { timeout: 10_000 });
  });
});
