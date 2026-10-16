import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { SessionPayload } from "./auth";

/**
 * The live-sync registry (realtime.ts) against a stand-in socket. What lives
 * here (#854 follow-up):
 *
 * - an open socket is authenticated again on every re-check exactly as a
 *   request is (`resolveSessionFromToken`), so a socket opened before
 *   «خروج», a revoked session or an ended support grant closes instead of
 *   outliving it;
 * - every connection receives only the branches the member may act in, as
 *   decided by authorize.ts: a pinned connection its own branch while it is
 *   still authorized (never an unauthorized one), an unpinned connection the
 *   branches its scope reaches (selected branches for a member with no home
 *   branch — never the rest, never another business's);
 * - the scope is re-decided on every re-check and emptied the moment a check
 *   fails, so a changed assignment or a failed read never leaves a socket
 *   receiving on a stale scope.
 *
 * `authorize` and `actionableLocationIds` are stand-ins here; the real ones
 * run under an unprivileged database role in
 * integration/realtime-session-854.integration.test.ts.
 */

const mocks = vi.hoisted(() => ({
  resolveSessionFromToken: vi.fn(),
  authorize: vi.fn(),
  actionableLocationIds: vi.fn(),
  /** The branches each member may act in right now, as authorize.ts would decide. */
  access: new Map<string, string[]>(),
}));

vi.mock("./auth", () => ({ resolveSessionFromToken: mocks.resolveSessionFromToken }));
vi.mock("./authorize", () => ({ authorize: mocks.authorize, actionableLocationIds: mocks.actionableLocationIds }));

import {
  REAUTH_INTERVAL_MS,
  broadcast,
  connectionCount,
  disconnectMember,
  registerConnection,
  resolveRealtimeScope,
} from "./realtime";

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
    sub: "owner-a",
    role: "owner",
    businessId: "business-a",
    locationId: null,
    fullName: "مالک",
    employeeSessionId: "session-a",
    ...overrides,
  } as SessionPayload;
}

const OWNER_A = sessionOf();
const OWNER_B = sessionOf({ sub: "owner-b", businessId: "business-b", employeeSessionId: "session-b" });
const CASHIER_A1 = sessionOf({ sub: "cashier-a1", role: "cashier", locationId: "a1", employeeSessionId: "session-c" });
const SELECTED_NO_HOME = sessionOf({ sub: "selected-a", role: "manager", locationId: null, employeeSessionId: "session-s" });

