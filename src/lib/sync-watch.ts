/**
 * The central watch long-poll: how it is asked, how a failure is classified,
 * and how long to wait before asking again. Issue #989.
 *
 * The watcher (`sync-wake-service.ts`) is an optimisation over the desktop's
 * 30-second tick, never a replacement for it. Two things follow, and this file
 * encodes both so the loop itself stays small:
 *
 *  - **A hold the network ends is not an application error.** A CDN, a reverse
 *    proxy or a NAT table commonly kills a connection that has been idle for
 *    ~30 s, and the app cannot answer that request at all — its handler may
 *    never see the close. `HTTP 502` pairs ~30 s apart in a real install are
 *    exactly that shape. Those outcomes are quiet (debug), the server is asked
 *    for a shorter hold so the edge never gets the chance, and the watcher asks
 *    again shortly.
 *  - **What *is* an error — a refused credential, a 5xx the app itself
 *    answered, an unreadable body — is reported once per streak** rather than
 *    on every retry, so the line keeps meaning something.
 *
 * Every retry delay is jittered by ±20% (the spread `sync-backoff.ts` uses),
 * so a fleet of sites that lost the edge together cannot come back in lockstep.
 *
 * Free of database and Next.js imports: the pull route imports the shared
 * constants, and the whole policy is unit-tested.
 */

/**
 * Seconds the central is asked to hold a watch request.
 *
 * 25 s sat too close to the ~30 s idle timeout most edges apply to a request
 * with no bytes flowing, so a hold plus connect/auth/DB time could cross it and
 * be killed with a 502/504. 15 s leaves roughly double the headroom and costs
 * one extra (idle) request per hold; it still delivers the near-instant wake.
 */
export const WATCH_WAIT_SECONDS = 15;

/**
 * The server's ceiling for `wait`, shared with `/api/server-sync/pull`.
 *
 * Below that same ~30 s edge idle timeout *including* a slow DB round-trip, and
 * it also protects an older desktop that still asks for 25 s: the server
 * answers within this cap whether or not the client asked for more.
 */
export const MAX_PULL_WAIT_SECONDS = 20;

/**
 * Client-side socket guard: the requested hold, the server's read at its end,
 * and slack for a slow edge. It must stay above `MAX_PULL_WAIT_SECONDS` so a
 * held request is never aborted before the server itself would answer.
 */
export const WATCH_TIMEOUT_MS = 25_000;

/** Base wait before asking again after a request that failed quickly. */
export const WATCH_RETRY_MS = 30_000;

/**
 * Wait after a request that stayed open long enough to have done the idle
 * waiting itself. Retrying at once is what keeps the wake near-instant when an
 * edge caps holds shorter than we ask: the "failed" hold was still 15 s of
 * waiting, so charging another full 30 s on top was pure lost latency.
 */
export const WATCH_QUICK_RETRY_MS = 1_500;

/** A request open this long counts as having served as the wait. */
export const WATCH_HELD_ENOUGH_MS = 5_000;

/** ±20% on every retry delay, matching `sync-backoff.ts`. */
export const WATCH_RETRY_JITTER = 0.2;

/**
 * Marked on every answer the pull route *itself* writes.
 *
 * A 5xx without it did not come from this application — Next.js and Node never
 * produce 502/503/504 — so the watcher can say "an intermediary answered, not
 * the app" in its diagnostic line instead of leaving an operator to guess
 * (issue #989, question 4).
 */
export const SYNC_PULL_MARKER_HEADER = "x-biza-sync-pull";

export type WatchFailureKind =
  /** 502/503/504 from an intermediary, or a connection ended while held. */
  | "hold-ended"
  /** The site could not reach the central at all (DNS, refused, offline). */
  | "unreachable"
  /** The central refused the credential — a pairing problem, not a blip. */
  | "unauthorized"
  /** Another status the application itself answered. */
  | "server-error"
  /** 2xx whose body could not be read as JSON. */
  | "protocol";

