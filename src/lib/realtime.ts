/**
 * Server-side WebSocket registry for live sync (Phase 4): the custom server
 * (server.ts) accepts `/ws` upgrades and hands each authenticated socket to
 * `registerConnection`; API route handlers call `broadcast` after a mutation
 * commits so every connected cashier/waiter/KDS screen updates within ~1s.
 *
 * A connection pinned to a location (`locationId` set) receives that
 * location's events; an all-locations connection (a null `locationId`: an
 * owner or a roaming manager) receives every location *of its own business*.
 * Covered by realtime.test.ts against a stand-in socket.
 */
import type { WebSocket } from "ws";
import type { SessionPayload } from "./auth";

export type RealtimeEvent =
  | { type: "order.created"; orderId: string }
  | { type: "order.updated"; orderId: string }
  | { type: "order.item_status"; orderId: string; itemId: string; status: string }
  | { type: "table.status"; tableId: string; status: string }
  | { type: "table_session.updated"; sessionId: string }
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
   * For an all-locations connection, the ids of its own business's
   * locations — what `broadcast` matches it against. Empty until the first
   * load answers (so it receives nothing rather than everything), and
   * reloaded on every re-authorization, which is how a branch opened after
   * the socket starts reaching it. Unused for a pinned connection.
   */
  businessLocationIds: ReadonlySet<string>;
}

// Cached on globalThis so dev-mode hot reload of this module doesn't spawn a
// second, disconnected registry (same pattern as getPool() in db.ts).
const globalForRt = globalThis as unknown as { rtConnections?: Set<Connection> };
const connections = globalForRt.rtConnections ?? (globalForRt.rtConnections = new Set());

/** How often an open socket is authenticated and authorized again. */
export const REAUTH_INTERVAL_MS = 30_000;

/** Every location of one business, read inside that business's own tenant scope. */
async function loadBusinessLocationIds(businessId: string): Promise<Set<string>> {
  const { query, withTenant } = await import("./db");
  const { rows } = await withTenant(businessId, () =>
    query<{ id: string }>("SELECT id FROM locations WHERE business_id = $1", [businessId]),
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Registers an upgraded socket. `token` is the session cookie it was opened
 * with: the upgrade authenticated it once, and every re-authorization
 * authenticates it again exactly as an HTTP request is authenticated
 * (`resolveSessionFromToken`: signature and expiry, the support grant, the
 * `employee_sessions` row, the identity's token version, the native device).
 * Until the #854 follow-up the re-check looked only at the membership, so a
 * socket opened before «خروج» — or before the session was ended from the
 * security center, or a support grant ended — kept receiving the business's
 * live events for as long as it stayed open.
 */
export function registerConnection(ws: WebSocket, session: SessionPayload, token: string): void {
  const conn: Connection = { ws, session, businessLocationIds: new Set() };
  connections.add(conn);
  ws.on("close", () => connections.delete(conn));
  ws.on("error", () => connections.delete(conn));

  const allLocations = session.locationId === null;
  const refreshLocations = async () => {
    if (allLocations) conn.businessLocationIds = await loadBusinessLocationIds(conn.session.businessId);
  };
  refreshLocations().catch((error: unknown) => {
    console.error("WebSocket location scope failed to load", error);
    ws.close(1011, "Authorization Check Failed");
  });

  // Long-lived channels re-authenticate the token and re-authorize against
  // current membership and branch state; JWT role claims are never trusted
  // for the lifetime of a socket.
  const interval = setInterval(async () => {
    try {
      const { resolveSessionFromToken } = await import("./auth");
      const current = await resolveSessionFromToken(token);
      if (!current) {
        ws.close(1008, "Session Ended");
        return;
      }
      const { authorize } = await import("./authorize");
      const decision = await authorize(current, { locationId: current.locationId });
      if (!decision.ok) {
        ws.close(1008, "Authorization Revoked");
        return;
      }
      conn.session = decision.session;
      await refreshLocations();
    } catch (error) {
      console.error("WebSocket re-authorization failed", error);
      ws.close(1011, "Authorization Check Failed");
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
    connection.ws.close(1008, reason);
    connections.delete(connection);
    closed += 1;
  }
  return closed;
}

/**
 * Sends `event` to every connection pinned to `locationId` and to every
 * all-locations connection of the business that owns it. Location ids are
 * unique, so the pinned match was always exact; an all-locations connection
 * used to match every location on the server, which on a central server
 * hosting several businesses handed one owner every other business's order,
 * table and low-stock events.
 */
export function broadcast(locationId: string, event: RealtimeEvent): void {
  const payload = JSON.stringify(event);
  for (const { ws, session, businessLocationIds } of connections) {
    const reaches = session.locationId === null ? businessLocationIds.has(locationId) : session.locationId === locationId;
    if (!reaches) continue;
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

export function connectionCount(): number {
  return connections.size;
}
