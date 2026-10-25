/**
 * Issue #1003 — the CSP violation collector's pure half.
 *
 * The policy built in security-headers.ts shipped for its whole life with no
 * `report-uri`/`report-to`, so "report-only" reported to nobody: no deployment
 * could ever learn whether enforcing it would break a screen. Browsers now
 * post violations to /api/csp-report, and this module turns those bodies into
 * one short, safe log line each.
 *
 * Two wire formats arrive at the same endpoint:
 *
 *  - `report-uri` (every browser, Electron included): one object,
 *    `{ "csp-report": { "document-uri", "effective-directive", ... } }`,
 *    sent as `application/csp-report`;
 *  - `report-to` (the Reporting API, HTTPS pages only): a batch,
 *    `[{ "type": "csp-violation", "body": { "documentURL", ... } }]`, sent as
 *    `application/reports+json`.
 *
 * What is deliberately NOT logged:
 *
 *  - query strings and fragments. A violating page can be a password-reset,
 *    invite or activation link whose token lives in the query; the origin and
 *    path are all anyone needs to find the offending screen;
 *  - `script-sample`/`sample`. It is the first characters of the inline code
 *    that was blocked, and an un-nonced inline script in this app would most
 *    likely be a React Server Components payload carrying rendered tenant data;
 *  - the original policy, the referrer and the user agent: noise, and the
 *    referrer is another URL with a query.
 *
 * The endpoint is unauthenticated by necessity (browsers send reports without
 * credentials), so the only thing an abuser can buy with it is log volume:
 * `createCspReportLog` caps lines per window and summarises the rest.
 */

export interface CspViolation {
  /** "enforce" or "report" — whether the browser actually blocked it. */
  disposition: "enforce" | "report";
  /** The directive that was violated, e.g. `script-src-elem`. */
  directive: string;
  /** What was blocked: a sanitized URL, or a CSP keyword such as `inline`/`eval`. */
  blocked: string;
  /** The page it happened on (origin + path). */
  document: string;
  /** Where the offending code lives, when the browser says (origin + path). */
  source?: string;
  line?: number;
  column?: number;
}

/** Most reports a single request may contribute; a real page sends one, a Reporting API batch a few. */
export const MAX_REPORTS_PER_REQUEST = 20;

/** Bodies above this are refused unread; a genuine batch is a few kilobytes. */
export const CSP_REPORT_MAX_BYTES = 64 * 1024;

const MAX_URL_LENGTH = 200;

/**
 * The non-URL values `blocked-uri`/`blockedURL` can take. Kept verbatim, since
 * "inline" vs "eval" is precisely what tells a reader which rule fired.
 */
const BLOCKED_KEYWORDS = new Set([
  "inline",
  "eval",
  "wasm-eval",
  "self",
  "data",
  "blob",
  "filesystem",
  "trusted-types-policy",
  "trusted-types-sink",
]);

/**
 * A URL reduced to origin + path, or a coarse label when it is not one.
 * Never the query or fragment — see the module comment.
 */
export function sanitizeReportUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (!value) return "";
  const keyword = value.toLowerCase();
  if (BLOCKED_KEYWORDS.has(keyword)) return keyword;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (scheme === "http" || scheme === "https" || scheme === "ws" || scheme === "wss") {
    return `${url.origin}${url.pathname}`.slice(0, MAX_URL_LENGTH);
  }
  // data:, blob:, chrome-extension:, about: … — the scheme is the useful part
  // (a browser extension injecting into a shared till is a classic source).
  return /^[a-z][a-z0-9+.-]{0,30}$/.test(scheme) ? scheme : "other";
}

/** A directive name, or "" if the value is not one. */
function directiveName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // `violated-directive` may carry the whole directive ("script-src 'self' …").
  const name = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[a-z][a-z-]{0,39}$/.test(name) ? name : "";
}

function position(raw: unknown): number | undefined {
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function violation(fields: {
  disposition: unknown;
  directive: unknown;
  fallbackDirective: unknown;
  blocked: unknown;
  document: unknown;
  source: unknown;
  line: unknown;
  column: unknown;
}): CspViolation | null {
  const directive = directiveName(fields.directive) || directiveName(fields.fallbackDirective);
  const document = sanitizeReportUrl(fields.document);
  if (!directive || !document) return null;
  const parsed: CspViolation = {
    disposition: fields.disposition === "report" ? "report" : "enforce",
    directive,
    blocked: sanitizeReportUrl(fields.blocked) || "unknown",
    document,
  };
  const source = sanitizeReportUrl(fields.source);
  if (source) parsed.source = source;
  const line = position(fields.line);
  if (line !== undefined) parsed.line = line;
  const column = position(fields.column);
  if (column !== undefined) parsed.column = column;
  return parsed;
}

/**
 * Every violation a report body describes, in either wire format, sanitized.
 * Malformed or foreign entries are dropped silently: this endpoint answers
 * nothing a caller could learn from, so there is nothing to report back.
 */
export function parseCspReports(body: unknown): CspViolation[] {
  const out: CspViolation[] = [];

  // report-uri: { "csp-report": { … } }
  const legacy = record(record(body)?.["csp-report"]);
  if (legacy) {
    const parsed = violation({
      disposition: legacy["disposition"],
      directive: legacy["effective-directive"],
      fallbackDirective: legacy["violated-directive"],
      blocked: legacy["blocked-uri"],
      document: legacy["document-uri"],
      source: legacy["source-file"],
      line: legacy["line-number"],
      column: legacy["column-number"],
    });
    if (parsed) out.push(parsed);
    return out;
  }

  // report-to: [{ "type": "csp-violation", "body": { … } }, …]
  if (!Array.isArray(body)) return out;
  for (const entry of body.slice(0, MAX_REPORTS_PER_REQUEST)) {
    const report = record(entry);
    if (!report || report["type"] !== "csp-violation") continue;
    const details = record(report["body"]);
    if (!details) continue;
    const parsed = violation({
      disposition: details["disposition"],
      directive: details["effectiveDirective"],
      fallbackDirective: details["violatedDirective"],
      blocked: details["blockedURL"],
      document: details["documentURL"] ?? report["url"],
      source: details["sourceFile"],
      line: details["lineNumber"],
      column: details["columnNumber"],
    });
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface CspReportLog {
  /** Logs what the current window still has room for; counts the rest. */
  record(violations: readonly CspViolation[]): void;
}

/**
 * A per-process line budget for violation logs.
 *
 * A broken policy makes every page load post a report, and an unauthenticated
 * caller can post as many as they like, so logging each one would let either
 * flood the console (and whatever ships it — see src/lib/observability.ts).
 * Up to `maxPerWindow` lines are written per window; when a window that
 * dropped some ends, one summary line says how many.
 */
export function createCspReportLog(options: {
  maxPerWindow?: number;
  windowMs?: number;
  now?: () => number;
  log?: (line: string) => void;
} = {}): CspReportLog {
  const maxPerWindow = options.maxPerWindow ?? 60;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  let windowStart = Number.NEGATIVE_INFINITY;
  let logged = 0;
  let suppressed = 0;

  return {
    record(violations) {
      if (violations.length === 0) return;
      const at = now();
      if (at - windowStart >= windowMs) {
        if (suppressed > 0) {
          log(`[csp] ${suppressed} further violation report(s) suppressed in the last window`);
        }
        windowStart = at;
        logged = 0;
        suppressed = 0;
      }
      for (const entry of violations) {
        if (logged >= maxPerWindow) {
          suppressed += 1;
          continue;
        }
        logged += 1;
        log(`[csp] violation ${JSON.stringify(entry)}`);
      }
    },
  };
}
