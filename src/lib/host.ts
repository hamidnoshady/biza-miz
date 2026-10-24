/**
 * Which origin a request arrived on: the apex router, the platform console,
 * or one business's own subdomain.
 *
 * Pure and dependency-free because both runtimes need it. `src/middleware.ts`
 * runs on Edge, where it cannot query Postgres — so the *only* thing it can do
 * with a host is parse it and compare the label against the JWT's own claim.
 * The Node-runtime resolver (/api/host/resolve) uses the same parse before it
 * touches the database, so the two layers can never disagree about what a host
 * means.
 *
 * ROOT_DOMAIN drives everything. Locally it is `localtest.me`, which resolves
 * every subdomain to 127.0.0.1 with no hosts-file editing; in production it is
 * whatever zone the deployment was given.
 *
 * The root may itself be a subdomain — `ac.eshobe.com` is a root just as much
 * as `eshobe.com` is, and businesses then live at `biz1.ac.eshobe.com`. Nothing
 * here counts labels in the root: it is matched as a suffix, so one more level
 * of nesting costs nothing in code. What it costs is in DNS and TLS, where the
 * wildcard has to be `*.ac.eshobe.com` — a certificate for `*.eshobe.com` does
 * NOT cover a name one level deeper.
 */

export type HostKind =
  /** The bare root domain — a "which business?" router, authenticates nothing. */
  | "apex"
  /** admin.{root} — the super-admin console's own realm. */
  | "admin"
  /** {label}.{root} — one business's origin. */
  | "business"
  /** Not under ROOT_DOMAIN at all, or ROOT_DOMAIN is unset. */
  | "unknown";

export interface ParsedHost {
  kind: HostKind;
  /** The business label for "business", "admin" for admin, "" otherwise. */
  label: string;
}

/** The console's own host label. Kept here so middleware and slug.ts agree. */
export const ADMIN_HOST_LABEL = "admin";

/**
 * Strips the port and any trailing dot, and lowercases.
 *
 * The Host header carries the port (`acme.localtest.me:3000` in dev, and
 * behind a proxy on any non-standard port), and a fully-qualified name may end
 * in a dot. Neither is part of the name we compare.
 */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/**
 * Parses a Host header against ROOT_DOMAIN.
 *
 * Returns "unknown" — never a guess — when the host is not under the root, or
 * when no root is configured. Callers must fail closed on it: an unknown host
 * is precisely the case where we cannot say which tenant is being addressed.
 * Multi-label subdomains (`a.b.{root}`) are also "unknown", because a wildcard
 * certificate covers exactly one level and anything deeper would be served
 * without a valid certificate. This is about labels *below* the root, not the
 * root's own depth: with ROOT_DOMAIN=`ac.eshobe.com`, `biz1.ac.eshobe.com` is
 * one label below the root and resolves normally, while `a.biz1.ac.eshobe.com`
 * does not.
 */
export function parseHost(host: string | null | undefined, rootDomain: string | null | undefined): ParsedHost {
  const root = rootDomain?.trim().toLowerCase().replace(/^\.+|\.+$/g, "") ?? "";
  const name = normalizeHost(host ?? "");
  if (!root || !name) return { kind: "unknown", label: "" };

  if (name === root) return { kind: "apex", label: "" };
  if (!name.endsWith(`.${root}`)) return { kind: "unknown", label: "" };

  const label = name.slice(0, -(root.length + 1));
  if (!label || label.includes(".")) return { kind: "unknown", label: "" };
  if (label === ADMIN_HOST_LABEL) return { kind: "admin", label };

  return { kind: "business", label };
}

/**
 * The first DNS label of a hostname — `titea` for `titea.app.eshobe.com`.
 *
 * `parseHost` is the answer when host tenancy is ON: it knows ROOT_DOMAIN, so
 * it can say whether a name is the apex, the console or a business. This is
 * the much weaker question that is still worth asking when host tenancy is
 * OFF — a deployment with no `ROOT_DOMAIN`, or one holding
 * `SUBDOMAIN_ROUTING=off` while its wildcard certificate is sorted out.
 *
 * There, `parseHost` returns "unknown" for every request and the login family
 * had nothing left to identify a tenant with but "the only active business",
 * which on a platform holding two is `business_required` — the staff picker
 * then failed with «دریافت فهرست کارکنان ممکن نشد» on an origin that plainly
 * names its business, while the owner's email login (which resolves a tenant
 * from the person's memberships instead) kept working. DNS is already
 * routing `{subdomain}.{whatever}` here; reading that first label is enough
 * to ask the database whether a business owns it.
 *
 * Returns "" for anything that cannot be a business label: a bare name with
 * no dot (`localhost`), an IPv4 literal, an IPv6 literal. A label that
 * survives is still only a *candidate* — nothing is decided until a
 * `businesses` row claims it.
 */
