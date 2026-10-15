import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { SessionPayload } from "./auth";

/**
 * The live-sync registry (realtime.ts) against a stand-in socket. Two
 * properties of the #854 follow-up live here:
 *
 * - an open socket is authenticated again on every re-check exactly as a
 *   request is (`resolveSessionFromToken`), so a socket opened before
 *   «خروج», a revoked session or an ended support grant closes instead of
 *   outliving it on the strength of the membership alone;
 * - an all-locations connection (an owner, a roaming manager) receives only
 *   its own business's locations' events — on a central server hosting
 *   several businesses it used to receive every business's.
 *
 * What `resolveSessionFromToken` refuses after a sign-out, for every door
 * that mints a session, is proven against a real schema in
 * integration/session-revocation-854.integration.test.ts.
 */

const mocks = vi.hoisted(() => ({
  resolveSessionFromToken: vi.fn(),
  authorize: vi.fn(),
  withTenant: vi.fn(),
  query: vi.fn(),
  locations: new Map<string, string[]>(),
  scope: { businessId: null as string | null },
}));

vi.mock("./auth", () => ({ resolveSessionFromToken: mocks.resolveSessionFromToken }));
vi.mock("./authorize", () => ({ authorize: mocks.authorize }));
vi.mock("./db", () => ({ withTenant: mocks.withTenant, query: mocks.query }));

import { REAUTH_INTERVAL_MS, broadcast, connectionCount, disconnectMember, registerConnection } from "./realtime";

/** The slice of `ws.WebSocket` the registry uses. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly received: unknown[] = [];
  readonly send = vi.fn((payload: string) => {
    this.received.push(JSON.parse(payload));
  });
  readonly close = vi.fn((code?: number, reason?: string) => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, reason);
  });
}

const sockets: FakeSocket[] = [];

function sessionOf(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sub: "member-a",
    role: "owner",
    businessId: "business-a",
    locationId: null,
    fullName: "مالک",
    employeeSessionId: "session-a",
    ...overrides,
  } as SessionPayload;
}

/** How many times one business's locations have been read. */
function loadsOf(businessId: string): number {
  return mocks.query.mock.calls.filter(([, params]) => (params as unknown[])[0] === businessId).length;
}

/** Opens a socket and, for an all-locations one, lets its location set load. */
async function open(session: SessionPayload, token = "token-a"): Promise<FakeSocket> {
  const loadsBefore = loadsOf(session.businessId);
  const socket = new FakeSocket();
  sockets.push(socket);
  registerConnection(socket as unknown as WebSocket, session, token);
  if (session.locationId === null) {
    await vi.waitFor(() => expect(loadsOf(session.businessId)).toBeGreaterThan(loadsBefore));
  }
  await settle();
  return socket;
}

/** Lets pending promise chains (every stub is async) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Lets the re-check interval elapse without expecting it to do anything. */
async function elapse(): Promise<void> {
  vi.advanceTimersByTime(REAUTH_INTERVAL_MS);
  await settle();
}

