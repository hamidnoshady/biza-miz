/**
 * A fixed-window request counter, plus the small pieces of key-building it
 * needs. Deliberately pure and store-agnostic (the caller owns the Map) so it
 * runs unmodified in `src/middleware.ts`'s Edge runtime, which has no
 * `node:async_hooks` and no database connection — the only state this file
 * ever touches is the Map passed in.
 */

import { INTERNAL_AUTH_HEADER, internalAuthToken } from "./internal-auth";

export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export function isPrivateIp(ip: string): boolean {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("127.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
    ip === "::1" ||
    ip.toLowerCase().startsWith("fc00:") ||
    ip.toLowerCase().startsWith("fe80:")
  );
}

/**
 * Whether `X-Real-IP` may be believed.
 *
 * It used to be read first and unconditionally, which quietly made every
 * IP-keyed limit in this app opt-in for the attacker: Caddy — the proxy in
 * front of both the LAN and the hosted deployment — sets `X-Forwarded-For` and
 * says nothing about `X-Real-IP`, so a client-supplied `X-Real-IP: 1.2.3.4`
 * arrived here untouched and became the rate-limit key. Rotating it walks past
 * the login brute-force limiter; pinning it to somebody else's address spends
 * their lockout budget for them.
 *
 * `X-Forwarded-For` does not have that problem, because `trustedHops` counts
 * back from the end of the chain the proxy appended to, so a forged prefix is
 * skipped. So the header is now only honoured where an operator has said their
 * proxy overwrites it (nginx's `proxy_set_header X-Real-IP` does; Caddy does
 * not) by setting `TRUST_X_REAL_IP=true`.
 */
function trustsRealIpHeader(): boolean {
  return (process.env.TRUST_X_REAL_IP ?? "").toLowerCase() === "true";
}

/**
 * Issue #1003 — the TCP peer address, as server.ts saw it.
 *
 * server.ts sets this on every request from `socket.remoteAddress` after
 * deleting whatever a client sent under the same name, so unlike the forwarded
 * headers it cannot be supplied from outside. It is the last resort when no
 * proxy has said who the client is: an absent or empty `X-Forwarded-For` used
 * to put the caller in one shared `unknown` bucket, where one person's failed
 * sign-ins counted against everyone else who landed there too.
 */
export const PEER_ADDRESS_HEADER = "x-pos-peer-address";

/**
 * A socket's remote address in the form the rate limiter keys on, or null.
 * A dual-stack listener reports IPv4 peers as `::ffff:192.0.2.1`, which is
 * unwrapped so a peer has one key whichever way it connected.
 */
export function normalizePeerAddress(address: string | null | undefined): string | null {
  const value = address?.trim() ?? "";
  if (!value) return null;
  const unmapped = /^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(value) ? value.slice("::ffff:".length) : value;
  return /^[0-9a-f:.]+(%[\w.-]+)?$/i.test(unmapped) ? unmapped : null;
}

function forwardedClientIp(forwarded: string, trustedHops: number): string {
  const parts = forwarded.split(",").map((s) => s.trim());

  if (trustedHops > 0) {
    // Count back `trustedHops` entries from the end, NOT one further. The
    // last entry was appended by our own trusted proxy and names the peer it
    // saw, so with the default one hop that entry *is* the client. Taking
    // `length - 1 - trustedHops` reads one position further left, which on a
    // forged `X-Forwarded-For: 1.2.3.4` returns the attacker's own value —
    // letting them pin the login limiter to someone else's address. This is
    // the index Phase 24 specified; the code had drifted from it.
    const index = Math.max(0, parts.length - trustedHops);
    return parts[index];
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    if (!isPrivateIp(parts[i])) return parts[i];
  }
  return parts[parts.length - 1];
}

export function clientIpFrom(headers: Headers, trustedHops: number): string {
  if (trustsRealIpHeader()) {
    const realIp = headers.get("x-real-ip");
    if (realIp) return realIp;
  }

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const ip = forwardedClientIp(forwarded, trustedHops);
    if (ip) return ip;
  }

  // Nothing usable forwarded — no header, an empty one, or an empty entry in
  // the position `trustedHops` names (`X-Forwarded-For: ,`). The peer this
  // server actually saw is still a per-client key; "unknown" is everyone's.
  return headers.get(PEER_ADDRESS_HEADER)?.trim() || "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the caller may retry; 0 when allowed. */
  retryAfterMs: number;
}

/**
 * The durable counter is best-effort: if it cannot be reached the limiter still
 * works, just per-process again. That degradation must be *visible* — it
 * silently reinstates the reset-on-restart, per-replica behaviour Wave 5 exists
 * to remove — but logging a stack trace on every single request turns one
 * misconfiguration into an unreadable log and a performance problem of its own.
 * So: complain immediately, then at a decreasing rate.
 */
