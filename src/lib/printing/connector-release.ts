/**
 * The Windows Print Connector release the web app knows about, and the rules
 * for *where the connector payload is downloaded from*.
 *
 * Two different facts were previously forced into one value — the tenant
 * origin a browser was using — and that coupling is what made first install
 * fragile:
 *
 *   A. `$allowedOrigin` — the Bizamiz browser origin the loopback connector
 *      serves printer access to. This is tenant-specific by design (strict
 *      CORS), and it is decided by the installer route from the request host,
 *      using the same host policy the tenant boundary itself uses.
 *
 *   B. `$connectorDownloadUrl` — where the bootstrap downloads the connector
 *      payload from. This must be a *stable, platform-controlled* address:
 *      one DNS name the deployment operator provisions once, rather than
 *      every tenant's `{subdomain}.{root}` hostname, whose resolution on the
 *      cashier's machine depends on the local DNS resolver's mood (the
 *      zaniziba.app.eshobe.com first-install failure). The payload itself is
 *      tenant-neutral, so tenant DNS was never the right place to fetch it.
 *
 * Version numbers are centralised here rather than repeated as magic numbers:
 * `CONNECTOR_PROTOCOL_VERSION` is the wire contract (browser client ↔
 * connector ↔ installer health gate), and `CONNECTOR_RELEASE` is the
 * human/support-facing release string the connector reports on /health and
 * the installer writes to install.log. The contract test pins the PowerShell
 * connector file to both.
 */
import { resolvePlatformBaseUrl } from "../deployment-role";

/** Wire protocol this web app speaks with the connector. Bump the connector's `version` with it. */
export const CONNECTOR_PROTOCOL_VERSION = 3;

/** The release identifier the connector reports and the installer logs. */
export const CONNECTOR_RELEASE = "3.3.1";

/** The one canonical payload path, served publicly (see middleware PUBLIC_PATHS). */
export const CONNECTOR_ASSET_PATH = "/windows/cafe-pos-print-connector.ps1";

/** The loopback port the connector listens on. One place: CSP, client, installer and docs all agree. */
export const CONNECTOR_PORT = 9123;

/** Just the environment that bears on connector distribution. */
export interface ConnectorReleaseEnv {
  /** Explicit stable download base, e.g. a static-asset domain. Wins over everything. */
  CONNECTOR_DOWNLOAD_BASE_URL?: string;
  /** Lowest protocol version an installed connector may speak; older answers mean "update required". */
  CONNECTOR_MIN_VERSION?: string;
  PLATFORM_BASE_URL?: string;
  POS_DOMAIN?: string;
  ROOT_DOMAIN?: string;
}

/**
 * The minimum connector protocol version the web app accepts. Defaults to the
 * protocol the client speaks; `CONNECTOR_MIN_VERSION` can pin an older floor
 * while a gradual rollout is in flight. Unparseable values fall back to the
 * default rather than breaking printing.
 */
export function connectorMinVersion(env: ConnectorReleaseEnv = process.env as ConnectorReleaseEnv): number {
  const raw = env.CONNECTOR_MIN_VERSION?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return CONNECTOR_PROTOCOL_VERSION;
}

/**
 * Normalise an origin to its canonical `scheme://host[:port]` form so two
 * spellings of the same origin compare equal: scheme/host lowercased,
 * default port dropped, trailing slash and path removed. Returns null for
 * anything that is not an absolute http(s) URL — never a guess.
 */
export function normalizeOrigin(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // URL.origin already lowercases the host and drops the default port; the
  // guard above keeps non-web schemes out because their "origin" serialises
  // as the string "null".
  return url.origin;
}

/**
 * Normalise the explicit connector download base (CONNECTOR_DOWNLOAD_BASE_URL
 * or an explicit platform URL). Unlike an *origin* an optional path prefix is
 * preserved, so a static host can serve the payload under e.g.
 * `https://cdn.example.com/cafe-pos`. Returns null when unusable.
 */
