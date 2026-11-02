export type CspMode = "off" | "report-only" | "enforce";

export function cspMode(): CspMode {
  const mode = process.env.CSP_MODE;
  if (mode === "off" || mode === "enforce") {
    return mode;
  }
  return "report-only";
}

export function generateNonce(): string {
  // Use crypto.subtle in a non-blocking/edge way if possible, or just Math.random fallback
  // Wait, edge has crypto.getRandomValues
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The Bizamiz Windows Print Connector is deliberately loopback-only. It is
 * the one cross-origin connection the app itself makes: an HTTPS cloud
 * dashboard has to reach the connector on the cashier's own PC. Keep these
 * origins in CSP or an enforced policy blocks printer discovery and printing
 * before CORS/LNA can even ask the user for permission.
 *
 * A custom URL is accepted only when it is still loopback. The connector is
 * not authenticated and must never be exposed to a LAN or public host.
 */
function connectorConnectSources(rawUrl = process.env.NEXT_PUBLIC_PRINT_CONNECTOR_URL): string[] {
  const sources = new Set(["http://127.0.0.1:9123", "http://localhost:9123"]);
  if (!rawUrl) return [...sources];
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (loopback && (url.protocol === "http:" || url.protocol === "https:")) sources.add(url.origin);
  } catch {
    // A malformed override is ignored here. The fetch will fail with the
    // ordinary connector_not_installed result rather than weakening CSP.
  }
  return [...sources];
}

/**
 * Origins the dashboard may frame: the Eshobe CMS admin, shown in the «ویرایش» modal of the
 * website manager. Read from the environment only — the CSP is built per request in
 * middleware, which cannot reach the database where an operator may have saved a different
 * CMS address; such a deployment lists it in `CMS_EMBED_ORIGINS` (comma-separated).
 * Anything that is not a plain http(s) origin is dropped rather than widening `frame-src`.
 */
export function cmsFrameSources(env: Record<string, string | undefined> = process.env): string[] {
  const origins = new Set<string>();
  const candidates = [env.ESHOBE_CMS_URL, ...(env.CMS_EMBED_ORIGINS ?? "").split(",")];
  for (const candidate of candidates) {
    const raw = candidate?.trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
    } catch {
      // A malformed address frames nothing; the modal then shows its own error.
    }
  }
  return [...origins];
}

/**
 * The video players a knowledge-base article may embed. These are exactly the
 * embed origins `kbVideoSource` (src/lib/knowledge.ts) converts YouTube,
 * Aparat and Vimeo links into — security-headers.test.ts derives them from
 * that function, so the two cannot drift. Without them an enforced policy
 * (the desktop's, since issue #1003) leaves every article video blank.
 */
export const KB_VIDEO_FRAME_SOURCES = [
  "https://www.youtube-nocookie.com",
  "https://www.aparat.com",
  "https://player.vimeo.com",
] as const;

/**
 * Where browsers send CSP violation reports (issue #1003). Before this the
 * policy had no `report-uri`/`report-to` at all, so "report-only" reported to
 * nobody and could never tell anyone whether enforcing it was safe.
 */
export const CSP_REPORT_PATH = "/api/csp-report";
/** The Reporting API group name `report-to` refers to; see `cspReportingEndpoints`. */
export const CSP_REPORT_GROUP = "csp-endpoint";