export interface WatchFailure {
  kind: WatchFailureKind;
  /** How long the request was open before it failed. */
  heldMs: number;
  /** Short, log-safe description (`HTTP 502`, `fetch failed (UND_ERR_SOCKET)`). */
  detail: string;
  /** Who wrote the failing answer. */
  answeredBy: "app" | "edge" | "network";
  /** Upstream headers when an intermediary answered (for the diagnostic). */
  edge: string | null;
}

export class SyncWatchError extends Error {
  readonly failure: WatchFailure;

  constructor(failure: WatchFailure) {
    super(failure.detail);
    this.name = "SyncWatchError";
    this.failure = failure;
  }
}

/** A 5xx is the *edge's* unless the app's own marker says otherwise. */
export function classifyHttpFailure(status: number, appAnswered: boolean): WatchFailureKind {
  if (status === 502 || status === 503 || status === 504) {
    // An app answer with this status would be a bug of ours and is worth
    // reporting; without the marker it was written in front of the app.
    return appAnswered ? "server-error" : "hold-ended";
  }
  if (status === 401 || status === 403) return "unauthorized";
  return "server-error";
}

/**
 * Socket-level endings that mean "the idle connection was cut", not "this site
 * cannot reach central". A request that had been open for a while is in the
 * same class whatever code the runtime reports — it was held, and then ended.
 */
const SOCKET_END_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ENETRESET",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_ABORTED",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export function classifyThrownFailure(input: {
  name?: string;
  code?: string;
  heldMs: number;
}): WatchFailureKind {
  // The socket guard fired, or the request was aborted mid-hold.
  if (input.name === "TimeoutError" || input.name === "AbortError") return "hold-ended";
  if (input.code && SOCKET_END_CODES.has(input.code.toUpperCase())) return "hold-ended";
  if (input.heldMs >= WATCH_HELD_ENOUGH_MS) {
    // Whatever ended it, a connection that stayed open this long was a held
    // request being terminated — not a site that cannot reach central.
    return "hold-ended";
  }
  return "unreachable";
}

/**
 * Log level for the n-th consecutive failure. A hold the edge ended is always
 * quiet; a genuine failure announces itself once per streak and then stays at
 * debug so retries cannot flood the channel operators watch.
 */
export function watchFailureLogLevel(
  kind: WatchFailureKind,
  consecutiveFailures: number,
): "debug" | "warn" | "error" {
  if (kind === "hold-ended") return "debug";
  if (consecutiveFailures > 1) return "debug";
  return kind === "unreachable" ? "warn" : "error";
}

/** ±`WATCH_RETRY_JITTER` around a base delay. */
export function jitteredWatchDelay(baseMs: number, random: () => number = Math.random): number {
  const sample = Math.min(Math.max(random(), 0), 1);
  return Math.round(baseMs * (1 - WATCH_RETRY_JITTER + 2 * WATCH_RETRY_JITTER * sample));
}

/**
 * Wait before the next watch attempt.
 *
 * A request that was open for `WATCH_HELD_ENOUGH_MS` already paid the idle
 * wait, so it retries after a short jittered pause; anything quicker keeps the
 * full (jittered) base. No exponential growth: this loop is a read, its failures
 * are usually the network's, and the 30 s tick still owns the fallback.
 */
export function watchRetryDelayMs(heldMs: number, random: () => number = Math.random): number {
  return jitteredWatchDelay(heldMs >= WATCH_HELD_ENOUGH_MS ? WATCH_QUICK_RETRY_MS : WATCH_RETRY_MS, random);
}

/** Upstream headers worth quoting when an intermediary — not the app — answered. */
const EDGE_HEADERS = ["server", "via", "x-cache", "cf-ray", "x-served-by", "x-request-id", "x-vercel-id"] as const;

export function describeEdge(headers: { get(name: string): string | null }): string | null {
  const parts: string[] = [];
  for (const name of EDGE_HEADERS) {
    const value = headers.get(name);
    if (value) parts.push(`${name}=${value}`);
  }
  return parts.length ? parts.join(" ") : null;
}

