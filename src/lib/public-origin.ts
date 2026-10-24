/**
 * The one browser-reachable canonical origin policy for cross-realm handoffs.
 *
 * `GET /api/platform/company/open` moves a browser from the Superadmin console
 * to the internal company's tenant realm — a *cross-origin* hop whenever host
 * tenancy is on, and an origin-scoped cookie is minted on the far side. The
 * destination URL must therefore name an origin a public browser can actually
 * reach. Issue #1062: the single-host branch built that URL from
 * `request.url`, which inside a route handler is the *container's* origin
 * (`http://localhost:3000` behind a TLS proxy), and the browser followed a
 * redirect to a loopback host nothing outside the container can open.
 *
 * The policy, stated once:
 *
 *   * **Host tenancy on** — the destination is the internal company's own
 *     tenant origin: `{subdomain}.{ROOT_DOMAIN}` under the configured root,
 *     with the scheme and external port the browser is actually using.
 *   * **Host tenancy off** (an intentionally single-host deployment) — the
 *     destination is the *validated browser-facing origin* of the request
 *     itself: the `Host` header (or `X-Forwarded-Host`, but only when the
 *     deployment declares its proxy rewrites `Host` via TRUST_FORWARDED_HOST),
 *     never `request.url`'s internal hostname.
 *   * **`PUBLIC_ORIGIN`**, when set, pins the browser-facing scheme/host/port
 *     outright and is the operator's explicit answer when the proxy contract
 *     cannot be inferred from headers.
 *
 * Anything the resolver cannot prove is browser-reachable fails closed —
 * *before* the handoff mints its one-use credential — with a stable error
 * code the console turns into actionable feedback and the logs record
 * (without tokens). Loopback and internal names stay legal exactly where they
 * are honest: explicitly local scenarios (the desktop site install, non-
 * production development). A production central deployment never sends a user
 * to `localhost`, `127.0.0.1`, a container-internal name, or a wrong
 * scheme/port.
 *
 * Pure at the centre (`resolveHandoffOrigin` takes its environment and headers
 * as plain values) with thin ambient wrappers, the same shape as `host.ts` —
 * so the deployment matrix in `public-origin.test.ts` runs without a server,
 * a proxy, or a database.
 */
import { parseHost, resolveRequestHost, trustForwardedHost, type HostEnv } from "./host";
import { validateSubdomain } from "./slug";
import { deploymentRole } from "./deployment-role";

/** Where a hostname resolves *for a browser outside the container network*. */
export type HostReachability =
  /** A real DNS name (or public address) a browser can reach. */
  | "public"
  /** localhost, 127.0.0.0/8, ::1 — only a browser ON this machine can reach it. */
  | "loopback"
  /** RFC1918 / link-local / unique-local addresses — LAN-only. */
  | "private"
  /** Container-internal names: single labels, *.internal, *.local and friends. */
  | "internal";

/**
 * Suffixes managed platforms and container runtimes hand their own processes.
 * `web-1234.internal` (Runflare-style), mDNS `.local`, and the classic
 * single-label compose service name (`web`, `db`) all name something no
 * outside browser can open. `localtest.me` is deliberately NOT here: it is a
 * real public name that resolves to loopback, which is exactly why the dev
 * root works in a browser without hosts-file editing.
 */
const INTERNAL_SUFFIXES = [".internal", ".local", ".localdomain", ".lan"];

/**
 * Splits a Host-header value into hostname and port.
 *
 * Handles the three shapes a Host can take: `name:port`, an IPv4 literal with
 * port, and a bracketed IPv6 literal (`[::1]:3000`). A bare IPv6 literal
 * (`::1`, more than one colon and no brackets) has no port to strip — its
 * colons are the address.
 */
export function splitHostPort(raw: string): { hostname: string; port: string } {
  const value = raw.trim().toLowerCase();
  if (!value) return { hostname: "", port: "" };
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return { hostname: value.slice(1), port: "" };
    const port = value.slice(end + 1).match(/^:(\d+)$/)?.[1] ?? "";
    return { hostname: value.slice(1, end), port };
  }
  if ((value.match(/:/g) ?? []).length > 1) return { hostname: value, port: "" };
  const match = value.match(/^(.+):(\d+)$/);
  if (match) return { hostname: match[1], port: match[2] };
  return { hostname: value, port: "" };
}

/**
 * Whether a hostname is browser-reachable from outside the container network.
 *
 * The classifier is about *names*, not about where they resolve: `acme.
 * localtest.me` is "public" even though it points at 127.0.0.1, because a
 * browser can open it — and `web-1234.internal` is "internal" even though the
 * container resolves it fine, because a browser cannot.
 */
