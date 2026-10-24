/**
 * Issue #1003 item 8 — where a browser landing on `/` goes, decided before any
 * HTML is streamed.
 *
 * `src/app/page.tsx` used to make this decision by calling `redirect()` from
 * the page component. The root `loading.tsx` wraps that page in a Suspense
 * boundary, so by the time the redirect was thrown Next had already started
 * streaming a 200 response, and the only way left to deliver it was a
 * `<meta http-equiv="refresh">` tag: `/` answered "200 OK" with a page that
 * then navigated itself. Crawlers, uptime probes, `curl -I` and the HTTP cache
 * all saw a successful empty page instead of a redirect, and every visit paid
 * for a full HTML response it never displayed.
 *
 * Middleware now rewrites `GET /` (and `HEAD /`) to `ROOT_LANDING_PATH`, a route
 * handler that answers with a real 307 decided by `resolveRootLanding` — the
 * same rules the page applied, moved here unchanged so both share one copy.
 * The two non-redirect outcomes (the apex's business directory and the
 * unknown-host explanation) are still rendered by the page; middleware does not
 * rewrite those hosts at all, see `rewritesToRootLanding`.
 *
 * Pure apart from the injected lookups, and free of Node-only imports, because
 * the Edge middleware imports this module too.
 */
import {
  hostRoutingEnabled,
  parseHost,
  preferredProto,
  requestHost,
  rootDomain as configuredRootDomain,
  swapHostLabel,
  type ParsedHost,
} from "./host";

/** The route handler middleware rewrites `/` to (src/app/api/host/landing/route.ts). */
export const ROOT_LANDING_PATH = "/api/host/landing";

export type RootLanding =
  /** The apex: no tenant to show, render the business directory. */
  | { kind: "directory" }
  /** A hostname not under ROOT_DOMAIN: render the operator-facing explanation. */
  | { kind: "unresolvable" }
  /** Anything else: send the browser on. `location` is a same-origin path, or an absolute URL for a renamed host. */
  | { kind: "redirect"; location: string };

/** The database-backed questions the decision needs; the Node-runtime callers pass the real ones. */
export interface RootLandingDeps {
  resolveBusinessByLabel(label: string): Promise<{ subdomain: string; viaAlias: boolean } | null>;
  getSession(): Promise<{ role: string; businessId: string } | null>;
  hasAnyUser(): Promise<boolean>;
  isSetupComplete(businessId: string): Promise<boolean>;
}

/**
 * Whether middleware should answer this request through `ROOT_LANDING_PATH`.
 *
 * Only `GET`/`HEAD` of exactly `/`. Under host routing the apex and unknown
 * hosts are left to the page, because their answer is a page, not a redirect;
 * every other host — a business, the console host — and every install without
 * host routing (the desktop, a single café) always redirects.
 */
export function rewritesToRootLanding(
  method: string,
  pathname: string,
  host: Pick<ParsedHost, "kind"> | null,
): boolean {
  if (pathname !== "/") return false;
  if (method !== "GET" && method !== "HEAD") return false;
  return !host || (host.kind !== "apex" && host.kind !== "unknown");
}

/** The landing decision for `/`, exactly as `src/app/page.tsx` made it before issue #1003. */
export async function resolveRootLanding(
  headers: { get(name: string): string | null },
  deps: RootLandingDeps,
): Promise<RootLanding> {
  // Phase 23 — middleware runs on Edge and cannot reach Postgres, so "which
  // business is this host, and is it an old name?" has to be answered here.
  const rootDomain = configuredRootDomain();
  if (hostRoutingEnabled()) {
    const host = parseHost(requestHost(headers), rootDomain);

    // The apex has no tenant to show. It is a signpost to the business hosts.
    if (host.kind === "apex") return { kind: "directory" };

    // A hostname this deployment cannot name a tenant for. Every redirect
    // cycle passes through `/`, so this is where one has to stop: continuing
    // on to `/dashboard` sends the request back into middleware, which bounces
    // it to the host resolver, which bounces it back here — forever, and with
    // a managed platform's health probe caught in it, that loop takes the
    // whole deployment down with a 502. Stopping costs a legitimate visitor
    // (someone reaching the app by IP, or by the platform's own default
    // domain) nothing but an explanation.
    if (host.kind === "unknown") return { kind: "unresolvable" };

    if (host.kind === "business") {
      const business = await deps.resolveBusinessByLabel(host.label);
      // Arrived on a host the business used to have: send them to the current
      // one so bookmarks made before a rename still work. The scheme and port
      // come from the request rather than being assumed — behind a proxy the
      // app's own view of them is the internal one.
      if (business?.viaAlias) {
        const proto = preferredProto(headers.get("x-forwarded-proto"), "https");
        const forwardedHost = headers.get("x-forwarded-host") ?? headers.get("host");
        return {
          kind: "redirect",
          location: `${proto}://${swapHostLabel(forwardedHost, business.subdomain, rootDomain)}/`,
        };
      }
    }
  }

  const session = await deps.getSession();
  if (!session) {
    // Empty install → first-run wizard; otherwise normal login.
    return { kind: "redirect", location: (await deps.hasAnyUser()) ? "/login" : "/welcome" };
  }
  // Owner/Manager land in the wizard until setup is finished.
  if (
    (session.role === "owner" || session.role === "manager") &&
    !(await deps.isSetupComplete(session.businessId))
  ) {
    return { kind: "redirect", location: "/setup" };
  }
  // The dashboard has one address. A business is named by its origin, never by
  // a path prefix: `/{slug}/dashboard` is the retired form, still redirected
  // for old bookmarks (see handleLegacyPathRedirect in src/middleware.ts) but
  // no longer generated anywhere.
  return { kind: "redirect", location: "/dashboard" };
}
