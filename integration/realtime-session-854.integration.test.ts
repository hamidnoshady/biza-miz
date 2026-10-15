/**
 * Issue #854 follow-up (third pass) — the live channel, under the production
 * runtime role.
 *
 * `/ws` authenticates a socket once, at the upgrade (server.ts). Its
 * 30-second re-check used to ask only whether the membership was still
 * usable, so a socket opened before «خروج» — or before the session was ended
 * from the security center — kept receiving the business's live events for
 * as long as it stayed open: the retained-token gap the HTTP routes no longer
 * have, on the one channel that is never requested again. And an
 * all-locations connection (an owner) matched every location on the server,
 * so on a central server hosting several businesses one business's owner
 * received every other business's order, table and low-stock events.
 *
 * Both are driven here through realtime.ts's real registry, the real
 * `resolveSessionFromToken` → `authorize` chain and the real logout route,
 * with the library pool on a purpose-created unprivileged role (the helper
 * and reasoning of authorization.integration.test.ts): row-level security is
 * on, as in production, so a read that escapes its tenant scope comes back
 * empty and fails the test instead of passing as the superuser would. Only
 * the socket itself is a stand-in.
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

  // Everything the registry, the session check and the logout route read goes
  // through the unprivileged role.
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  authLib = await import("../src/lib/auth");
  employeeService = await import("../src/lib/employee-service");
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
  await db.query("DELETE FROM businesses");
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

interface Member {
  id: string;
  businessId: string;
  role: "owner" | "cashier";
  /** Null for an all-locations member (an owner); a pinned member's location otherwise. */
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

async function addMember(business: Business, role: Member["role"], locationId: string | null): Promise<Member> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, location_id, location_scope)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [business.id, role, `${role}-${randomUUID().slice(0, 4)}`, locationId, locationId ? "home" : "all"],
  );
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

/** What server.ts does with an upgrade: authenticate the cookie, then register the socket with it. */
async function openSocket(token: string): Promise<FakeSocket> {
  const session = await authLib.resolveSessionFromToken(token);
  expect(session).not.toBeNull();
  const socket = new FakeSocket();
  sockets.push(socket);
  realtime.registerConnection(socket as unknown as WebSocket, session!, token);
  return socket;
}

/**
 * Waits until an all-locations socket has loaded its business's locations,
 * by probing a location only that socket can receive; the probes are then
 * forgotten.
 */
async function untilLoaded(socket: FakeSocket, locationId: string): Promise<void> {
  const probe = { type: "order.updated", orderId: `probe-${randomUUID()}` } as const;
  await vi.waitFor(
    () => {
      realtime.broadcast(locationId, probe);
      expect(socket.received).toContainEqual(probe);
    },
    { timeout: 10_000, interval: 50 },
  );
  socket.received.length = 0;
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
    // Loaded inside each owner's own tenant scope: under RLS an unscoped read
    // would come back empty and these would never arrive.
    await untilLoaded(alphaOwner, alphaSecond);
    await untilLoaded(betaOwner, betaMain);

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

describe("an open socket follows its session", () => {
  it("a socket opened before «خروج» closes at its next re-check; a live session's socket stays open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const alpha = await seedBusiness("Alpha", 1);
    const [alphaMain] = alpha.locationIds;
    const ownerToken = await signIn(await addMember(alpha, "owner", null));
    const cashierToken = await signIn(await addMember(alpha, "cashier", alphaMain));
    const ownerSocket = await openSocket(ownerToken);
    const cashierSocket = await openSocket(cashierToken);
    await untilLoaded(ownerSocket, alphaMain);
    cashierSocket.received.length = 0;

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