export function leadingHostLabel(host: string | null | undefined): string {
  const name = normalizeHost(host ?? "");
  // IPv6 literals keep their colons after normalizeHost strips the port.
  if (!name || name.includes(":")) return "";
  if (/^\d+(?:\.\d+)*$/.test(name)) return "";
  const dot = name.indexOf(".");
  if (dot <= 0) return "";
  return name.slice(0, dot);
}

/** `{label}.{root}` — for redirects to a business's own origin. */
export function businessHost(label: string, rootDomain: string): string {
  return `${label}.${rootDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, "")}`;
}

/**
 * Rewrite the label of an incoming Host header, keeping its port.
 *
 * The port is the point. A redirect built by mutating `request.nextUrl` keeps
 * *that* URL's port — which behind a TLS-terminating proxy is the container's
 * internal one, not the port the browser is talking to. Traefik listens on 443
 * and forwards to 3000, so `/platform` on a tenant host redirected to
 * `https://admin.example.com:3000/platform`, where nothing is listening.
 *
 * The Host header is the right source because it is what the *client* asked
 * for: it carries the external port when there is a non-default one, and none
 * when there isn't.
 */
export function swapHostLabel(hostHeader: string | null | undefined, newLabel: string, rootDomain: string): string {
  const port = (hostHeader ?? "").trim().match(/:(\d+)$/)?.[1];
  return businessHost(newLabel, rootDomain) + (port ? `:${port}` : "");
}

/**
 * The scheme the browser is actually using.
 *
 * `x-forwarded-proto` is what a terminating proxy sets; `fallback` is the
 * request's own scheme, which is correct when nothing is in front. Anything
 * other than http/https in the header is ignored rather than trusted — it is
 * client-supplied unless a proxy overwrote it.
 */
export function preferredProto(forwardedProto: string | null | undefined, fallback: string): string {
  const declared = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (declared === "https" || declared === "http") return declared;
  return fallback.replace(/:$/, "") || "https";
}

/**
 * Whether host-based tenancy is switched on.
 *
 * **ROOT_DOMAIN is the switch now.** Phase 23 shipped this behind an opt-in
 * `SUBDOMAIN_ROUTING=on` because the path-prefix rewrite was still the shipped
 * default and had to stay reachable. That rewrite is gone — a business is
 * addressed by its origin and by nothing else — so a deployment that declares
 * a root domain wants per-business origins by definition, and requiring a
 * second variable to say so only produces the failure mode where ROOT_DOMAIN
 * is set, routing is off, and several tenants share one origin with no
 * boundary at all.
 *
 * An install with no ROOT_DOMAIN (the desktop app, a single-café laptop) is
 * unaffected: nothing is host-scoped there, and `/dashboard` is served as-is.
 *
 * `SUBDOMAIN_ROUTING=off` remains as an explicit escape hatch for the one case
 * that still needs it — a deployment whose DNS or wildcard certificate is not
 * ready, which would otherwise be locked out of its own dashboard by an
 * upgrade. Any other value, including unset, means on.
 */
export interface HostEnv {
  SUBDOMAIN_ROUTING?: string;
  ROOT_DOMAIN?: string;
  TRUST_FORWARDED_HOST?: string;
}

/** The values that turn the switch off; everything else (including unset) is on. */
const ROUTING_OFF = new Set(["off", "false", "0", "no"]);

export function subdomainRoutingEnabled(env: HostEnv): boolean {
  if (!env.ROOT_DOMAIN?.trim()) return false;
  return !ROUTING_OFF.has(env.SUBDOMAIN_ROUTING?.trim().toLowerCase() ?? "");
}

/**
 * Whether the deployment's proxy rewrites `Host`, so the real one arrives in
 * `X-Forwarded-Host`.
 *
 * Off by default, and that default is the safe one: `X-Forwarded-Host` is
 * client-supplied unless something in front overwrites it, and this decides
 * which tenant a request belongs to. Traefik passes the original `Host`
 * through untouched, so a deployment behind it must leave this off.
 *
 * A managed platform (Runflare, and most PaaS/CDN edges) does the opposite: it
 * routes by hostname itself and hands the container an internal name like
 * `web-1234.internal:3000`, keeping the browser's hostname in
 * `X-Forwarded-Host`. There, `Host` names no tenant ever, every request parses
 * as "unknown", and host tenancy cannot work at all — turning this on is the
 * only way to run per-business origins on such a platform.
 *
 * What it costs, stated plainly: a caller who can reach the app *directly*,
 * bypassing the proxy, can then choose which origin their request appears to
 * be on. That does not cross the tenant boundary — rows are scoped by the
 * `businessId` inside the session JWT, not by the host, so RLS is unaffected —
 * but it does mean the origin check degrades to what the browser's cookie jar
 * already enforces. Only turn it on when the platform is the sole route in.
 */