export function classifyHostname(rawHostname: string): HostReachability {
  const name = rawHostname.trim().toLowerCase().replace(/\.$/, "");
  if (!name) return "internal";
  if (name === "localhost" || name.endsWith(".localhost")) return "loopback";

  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    const [a, b] = name.split(".").map(Number);
    if (a === 127) return "loopback";
    if (a === 0) return "internal";
    if (a === 10) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 169 && b === 254) return "private";
    return "public";
  }

  if (name.includes(":")) {
    if (name === "::1" || name === "0:0:0:0:0:0:0:1") return "loopback";
    if (name === "::" || name === "0:0:0:0:0:0:0:0") return "internal";
    if (/^f[cd]/.test(name)) return "private";
    if (/^fe[89ab]/.test(name)) return "private";
    return "public";
  }

  // A bare single label (`web`, `api-1`) is a container/service name.
  if (!name.includes(".")) return "internal";
  for (const suffix of INTERNAL_SUFFIXES) {
    if (name.endsWith(suffix)) return "internal";
  }
  return "public";
}

/**
 * Why a handoff destination could not be proven browser-reachable.
 *
 * Each code names the *operator* action that fixes it; the console maps them
 * to a Persian explanation and the log records the same code. Deliberately
 * coarse — no hostnames, no ports, no URLs, so nothing token-bearing or
 * infrastructure-identifying can leak through diagnostics.
 */
export type HandoffOriginFailure =
  /** PUBLIC_ORIGIN is set but is not a bare http(s) origin (scheme + host [+ port] only). */
  | "public_origin_invalid"
  /** PUBLIC_ORIGIN is plain http while this deployment serves production traffic. */
  | "public_origin_insecure"
  /** PUBLIC_ORIGIN names a loopback/private/container-internal host a public browser cannot reach. */
  | "public_origin_internal"
  /** Host tenancy is on but ROOT_DOMAIN is unset. */
  | "root_domain_missing"
  /** ROOT_DOMAIN is malformed — a scheme, port, path, space, or no dot at all. */
  | "root_domain_invalid"
  /** ROOT_DOMAIN names a loopback/private/internal zone. */
  | "root_domain_internal"
  /** The request carries no host at all. */
  | "request_host_missing"
  /** The resolved request host is loopback/private/internal and this is not an explicitly local deployment. */
  | "request_host_internal"
  /** X-Forwarded-Host carries the browser's host but TRUST_FORWARDED_HOST is off, so the only host we may trust is the container's internal one. */
  | "forwarded_host_untrusted"
  /** X-Forwarded-Proto is present but its first hop is neither http nor https. */
  | "forwarded_proto_invalid"
  /** Production traffic resolved to a plain-http destination (TLS proxy forgot X-Forwarded-Proto, or worse). */
  | "origin_insecure"
  /** Host tenancy is on and the resolved request host is not under ROOT_DOMAIN. */
  | "request_host_outside_root"
  /** The company's subdomain cannot be a DNS label. */
  | "subdomain_invalid";

export interface PublicOriginEnv extends HostEnv {
  /** Optional operator-pinned browser-facing origin (`https://panel.example.com`). */
  PUBLIC_ORIGIN?: string;
}

export interface HandoffOriginContext {
  env: PublicOriginEnv;
  /**
   * Whether this deployment is *explicitly* local: the desktop site install
   * (DEPLOYMENT_ROLE=site) or non-production development. Only then may a
   * loopback/private/internal destination through.
   */
  allowLocal: boolean;
  hostHeader: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  /** `request.nextUrl.protocol`, e.g. "http:". */
  requestProtocol: string;
  /** The internal company's subdomain when host tenancy is on; null in single-host mode. */
  tenantSubdomain: string | null;
}

export type HandoffOriginResult =
  | { ok: true; origin: string }
  | { ok: false; code: HandoffOriginFailure };

/** Same shape as `validateSubdomain`'s input: one DNS label, or a failure. */
function validatedLabel(subdomain: string): { ok: true; label: string } | { ok: false; code: HandoffOriginFailure } {
  const label = subdomain.trim().toLowerCase();
  if (validateSubdomain(label) !== null) return { ok: false, code: "subdomain_invalid" };
  return { ok: true, label };
}

