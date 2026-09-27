import { NextRequest, NextResponse } from "next/server";
import {
  cspMode,
  generateNonce,
  contentSecurityPolicy,
  staticSecurityHeaders,
} from "@/lib/security-headers";

// Imported from auth-edge, not auth: middleware runs in the Edge runtime,
// where the tenant context (node:async_hooks) and the pg pool that @/lib/auth
// now pulls in cannot load.
import { SESSION_COOKIE, verifySession } from "@/lib/auth-edge";
import {
  PLATFORM_SESSION_COOKIE,
  verifyPlatformSession,
} from "@/lib/platform-auth-edge";
import {
  checkRateLimit,
  hashKey,
  sweepExpired,
  clientIpFrom,
  type RateLimitEntry,
} from "@/lib/rate-limit";
import { isInternalCall } from "@/lib/internal-auth";
import { legacyRedirectTarget } from "@/lib/app-routes";
import { deploymentRole } from "@/lib/deployment-role";
import { supportMutationAllowed } from "@/lib/support-session";
import {
  ADMIN_HOST_LABEL,
  hostRoutingEnabled,
  parseHost,
  preferredProto,
  requestHost,
  swapHostLabel,
  type ParsedHost,
} from "@/lib/host";

const CENTRAL_EXECUTION_PATHS = [
  "/api/rollup/ingest",
  "/api/server-sync/push",
  "/api/server-sync/pull",
  "/api/server-sync/media",
  "/api/server-sync/update-check",
  "/api/server-sync/config/generate-token",
  "/api/peer/backup",
  "/api/v1",
  "/api/ai",
  "/api/workspace",
  "/api/billing",
  "/api/messaging",
  "/api/notifications/devices",
  "/api/notifications/public-key",
  "/api/notifications/test",
  "/api/growth",
  "/api/cms",
  "/api/website",
  "/api/connections/website",
  "/api/integrations",
  "/api/integrations/wordpress",
  "/api/integrations/woocommerce/webhook",
  "/api/mcp",
  "/api/connections/mcp",
  "/api/well-known/oauth-",
  "/.well-known/oauth-",
  "/api/cms/revalidate",
  "/api/cms/order-events",
  "/api/pairing/redeem",
  "/mcp",
] as const;

export function isCentralExecutionPath(pathname: string): boolean {
  return CENTRAL_EXECUTION_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || (prefix.endsWith("-") && pathname.startsWith(prefix)));
}

const PUBLIC_PATHS = [
  // The root path decides, in src/app/page.tsx, between the login page and the
  // first-run wizard — and that decision needs to happen there, because only a
  // Node-runtime page can ask the database whether the install has any users
  // yet. Gating `/` here pre-empted it with an unconditional redirect to
  // /login, which made the wizard unreachable on a fresh desktop install (the
  // Electron window opens exactly `/`). The page itself sends an authenticated
  // caller on to the dashboard, so nothing is exposed by letting it run.
  "/",
  "/login",
  // The login split: the tenant origin's root is the staff quick login, and
  // the owner/manager password login moved to this subdirectory of the
  // business's own origin (src/app/admin). Like `/login` it mints nothing
  // yet — no session exists when it is reached — so it cannot require one.
  "/admin",
  "/api/auth/login",
  "/api/auth/pin-login",
  // Phase 20 Wave 3 — the biometric-login counterpart of pin-login: no
  // session exists yet either, by the same definition. Registering a new
  // authenticator (/api/auth/webauthn/register/*) is deliberately NOT here —
  // that's self-service for an already-authenticated employee, not a login
  // path, so it goes through the normal session requirement below.
  "/api/auth/webauthn/login",
  // Phase 23 follow-up — the console's one-time impersonation handoff token is
  // the credential: the caller has no session on the business's origin yet, by
  // definition (the token exists precisely to mint the first one). Same shape
  // as accept-invite.
  "/api/auth/impersonate-handoff",
  // First-run flow: /welcome bootstraps an empty install; the state endpoint
  // answers "needsBootstrap" (and nothing more) without a session.
  "/welcome",
  "/api/setup/bootstrap",
  "/api/setup/state",
  // Desktop first-run pairing: like bootstrap, it runs against an empty
  // database, so there is no session to require. The one-time code in the body
  // is the credential, and the route refuses once any user exists.
  "/api/setup/pair",
  // The cloud side of that same exchange, on whatever origin the owner copied.
  // The twin under /api/platform is unchanged, but everything with that prefix
  // is moved to the console's host — and since an owner now issues a desktop
  // code from their *own* dashboard, the address they hand the desktop app is
  // their business origin. See src/lib/pairing-redeem.ts.
  "/api/pairing/redeem",
  // Phase 12: self-service business registration creates the tenant a session
  // would otherwise be scoped to, so it cannot require one. Refuses with 403
  // unless ALLOW_PUBLIC_SIGNUP is set.
  "/api/setup/signup",
  // Phase 13: an invitee has no session and no membership of the inviting
  // business yet — the single-use token in the link is the credential.
  "/invite",
  "/api/auth/accept-invite",
  // Phase 9: the caller is another location's server, not a browser — the
  // route authenticates it with a per-location bearer token, not a session.
  "/api/rollup/ingest",
  // Phase 11: same shape — the caller is a peer server (café laptop <-> VPS),
  // authenticated by a bearer token (server-sync.ts's per-business hashed
  // token, or the legacy REMOTE_SYNC_TOKEN fallback), never a session. These
  // were missing from this list entirely, which meant this generic "no
  // session -> 401" branch below rejected every real call before it ever
  // reached the route handler's own token check — server-sync has been
  // completely unreachable regardless of a valid token until this fix.
  "/api/server-sync/push",
  "/api/server-sync/pull",
  "/api/server-sync/media",
  // Migration 0132: the same shape again — the caller is another *server*
  // migrating onto this one, authenticated with a bearer token issued in the
  // super-admin console (`platform_backup_tokens`, hashed), never with a
  // session. Both endpoints answer 404 while serving is disabled, so nothing is
  // exposed by letting them through the session gate; the handlers do the auth.
  "/api/peer/backup",
  // Phase 19: third-party integrations authenticate each request with a
  // bearer API key inside api-auth.ts, not with a tenant session cookie.
  // Prefix matching keeps every /api/v1/* route reachable pre-session.
  "/api/v1",
  // Phase 23: WooCommerce delivers webhooks to this URL with an HMAC-SHA256
  // signature, not a tenant session — the handler authenticates the delivery
  // against the connection's webhook secret before resolving its business.
  "/api/integrations/woocommerce/webhook",
  // The other way a store connects: the WordPress plugin authenticates every
  // call with a bearer link token plus an HMAC envelope over timestamp, nonce
  // and body (src/lib/integrations/plugin-link.ts), never a tenant session.
  // Prefix-matched so the whole /ping, /handshake, /events, /jobs family is
  // reachable pre-session.
  "/api/integrations/wordpress",
  // Phase 34: the MCP connector. Every path under /api/mcp authenticates with a
  // bearer credential (a connector token, or an OAuth access token) or is part
  // of the OAuth flow that mints one — the authorize/token/register endpoints
  // exist precisely to be reachable before any session, and the MCP endpoint
  // itself is called by a program that will never hold a cookie. Prefix-matched
  // so the whole family is reachable. The one part of the flow that DOES need a
  // session — the owner pressing "allow" — deliberately lives outside this
  // prefix, at /api/connections/mcp/consent.
  "/api/mcp",
  // The OAuth discovery documents, which a client reads before it has any
  // credential at all. `/.well-known/*` is what RFC 8414/9728 specify and is
  // rewritten to `/api/well-known/*` in next.config.ts — middleware runs before
  // that rewrite, so both spellings are listed.
  "/.well-known",
  "/api/well-known",
  // Phase 23: the apex host's "which business?" router. It verifies a password
  // but mints nothing — the whole point is that no session exists on the apex —
  // so like every other credential exchange it cannot require one.
  "/api/auth/directory",
  // Phase 24 — the tenant-password MFA interstitial. Guarded by the five-minute
  // `mfa_pending` bearer token, never by a session — issuing a session first is
  // exactly what MFA exists to prevent, so by definition the caller has none
  // yet. These three were missing here entirely, which meant the generic
  // "no session -> 401" branch below rejected every one of them before the
  // route handler (which does check the bearer token) ever ran: any account
  // with MFA required could never finish signing in.
  "/api/auth/mfa/challenge",
  "/api/auth/mfa/verify",
  "/api/auth/mfa/enrol",
  // Phase 23: host resolution — "what business is this hostname?" (/resolve)
  // and "you're at the wrong address, here's the right one" (/redirect). Both
  // answer questions the Edge runtime cannot, because they need Postgres, for
  // callers who by definition have no usable session on this origin.
  "/api/host",
  // Liveness probe. Both the client status strip and the hosting platform's
  // own health check hit it without a session, and a probe that gets
  // redirected into the host resolver reads as "the app is down".
  "/api/health",
  // The site relay uses a server-only bearer secret, never a browser session.
  // It accepts only Support/Bug Report envelopes and is the sole cloud channel
  // intentionally available to a fully Local installation.
  "/api/cloud-exceptions/relay",
  // The Windows Print Connector payload (public/windows). It is tenant-neutral
  // by design — the same static file for every business — but it is consumed
  // by the installer's PowerShell download, which by definition carries no
  // session cookie. Gating it behind the session check made first install
  // download the *login page's HTML* instead of the connector on every
  // host-routed deployment. The exact tenant origin is never decided here;
  // the authenticated installer route bakes it into each .cmd.
  "/windows",
];

