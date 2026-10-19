/**
 * Professional error handling (Section 12 of the desktop audit) — pure
 * helpers shared by every render-error boundary (`error.tsx`,
 * `global-error.tsx`) so each failure gets the same three things: a
 * friendly Persian message (already handled by those files' own copy), a
 * short **error ID** the user can quote to support, and a downloadable
 * **technical log** with the detail nobody should have to read on screen.
 *
 * Kept deliberately separate from the render-boundary components: this file
 * touches neither React nor the DOM, so it is unit-testable the same way
 * every other pure `lib` module is, and the boundaries stay thin wrappers
 * around it.
 */

/**
 * A short, support-friendly identifier — distinct from Next's own opaque
 * `error.digest` (a server-log correlation id that is not always present,
 * e.g. for an error thrown entirely client-side). Deterministic given the
 * same `(seed, now)` pair so a re-render of the same boundary before the
 * user reloads keeps showing the same code instead of minting a new one
 * every paint.
 *
 * Shape: `ERR-XXXX-XXXX` in Crockford's base32 alphabet (no 0/O/1/I/L
 * confusion when read aloud over the phone to support).
 */
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function toBase32(value: number, length: number): string {
  let n = Math.abs(Math.trunc(value));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out = BASE32_ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/** FNV-1a — small, dependency-free, good enough to spread a seed string across the id's bits. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function generateErrorId(seed: string, now: number = Date.now()): string {
  const h = hash32(`${seed}:${now}`);
  const first = h & 0xffff;
  const second = (h >>> 16) & 0xffff;
  return `ERR-${toBase32(first, 4)}-${toBase32(second, 4)}`;
}

export interface ErrorReportContext {
  errorId: string;
  message: string;
  stack?: string | null;
  /** Next's own server-log correlation id, when this boundary received one. */
  digest?: string | null;
  /** Where the user was when it happened — a URL, not a component name, so it means something to support. */
  url?: string;
  userAgent?: string;
  /** ISO timestamp; pass one explicitly from a test for a deterministic report. */
  occurredAt?: string;
  /** App/desktop release version, when known (APP_RELEASE_VERSION et al.). */
  appVersion?: string;
}