/** The `Reporting-Endpoints` header value that names `CSP_REPORT_GROUP`. */
export function cspReportingEndpoints(): string {
  return `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;
}

/**
 * A Host header that is safe to splice into a CSP source expression: a DNS
 * name, an IPv4 address or a bracketed IPv6 literal, with an optional port.
 * Anything else (spaces, `;`, `,`, quotes, a path) could inject a directive,
 * so it is refused rather than escaped.
 */
const CSP_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

/**
 * This origin's own WebSocket endpoint, for `connect-src`.
 *
 * `useRealtime()` opens `ws(s)://${location.host}/ws` and nothing else, so the
 * policy names exactly that host instead of the bare `ws:`/`wss:` schemes,
 * which let a script open a socket to *any* server — the exfiltration channel
 * connect-src exists to close. CSP3 browsers already match same-origin
 * sockets with `'self'`; the explicit entries are for Safari before 15.4,
 * which did not. The port stays: it is part of the origin (the desktop serves
 * `http://127.0.0.1:3000`). A missing or malformed host leaves `'self'` alone,
 * so the failure direction is stricter, never wider.
 */
export function sameOriginSocketSources(host: string | null | undefined): string[] {
  const value = host?.trim().toLowerCase() ?? "";
  if (!value || !CSP_HOST_PATTERN.test(value)) return [];
  return [`ws://${value}`, `wss://${value}`];
}

// Telegram's official Apps page links WebK and WebA under this origin
// (web.telegram.org/k/ and /a/). Do not broaden to undocumented subdomains.
export const TELEGRAM_WEB_FRAME_ANCESTORS = ["https://web.telegram.org"] as const;

export function telegramFrameAncestorsDirective(): string {
  return `frame-ancestors 'self' ${TELEGRAM_WEB_FRAME_ANCESTORS.join(" ")}`;
}

export function contentSecurityPolicy(
  nonce: string,
  opts: {
    https: boolean;
    reportOnly?: boolean;
    telegramMiniApp?: boolean;
    /** The host the browser addressed (`requestHost`), for this origin's own WebSocket. */
    host?: string | null;
  } = { https: false },
): string {
  const frameAncestors = opts.telegramMiniApp
    ? telegramFrameAncestorsDirective().slice("frame-ancestors ".length)
    : "'none'";
  // Plain-HTTP schemes are only meaningful to a page that is itself served
  // over HTTP (the desktop at http://127.0.0.1, a LAN box without TLS). An
  // HTTPS page blocks or upgrades mixed content anyway, so there `http:` only
  // widened the policy.
  const insecureScheme = opts.https ? [] : ["http:"];
  const parts = [

    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
    // The frames this app opens: the CMS admin (website manager's edit modal)
    // and the knowledge base's video players. Without this line
    // `default-src 'self'` would refuse them under an enforced policy.
    ["frame-src 'self'", ...cmsFrameSources(), ...KB_VIDEO_FRAME_SOURCES].join(" "),
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    // Website managers render image URLs owned by the business's connected
    // CMS/WordPress host. Restricting img-src to self made every remote media
    // thumbnail fail as soon as CSP moved from report-only to enforcement.
    // Images may load over HTTP on a local HTTP deployment; HTTPS pages get
    // `https:` only (and enforced ones `upgrade-insecure-requests` below).
    ["img-src 'self' data: blob:", ...insecureScheme, "https:"].join(" "),
    // A knowledge-base article may link a video *file* hosted anywhere; it
    // plays in the native <video> player, which `default-src 'self'` refused.
    // Media cannot run script, so the scheme-wide source costs no XSS surface.
    ["media-src 'self' blob:", ...insecureScheme, "https:"].join(" "),
    // `data:` is for the print-template preview: its sandboxed frame inherits
    // this policy and carries the Persian font as a data URI, because an
    // opaque-origin document cannot fetch it from this origin.
    "font-src 'self' data:",
    [
      "connect-src 'self'",
      ...sameOriginSocketSources(opts.host),
      ...connectorConnectSources(),
    ].join(" "),
    "worker-src 'self'",
    "manifest-src 'self'",
    // Report-only reported to nobody until issue #1003. `report-uri` is the
    // one every browser (and Electron) honours; `report-to` is its successor,
    // but a browser that understands it then ignores `report-uri` entirely and
    // only posts to a potentially trustworthy endpoint — so it is added only
    // where the page is HTTPS, never on a plain-HTTP LAN origin, where it would
    // silence reporting instead of improving it.
    `report-uri ${CSP_REPORT_PATH}`,
  ];
  if (opts.https) {
    parts.push(`report-to ${CSP_REPORT_GROUP}`);
  }
  // Browsers explicitly ignore this directive in a report-only policy and
  // emit a warning for every response. Add it only when it can take effect.
  if (opts.https && !opts.reportOnly) {
    parts.push("upgrade-insecure-requests");
  }
  return parts.join("; ");
}

export function staticSecurityHeaders(opts: { https: boolean; telegramMiniApp?: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
    // Camera access is needed by the in-app barcode / QR scanner. The local
    // and loopback entries let a top-level cloud dashboard ask the browser for
    // its one-time Local Network Access permission before calling the Windows
    // print agent. `local-network-access` is the Chrome 142–144 compatibility
    // alias; newer browsers split it into local-network / loopback-network.
    // All remain same-origin document capabilities — embeds get nothing.
    "Permissions-Policy":
      "camera=(self), publickey-credentials-get=(self), local-network=(self), loopback-network=(self), local-network-access=(self)",
  };
  // X-Frame-Options has no origin allow-list syntax. The Telegram Web Mini App
  // gets exact framing origins from CSP's frame-ancestors instead; every other
  // route retains the legacy DENY header as defense in depth.
  if (!opts.telegramMiniApp) headers["X-Frame-Options"] = "DENY";
  if (opts.https) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}