/**
 * Phase 15 — the super-admin realm's own public entrances. The platform login
 * page and its auth endpoints must be reachable without a platform session
 * (you cannot require the thing you are trying to obtain), and `auth/me`
 * self-guards (it returns null rather than 401 when signed out, so the console
 * can bootstrap). Everything else under /platform requires the platform cookie.
 */
const PLATFORM_PUBLIC_PATHS = [
  "/platform/login",
  "/api/platform/auth/login",
  "/api/platform/auth/logout",
  "/api/platform/auth/me",
  // Desktop pairing: the caller is a freshly-installed app with no session in
  // either realm, and the one-time code in the body is the credential — the
  // same shape as accept-invite. The handler resolves it or refuses.
  "/api/platform/pairing/redeem",
  // The platform-admin twin of the tenant MFA interstitial above — same
  // bearer-token guard, same reason it must be reachable pre-session.
  "/api/platform/auth/mfa/challenge",
  "/api/platform/auth/mfa/verify",
  "/api/platform/auth/mfa/enrol",
];

/**
 * Whether a path is served without a tenant session.
 *
 * A declared path matches itself and its subtree, never a path that merely
 * shares its text (`/logindecoy` is not `/login`). `"/"` is exact-only by the
 * same rule — its subtree form is `"//"`, which no real path starts with — so
 * listing it opens the root page alone, not the whole app.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * The handful of paths still answered on a host that parses as "unknown"
 * (not under ROOT_DOMAIN at all). Everything else is a 404 — see the
 * fail-closed block in `handle()` for why. Kept as its own exported
 * predicate so the middleware test can hold the list honest: every entry
 * here is an explanation or a probe, never anything that authenticates.
 */
export function unknownHostAllowedPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/api/health" ||
    // The rate limiter's durable counter, which middleware calls on *itself*
    // over loopback (internalBaseOrigin in src/lib/rate-limit.ts defaults to
    // http://127.0.0.1:{PORT}). That Host header is `127.0.0.1`, which is never
    // under ROOT_DOMAIN — so failing closed here 404'd the call on every
    // host-routed deployment and silently dropped every bucket back to the
    // per-process Map: the reset-on-restart, not-shared-across-replicas
    // behaviour Phase 24 Wave 5 exists to remove. This path serves no tenant
    // and no console, and it authenticates with the internal secret derived
    // from JWT_SECRET (src/lib/internal-auth.ts), so letting it through on a
    // hostname nobody vouches for opens no entrance to anything.
    pathname === "/api/internal/rate-limit" ||
    // CMS usage ingest authenticates with its own billing credential, not a
    // tenant session and not the internal JWT secret.
    pathname === "/api/internal/billing/usage/v1/batch" ||
    pathname === "/api/host" ||
    pathname.startsWith("/api/host/")
  );
}