let durableFailures = 0;

function noteDurableFailure(reason: string): void {
  durableFailures += 1;
  const isPowerOfTen = /^10*$/.test(String(durableFailures));
  if (durableFailures === 1 || isPowerOfTen) {
    console.error(
      `rate-limit: durable (Postgres) counter unreachable — falling back to the per-process ` +
        `counter, which resets on restart and is not shared across replicas. ` +
        `Occurrence ${durableFailures}. Reason: ${reason}`,
    );
  }
}

/**
 * Where middleware calls the durable counter that lives in this same process.
 *
 * The default is the process's own loopback listener, not the request's
 * public origin — deliberately. In a container behind a TLS-terminating proxy
 * the public hostname is very often *unreachable from inside the container*:
 * NAT hairpinning is not guaranteed, the proxy may refuse to talk to its own
 * public address, and the container's /etc/hosts knows nothing about it. The
 * fetch then dies at the transport layer ("fetch failed") on every single
 * limited request and the limiter quietly falls back to the per-process Map —
 * which is exactly the reset-on-restart, not-shared-across-replicas behaviour
 * this counter exists to remove, but with no failure visible to the user.
 *
 * Loopback has none of that exposure: it never leaves the host, needs no DNS
 * or proxy, and the data the route touches lives in Postgres anyway — so
 * hitting whichever local replica answered the request is just as durable and
 * just as shared across replicas as routing the call any other way.
 *
 * INTERNAL_BASE_URL stays as an explicit override for the unusual layout where
 * the Node runtime serving /api/internal is a different container/host from
 * the one running middleware (e.g. a split-tier deploy). It does not need to
 * be set for a plain reverse-proxy install; the default already handles that.
 */
export function internalBaseOrigin(env?: Record<string, string | undefined>): string {
  const source = env ?? process.env;
  const configured = source.INTERNAL_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const port = Number(source.PORT) || 3000;
  return `http://127.0.0.1:${port}`;
}

export async function checkRateLimit(
  _store: Map<string, RateLimitEntry> | null,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<RateLimitResult> {
  // Phase 24 Wave 5 — the durable counter lives in Postgres, which this (Edge)
  // runtime cannot reach, so it is asked for over HTTP. The call is signed
  // with the internal secret because the endpoint writes a shared table and
  // has no session to authenticate: see src/lib/internal-auth.ts.
  //
  // `now` is deliberately NOT sent. The window is anchored on the database
  // clock; letting the caller supply the time let a forged call rewind its own
  // window forever. It stays in the signature for the in-memory fallback
  // below, which is per-process and has no such exposure.
  //
  // The target defaults to this process's loopback listener (see
  // internalBaseOrigin) so it works behind a proxy that terminates the public
  // hostname; INTERNAL_BASE_URL overrides it for split-tier deployments.
  try {
    const token = await internalAuthToken();
    if (token) {
      const origin = internalBaseOrigin();
      const res = await fetch(`${origin}/api/internal/rate-limit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [INTERNAL_AUTH_HEADER]: token },
        body: JSON.stringify({ key, limit, windowMs }),
      });
      if (res.ok) {
        durableFailures = 0;
        return (await res.json()) as RateLimitResult;
      }
      noteDurableFailure(`HTTP ${res.status}`);
    } else {
      noteDurableFailure("no JWT_SECRET, so the internal call cannot be signed");
    }
  } catch (err) {
    noteDurableFailure(err instanceof Error ? err.message : String(err));
  }

  // Memory fallback if fetch fails
  const store = _store || new Map();
  const entry = store.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (entry.count < limit) {
    entry.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: windowMs - (now - entry.windowStart) };
}

/**
 * Drops entries whose window ended more than `staleAfterMs` ago. The
 * business-keyed store stays small on its own (one entry per business), but
 * the IP- and token-keyed stores grow with every distinct caller ever seen —
 * call this occasionally (not on every request) to keep them bounded.
 */
export function sweepExpired(store: Map<string, RateLimitEntry>, now: number, staleAfterMs: number): void {
  for (const [key, entry] of store) {
    if (now - entry.windowStart > staleAfterMs) store.delete(key);
  }
}

const FNV_OFFSET_BASIS = 0x811c9dc5;

/**
 * Non-cryptographic hash, used only to keep raw bearer tokens out of the
 * rate-limiter's map keys — never for anything security-sensitive (token
 * equality itself is still checked with `tokensMatch`'s timing-safe compare
 * in server-sync.ts). A collision here just buckets two distinct tokens
 * under one counter, making that bucket's effective limit stricter; it can't
 * let a request through that shouldn't be, or leak one token's identity via
 * another's.
 */
export function hashKey(value: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