export function trustForwardedHost(env: HostEnv): boolean {
  const value = env.TRUST_FORWARDED_HOST?.trim().toLowerCase();
  return value === "on" || value === "true" || value === "1";
}

/**
 * The hostname the tenancy decision is made on.
 *
 * One place, so middleware, the root page, the login family and WebAuthn's
 * origin check can never disagree about what "this request's host" means —
 * a disagreement there would be a boundary that holds in one layer and not
 * another.
 *
 * `X-Forwarded-Host` may carry a list when several proxies have appended to
 * it; the first entry is the one the browser asked for, which is the one that
 * names a tenant.
 */
export function resolveRequestHost(
  hostHeader: string | null | undefined,
  forwardedHost: string | null | undefined,
  env: HostEnv,
): string {
  if (trustForwardedHost(env)) {
    const first = forwardedHost?.split(",")[0]?.trim();
    if (first) return first;
  }
  return hostHeader?.trim() ?? "";
}

/**
 * Whether a WebSocket upgrade's `Origin` names this same deployment.
 *
 * Lives here, next to `resolveRequestHost`, because the two must agree: the
 * custom server (server.ts) accepts `/ws` upgrades and has to compare `Origin`
 * against the host the BROWSER used, which behind a managed platform edge is
 * `X-Forwarded-Host` and not `Host`. Comparing against the raw `Host` there
 * 403s every upgrade — the edge hands the container an internal name like
 * `web-1234.internal:3000` that no browser `Origin` can ever match — so live
 * sync never connects and the dashboard sits on "اتصال به سرور قطع است" while
 * the app and database are perfectly healthy.
 *
 * A missing `Origin` is allowed: non-browser clients (the desktop shell, the
 * print agent, health probes) do not send one, and it is browsers alone that
 * this check defends against. Ports are compared too — `normalizeHost` strips
 * them, and same-origin policy does distinguish them, but the edge routinely
 * rewrites the port between browser and container, so matching on hostname is
 * the only comparison that holds across every shipped deployment.
 */
export function websocketOriginAllowed(
  origin: string | null | undefined,
  hostHeader: string | null | undefined,
  forwardedHost: string | null | undefined,
  env: HostEnv,
): boolean {
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const expected = resolveRequestHost(hostHeader, forwardedHost, env);
  if (!expected) return false;
  return normalizeHost(originHost) === normalizeHost(expected);
}

/**
 * Whether `/api/host/resolve?debug=1` may answer (issue #1003; SECURITY_AUDIT
 * L5). The debug block echoes the raw Host / X-Forwarded-Host headers and the
 * routing configuration — including, behind a managed platform, the internal
 * hostname of the container — to anyone who asks. That is the one tool for
 * finding out that a proxy rewrites `Host`, so it stays available wherever it
 * is needed: always in development, and on a production server only while an
 * operator has switched it on with `HOST_RESOLVE_DEBUG=on`. Otherwise the
 * parameter is ignored.
 */
export function hostDebugEnabled(env: { NODE_ENV?: string; HOST_RESOLVE_DEBUG?: string }): boolean {
  if (env.NODE_ENV !== "production") return true;
  const flag = env.HOST_RESOLVE_DEBUG?.trim().toLowerCase();
  return flag === "on" || flag === "true" || flag === "1";
}

/** `resolveRequestHost` against the ambient environment and a request's headers. */
export function requestHost(headers: {
  get(name: string): string | null;
}): string {
  return resolveRequestHost(
    headers.get("host"),
    headers.get("x-forwarded-host"),
    process.env as HostEnv,
  );
}

/**
 * The same question against the ambient environment, which is how every
 * caller outside the tests asks it.
 *
 * The cast is needed because process.env's type declares no properties of its
 * own, so TypeScript's weak-type check rejects passing it to an all-optional
 * interface — the same reason deployment-role.ts casts.
 */
export function hostRoutingEnabled(): boolean {
  return subdomainRoutingEnabled(process.env as HostEnv);
}

/** ROOT_DOMAIN, trimmed — "" when unset. */
export function rootDomain(): string {
  return process.env.ROOT_DOMAIN?.trim() ?? "";
}