/** Methods that change state — the ones a read-only impersonation may not use. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A POST that pretends to invoke a server action.
 *
 * This app has none: every mutation is a route handler under `/api/**`. So a
 * request carrying `next-action` reaches Next's own "this app has no server
 * actions, answer 404 early" branch — which *warns* on the way out
 * (`The Server Reference ID did not match the expected format. Received "x"`,
 * plus the stack, once per request) into the same log stream an operator reads to
 * find a broken café. Nothing of ours can send one — no client code, the print
 * agent, the WordPress plugin or the service worker (which only ever reads GET)
 * puts that header on a request — so whatever arrives with it is a scanner probing
 * the Server Action surface with `0`, `1`, `x` and `action` for an id, or a client
 * aimed at whatever else this address used to serve. Both are answered the same
 * way, and the log stops being where an operator has to notice them.
 */
const SERVER_ACTION_ID = /^[0-9a-f]{42}$/;

/**
 * Whether to refuse a request before the router sees it — the malformed ids only,
 * which is the whole of what middleware can decide without reading a body. A
 * well-formed one (`SERVER_REFERENCE_ID_LENGTH` hex characters: one info byte plus
 * the module/export hash) is passed through to fail in Next's own way, so this
 * guard does not have to be revisited on the day the app grows its first server
 * action.
 *
 * `/api/**` is exempt, and not for tidiness: a route handler never reads the
 * header (only the page render path does), so a POST to one of them is already
 * answered by that handler on its own terms. Refusing it here instead would
 * change documented behaviour for every integration, print agent and peer server
 * that ever calls us, to silence a log line that was never going to be written.
 *
 * Exported for `src/middleware.test.ts`, which holds the three edges: a malformed
 * id on a page path is refused, a well-formed id, a non-POST and an API path are
 * not touched.
 */
export function isStrayServerActionCall(
  method: string,
  pathname: string,
  nextAction: null | string,
): boolean {
  if (method !== "POST" || nextAction === null || pathname.startsWith("/api/")) return false;
  return !SERVER_ACTION_ID.test(nextAction);
}

/**
 * Phase 17 — tenant-scoped rate limiting. Four independent fixed-window
 * counters, keyed so that one business (or one runaway bearer-token client,
 * or one IP hammering a login form) can only ever exhaust its own bucket:
 *
 *  - `businessLimits`: every authenticated tenant API request, keyed by
 *    `session.businessId` (decoded from the JWT — no DB lookup needed here).
 *    This is the exit criterion itself: "one business's traffic ... can't
 *    degrade another's".
 *  - `syncTokenLimits`: the session-less, bearer-token server-to-server
 *    routes (`rollup/ingest`, `server-sync/push`, `server-sync/pull`).
 *    Middleware can't resolve a token to a business without the DB, so this
 *    keys on the token itself (hashed, so raw tokens never sit in memory as
 *    map keys) — a runaway or misconfigured sync client can only ever
 *    saturate its own bucket, not every business sharing this server.
 *  - `apiKeyLimits`: the session-less public API route family, keyed by a
 *    hash of its Authorization header so one integration cannot starve other
 *    businesses (or retain a raw secret in this process).
 *  - `authIpLimits`: credential-exchange endpoints, keyed by IP, ahead of any
 *    session — the login routes have no other request-volume defence today.
 *
 * All four Maps are module-level and unbounded by nothing but `sweepExpired`
 * (called occasionally, not per-request) — the business map stays small on
 * its own (one entry per business), but the IP/token maps grow with every
 * distinct caller ever seen.
 */
const businessLimits = new Map<string, RateLimitEntry>();
const syncTokenLimits = new Map<string, RateLimitEntry>();
const apiKeyLimits = new Map<string, RateLimitEntry>();
const authIpLimits = new Map<string, RateLimitEntry>();
const rosterIpLimits = new Map<string, RateLimitEntry>();
const mcpLimits = new Map<string, RateLimitEntry>();

const BUSINESS_API_LIMIT = 300;
const BUSINESS_API_WINDOW_MS = 60_000;
const SYNC_TOKEN_LIMIT = 60;
const SYNC_TOKEN_WINDOW_MS = 60_000;
const API_KEY_LIMIT = 120;
const API_KEY_WINDOW_MS = 60_000;
const AUTH_IP_LIMIT = 20;
const AUTH_IP_WINDOW_MS = 60_000;
/**
 * The staff picker's roster read gets its own bucket, and a much larger one,
 * because it is the *landing page* of a business's origin rather than a
 * credential attempt: src/app/page.tsx sends every signed-out visitor to
 * /login, and /login's only content is the picker, so one of these fires on
 * every single visit from every terminal.
 *
 * It used to share `AUTH_IP_LIMIT` (20/min) with the credential exchanges it
 * precedes. That made the login screen able to lock itself out: a handful of
 * tills behind one café NAT address — one shared public IP, and behind no
 * proxy at all they share the literal key `ip:unknown` — spend the budget on
 * page loads alone, after which `POST /api/auth/pin-login` answers 429 too and
 * nobody can sign in for the rest of the window. Enumeration still needs a
 * ceiling (this route lists a business's staff pre-session), so it keeps one;
 * it just no longer competes with the PIN that follows it. Brute-forcing the
 * PIN itself stays bounded twice over — by AUTH_IP_LIMIT here and by the
 * per-employee lockout in employee-service.ts.
 */
const ROSTER_IP_LIMIT = 120;
const ROSTER_IP_WINDOW_MS = 60_000;
// Phase 34 — the MCP realm's own bucket, keyed by bearer credential (or by IP
// where there is none yet, which is the OAuth flow). Higher than the public
// API's, because a single model turn routinely fans out into a handful of tool
// calls and an owner watching a chat stall on a 429 has no way to tell why.
const MCP_LIMIT = 240;
const MCP_WINDOW_MS = 60_000;

