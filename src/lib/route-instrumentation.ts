/**
 * Redacted timing/error instrumentation for `dashboard/ui.tsx`'s (and
 * `setup/ui.tsx`'s) shared `api()` wrapper — issue #909's "Add redacted
 * timing and error instrumentation by route family and stage."
 *
 * Two deliberate restrictions keep this safe to export from a browser with
 * no review:
 *
 * - **Route family, never a route.** A full URL can carry a tenant's
 *   customer id, invoice number, phone number or anything else a path
 *   segment happens to be — exactly the kind of thing `error-report.ts`
 *   already redacts out of free-text messages. Rather than try to pattern-
 *   match every possible secret shape in a URL (the free-text approach is
 *   inherently a losing race against new ID formats), `routeFamily()`
 *   collapses every id-shaped path segment — a UUID, a plain number, or a
 *   long opaque token — to a fixed `:id` placeholder, and the query string
 *   is dropped outright, never inspected. `/api/ledger/expenses/4821` and
 *   `/api/ledger/expenses/9fcf…-…` both become
 *   `/api/ledger/expenses/:id`, which is the unit a dashboard/support
 *   engineer actually wants ("is this feature slow/failing"), not the one
 *   that could identify a person or a transaction.
 * - **A closed outcome vocabulary, never a message.** The only thing ever
 *   recorded about *why* a stage happened is one of a handful of enum
 *   values already used elsewhere in this codebase (`timeout`,
 *   `network_error`, `malformed_response`, `http_error`, `ok`) plus a status
 *   bucket (`2xx`/`4xx`/`5xx`/`0`) — never the server's response body, never
 *   a stack trace, never the Persian message shown on screen. There is
 *   structurally no parameter this module accepts that free text could be
 *   smuggled through.
 *
 * Stored as a small, capped aggregate (count/total/max per
 * family+method+stage+outcome), not a growing list of raw timestamped
 * events — "how is `/api/ledger/payroll/*` doing" is the question this
 * answers, not "reconstruct every request this session made".
 */

export type RouteTimingStage = "slow" | "settled";

export type RouteTimingOutcome = "ok" | "timeout" | "network_error" | "malformed_response" | "http_error" | "aborted";

const KNOWN_OUTCOMES: ReadonlySet<RouteTimingOutcome> = new Set([
  "ok",
  "timeout",
  "network_error",
  "malformed_response",
  "http_error",
  "aborted",
]);

export type StatusBucket = "2xx" | "3xx" | "4xx" | "5xx" | "0";

/** `200` → `"2xx"`, `0` (no response at all) → `"0"`. Never the exact status — the bucket is all a "how is this route family doing" view needs. */
export function statusBucket(status: number): StatusBucket {
  if (status === 0) return "0";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

// A UUID (any version/variant), a run of digits, or a long opaque
// alphanumeric token (12+ chars, mixing in at least one digit so a genuine
// route word — "accounting", "reconciliation" — is never mistaken for one).
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
const OPAQUE_TOKEN_SEGMENT = /^(?=.*\d)[a-zA-Z0-9_-]{12,}$/;

function isIdLikeSegment(segment: string): boolean {
  return UUID_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment) || OPAQUE_TOKEN_SEGMENT.test(segment);
}

/**
 * Collapses a URL to its route family: the path only (the query string,
 * wherever it starts, is never read), with every id-shaped segment replaced
 * by `:id`. Safe to call with a relative path (`/api/ledger/expenses/42`) or
 * an absolute URL; anything this cannot parse as either falls back to the
 * literal text before its first `?`, which is still never more than the
 * caller already passed to `fetch()`.
 */
export function routeFamily(url: string): string {
  let path = url;
  const queryIndex = path.indexOf("?");
  if (queryIndex !== -1) path = path.slice(0, queryIndex);
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      path = new URL(path).pathname;
    }
  } catch {
    // Not a parseable absolute URL — treat the pre-query text as the path,
    // same as the relative-URL case below.
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const familySegments = segments.map((segment) => (isIdLikeSegment(segment) ? ":id" : segment));
  return "/" + familySegments.join("/");
}

interface RouteStageMetrics {
  count: number;
  totalMs: number;
  maxMs: number;
  /** Only populated for the "settled" stage — see `recordRouteStage`. */
  outcomes: Partial<Record<RouteTimingOutcome, number>>;
}

type RouteMetricsStore = Record<string, RouteStageMetrics>;

const ROUTE_TIMING_STORAGE_KEY = "pos:routeTimingMetrics";
/** Bounds the store even if an unexpectedly large number of distinct route families appear in one session. */
const MAX_TRACKED_KEYS = 300;

function metricsKey(method: string, family: string, stage: RouteTimingStage): string {
  return `${method.toUpperCase()} ${family}|${stage}`;
}