/** Fires one re-check and waits until it has authenticated the token and finished. */
async function tick(): Promise<void> {
  const checksBefore = mocks.resolveSessionFromToken.mock.calls.length;
  vi.advanceTimersByTime(REAUTH_INTERVAL_MS);
  await vi.waitFor(() => expect(mocks.resolveSessionFromToken.mock.calls.length).toBeGreaterThan(checksBefore));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  mocks.locations.clear();
  mocks.locations.set("business-a", ["location-a1", "location-a2"]);
  mocks.locations.set("business-b", ["location-b1"]);
  mocks.withTenant.mockImplementation(async (businessId: string, fn: () => Promise<unknown>) => {
    const outer = mocks.scope.businessId;
    mocks.scope.businessId = businessId;
    try {
      return await fn();
    } finally {
      mocks.scope.businessId = outer;
    }
  });
  mocks.query.mockImplementation(async (_sql: string, params: unknown[]) => {
    const [businessId] = params as [string];
    // The registry must read a business's locations inside that business's
    // own tenant scope, never another's and never none.
    if (mocks.scope.businessId !== businessId) throw new Error("query outside its own tenant scope");
    return { rows: (mocks.locations.get(businessId) ?? []).map((id) => ({ id })) };
  });
  mocks.resolveSessionFromToken.mockImplementation(async () => sessionOf());
  mocks.authorize.mockImplementation(async (session: SessionPayload) => ({ ok: true, session }));
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close(1000, "test over");
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("registerConnection — an open socket is authenticated again, as every request is", () => {
  it("re-checks the token it was opened with on every interval, then the membership", async () => {
    const owner = sessionOf();
    const socket = await open(owner, "token-a");

    await tick();
    expect(mocks.resolveSessionFromToken).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSessionFromToken).toHaveBeenCalledWith("token-a");
    expect(mocks.authorize).toHaveBeenCalledWith(owner, { locationId: null });
    expect(socket.close).not.toHaveBeenCalled();

    await tick();
    expect(mocks.resolveSessionFromToken).toHaveBeenCalledTimes(2);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("closes a socket whose session has ended — «خروج», a revoked session, an ended support grant", async () => {
    const socket = await open(sessionOf());
    mocks.resolveSessionFromToken.mockResolvedValue(null);

    await tick();
    expect(socket.close).toHaveBeenCalledWith(1008, "Session Ended");
    // The membership alone no longer keeps it open: it is not even asked.
    expect(mocks.authorize).not.toHaveBeenCalled();
    // And the closed socket is out of the registry: nothing more reaches it.
    broadcast("location-a1", { type: "order.updated", orderId: "order-1" });
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("closes a socket whose membership no longer authorizes it", async () => {
    const socket = await open(sessionOf());
    mocks.authorize.mockResolvedValue({ ok: false, code: "MEMBERSHIP_INACTIVE", status: 401 });

    await tick();
    expect(socket.close).toHaveBeenCalledWith(1008, "Authorization Revoked");
  });

  it("fails closed when the check itself fails, without logging the token", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const socket = await open(sessionOf(), "secret-session-token");
    mocks.resolveSessionFromToken.mockRejectedValue(new Error("database unavailable"));

    await tick();
    expect(socket.close).toHaveBeenCalledWith(1011, "Authorization Check Failed");
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls.map((call) => call.map(String)))).not.toContain("secret-session-token");
  });

  it("stops re-checking once the socket has closed", async () => {
    const socket = await open(sessionOf());
    socket.close(1000, "page closed");

    await elapse();
    await elapse();
    expect(mocks.resolveSessionFromToken).not.toHaveBeenCalled();
    expect(connectionCount()).toBe(0);
  });
});

describe("broadcast — business isolation of all-locations connections", () => {
  it("delivers a location's event to its own business's owner and pinned staff only", async () => {
    const ownerA = await open(sessionOf());
    const ownerB = await open(sessionOf({ sub: "member-b", businessId: "business-b", employeeSessionId: "session-b" }), "token-b");
    const cashierA1 = await open(
      sessionOf({ sub: "cashier-a", role: "cashier", locationId: "location-a1", employeeSessionId: "session-c" }),
      "token-c",
    );

    broadcast("location-b1", { type: "order.created", orderId: "order-b" });
    expect(ownerB.received).toEqual([{ type: "order.created", orderId: "order-b" }]);
    expect(ownerA.received).toEqual([]);
    expect(cashierA1.received).toEqual([]);

    broadcast("location-a2", { type: "table.status", tableId: "table-2", status: "occupied" });
    expect(ownerA.received).toEqual([{ type: "table.status", tableId: "table-2", status: "occupied" }]);
    expect(ownerB.received).toHaveLength(1);
    expect(cashierA1.received).toEqual([]);

    broadcast("location-a1", {
      type: "inventory.low_stock",
      inventoryItemId: "item-1",
      name: "شیر",
      quantity: 1,
      reorderLevel: 5,
    });
    expect(ownerA.received).toHaveLength(2);
    expect(cashierA1.received).toHaveLength(1);
    expect(ownerB.received).toHaveLength(1);

    broadcast("location-elsewhere", { type: "order.updated", orderId: "order-x" });
    expect([ownerA, ownerB, cashierA1].map((socket) => socket.received.length)).toEqual([2, 1, 1]);
  });

  it("reads an all-locations connection's locations inside its own tenant scope; a pinned one reads none", async () => {
    await open(sessionOf({ sub: "cashier-a", role: "cashier", locationId: "location-a1" }));
    expect(mocks.withTenant).not.toHaveBeenCalled();

    await open(sessionOf({ sub: "member-b", businessId: "business-b" }), "token-b");
    expect(mocks.withTenant).toHaveBeenCalledTimes(1);
    expect(mocks.withTenant.mock.calls[0][0]).toBe("business-b");
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("FROM locations WHERE business_id = $1"), ["business-b"]);
  });

  it("receives nothing — not everything — until its locations have loaded, and closes if they cannot load", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let failLoad: (error: Error) => void = () => {};
    mocks.query.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failLoad = reject;
        }),
    );
    const socket = new FakeSocket();
    sockets.push(socket);
    registerConnection(socket as unknown as WebSocket, sessionOf(), "token-a");
    await settle();

    broadcast("location-a1", { type: "order.updated", orderId: "order-1" });
    broadcast("location-b1", { type: "order.updated", orderId: "order-2" });
    expect(socket.send).not.toHaveBeenCalled();

    failLoad(new Error("database unavailable"));
    await settle();
    expect(socket.close).toHaveBeenCalledWith(1011, "Authorization Check Failed");
    expect(errors).toHaveBeenCalled();
  });

  it("starts delivering a branch opened after the socket connected from the next re-check", async () => {
    const owner = await open(sessionOf());
    mocks.locations.set("business-a", ["location-a1", "location-a2", "location-a3"]);

    broadcast("location-a3", { type: "order.created", orderId: "order-new-branch" });
    expect(owner.received).toEqual([]);

    await tick();
    broadcast("location-a3", { type: "order.created", orderId: "order-new-branch" });
    expect(owner.received).toEqual([{ type: "order.created", orderId: "order-new-branch" }]);
  });

  it("disconnectMember closes only that member's sockets in that business", async () => {
    const ownerA = await open(sessionOf());
    const sameIdElsewhere = await open(sessionOf({ businessId: "business-b", employeeSessionId: "session-b" }), "token-b");

    expect(disconnectMember("business-a", "member-a")).toBe(1);
    expect(ownerA.close).toHaveBeenCalledWith(1008, "Access Revoked");
    expect(sameIdElsewhere.close).not.toHaveBeenCalled();
  });
});