const STALE_ENTRY_MS = 5 * 60_000;
const SWEEP_EVERY_N_REQUESTS = 200;
let requestsSinceSweep = 0;

function maybeSweep(now: number) {
  requestsSinceSweep += 1;
  if (requestsSinceSweep < SWEEP_EVERY_N_REQUESTS) return;
  requestsSinceSweep = 0;
  sweepExpired(businessLimits, now, STALE_ENTRY_MS);
  sweepExpired(syncTokenLimits, now, STALE_ENTRY_MS);
  sweepExpired(apiKeyLimits, now, STALE_ENTRY_MS);
  sweepExpired(authIpLimits, now, STALE_ENTRY_MS);
  sweepExpired(rosterIpLimits, now, STALE_ENTRY_MS);
  sweepExpired(mcpLimits, now, STALE_ENTRY_MS);
}

function clientIp(request: NextRequest): string {
  const trustedHops = Number(process.env.TRUSTED_PROXY_HOPS ?? "1");
  const ip = clientIpFrom(request.headers, trustedHops);
  if (ip !== "unknown") return ip;
  return "unknown";
}

function rateLimited(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    { error: "rate_limited" },
    {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
    },
  );
}

/** Credential-exchange endpoints in both auth realms — brute-force targets with no session to key on yet. */
const AUTH_RATE_LIMITED_PATHS = [
  "/api/auth/login",
  "/api/auth/pin-login",
  // Phase 20 Wave 3 — the biometric login ceremony's two steps. Deliberately
  // *not* the staff picker's roster read, which preceded the PIN here until it
  // turned out that sharing one 20/min budget let the login page's own loads
  // starve the PIN that follows it — see isStaffRosterPath and ROSTER_IP_LIMIT.
  "/api/auth/webauthn/login/options",
  "/api/auth/webauthn/login/verify",
  "/api/platform/auth/login",
  // Phase 23 — the apex directory checks a password from an unauthenticated
  // public origin, so it is a brute-force target on exactly the same terms as
  // the login routes above and shares their per-IP bucket.
  "/api/auth/directory",
  // Phase 23 follow-up — a one-time impersonation handoff token is a
  // credential exchange like every other token/code redemption, so it shares
  // the per-IP bucket rather than going unlimited.
  "/api/auth/impersonate-handoff",
  // A pairing code is a 12-character credential submitted without a session,
  // and /api/setup/pair forwards one; all three belong in the same per-IP
  // bucket as every other credential exchange rather than going unlimited.
  "/api/platform/pairing/redeem",
  "/api/pairing/redeem",
  "/api/setup/pair",
  // Self-service business registration accepts an *existing* platform user's
  // email with a guessed password (adding a business to an already-registered
  // account authenticates against that account's real password — see
  // business-provisioning.ts's EmailPasswordMismatchError) and had no per-IP
  // throttle of its own at all: unlike every route above it sits outside this
  // list, so an attacker could try passwords against a known Owner email
  // indefinitely, limited only by bcrypt's own cost. It shares the same
  // per-IP bucket as every other credential exchange rather than going
  // unlimited.
  "/api/setup/signup",
  // Phase 24 — the tenant/platform MFA interstitial (see PUBLIC_PATHS above):
  // `verify` checks a 6-digit TOTP/SMS code or a 10-code recovery list against
  // a pending login, and `enrol` is reachable with the same bearer token.
  // `challenge` already carries its own per-identity limiter
  // (mfa-rate-limit.ts) but shares this bucket too, same as every other
  // pre-session endpoint, since it is still a plain per-IP target.
  "/api/auth/mfa/challenge",
  "/api/auth/mfa/verify",
  "/api/auth/mfa/enrol",
  // Phase 42 — the phone-OTP door's two steps: `request` spends SMS credit
  // and `verify` guesses a 6-digit code, both pre-session (see the sibling
  // comment in PUBLIC_PATHS). The per-identity send limiter lives in
  // phone-otp.ts; this per-IP bucket is the outer ceiling.
  "/api/auth/phone-otp/request",
  "/api/auth/phone-otp/verify",
  "/api/platform/auth/mfa/challenge",
  "/api/platform/auth/mfa/verify",
  "/api/platform/auth/mfa/enrol",
];

/**
 * The staff picker's roster read — one request per login-page load, on the
 * landing page of every business origin, so it is bucketed on its own terms
 * (ROSTER_IP_LIMIT) rather than sharing the credential budget.
 *
 * Exported for src/middleware.test.ts, which holds the separation honest: the
 * whole bug this fixes was the roster sitting inside AUTH_RATE_LIMITED_PATHS.
 */
export function isStaffRosterPath(pathname: string): boolean {
  return pathname === "/api/auth/pin-login/roster";
}

/**
 * Whether a path draws on the credential-exchange budget (AUTH_IP_LIMIT).
 *
 * Exported for src/middleware.test.ts, which pins the one thing that must not
 * regress: the staff picker's roster read is *not* in this bucket, because
 * sharing it let the login page's own loads starve the PIN that follows.
 */
export function isAuthRateLimitedPath(pathname: string): boolean {
  return AUTH_RATE_LIMITED_PATHS.includes(pathname);
}

/** The session-less, bearer-token server-to-server routes (see PUBLIC_PATHS below for why each is public). */
const SYNC_TOKEN_RATE_LIMITED_PATHS = [
  "/api/rollup/ingest",
  "/api/server-sync/push",
  "/api/server-sync/pull",
];

/**
 * The WordPress plugin channel shares that bucket, and shares it *by prefix*
 * rather than by an exact route list: it is a family of five endpoints one
 * caller cycles through on every scheduled run, and a compromised WordPress
 * install is exactly the runaway client the per-token bucket exists to
 * contain.
 */
function isPluginChannelPath(pathname: string): boolean {
  return pathname === "/api/integrations/wordpress" || pathname.startsWith("/api/integrations/wordpress/");
}

