/**
 * Server-side WebSocket registry for live sync (Phase 4): the custom server
 * (server.ts) accepts `/ws` upgrades and hands each authenticated socket to
 * `registerConnection`; API route handlers call `broadcast` after a mutation
 * commits so every connected cashier/waiter/KDS screen updates within ~1s.
 *
 * Every connection carries the set of branches whose events it may receive,
 * decided by the same authorization every route uses (`authorize` and
 * `actionableLocationIds` in authorize.ts — membership, business status and
 * branch scope, including a Hybrid site's local branch restriction):
 *
 * - a connection pinned to a branch (`session.locationId` set) receives that
 *   branch's events, and only while the member may still act in it;
 * - a connection with no pinned branch (an owner, or a member with no home
 *   branch) receives the branches of its own business that its scope reaches —
 *   all of them for an owner or an `all` scope, the selected ones for a
 *   `selected` scope, none for `none`.
 *
 * The set is resolved before the socket is accepted (server.ts refuses the
 * upgrade otherwise), recomputed on every re-authorization, and emptied the
 * moment a re-check fails, so a socket never receives events on a stale or
 * unresolved scope. Covered by realtime.test.ts against a stand-in socket and by
 * integration/realtime-session-854.integration.test.ts under an unprivileged
 * database role.
 */
import type { WebSocket } from "ws";
import type { SessionPayload } from "./auth";

export type RealtimeEvent =
  | { type: "order.created"; orderId: string }
  | { type: "order.updated"; orderId: string }
  | { type: "order.item_status"; orderId: string; itemId: string; status: string }
  | { type: "table.status"; tableId: string; status: string }
  | { type: "table_session.updated"; sessionId: string }
  | { type: "floor.updated"; entity?: string; entityId?: string }
  | {
      type: "inventory.low_stock";
      inventoryItemId: string;
      name: string;
      quantity: number;
      reorderLevel: number;
    };

interface Connection {
  ws: WebSocket;
  session: SessionPayload;
  /**
   * The branches whose events this connection may receive right now — what
   * `broadcast` matches against. Replaced on every re-authorization and emptied
   * before a socket is closed for a failed or refused re-check.
   */
  allowedLocationIds: ReadonlySet<string>;
}

// Cached on globalThis so dev-mode hot reload of this module doesn't spawn a
// second, disconnected registry (same pattern as getPool() in db.ts).
const globalForRt = globalThis as unknown as { rtConnections?: Set<Connection> };
const connections = globalForRt.rtConnections ?? (globalForRt.rtConnections = new Set());

/** How often an open socket is authenticated and authorized again. */
export const REAUTH_INTERVAL_MS = 30_000;

const NOTHING: ReadonlySet<string> = new Set();

/** What a session may receive on the live channel, or why it may not open one. */
export type RealtimeScope =
  | { ok: true; session: SessionPayload; locationIds: ReadonlySet<string> }
  | { ok: false; status: 401 | 403 };

/**
 * Decides which branches' events `session` may receive, from the database, now.
 *
 * A pinned session asks `authorize` about its branch (`canActInLocation`): the
 * branch must be an active branch of the member's own business that the
 * member's scope reaches, or the socket is refused — an unauthorized pinned
 * branch never receives anything. A session with no pinned branch receives
 * `actionableLocationIds`: every branch the member may act in, which never
 * includes another business's. A throw (a failed read) propagates; callers
 * fail closed on it.
 */
export async function resolveRealtimeScope(session: SessionPayload): Promise<RealtimeScope> {
  const { authorize, actionableLocationIds } = await import("./authorize");
  const pinned = session.locationId ?? null;
  const decision = await authorize(session, pinned ? { locationId: pinned } : {});
  if (!decision.ok) return { ok: false, status: decision.status === 401 ? 401 : 403 };
  const locationIds = pinned ? new Set([pinned]) : new Set(await actionableLocationIds(decision.membership));
  return { ok: true, session: decision.session, locationIds };
}

/**
 * Registers an upgraded socket. `token` is the session cookie it was opened
 * with and `locationIds` the scope `resolveRealtimeScope` granted it at the
 * upgrade.
 *
 * Every re-authorization authenticates the token again exactly as an HTTP
 * request is authenticated (`resolveSessionFromToken`: signature and expiry, the
 * support grant, the `employee_sessions` row, the identity's token version, the
 * native device) and then re-decides the scope, so a socket follows «خروج», a
 * session ended from the security center, a closed support grant, a suspended
 * membership and a changed branch assignment within one interval.
 */
export function registerConnection(
  ws: WebSocket,
  session: SessionPayload,
  token: string,
  locationIds: ReadonlySet<string>,
): void {
  const conn: Connection = { ws, session, allowedLocationIds: new Set(locationIds) };
  connections.add(conn);
  ws.on("close", () => connections.delete(conn));
  ws.on("error", () => connections.delete(conn));

  const end = (code: number, reason: string) => {
    conn.allowedLocationIds = NOTHING;
    ws.close(code, reason);
  };

  // Long-lived channels re-authenticate the token and re-authorize against
  // current membership and branch state; JWT role claims are never trusted
  // for the lifetime of a socket.
  const interval = setInterval(async () => {
    try {
      const { resolveSessionFromToken } = await import("./auth");
      const current = await resolveSessionFromToken(token);
      if (!current) {
        end(1008, "Session Ended");
        return;
      }
      const scope = await resolveRealtimeScope(current);
      if (!scope.ok) {
        end(1008, "Authorization Revoked");
        return;
      }
      conn.session = scope.session;
      conn.allowedLocationIds = scope.locationIds;
    } catch (error) {
      console.error("WebSocket re-authorization failed", error instanceof Error ? error.message : "unknown error");
      end(1011, "Authorization Check Failed");
    }
  }, REAUTH_INTERVAL_MS);
  interval.unref();

  ws.on("close", () => clearInterval(interval));
}

/** Close a member's sockets immediately after IAM revocation commits. */
export function disconnectMember(businessId: string, userId: string, reason = "Access Revoked"): number {
  let closed = 0;
  for (const connection of connections) {
    if (connection.session.businessId !== businessId || connection.session.sub !== userId) continue;
    connection.allowedLocationIds = NOTHING;
    connection.ws.close(1008, reason);
    connections.delete(connection);
    closed += 1;
  }
  return closed;
}

/**
 * Sends `event` to every connection whose current scope includes `locationId`.
 * Location ids are unique across businesses, and a scope only ever holds
 * branches of the connection's own business, so this is also the tenant
 * boundary: an all-locations connection used to match every location on the
 * server (#854 follow-up), and a pinned one used to be served before its branch
 * access had been checked at all.
 */
export function broadcast(locationId: string, event: RealtimeEvent): void {
  const payload = JSON.stringify(event);
  for (const { ws, allowedLocationIds } of connections) {
    if (!allowedLocationIds.has(locationId)) continue;
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

export function connectionCount(): number {
  return connections.size;
}