/** What server.ts does with an upgrade: decide the scope, then register (or refuse). */
async function open(session: SessionPayload, token = `token-${session.sub}`): Promise<FakeSocket> {
  const scope = await resolveRealtimeScope(session);
  if (!scope.ok) throw new Error(`refused ${scope.status}`);
  const socket = new FakeSocket();
  sockets.push(socket);
  registerConnection(socket as unknown as WebSocket, scope.session, token, scope.locationIds);
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

/** One event per branch, so a test can read off exactly which branches a socket heard. */
function broadcastToEvery(...locationIds: string[]): void {
  for (const locationId of locationIds) broadcast(locationId, { type: "order.updated", orderId: `order-${locationId}` });
}

const heard = (socket: FakeSocket) => socket.received.map((event) => (event as { orderId: string }).orderId.replace("order-", ""));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  mocks.access.clear();
  mocks.access.set("owner-a", ["a1", "a2", "a3"]);
  mocks.access.set("owner-b", ["b1"]);
  mocks.access.set("cashier-a1", ["a1"]);
  mocks.access.set("selected-a", ["a2"]);
  // The token re-check hands back the session the token names.
  mocks.resolveSessionFromToken.mockImplementation(async (token: string) => {
    const sub = token.replace("token-", "");
    return [OWNER_A, OWNER_B, CASHIER_A1, SELECTED_NO_HOME].find((s) => s.sub === sub) ?? null;
  });
  // authorize.ts, reduced to what the registry relies on: the membership is
  // usable, and a named branch is one the member may act in.
  mocks.authorize.mockImplementation(async (session: SessionPayload, request: { locationId?: string | null } = {}) => {
    if (!mocks.access.has(session.sub)) return { ok: false, code: "MEMBERSHIP_NOT_FOUND", status: 401 };
    if (request.locationId && !mocks.access.get(session.sub)!.includes(request.locationId)) {
      return { ok: false, code: "LOCATION_FORBIDDEN", status: 403 };
    }
    return { ok: true, session, membership: { userId: session.sub, businessId: session.businessId } };
  });
  mocks.actionableLocationIds.mockImplementation(async (membership: { userId: string }) => [
    ...(mocks.access.get(membership.userId) ?? []),
  ]);
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close(1000, "test over");
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("resolveRealtimeScope — the branches a session may hear, decided by authorize.ts", () => {
  it("a pinned session asks about its own branch and hears only that branch", async () => {
    const scope = await resolveRealtimeScope(CASHIER_A1);
    expect(mocks.authorize).toHaveBeenCalledWith(CASHIER_A1, { locationId: "a1" });
    expect(mocks.actionableLocationIds).not.toHaveBeenCalled();
    expect(scope).toEqual({ ok: true, session: CASHIER_A1, locationIds: new Set(["a1"]) });
  });

  it("refuses a pinned session whose branch the member may no longer act in — it never gets a scope", async () => {
    mocks.access.set("cashier-a1", ["a2"]);
    expect(await resolveRealtimeScope(CASHIER_A1)).toEqual({ ok: false, status: 403 });
  });

  it("an unpinned session hears exactly the branches its scope reaches — selected ones for a member with no home branch", async () => {
    const scope = await resolveRealtimeScope(SELECTED_NO_HOME);
    expect(mocks.authorize).toHaveBeenCalledWith(SELECTED_NO_HOME, {});
    expect(scope).toEqual({ ok: true, session: SELECTED_NO_HOME, locationIds: new Set(["a2"]) });
  });

  it("refuses a session whose membership is gone, as a 401", async () => {
    mocks.access.delete("owner-a");
    expect(await resolveRealtimeScope(OWNER_A)).toEqual({ ok: false, status: 401 });
  });

  it("lets a failed read propagate, so the caller fails closed", async () => {
    mocks.actionableLocationIds.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(resolveRealtimeScope(OWNER_A)).rejects.toThrow("database unavailable");
  });
});

describe("broadcast — each connection hears its own scope and nothing else", () => {
  it("delivers by scope: owners their own business, a pinned cashier its branch, a selected member its selection", async () => {
    const ownerA = await open(OWNER_A);
    const ownerB = await open(OWNER_B);
    const cashierA1 = await open(CASHIER_A1);
    const selected = await open(SELECTED_NO_HOME);

    broadcastToEvery("a1", "a2", "a3", "b1", "elsewhere");
    expect(heard(ownerA)).toEqual(["a1", "a2", "a3"]);
    expect(heard(ownerB)).toEqual(["b1"]);
    expect(heard(cashierA1)).toEqual(["a1"]);
    // Selected scope, no home branch: the selected branch only — not every
    // branch of the business, which is what it used to get.
    expect(heard(selected)).toEqual(["a2"]);
  });

  it("delivers exactly the scope a socket was registered with, never more", async () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    registerConnection(socket as unknown as WebSocket, OWNER_A, "token-owner-a", new Set());
    broadcastToEvery("a1", "a2", "a3");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("delivers the low-stock payload intact to the branches that may hear it", async () => {
    const cashierA1 = await open(CASHIER_A1);
    const event = { type: "inventory.low_stock", inventoryItemId: "item-1", name: "شیر", quantity: 1, reorderLevel: 5 } as const;
    broadcast("a1", event);
    broadcast("a2", event);
    expect(cashierA1.received).toEqual([event]);
  });
});

describe("registerConnection — an open socket is authenticated and authorized again on every interval", () => {
  it("re-checks the token it was opened with, then the scope", async () => {
    const socket = await open(OWNER_A, "token-owner-a");
    mocks.authorize.mockClear();

    await tick();
    expect(mocks.resolveSessionFromToken).toHaveBeenLastCalledWith("token-owner-a");
    expect(mocks.authorize).toHaveBeenCalledWith(OWNER_A, {});
    expect(socket.close).not.toHaveBeenCalled();

    await tick();
    expect(mocks.resolveSessionFromToken).toHaveBeenCalledTimes(2);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("closes a socket whose session has ended — «خروج», a revoked session, a closed support grant — and delivers nothing after", async () => {
    const socket = await open(OWNER_A);
    mocks.authorize.mockClear();
    mocks.resolveSessionFromToken.mockResolvedValue(null);

    await tick();
    expect(socket.close).toHaveBeenCalledWith(1008, "Session Ended");
    expect(mocks.authorize).not.toHaveBeenCalled();
    broadcastToEvery("a1", "a2");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("closes a socket whose membership no longer authorizes it", async () => {
    const socket = await open(OWNER_A);
    mocks.access.delete("owner-a");

    await tick();
    expect(socket.close).toHaveBeenCalledWith(1008, "Authorization Revoked");
    broadcastToEvery("a1");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("follows a changed branch assignment on an open socket: a removed branch stops, an added one starts", async () => {
    const selected = await open(SELECTED_NO_HOME);
    mocks.access.set("selected-a", ["a3"]);
    broadcastToEvery("a2", "a3");
    // Until the next re-check the old scope stands; no new branch is heard early.
    expect(heard(selected)).toEqual(["a2"]);

    await tick();
    selected.received.length = 0;
    broadcastToEvery("a1", "a2", "a3", "b1");
    expect(heard(selected)).toEqual(["a3"]);
    expect(selected.close).not.toHaveBeenCalled();
  });

  it("closes a pinned socket at the next re-check once its branch is withdrawn, and it hears nothing more", async () => {
    const cashierA1 = await open(CASHIER_A1);
    mocks.access.set("cashier-a1", ["a2"]);

    await tick();
    expect(cashierA1.close).toHaveBeenCalledWith(1008, "Authorization Revoked");
    broadcastToEvery("a1", "a2");
    expect(cashierA1.send).not.toHaveBeenCalled();
  });

  it("a scope that reaches nothing keeps the socket open and silent", async () => {
    const selected = await open(SELECTED_NO_HOME);
    mocks.access.set("selected-a", []);

    await tick();
    broadcastToEvery("a1", "a2", "a3");
    expect(selected.send).not.toHaveBeenCalled();
    expect(selected.close).not.toHaveBeenCalled();
  });

  it("fails closed when the scope cannot be read on a re-check: closed, and nothing delivered", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const selected = await open(SELECTED_NO_HOME);
    mocks.actionableLocationIds.mockRejectedValueOnce(new Error("permission denied for table user_locations"));

    await tick();
    expect(selected.close).toHaveBeenCalledWith(1011, "Authorization Check Failed");
    broadcastToEvery("a2");
    expect(selected.send).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
  });

  it("fails closed when the session check itself fails, without logging the token", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const socket = await open(OWNER_A, "token-owner-a");
    mocks.resolveSessionFromToken.mockRejectedValue(new Error("database unavailable"));

    await tick();
    expect(socket.close).toHaveBeenCalledWith(1011, "Authorization Check Failed");
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls.map((call) => call.map(String)))).not.toContain("token-owner-a");
  });

  it("stops re-checking once the socket has closed", async () => {
    const socket = await open(OWNER_A);
    socket.close(1000, "page closed");

    await elapse();
    await elapse();
    expect(mocks.resolveSessionFromToken).not.toHaveBeenCalled();
    expect(connectionCount()).toBe(0);
  });
});

describe("disconnectMember — an IAM revocation closes the member's sockets at once", () => {
  it("closes only that member's sockets in that business, and they hear nothing more", async () => {
    const ownerA = await open(OWNER_A);
    const cashierA1 = await open(CASHIER_A1);

    expect(disconnectMember("business-a", "owner-a")).toBe(1);
    expect(ownerA.close).toHaveBeenCalledWith(1008, "Access Revoked");
    broadcastToEvery("a1");
    expect(ownerA.send).not.toHaveBeenCalled();
    expect(heard(cashierA1)).toEqual(["a1"]);
  });
});