/**
 * The MCP realm: the endpoint plus its OAuth flow and discovery documents.
 * Prefix-based for the same reason the plugin channel is — one caller cycles
 * through the whole family, and a compromised connector is exactly the runaway
 * client the per-credential bucket exists to contain.
 */
function isMcpPath(pathname: string): boolean {
  return (
    pathname === "/api/mcp" ||
    pathname.startsWith("/api/mcp/") ||
    pathname.startsWith("/.well-known/oauth-") ||
    pathname.startsWith("/api/well-known/oauth-")
  );
}

/**
 * The backup-serving channel (migration 0132): the manifest poll and the one
 * large download that follows it. Prefix-bucketed like the plugin channel — one
 * peer cycles through both, and a peer stuck in a retry loop is exactly the
 * runaway this bucket exists to contain. A download is one request, so the sync
 * window bounds *attempts*, not bytes, which is the right unit here.
 *
 * Exported for src/middleware.test.ts, which asserts both halves: that the
 * channel is reachable without a session, and that the prefix does not swallow a
 * path that merely resembles it.
 */
export function isPeerBackupPath(pathname: string): boolean {
  return pathname === "/api/peer/backup" || pathname.startsWith("/api/peer/backup/");
}

/** All public API routes share one per-key bucket; this must stay prefix-based, not an exact route list. */
function isPublicApiPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

/**
 * Routes this server calls on itself, which are never public.
 *
 * Reaching one still requires the internal secret; this only marks which paths
 * are *eligible* to present it, so a stray header on any other route changes
 * nothing.
 */
function isInternalRoutePath(pathname: string): boolean {
  return pathname === "/api/internal/rate-limit" || pathname.startsWith("/api/internal/");
}