/** The URL the watch asks: peek a single event, held for `WATCH_WAIT_SECONDS`. */
export function centralWatchUrl(input: {
  remoteUrl: string;
  afterEventId?: number | null;
  afterTxid?: string | null;
}): URL {
  const url = new URL(`${input.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/pull`);
  url.searchParams.set("after", String(input.afterEventId ?? 0));
  url.searchParams.set("afterTx", input.afterTxid ?? "0");
  url.searchParams.set("limit", "1");
  url.searchParams.set("wait", String(WATCH_WAIT_SECONDS));
  url.searchParams.set("peek", "1");
  return url;
}

export type WatchFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface WatchRequest {
  remoteUrl: string;
  token: string;
  afterEventId?: number | null;
  afterTxid?: string | null;
  signal: AbortSignal;
  fetchImpl?: WatchFetch;
  now?: () => number;
}

export interface WatchAnswer {
  pending: boolean;
  heldMs: number;
}

function thrownFailure(error: unknown, heldMs: number): SyncWatchError {
  const err = error as { name?: unknown; message?: unknown; cause?: unknown } | null | undefined;
  const cause = err?.cause as { code?: unknown; message?: unknown } | null | undefined;
  const name = typeof err?.name === "string" ? err.name : undefined;
  const message =
    typeof err?.message === "string" && err.message ? err.message : typeof error === "string" ? error : "fetch failed";
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  const causeMessage = typeof cause?.message === "string" ? cause.message : undefined;
  const kind = classifyThrownFailure({ name, code, heldMs });
  const detail = [message, code ? `(${code})` : causeMessage ? `(${causeMessage})` : ""].filter(Boolean).join(" ");
  return new SyncWatchError({ kind, heldMs, detail, answeredBy: "network", edge: null });
}

/**
 * One long-poll. Returns whether anything is waiting, or throws a
 * `SyncWatchError` carrying the classification (never a bare network error).
 */
export async function attemptCentralWatch(input: WatchRequest): Promise<WatchAnswer> {
  const now = input.now ?? Date.now;
  const doFetch: WatchFetch = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const started = now();
  let response: Response;
  try {
    response = await doFetch(centralWatchUrl(input), {
      // Stored settings can carry the trailing whitespace a copy/paste leaves.
      headers: { Authorization: `Bearer ${input.token.trim()}` },
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(WATCH_TIMEOUT_MS)]),
    });
  } catch (error) {
    throw thrownFailure(error, now() - started);
  }

  const heldMs = now() - started;
  // The app marks its own answers; anything else came through (or from) an edge.
  const appAnswered = response.headers.get(SYNC_PULL_MARKER_HEADER) !== null;
  if (!response.ok) {
    const kind = classifyHttpFailure(response.status, appAnswered);
    throw new SyncWatchError({
      kind,
      heldMs,
      detail: `HTTP ${response.status}`,
      answeredBy: appAnswered ? "app" : "edge",
      edge: appAnswered ? null : describeEdge(response.headers),
    });
  }

  try {
    const body = (await response.json()) as { pending?: boolean };
    return { pending: body?.pending === true, heldMs };
  } catch {
    // The body can also be cut off when an edge ends a hold mid-response,
    // which belongs with the other ended holds; a fast, complete answer with
    // no readable body is a protocol failure in the app.
    const cutOff = heldMs >= WATCH_HELD_ENOUGH_MS;
    throw new SyncWatchError({
      kind: cutOff ? "hold-ended" : "protocol",
      heldMs,
      detail: cutOff ? "the response was cut off mid-body" : "200 with an unreadable body",
      answeredBy: appAnswered ? "app" : "edge",
      edge: appAnswered ? null : describeEdge(response.headers),
    });
  }
}

/** A log line for any error the watch threw; never includes the token. */
export function describeWatchFailure(failure: WatchFailure, consecutiveFailures: number): string {
  const parts = [`${failure.detail} after ${(failure.heldMs / 1000).toFixed(1)}s`];
  if (failure.answeredBy === "edge") parts.push("answered before the app, so it did not come from the app");
  if (failure.edge) parts.push(`edge: ${failure.edge}`);
  if (consecutiveFailures > 1) parts.push(`attempt ${consecutiveFailures}`);
  const outcome = failure.kind === "hold-ended" ? "central watch ended early" : "central watch failed";
  return `sync wake: ${outcome}: ${parts.join("; ")}`;
}