/**
 * Renders the same secret-redaction rule the desktop's own log writer uses
 * (electron/logger.js's `redact`), so a technical report exported from the
 * browser never leaks a connection string, bearer token, or password that
 * happened to be in an error message.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+/gi,
  /(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi,
  /((?:jwt|sync|pairing|api)[_-]?(?:secret|token|code)\s*[:=]\s*)[^\s,;]+/gi,
  /((?:password|passphrase)\s*[:=]\s*)[^\s,;]+/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "$1[REDACTED]");
  return out;
}

/** Plain-text technical report — the content of the "Export Logs" download, never rendered on screen. */
export function buildTechnicalReport(context: ErrorReportContext): string {
  const lines = [
    `Error ID: ${context.errorId}`,
    `Occurred at: ${context.occurredAt ?? new Date().toISOString()}`,
    context.digest ? `Server digest: ${context.digest}` : null,
    context.appVersion ? `App version: ${context.appVersion}` : null,
    context.url ? `URL: ${context.url}` : null,
    context.userAgent ? `User agent: ${context.userAgent}` : null,
    "",
    `Message: ${redactSecrets(context.message)}`,
    context.stack ? "" : null,
    context.stack ? "Stack:" : null,
    context.stack ? redactSecrets(context.stack) : null,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

const CLIENT_ERROR_LOG_KEY = "pos:clientErrorLog";
/** Ring buffer cap — enough recent errors for a support session without growing localStorage unbounded. */
const MAX_LOGGED_ERRORS = 50;

export interface StoredErrorEntry {
  errorId: string;
  occurredAt: string;
  report: string;
}

function readStoredErrors(storage: Pick<Storage, "getItem">): StoredErrorEntry[] {
  try {
    const raw = storage.getItem(CLIENT_ERROR_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredErrorEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Appends one error's technical report to a capped local ring buffer, so
 * "Export Logs" can hand support more than just the one error currently on
 * screen — the sequence of failures leading up to it is often the useful
 * part. Silently a no-op if storage is unavailable (private browsing, quota
 * exceeded): the on-screen error ID/report still exists for this one error.
 */
export function recordClientError(
  entry: StoredErrorEntry,
  storage: Storage | undefined = typeof window !== "undefined" ? window.localStorage : undefined,
): void {
  if (!storage) return;
  try {
    const existing = readStoredErrors(storage);
    const next = [...existing, entry].slice(-MAX_LOGGED_ERRORS);
    storage.setItem(CLIENT_ERROR_LOG_KEY, JSON.stringify(next));
  } catch {
    // Best-effort only — never let logging itself throw inside an error boundary.
  }
}

/** The full exportable log — every stored report, newest last, for the download button. */
export function exportClientErrorLog(
  storage: Storage | undefined = typeof window !== "undefined" ? window.localStorage : undefined,
): string {
  if (!storage) return "";
  const entries = readStoredErrors(storage);
  if (entries.length === 0) return "";
  return entries.map((entry) => entry.report).join("\n\n" + "=".repeat(40) + "\n\n");
}

// ---------------------------------------------------------------------------
// API/fetch-layer failures
// ---------------------------------------------------------------------------

/**
 * The residual gap the audit's Section 12 review documented: `error.tsx` /
 * `global-error.tsx` give a *render* error the full treatment (error ID +
 * technical log + export), but an API call that fails — a 500 from a route
 * handler, a dropped connection mid-request — only ever surfaced through
 * `dashboard/ui.tsx`'s plain `<ErrorBox>{errorMessage(...)}</ErrorBox>`
 * pattern, with nothing recorded anywhere support could later ask for.
 *
 * Rather than retrofit an error ID onto every one of the ~200 call sites that
 * render `errorMessage()` — a much larger, riskier change that would touch
 * page-level JSX across the app — this hooks the few shared fetch wrappers
 * every one of those call sites already goes through
 * (`dashboard/ui.tsx`'s and `setup/ui.tsx`'s `api()`, `platform-client.ts`'s
 * `platformFetch()`) so a genuinely unexpected failure is appended to the
 * same exportable ring buffer a render error uses, with zero UI change: the
 * on-screen message is exactly what it already was, but "دریافت فایل
 * گزارش‌ها" on the new Logs settings tab now also has this failure's detail
 * (URL, status, method, server-reported code) if a user needs to hand it to
 * support.
 *
 * Deliberately narrow about what counts as worth recording: an ordinary
 * validation rejection (400 "این فیلد الزامی است") is the app working
 * correctly, not a bug, and logging every one of those would bury the
 * genuinely unexpected failures in noise. Only a transport failure (no HTTP
 * response at all — offline, DNS, a dropped connection) or a request that
 * reached the server and the server itself failed (5xx) is recorded.
 */
export interface ApiFailureContext {
  /** HTTP method, e.g. "GET"/"POST" — absent defaults to GET in the report. */
  method?: string;
  url: string;
  /** 0 for a transport failure that never got an HTTP response. */
  status: number;
  /** The server's own error code, when one came back (e.g. "server_error", "network_error"). */
  code?: string;
  occurredAt?: string;
  /**
   * Issue #909 — record regardless of `status`, for failures the status code
   * alone cannot identify as notable: a 200/2xx response whose body was not
   * valid JSON (a masked failure — a proxy's HTML error page, a truncated
   * body — that `isNotableApiFailure` would otherwise wave through as an
   * ordinary 2xx) or a client-side read deadline, which already reports
   * `status: 0` but is set here explicitly by the caller that knows the
   * cause. Callers that already know a failure is worth a technical report —
   * independent of what `isNotableApiFailure` would conclude from the status
   * alone — set this instead of trying to make the status lie.
   */
  force?: boolean;
}

/** Whether an API failure is worth recording — see the module doc above. */
export function isNotableApiFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

/**
 * Builds and stores a technical report for one API failure, the same way a
 * render error does, so it shows up in the same exported log. Returns the
 * assigned error id (not shown in the UI by default — this is a background
 * log entry, not a new on-screen element — but available to a caller that
 * wants to fold it into a toast/detail view later).
 *
 * No-op (returns null) for a failure `isNotableApiFailure` would exclude —
 * callers may skip that check themselves and rely on this one.
 */
export function recordApiFailure(
  context: ApiFailureContext,
  storage: Storage | undefined = typeof window !== "undefined" ? window.localStorage : undefined,
): string | null {
  if (!context.force && !isNotableApiFailure(context.status)) return null;
  const occurredAt = context.occurredAt ?? new Date().toISOString();
  const errorId = generateErrorId(`api:${context.method ?? "GET"}:${context.url}:${context.status}`, Date.parse(occurredAt) || Date.now());
  const message = `API request failed — ${context.method ?? "GET"} ${context.url} — HTTP ${context.status || "(no response)"}${
    context.code ? ` — code: ${context.code}` : ""
  }`;
  const report = buildTechnicalReport({ errorId, message, occurredAt, url: context.url });
  recordClientError({ errorId, occurredAt, report }, storage);
  return errorId;
}