async function handleRateLimits(
  request: NextRequest,
  pathname: string,
  now: number,
): Promise<NextResponse | null> {
  if (AUTH_RATE_LIMITED_PATHS.includes(pathname)) {
    const result = await checkRateLimit(
      authIpLimits,
      `ip:${clientIp(request)}`,
      AUTH_IP_LIMIT,
      AUTH_IP_WINDOW_MS,
      now,
    );
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  // The staff picker's roster: its own bucket, its own map, so a floor full of
  // terminals reloading the login screen can spend this budget all day without
  // ever touching the one the PIN itself needs. See ROSTER_IP_LIMIT for why the
  // two were separated.
  //
  // The key is namespaced, not just the Map: the durable counter in Postgres is
  // a single row per key (`rate_limits`, upserted `ON CONFLICT (key)`), so two
  // buckets that both asked for `ip:{addr}` would increment the *same* row and
  // the stricter ceiling would win — the roster's reads would still spend the
  // PIN's budget on every deployment where the durable counter is reachable.
  if (isStaffRosterPath(pathname)) {
    const result = await checkRateLimit(
      rosterIpLimits,
      `roster-ip:${clientIp(request)}`,
      ROSTER_IP_LIMIT,
      ROSTER_IP_WINDOW_MS,
      now,
    );
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  if (
    SYNC_TOKEN_RATE_LIMITED_PATHS.includes(pathname) || isPluginChannelPath(pathname) || isPeerBackupPath(pathname)
  ) {
    const authHeader = request.headers.get("authorization");
    const key = authHeader
      ? `token:${hashKey(authHeader)}`
      : `ip:${clientIp(request)}`;
    const result = await checkRateLimit(
      syncTokenLimits,
      key,
      SYNC_TOKEN_LIMIT,
      SYNC_TOKEN_WINDOW_MS,
      now,
    );
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  if (isMcpPath(pathname)) {
    const authHeader = request.headers.get("authorization");
    const key = authHeader ? `mcp:${hashKey(authHeader)}` : `ip:${clientIp(request)}`;
    const result = await checkRateLimit(mcpLimits, key, MCP_LIMIT, MCP_WINDOW_MS, now);
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  if (isPublicApiPath(pathname)) {
    const authHeader = request.headers.get("authorization");
    const key = authHeader
      ? `api-key:${hashKey(authHeader)}`
      : `ip:${clientIp(request)}`;
    const result = await checkRateLimit(
      apiKeyLimits,
      key,
      API_KEY_LIMIT,
      API_KEY_WINDOW_MS,
      now,
    );
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  return null;
}

async function handlePlatformAdmin(
  request: NextRequest,
  pathname: string,
  host: ParsedHost | null,
  rootDomain: string,
  requestHeaders: Headers,
): Promise<NextResponse | null> {
  if (
    pathname === "/platform" ||
    pathname.startsWith("/platform/") ||
    pathname.startsWith("/api/platform")
  ) {
    // The platform console is a central-runtime application, not merely a
    // hidden tenant page. A Local or Hybrid site process must never expose it,
    // even when somebody knows the route or has copied a platform cookie.
    if (deploymentRole() !== "central") {
      return pathname.startsWith("/api/")
        ? NextResponse.json({ error: "deployment_unsupported" }, { status: 404 })
        : new NextResponse("Not Found", { status: 404 });
    }

    // Phase 23: the console lives on admin.{root} and nowhere else. Serving it
    // from a tenant's origin would put the super-admin realm inside that
    // tenant's browser origin — the exact sharing this wave removes — so the
    // request is moved to the console's own host rather than answered here.
    if (host && host.kind !== "admin") {
      return redirectToLabel(
        request,
        ADMIN_HOST_LABEL,
        rootDomain,
        `${request.nextUrl.pathname}${request.nextUrl.search}`,
      );
    }

    if (PLATFORM_PUBLIC_PATHS.some((p) => pathname === p)) {
      return NextResponse.next({ request: { headers: requestHeaders } });
    }

    const platformToken = request.cookies.get(PLATFORM_SESSION_COOKIE)?.value;
    const platformSession = platformToken
      ? await verifyPlatformSession(platformToken)
      : null;
    if (!platformSession) {
      return NextResponse.redirect(new URL("/platform/login", request.url));
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  }
  return null;
}

/**
 * A redirect to another label under ROOT_DOMAIN, on the origin the *browser*
 * is using.
 *
 * Mutating `request.nextUrl` would keep that URL's port, which behind a
 * TLS-terminating proxy is the container's internal one — Traefik listens on
 * 443 and forwards to 3000, so `/platform` on a tenant host used to redirect
 * to `https://admin.example.com:3000/platform`, where nothing is listening.
 * The Host header is what the client actually asked for, so it is the source
 * of truth for both host and port.
 */
function redirectToLabel(
  request: NextRequest,
  label: string,
  rootDomain: string,
  pathAndQuery: string,
  status?: number,
): NextResponse {
  const hostHeader = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = preferredProto(request.headers.get("x-forwarded-proto"), request.nextUrl.protocol);
  const target = swapHostLabel(hostHeader, label, rootDomain);
  return NextResponse.redirect(`${proto}://${target}${pathAndQuery}`, status);
}

/**
 * Hand a request to the Node-runtime resolver, on this same host.
 *
 * Middleware can see that a host does not match the session but not *why* —
 * an alias left over from a rename looks identical to a wrong origin, and
 * telling them apart needs the database. /api/host/redirect can, and either
 * forwards to the canonical host or sends the visitor to this host's login.
 */
function toHostResolver(request: NextRequest, next: string, slug?: string): NextResponse {
  const url = new URL("/api/host/redirect", request.url);
  url.searchParams.set("next", next);
  if (slug) url.searchParams.set("slug", slug);
  return NextResponse.redirect(url);
}

async function handleTenantAuth(request: NextRequest, pathname: string, host: ParsedHost | null) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return {
        response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
    // On a business host the signed-out case has to go through the resolver
    // too, not straight to /login. A bookmark to an old host is *usually*
    // followed while signed out, and a login served from a renamed host can
    // never succeed — the session it mints names the current subdomain, which
    // this host no longer matches, so the visitor would be bounced right back.
    // The resolver forwards an alias and sends a canonical host to /login
    // itself, so a signed-out visit costs one extra hop and terminates.
    if (host?.kind === "business") {
      return {
        response: toHostResolver(request, `${request.nextUrl.pathname}${request.nextUrl.search}`),
      };
    }
    const loginUrl = new URL("/login", request.url);
    // Carry where they were going, so a deep link survives the sign-in. Phase 34
    // needs this concretely: an owner following Claude's "connect" button lands
    // on /mcp/consent, and losing that URL at the login page abandons an OAuth
    // flow they cannot restart from inside the app.
    if (!pathname.startsWith("/api/")) {
      loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    }
    return { response: NextResponse.redirect(loginUrl) };
  }
  return { session };
}

/**
 * Phase 23 — the tenant isolation boundary, and the reason this wave exists.
 *
 * Before subdomain routing, every business was served from one origin and the
 * only thing separating them was a path prefix the app itself applied. One
 * `pos_session` cookie was valid for whichever business its JWT named, and all
 * tenants shared a cookie jar, a `localStorage`, a service worker, and a
 * CSP/CORS boundary. Origin is the browser's only real isolation primitive.
 *
 * Middleware runs on Edge and cannot query Postgres, so it cannot look up
 * which business a host belongs to. What it *can* do is compare the host's
 * label to the `businessSubdomain` claim minted into the session — and that is
 * enough, because the claim was written by a Node-runtime login that did have
 * the database. A mismatch means the session is not valid on this origin.
 *
 * It fails closed in every direction: an unknown host, a session with no
 * subdomain claim (minted before Phase 23), and a label that simply differs
 * all land on this host's login with the cookie cleared. Anything softer would
 * make the boundary advisory.
 */
function handleHostIsolation(
  request: NextRequest,
  pathname: string,
  host: ParsedHost,
  sessionSubdomain: string | undefined,
): NextResponse | null {
  // The console is its own realm on its own host, already handled upstream by
  // handlePlatformAdmin; the apex authenticates nothing. Neither carries a
  // tenant session, so there is nothing to compare here.
  if (host.kind === "admin" || host.kind === "apex") return null;

  if (host.kind === "business" && sessionSubdomain === host.label) return null;

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "wrong_origin" }, { status: 401 });
  }

  // A page request goes to the resolver rather than straight to /login,
  // because this host may be an alias from a rename — in which case the right
  // answer is "you're at the old address, here's the new one", not "log in
  // again at an address that serves nobody". The resolver sends a genuinely
  // wrong origin to /login itself.
  //
  // Clearing the cookie matters as much as the redirect: leaving it in place
  // would send the browser back into the same mismatch on every navigation,
  // and the value is useless on this origin by definition.
  const response = toHostResolver(request, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

/**
 * The bookmark bridge for the retired path-prefix URLs.
 *
 * `/{slug}/dashboard/**` was the old address of every dashboard page. Nothing
 * in the app emits that form any more — the generator is gone, and a business
 * is addressed by its origin — but printed URLs and saved bookmarks still
 * carry it, so it 301s to the same path on the business's own host rather than
 * dead-ending. 301 rather than 302 because the move is permanent: the point is
 * for browsers and link-checkers to stop asking.
 */
function handleLegacyPathRedirect(
  request: NextRequest,
  pathname: string,
  rootDomain: string,
  sessionSlug: string | undefined,
  sessionSubdomain: string | undefined,
): NextResponse | null {
  // `/api/` first: `/api/dashboard/**` is a real route family and matches the
  // pattern below exactly (slug "api"), so without this every dashboard data
  // fetch would be redirected to the host resolver instead of being served.
  if (pathname.startsWith("/api/")) return null;

  const prefixed = pathname.match(/^\/([^/]+)\/dashboard(\/.*)?$/);
  if (!prefixed) return null;

  const [, slug, rest] = prefixed;
  const next = `/dashboard${rest ?? ""}${request.nextUrl.search}`;

  // The slug is NOT the host label. They agree for every business migration
  // 0066 backfilled, and diverge the moment an admin sets a real subdomain —
  // so reinterpreting the slug as a label sends `/acme-cafe/dashboard` to
  // `acme-cafe.example.com`, which serves nobody. A session that names this
  // very business already carries the translation; otherwise only the
  // database has it, so the Node-runtime resolver does the lookup.
  if (sessionSlug && sessionSubdomain && sessionSlug === slug) {
    return redirectToLabel(request, sessionSubdomain, rootDomain, next, 301);
  }
  return toHostResolver(request, next, slug);
}

async function handle(request: NextRequest, requestHeaders: Headers) {
  // ---- Legacy app URLs -----------------------------------------------------
  //
  // The apps are real route directories now (`src/app/(app)/…`), so the public
  // URLs need no rewrite at all: `/crm/segments` *is* the route Next resolves,
  // and the pathname the browser holds is the pathname the server rendered.
  // The earlier attempt mutated `request.nextUrl.pathname` to point back at
  // `/dashboard/<app>`, which desynchronised server rendering from the client
  // router and is exactly what made these URLs answer 404.
  //
  // What remains is one permanent redirect per old address, ahead of the
  // session check on purpose: an old bookmark should land on the canonical URL
  // whether or not the visitor is signed in, and the destination then does its
  // own authentication. The suffix is carried verbatim (so `/dashboard/crm`
  // becomes `/crm/overview` while `/dashboard/crm/segments` becomes
  // `/crm/segments`, never `/crm/segments/overview`), and so is the query
  // string. `src/lib/app-routes.ts` owns the table; `app-routes.test.ts` holds
  // the `/crm/overview/overview` regression.
  const legacyTarget = legacyRedirectTarget(request.nextUrl.pathname, request.nextUrl.search);
  if (legacyTarget) {
    return NextResponse.redirect(new URL(legacyTarget, request.url), 308);
  }

  const { pathname } = request.nextUrl;
  const now = Date.now();
  maybeSweep(now);

  // ---- A request that is not one this app serves ---------------------------
  //
  // Ahead of the rate limits on purpose: a probe of a surface this app does not
  // have should cost nothing and should not spend the bucket of the IP it came
  // from, which may well be shared with a real customer behind the same NAT.
  if (isStrayServerActionCall(request.method, pathname, request.headers.get("next-action"))) {
    return NextResponse.json({ error: "invalid_action_id" }, { status: 400 });
  }

  const rateLimitResponse = await handleRateLimits(request, pathname, now);
  if (rateLimitResponse) return rateLimitResponse;

  // Read once per request. A deployment with a ROOT_DOMAIN is host-routed;
  // `SUBDOMAIN_ROUTING=off` is the escape hatch for one whose wildcard
  // certificate is not issuing yet (see subdomainRoutingEnabled).
  const rootDomain = process.env.ROOT_DOMAIN?.trim() ?? "";
  const hostRouting = hostRoutingEnabled();
  // The real `Host` header by default, never `x-forwarded-host`: this drives
  // the isolation decision, and a forwarded header is client-supplied unless a
  // proxy overwrote it. Traefik passes the original Host through untouched.
  // The forwarded headers are otherwise consulted only when *building* a
  // redirect, where the worst a spoofed value can do is change a port.
  //
  // `TRUST_FORWARDED_HOST=on` inverts that, for a managed platform whose edge
  // routes by hostname and hands the container an internal name instead — see
  // `trustForwardedHost` for what that costs and when it is the only option.
  const host = hostRouting ? parseHost(requestHost(request.headers), rootDomain) : null;

  // ---- A hostname nobody vouches for ----------------------------------------
  //
  // Under host routing the hostname IS the tenancy decision, and an "unknown"
  // host — anything not under ROOT_DOMAIN, like a stale `admin.eshobe.com`
  // record left over from an earlier zone — serves no tenant and no console.
  // Fail closed: no login page, no console redirect (the old behaviour
  // forwarded /platform on ANY hostname to admin.{root}, which made a stray
  // DNS record read as a working entrance to the super-admin panel), no API.
  // What stays open is deliberately tiny: `/` itself, which renders the
  // operator-facing explanation page, the liveness probe (which a hosting
  // platform may aim at whatever hostname it pleases), and the host
  // diagnostics that exist precisely to debug this case.
  if (host && host.kind === "unknown") {
    if (!unknownHostAllowedPath(pathname)) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return new NextResponse("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  // Public/bearer authentication does not imply that a site process is an
  // execution target. Cloud APIs are absent on Local and Hybrid site runtimes;
  // their central counterparts remain reachable on the Cloud origin.
  if (deploymentRole() !== "central" && isCentralExecutionPath(pathname)) {
    return pathname.startsWith("/api/") || pathname.startsWith("/.well-known/")
      ? NextResponse.json({ error: "not_found" }, { status: 404 })
      : new NextResponse("Not Found", { status: 404 });
  }

  // ---- Super-admin realm ---------------------------------------------------
  const platformResponse = await handlePlatformAdmin(request, pathname, host, rootDomain, requestHeaders);
  if (platformResponse) return platformResponse;

  // ---- Tenant realm --------------------------------------------------------
  if (hostRouting) {
    // Neither the apex nor the console host serves a tenant, so a tenant login
    // there could only mint a cookie valid on an origin that will never use
    // it. Each is sent to the sign-in its own host does have: the apex's
    // "which business?" directory, and the console's own login page.
    if (pathname === "/login") {
      if (host?.kind === "apex") return NextResponse.redirect(new URL("/", request.url));
      if (host?.kind === "admin") {
        return NextResponse.redirect(new URL("/platform/login", request.url));
      }
    }

    // The owner/manager door has the same two non-answers: on the apex there
    // is no tenant whose admin could sign in (the directory at `/` is that
    // host's only credential exchange), and on the console host the realm's
    // own login is the one that mints a usable cookie.
    if (pathname === "/admin") {
      if (host?.kind === "apex") return NextResponse.redirect(new URL("/", request.url));
      if (host?.kind === "admin") {
        return NextResponse.redirect(new URL("/platform/login", request.url));
      }
    }

    // Ahead of the session check on purpose: an old bookmark should land on
    // the right host whether or not the visitor is signed in here, and the
    // destination host does its own authentication. The session is read (not
    // required) only because it carries the slug→subdomain translation the
    // Edge runtime cannot look up.
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const claims = token ? await verifySession(token) : null;
    const legacyRedirect = handleLegacyPathRedirect(
      request,
      pathname,
      rootDomain,
      claims?.businessSlug,
      claims?.businessSubdomain,
    );
    if (legacyRedirect) return legacyRedirect;
  } else {
    // No root domain — a desktop or single-café install, where there is no
    // other host to send anyone to. An old prefixed bookmark just loses its
    // prefix: without this it would 404, since nothing routes `/{slug}/…` any
    // more.
    const prefixed = pathname.startsWith("/api/")
      ? null
      : pathname.match(/^\/[^/]+(\/dashboard(?:\/.*)?)$/);
    if (prefixed) {
      const url = request.nextUrl.clone();
      url.pathname = prefixed[1];
      return NextResponse.redirect(url, 301);
    }
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Phase 24 Wave 5 — this server calling itself.
  //
  // `checkRateLimit` above runs in the Edge runtime and cannot reach Postgres,
  // so it asks the Node-runtime route for the durable counter over HTTP. That
  // fetch re-enters middleware, where it has no session cookie — it is made
  // *for* requests that have none — so the tenant guard below would answer 401
  // and the counter would never be written. The limiter then falls back to the
  // per-process Map on every single request, silently restoring exactly the
  // reset-on-restart, per-replica behaviour Wave 5 exists to remove.
  //
  // Listing the path in PUBLIC_PATHS would fix the 401 by making it genuinely
  // public, which is the opposite of what it needs. Instead the request is let
  // through only when it carries the internal secret, which the route then
  // verifies again itself — middleware decides "this is our own call", the
  // route decides whether to trust it.
  if (pathname === "/api/internal/billing/usage/v1/batch") {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  if (isInternalRoutePath(pathname) && (await isInternalCall(request.headers))) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const authResult = await handleTenantAuth(request, pathname, host);
  if ("response" in authResult) return authResult.response;
  const session = authResult.session;

  if (host) {
    // ---- Origin is the tenant boundary -------------------------------------
    //
    // The only tenancy the URL carries. A business used to be named by a
    // `/{slug}/` path prefix that middleware rewrote away; that scheme is gone
    // (see handleLegacyPathRedirect for what became of its URLs), so an install
    // with no ROOT_DOMAIN — the desktop app, a single-café laptop — simply
    // serves `/dashboard` with no host check to make.
    const isolationResponse = handleHostIsolation(request, pathname, host, session.businessSubdomain);
    if (isolationResponse) return isolationResponse;
  }

  // Phase 17 — every authenticated tenant API request counts against its own
  if (pathname.startsWith("/api/")) {
    const result = await checkRateLimit(
      businessLimits,
      `biz:${session.businessId}`,
      BUSINESS_API_LIMIT,
      BUSINESS_API_WINDOW_MS,
      now,
    );
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  // Phase 24 — Origin check on cookie-authenticated mutations
  const originCheckEnabled = process.env.ORIGIN_CHECK !== "0" && process.env.ORIGIN_CHECK !== "off";
  if (
    originCheckEnabled &&
    MUTATING_METHODS.has(request.method) &&
    pathname.startsWith("/api/")
  ) {
    const origin = request.headers.get("origin");
    if (!origin) {
      return NextResponse.json({ error: "bad_origin" }, { status: 403 });
    }
    try {
      const originUrl = new URL(origin);
      const host = requestHost(request.headers);
      if (originUrl.host !== host) {
        return NextResponse.json({ error: "bad_origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "bad_origin" }, { status: 403 });
    }
  }

  // Phase 15 — read-only impersonation. The same decision `withTenantScope`
  // makes, so the two layers cannot disagree — in particular both let the
  // session's own end request through.
  if (
    session.imp &&
    pathname.startsWith("/api/") &&
    MUTATING_METHODS.has(request.method) &&
    !supportMutationAllowed(session, request.method, pathname)
  ) {
    return NextResponse.json(
      { error: session.imp.mode === "read_only" ? "impersonation_read_only" : "support_capability_denied" },
      { status: 403 },
    );
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export async function middleware(request: NextRequest) {
  const nonce = generateNonce();
  const isHttps =
    preferredProto(request.headers.get("x-forwarded-proto"), request.nextUrl.protocol) === "https";

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  
  const mode = cspMode();
  const cspStr = contentSecurityPolicy(nonce, {
    https: isHttps,
    reportOnly: mode === "report-only",
  });
  
  // Set CSP on the incoming request so Next.js reads it for script nonces
  // (Next 15 reads it from the incoming request)
  requestHeaders.set("content-security-policy", cspStr);
  
  const response = await handle(request, requestHeaders) ?? NextResponse.next({ request: { headers: requestHeaders } });

  const headersObj = staticSecurityHeaders({ https: isHttps });
  for (const [key, val] of Object.entries(headersObj)) {
    response.headers.set(key, val);
  }

  if (mode === "enforce") {
    response.headers.set("Content-Security-Policy", cspStr);
  } else if (mode === "report-only") {
    response.headers.set("Content-Security-Policy-Report-Only", cspStr);
  }

  return response;
}

export const config = {
  // Everything except Next internals and static assets.
  //
  // The three PWA files are excluded by name, and that exclusion is what makes
  // the app installable on Android at all. A browser fetches a web app manifest
  // with credentials *omitted* (unless the link tag says
  // `crossorigin="use-credentials"` — it does not), so the request arrives with
  // no session cookie: middleware saw an unauthenticated page request and
  // redirected it to the host resolver, Chrome got HTML where it wanted JSON,
  // and with no readable manifest "Install app" silently degrades to a
  // home-screen *shortcut* — which opens in a Chrome tab with the address bar,
  // exactly the "it's just Chrome" symptom. iOS was unaffected only because
  // Safari ignores the manifest and installs from the `apple-mobile-web-app-*`
  // meta tags instead. `sw.js` and `offline.html` are here for the same reason
  // in a milder form: registration fired from the login page (no session yet)
  // was fetching a redirect, and an offline fallback that needs a live session
  // to be *read* is not a fallback. None of the three carries tenant data.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|offline.html|.*\\.(?:woff2|png|svg|ico)).*)",
  ],
};