function readStore(storage: Pick<Storage, "getItem">): RouteMetricsStore {
  try {
    const raw = storage.getItem(ROUTE_TIMING_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as RouteMetricsStore) : {};
  } catch {
    return {};
  }
}

function writeStore(storage: Pick<Storage, "setItem">, store: RouteMetricsStore): void {
  try {
    storage.setItem(ROUTE_TIMING_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Best-effort only — never let instrumentation itself throw into a caller's request path.
  }
}

export interface RouteStageSample {
  method: string;
  /** The exact URL the caller used — reduced to a route family internally; never stored or logged as-is. */
  url: string;
  stage: RouteTimingStage;
  durationMs: number;
  /** Only meaningful for the "settled" stage; ignored for "slow". */
  outcome?: RouteTimingOutcome;
  status?: number;
}

/**
 * Folds one timing sample into the capped aggregate. Never throws: a
 * malformed or storage-unavailable call degrades to a silent no-op, the same
 * contract `recordClientError`/`recordApiFailure` already give the rest of
 * this fetch layer, so instrumentation can never be the reason a real
 * request fails.
 */
export function recordRouteStage(
  sample: RouteStageSample,
  storage: Storage | undefined = typeof window !== "undefined" ? window.localStorage : undefined,
): void {
  if (!storage) return;
  const family = routeFamily(sample.url);
  const key = metricsKey(sample.method, family, sample.stage);
  const store = readStore(storage);
  let entry = store[key];
  if (!entry) {
    if (Object.keys(store).length >= MAX_TRACKED_KEYS) return; // bounded — see module doc.
    entry = { count: 0, totalMs: 0, maxMs: 0, outcomes: {} };
    store[key] = entry;
  }
  entry.count += 1;
  entry.totalMs += Math.max(0, sample.durationMs);
  entry.maxMs = Math.max(entry.maxMs, sample.durationMs);
  if (sample.stage === "settled") {
    const outcome: RouteTimingOutcome = sample.outcome && KNOWN_OUTCOMES.has(sample.outcome) ? sample.outcome : "http_error";
    entry.outcomes[outcome] = (entry.outcomes[outcome] ?? 0) + 1;
  }
  writeStore(storage, store);
}

export interface RouteTimingSummaryRow {
  method: string;
  family: string;
  stage: RouteTimingStage;
  count: number;
  avgMs: number;
  maxMs: number;
  outcomes: Partial<Record<RouteTimingOutcome, number>>;
}

/** The full aggregate, one row per method+family+stage — for the Logs panel's export and for tests. */
export function routeTimingSummary(
  storage: Storage | undefined = typeof window !== "undefined" ? window.localStorage : undefined,
): RouteTimingSummaryRow[] {
  if (!storage) return [];
  const store = readStore(storage);
  return Object.entries(store).map(([key, entry]) => {
    const [methodAndFamily, stage] = key.split("|");
    const spaceIndex = methodAndFamily.indexOf(" ");
    const method = methodAndFamily.slice(0, spaceIndex);
    const family = methodAndFamily.slice(spaceIndex + 1);
    return {
      method,
      family,
      stage: stage as RouteTimingStage,
      count: entry.count,
      avgMs: entry.count > 0 ? Math.round(entry.totalMs / entry.count) : 0,
      maxMs: Math.round(entry.maxMs),
      outcomes: entry.outcomes,
    };
  });
}

/** Plain-text report for "Export Logs" — never shown inline, same shape as `buildTechnicalReport`. */
export function buildRouteTimingReport(
  storage: Storage | undefined = typeof window !== "undefined" ? window.localStorage : undefined,
): string {
  const rows = routeTimingSummary(storage).sort((a, b) => (a.family === b.family ? a.stage.localeCompare(b.stage) : a.family.localeCompare(b.family)));
  if (rows.length === 0) return "";
  const lines = rows.map((row) => {
    const outcomesText = Object.entries(row.outcomes)
      .map(([outcome, count]) => `${outcome}=${count}`)
      .join(", ");
    return `${row.method} ${row.family} [${row.stage}] — count=${row.count}, avg=${row.avgMs}ms, max=${row.maxMs}ms${
      outcomesText ? `, outcomes: ${outcomesText}` : ""
    }`;
  });
  return lines.join("\n");
}

/** Clears the aggregate — for tests, and for a future "reset performance log" action. */
export function resetRouteTimingMetrics(
  storage: Storage | undefined = typeof window !== "undefined" ? window.localStorage : undefined,
): void {
  if (!storage) return;
  try {
    storage.removeItem(ROUTE_TIMING_STORAGE_KEY);
  } catch {
    // Best-effort only.
  }
}
