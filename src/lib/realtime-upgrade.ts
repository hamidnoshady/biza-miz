/**
 * Issue #1003 item 4 — the decisions server.ts makes about a `/ws` upgrade,
 * pulled out of the raw `upgrade` handler so they can be tested.
 *
 * An upgrade request arrives as a bare socket, outside Next and outside every
 * framework safety net: whatever the handler does not explicitly answer and
 * destroy stays open. The handler used to read the session cookie with an
 * unguarded `decodeURIComponent` and await the session lookup with no
 * try/catch, so a cookie containing a lone `%`, or a database hiccup, made the
 * async handler reject *before* it reached `socket.destroy()` — leaving an
 * unauthenticated TCP connection held open for as long as the peer liked. It
 * also checked the Origin only after a database round trip, so a cross-site
 * page could make the server do that work for every attempt.
 *
 * Here every outcome is a value: `authorizeRealtimeUpgrade` never throws, and
 * the order is cheapest-first — Origin, then cookie, then session, then branch
 * scope — so a request that can be refused for free is.
 *
 * Also here: the per-message size cap and the ping/pong heartbeat. `ws`
 * defaults to accepting 100 MiB messages and has no liveness check at all, so
 * a client that vanished without a FIN (a tablet leaving Wi-Fi, a NAT entry
 * expiring) stayed registered — and kept being sent events — indefinitely.
 */
import { STATUS_CODES } from "node:http";

/**
 * The largest message a client may send. The browser client never sends
 * anything (useRealtime only listens) and the server registers no message
 * handler; this only bounds what a hostile client can make `ws` buffer.
 */
export const REALTIME_MAX_PAYLOAD_BYTES = 64 * 1024;

/** How often each socket is pinged; one missed pong in a row terminates it. */
export const REALTIME_HEARTBEAT_MS = 30_000;

/**
 * A cookie's value from a raw `Cookie` header, or null when it is absent —
 * or malformed. A value that does not percent-decode (a lone `%`, a truncated
 * escape) is treated exactly like no cookie: it cannot be anybody's session.
 */
export function readCookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** The branch-scope answer `resolveRealtimeScope` (src/lib/realtime.ts) gives. */
export type RealtimeScopeLike<S> =
  | { ok: true; session: S; locationIds: ReadonlySet<string> }
  | { ok: false; status: 401 | 403 };

export type RealtimeUpgradeDecision<S> =
  | { ok: true; token: string; session: S; locationIds: ReadonlySet<string> }
  | { ok: false; status: 401 | 403 | 503 };

/**
 * Whether this upgrade may become a realtime socket, and as whom.
 *
 *   1. Origin (no I/O)          → 403 when a browser sends a foreign one
 *   2. session cookie           → 401 when absent or malformed
 *   3. session lookup           → 401 when invalid; 503 when it throws
 *   4. branch scope             → its own 401/403; 503 when it throws
 *
 * 503 for a failed lookup, as before for the scope: "try again later" lets
 * the client back off, where a 401 would read as "signed out".
 */
export async function authorizeRealtimeUpgrade<S>(
  request: { originAllowed: boolean; cookieHeader: string | undefined },
  deps: {
    cookieName: string;
    resolveSession(token: string): Promise<S | null>;
    resolveScope(session: S): Promise<RealtimeScopeLike<S>>;
    log?: (message: string) => void;
  },
): Promise<RealtimeUpgradeDecision<S>> {
  const log = deps.log ?? ((message: string) => console.error(message));
  if (!request.originAllowed) return { ok: false, status: 403 };

  const token = readCookieValue(request.cookieHeader, deps.cookieName);
  if (!token) return { ok: false, status: 401 };

  let session: S | null;
  try {
    session = await deps.resolveSession(token);
  } catch (error) {
    log(`WebSocket session lookup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { ok: false, status: 503 };
  }
  if (!session) return { ok: false, status: 401 };

  // Branch scope before the socket opens (#854 follow-up): the same
  // authorization every route uses decides which branches' events this
  // session may receive. A session that may not act in its pinned branch —
  // or whose membership is gone — is refused here rather than accepted and
  // then closed, so the client backs off instead of reconnecting every
  // second; a failed read refuses too, because an unresolved scope must
  // deliver nothing.
  let scope: RealtimeScopeLike<S>;
  try {
    scope = await deps.resolveScope(session);
  } catch (error) {
    log(`WebSocket authorization failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { ok: false, status: 503 };
  }
  if (!scope.ok) return { ok: false, status: scope.status };
  return { ok: true, token, session: scope.session, locationIds: scope.locationIds };
}

/** The slice of a raw upgrade socket `rejectUpgrade` needs (a `stream.Duplex`). */
export interface UpgradeSocket {
  readonly destroyed: boolean;
  readonly writable: boolean;
  end(chunk: string): unknown;
  destroy(): unknown;
  once(event: "finish", listener: () => void): unknown;
}

/**
 * Answer an upgrade with a plain HTTP status and close the socket — always.
 *
 * `end()` then destroy once the response is flushed (how `ws` itself aborts a
 * handshake), so the client actually receives the status rather than a reset;
 * a peer that never lets the bytes drain is destroyed after a short grace
 * period regardless. Safe to call on a socket that is already gone.
 */
export function rejectUpgrade(socket: UpgradeSocket, status: number, graceMs = 2_000): void {
  if (socket.destroyed) return;
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const timer = setTimeout(() => socket.destroy(), graceMs);
  timer.unref?.();
  socket.once("finish", () => {
    clearTimeout(timer);
    socket.destroy();
  });
  try {
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    clearTimeout(timer);
    socket.destroy();
  }
}

/** The slice of a `ws` WebSocket the heartbeat needs. */
export interface HeartbeatSocket {
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
}

export interface RealtimeHeartbeat {
  /** Start watching a freshly opened socket; it counts as alive until the first round. */
  track(ws: HeartbeatSocket): void;
  /** Stop pinging (shutdown). Sockets are left to the caller to close. */
  stop(): void;
}

/**
 * Ping every client each `intervalMs`; terminate the ones that did not answer
 * the previous ping. Browsers (and the `ws` client) answer pings on their
 * own, so a live client costs two small frames per interval and a dead one is
 * gone within two intervals — `terminate` fires its `close`, which is what
 * removes it from the realtime registry. The timer is unref'd so it never
 * holds the process open by itself.
 */
export function createRealtimeHeartbeat(
  clients: Iterable<HeartbeatSocket>,
  intervalMs = REALTIME_HEARTBEAT_MS,
): RealtimeHeartbeat {
  const alive = new WeakSet<HeartbeatSocket>();
  const timer = setInterval(() => {
    for (const ws of clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, intervalMs);
  timer.unref?.();
  return {
    track(ws) {
      alive.add(ws);
      ws.on("pong", () => alive.add(ws));
    },
    stop() {
      clearInterval(timer);
    },
  };
}