const ROOT_DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function validatedRootDomain(
  env: PublicOriginEnv,
  allowLocal: boolean,
): { ok: true; root: string } | { ok: false; code: HandoffOriginFailure } {
  const raw = (env.ROOT_DOMAIN ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!raw) return { ok: false, code: "root_domain_missing" };
  if (!ROOT_DOMAIN_PATTERN.test(raw)) return { ok: false, code: "root_domain_invalid" };
  if (!allowLocal && classifyHostname(raw) !== "public") {
    return { ok: false, code: "root_domain_internal" };
  }
  return { ok: true, root: raw };
}

/**
 * Parses `PUBLIC_ORIGIN` — which must be exactly an origin: scheme, host and
 * an optional port. No path, query, fragment, credentials, or trailing junk.
 * A pin with a path (`https://example.com/app`) would silently drop the path
 * or prepend it to redirects; refusing is the only safe reading.
 */
export function parsePublicOrigin(
  value: string,
): { scheme: string; hostname: string; port: string; origin: string } | null {
  const raw = value.trim();
  if (!raw) return null;
  const withoutScheme = raw.replace(/^https?:\/\//i, "");
  if (!withoutScheme || /[/?#]/.test(withoutScheme.replace(/\/$/, ""))) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.origin === "null") return null;
  return {
    scheme: url.protocol.replace(/:$/, ""),
    hostname: url.hostname.toLowerCase(),
    port: url.port,
    origin: url.origin,
  };
}

/**
 * The scheme the browser is using, under the proxy trust contract.
 *
 * `X-Forwarded-Proto` is honoured when its first hop is http or https — the
 * established `preferredProto` contract, needed by every proxy shape the
 * product ships behind. A value that claims to be a scheme but is neither
 * fails closed here (`forwarded_proto_invalid`) instead of being silently
 * discarded: a mangled or spoofed scheme must not fall back to the
 * container's own http and produce a mixed-scheme redirect.
 */
function resolveScheme(forwardedProto: string | null | undefined, requestProtocol: string): string | null {
  const raw = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (raw) {
    if (raw !== "http" && raw !== "https") return null;
    return raw;
  }
  const fallback = requestProtocol.replace(/:$/, "").toLowerCase();
  return fallback === "http" || fallback === "https" ? fallback : "https";
}

function portSuffix(scheme: string, port: string): string {
  if (!port) return "";
  if (scheme === "https" && port === "443") return "";
  if (scheme === "http" && port === "80") return "";
  return `:${port}`;
}

function joinOrigin(scheme: string, hostname: string, port: string): string {
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `${scheme}://${host}${portSuffix(scheme, port)}`;
}

function tenantOrigin(scheme: string, label: string, root: string, port: string): string {
  return joinOrigin(scheme, `${label}.${root}`, port);
}

/**
 * The handoff destination — or the reason there must not be one.
 *
 * Never consults `request.url`: that is where #1062 came from. Everything is
 * derived from `PUBLIC_ORIGIN`, the configured root, and the request's
 * *validated* host under the TRUST_FORWARDED_HOST contract — the same rule
 * `resolveRequestHost` applies to the tenancy decision, so the origin this
 * builds can never disagree with the origin middleware thinks the request is
 * on. The result carries no path; the caller appends its fixed route.
 */
export function resolveHandoffOrigin(ctx: HandoffOriginContext): HandoffOriginResult {
  const declared = (ctx.env.PUBLIC_ORIGIN ?? "").trim();
  if (declared) {
    const explicit = parsePublicOrigin(declared);
    if (!explicit) return { ok: false, code: "public_origin_invalid" };
    if (!ctx.allowLocal) {
      if (explicit.scheme !== "https") return { ok: false, code: "public_origin_insecure" };
      if (classifyHostname(explicit.hostname) !== "public") {
        return { ok: false, code: "public_origin_internal" };
      }
    }
    if (ctx.tenantSubdomain === null) return { ok: true, origin: explicit.origin };
    // Host tenancy: the pin must name this deployment's root zone (its apex,
    // console, or a tenant), and the tenant host is rebuilt under the root so
    // a pin naming one business cannot capture another's handoff.
    const root = validatedRootDomain(ctx.env, ctx.allowLocal);
    if (!root.ok) return root;
    if (parseHost(explicit.hostname, root.root).kind === "unknown") {
      return { ok: false, code: "public_origin_invalid" };
    }
    const label = validatedLabel(ctx.tenantSubdomain);
    if (!label.ok) return label;
    return { ok: true, origin: tenantOrigin(explicit.scheme, label.label, root.root, explicit.port) };
  }

  const scheme = resolveScheme(ctx.forwardedProto, ctx.requestProtocol);
  if (!scheme) return { ok: false, code: "forwarded_proto_invalid" };

  const trustedHost = resolveRequestHost(ctx.hostHeader, ctx.forwardedHost, ctx.env);
  if (!trustedHost.trim()) return { ok: false, code: "request_host_missing" };
  const { hostname, port } = splitHostPort(trustedHost);
  if (!hostname) return { ok: false, code: "request_host_missing" };

  const reach = classifyHostname(hostname);
  if (!ctx.allowLocal && reach !== "public") {
    // The #1062 shape, named precisely: a public host IS known to the proxy —
    // it rode in X-Forwarded-Host — but the deployment has not declared that
    // header trustworthy, so the only host we may act on is the container's
    // internal one. "Set TRUST_FORWARDED_HOST=on (if the proxy overwrites the
    // header) or PUBLIC_ORIGIN, or make the proxy pass the browser's Host."
    const forwarded = ctx.forwardedHost?.split(",")[0]?.trim() ?? "";
    if (forwarded && !trustForwardedHost(ctx.env)) {
      return { ok: false, code: "forwarded_host_untrusted" };
    }
    return { ok: false, code: "request_host_internal" };
  }
  if (!ctx.allowLocal && scheme !== "https") {
    return { ok: false, code: "origin_insecure" };
  }

  if (ctx.tenantSubdomain === null) {
    return { ok: true, origin: joinOrigin(scheme, hostname, port) };
  }

  const root = validatedRootDomain(ctx.env, ctx.allowLocal);
  if (!root.ok) return root;
  const label = validatedLabel(ctx.tenantSubdomain);
  if (!label.ok) return label;
  if (parseHost(trustedHost, root.root).kind === "unknown") {
    return { ok: false, code: "request_host_outside_root" };
  }
  return { ok: true, origin: tenantOrigin(scheme, label.label, root.root, port) };
}

// ---------------------------------------------------------------------------
// Ambient wrappers
// ---------------------------------------------------------------------------

/**
 * Whether loopback/private/internal destinations are legitimate here.
 *
 * "Explicitly local" means exactly two things: a site install (the desktop
 * binds 127.0.0.1 and DEPLOYMENT_ROLE=site says so out loud) or
 * non-production development. A production *central* deployment — the shape
 * #1062 broke on — is never local, whatever its request host claims to be.
 */
export function localOriginsAllowed(): boolean {
  const env = process.env as { NODE_ENV?: string };
  return env.NODE_ENV !== "production" || deploymentRole() === "site";
}

export interface HandoffRequestLike {
  headers: { get(name: string): string | null };
  nextUrl: { protocol: string; host?: string };
}

/**
 * `resolveHandoffOrigin`'s context for a real request and the ambient environment.
 *
 * The host input is the `Host` header, falling back to `nextUrl.host` — the
 * same value every real server fills from the request line, and the input the
 * routes' host handling always used (the #1062 defect was trusting it (or a
 * spoofable `X-Forwarded-Host`) as an *origin*; here it is only a host string,
 * and `resolveHandoffOrigin` classifies and validates it like any other).
 * The fallback matters for synthetic requests — `new NextRequest(url)` carries
 * no `Host` header — so the test harness and any header-less caller land on
 * the same validated single-host path a real request would.
 */
export function handoffOriginContext(
  request: HandoffRequestLike,
  tenantSubdomain: string | null,
  env: PublicOriginEnv = process.env as PublicOriginEnv,
): HandoffOriginContext {
  return {
    env,
    allowLocal: localOriginsAllowed(),
    hostHeader: request.headers.get("host") ?? request.nextUrl.host ?? null,
    forwardedHost: request.headers.get("x-forwarded-host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
    requestProtocol: request.nextUrl.protocol,
    tenantSubdomain,
  };
}

/**
 * Response headers every handoff response carries.
 *
 * The receiver's URL holds the one-use credential in its query string:
 * `no-store` keeps it out of caches and intermediaries, `no-referrer` stops
 * the redirect chain from leaking the token-bearing URL as a `Referer` on the
 * very next request (the app page the handoff lands on). The same two headers
 * go on the open endpoint's redirect so its Location (the token URL) is never
 * cached or referrered either.
 */
export function handoffSecurityHeaders(): Readonly<Record<string, string>> {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
}

/** Applies `handoffSecurityHeaders` in place and returns the response. */
export function withHandoffHeaders<T extends { headers: Headers }>(response: T): T {
  for (const [name, value] of Object.entries(handoffSecurityHeaders())) {
    response.headers.set(name, value);
  }
  return response;
}