function normalizeDownloadBase(value: string | null | undefined): string | null {
  const raw = value?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  if (!/^https?:\/\//.test(raw)) return null;
  const normalized = normalizeOrigin(raw);
  if (!normalized) return null;
  try {
    const path = new URL(raw).pathname.replace(/\/+$/, "");
    return normalized + (path === "" || path === "/" ? "" : path);
  } catch {
    return null;
  }
}

export type DownloadBaseSource =
  /** CONNECTOR_DOWNLOAD_BASE_URL — the operator's explicit static/platform base. */
  | "explicit"
  /** PLATFORM_BASE_URL / POS_DOMAIN / ROOT_DOMAIN — the platform's own stable base URL. */
  | "platform"
  /** No suitable platform base: the request's own origin (localhost, desktop, LAN installs). */
  | "request-origin";

export interface ResolvedDownloadBase {
  base: string;
  source: DownloadBaseSource;
}

/**
 * Where the bootstrap installer downloads the connector payload from.
 *
 * Precedence:
 *
 *  1. `CONNECTOR_DOWNLOAD_BASE_URL` — always honoured (and an invalid value
 *     is an error, not a silent fallback: a typo'd static host must fail fast
 *     rather than ship installers that point nowhere).
 *  2. The platform's own base (PLATFORM_BASE_URL → POS_DOMAIN → ROOT_DOMAIN's
 *     apex via the deployment-role resolver) — but only for requests that
 *     arrived over HTTPS. On a hosted platform the tenant hostname is exactly
 *     what we want to avoid; the apex is one stable, operator-provisioned
 *     name. Development/local deployments speak plain HTTP (localtest.me,
 *     pos.cafe.lan, a LAN IP), where `https://{root}` on 443 answers nothing
 *     — there the request origin is the right base.
 *  3. The request origin itself. A machine that just downloaded the installer
 *     from that origin can reach it again; for single-origin installs it is
 *     the only name guaranteed to serve this exact build of the app.
 *
 * Returns null when nothing usable exists (the caller fails the request with
 * a configuration error rather than manufacturing a hostname).
 */
export function resolveConnectorDownloadBase(
  env: ConnectorReleaseEnv,
  requestOrigin: string,
): ResolvedDownloadBase | null {
  const origin = normalizeOrigin(requestOrigin);
  if (!origin) return null;

  if (env.CONNECTOR_DOWNLOAD_BASE_URL?.trim()) {
    const explicit = normalizeDownloadBase(env.CONNECTOR_DOWNLOAD_BASE_URL);
    return explicit ? { base: explicit, source: "explicit" } : null;
  }

  if (new URL(origin).protocol === "https:") {
    const platform = normalizeDownloadBase(
      resolvePlatformBaseUrl({ PLATFORM_BASE_URL: env.PLATFORM_BASE_URL, POS_DOMAIN: env.POS_DOMAIN, ROOT_DOMAIN: env.ROOT_DOMAIN }),
    );
    if (platform) return { base: platform, source: "platform" };
  }

  return { base: origin, source: "request-origin" };
}

/** The absolute payload URL for a resolved download base. */
export function buildConnectorDownloadUrl(base: string): string {
  const normalized = normalizeDownloadBase(base);
  if (!normalized) throw new Error("invalid_connector_download_base");
  return `${normalized}${CONNECTOR_ASSET_PATH}`;
}

/**
 * The connector's allowed-origin set: the origin of the current request
 * first (it is the one the installing browser demonstrably uses), then any
 * further legitimate POS origins — subdomain aliases left over from a rename,
 * for example. Everything is normalised and deduplicated, and the set is
 * capped so a configuration mistake cannot grow a permission list without
 * bound. An invalid primary origin is an error: the whole point of the set is
 * that it contains only origins the server itself vouches for.
 */
export function mergeAllowedOrigins(primary: string, additional: Array<string | null | undefined> = []): string[] {
  const normalizedPrimary = normalizeOrigin(primary);
  if (!normalizedPrimary) throw new Error("unsupported_installer_origin");

  const seen = new Set<string>([normalizedPrimary]);
  for (const candidate of additional) {
    const normalized = normalizeOrigin(candidate);
    if (normalized) seen.add(normalized);
  }
  return [...seen].slice(0, 8);
}
