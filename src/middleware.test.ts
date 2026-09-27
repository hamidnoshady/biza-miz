import { describe, expect, it } from "vitest";
import {
  isAuthRateLimitedPath,
  isCentralExecutionPath,
  isPeerBackupPath,
  isPublicPath,
  isStaffRosterPath,
  isStrayServerActionCall,
  unknownHostAllowedPath,
} from "./middleware";

describe("isPublicPath", () => {
  it("lets the root path through so it can choose between login and the wizard", () => {
    // The regression this guards: `/` used to be gated here, so an
    // unauthenticated visitor was redirected to /login before src/app/page.tsx
    // could ask whether the install has any users. A fresh desktop install
    // opens exactly `/`, so the first-run wizard was unreachable.
    expect(isPublicPath("/")).toBe(true);
  });

  it("keeps the first-run wizard and its state endpoint session-less", () => {
    expect(isPublicPath("/welcome")).toBe(true);
    expect(isPublicPath("/api/setup/state")).toBe(true);
    expect(isPublicPath("/api/setup/pair")).toBe(true);
  });

  it("keeps the tenant admin door (/admin) session-less like /login", () => {
    // The login split moved the owner/manager password form to this
    // subdirectory of the business's own origin. It mints no session before
    // it is reached, so it cannot require one — same reasoning as /login.
    expect(isPublicPath("/admin")).toBe(true);
    // ...but the subtree rule must not open a path that only shares the text.
    expect(isPublicPath("/administrator")).toBe(false);
    expect(isPublicPath("/admindash")).toBe(false);
  });

  it("still gates everything that is not declared public", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/dashboard/backup")).toBe(false);
    expect(isPublicPath("/api/orders")).toBe(false);
    expect(isPublicPath("/setup")).toBe(false);
  });

  it("matches a public path's subtree but not a path that merely shares its prefix", () => {
    expect(isPublicPath("/api/v1/orders")).toBe(true);
    expect(isPublicPath("/logindecoy")).toBe(false);
  });

  it("serves the Windows connector payload without a session", () => {
    // The installer's PowerShell download carries no session cookie by
    // definition. When this path was gated, host-routed deployments answered
    // the download with a redirect into the login page — and the installer
    // saved that HTML as the connector script. This is the regression guard.
    expect(isPublicPath("/windows")).toBe(true);
    expect(isPublicPath("/windows/cafe-pos-print-connector.ps1")).toBe(true);
    expect(isPublicPath("/windowshade")).toBe(false);
  });

  it("gates the apps' new top-level URLs exactly like the dashboard's", () => {
    // The apps left `/dashboard/<app>` for prefixes of their own. They are
    // still the same signed-in surfaces, and nothing about giving an app a
    // shorter address may make it readable without a session — the whole
    // point of `PUBLIC_PATHS` being a list rather than a prefix rule.
    for (const pathname of [
      "/accounting",
      "/accounting/overview",
      "/accounting/expenses",
      "/accounting/pos",
      "/accounting/inventory",
      "/accounting/products",
      "/accounting/products/new",
      "/accounting/cosmetics",
      "/accounting/reports",
      "/accounting/floor",
      "/accounting/kitchen",
      "/accounting/reservations",
      "/accounting/delivery",
      "/accounting/settings",
      "/crm/persons/42",
      "/growth/campaigns",
      "/websites/cms/pages",
      "/websites/wp/orders",
      "/workspace",
      "/workspace/projects",
      "/workspace/contracts",
      "/settings",
      "/settings/team",
      "/settings/billing",
      "/settings/subscription",
      "/settings/connections",
    ]) {
      expect(isPublicPath(pathname), `${pathname} must require a session`).toBe(
        false,
      );
    }
  });
});

describe("unknown hosts — fail closed", () => {
  it("still serves only the explanation page, the liveness probe and host diagnostics", () => {
    // A hostname not under ROOT_DOMAIN (a stale DNS record from an earlier
    // zone, say) must not read as a working entrance to anything: no login
    // page, no console redirect, no tenant API. The allowlist is exactly the
    // paths that explain or probe, never anything that authenticates.
    expect(unknownHostAllowedPath("/")).toBe(true);
    expect(unknownHostAllowedPath("/api/health")).toBe(true);
    expect(unknownHostAllowedPath("/api/host")).toBe(true);
    expect(unknownHostAllowedPath("/api/host/resolve")).toBe(true);
    expect(unknownHostAllowedPath("/api/host/redirect")).toBe(true);
  });

  it("still answers the rate limiter's own loopback call, which has no hostname to vouch for", () => {
    // The regression this guards: middleware asks the Node runtime for the
    // durable counter at http://127.0.0.1:{PORT}/api/internal/rate-limit, and
    // `127.0.0.1` is never under ROOT_DOMAIN — so failing closed 404'd the call
    // on every host-routed deployment and silently dropped every bucket back to
    // the per-process Map (reset on restart, not shared across replicas). The
    // path serves no tenant and no console and authenticates with the internal
    // secret, so it opens no entrance by being reachable.
    expect(unknownHostAllowedPath("/api/internal/rate-limit")).toBe(true);
    // ...but nothing else under /api/internal/ comes along for the ride.
    expect(unknownHostAllowedPath("/api/internal/")).toBe(false);
    expect(unknownHostAllowedPath("/api/internal/anything-else")).toBe(false);
    // and it is still not a *public* path — the secret remains the only way in.
    expect(isPublicPath("/api/internal/rate-limit")).toBe(false);
  });

  it("closes everything else — including the old console funnel", () => {
    expect(unknownHostAllowedPath("/login")).toBe(false);
    expect(unknownHostAllowedPath("/admin")).toBe(false);
    expect(unknownHostAllowedPath("/dashboard")).toBe(false);
    // The regression this guards: /platform on an unknown host used to be
    // forwarded to admin.{root}, which let any stray hostname act as an
    // entrance to the super-admin panel.
    expect(unknownHostAllowedPath("/platform")).toBe(false);
    expect(unknownHostAllowedPath("/platform/login")).toBe(false);
    expect(unknownHostAllowedPath("/api/auth/login")).toBe(false);
    expect(unknownHostAllowedPath("/api/hostile")).toBe(false);
  });
});

describe("public paths — Phase 23 host resolution", () => {
  it("keeps both host-resolution routes session-less", () => {
    // They exist precisely for callers whose session is absent or belongs to
    // another origin, so requiring one would make them unreachable exactly
    // when they are needed.
    expect(isPublicPath("/api/host/resolve")).toBe(true);
    expect(isPublicPath("/api/host/redirect")).toBe(true);
  });

  it("does not open anything else that merely starts with the same text", () => {
    expect(isPublicPath("/api/hostile")).toBe(false);
  });
});

describe("the backup-serving channel — migration 0132", () => {
  it("leaves the two peer endpoints session-less, because the caller is another server", () => {
    // A machine being migrated onto this one has no cookie to present; it has a
    // bearer token from the super-admin console, which the handlers verify. The
    // public entry is what makes the route reachable at all — an operator who
    // forgot it gets a redirect to /login in response to a POST, which reads as
    // a broken token rather than a missing rule.
    expect(isPublicPath("/api/peer/backup/manifest")).toBe(true);
    expect(isPublicPath("/api/peer/backup/download")).toBe(true);
  });

  it("does not open a path that only shares the prefix", () => {
    expect(isPublicPath("/api/peer/backupfoo")).toBe(false);
    expect(isPublicPath("/api/peer")).toBe(false);
    expect(isPublicPath("/api/peer/other/route")).toBe(false);
  });

  it("rate-limits the whole channel per token, so a retrying peer cannot hammer it", () => {
    // The download is one request and the manifest is polled, so bucketing by
    // prefix bounds *attempts* — which is what a runaway migration produces.
    expect(isPeerBackupPath("/api/peer/backup/manifest")).toBe(true);
    expect(isPeerBackupPath("/api/peer/backup/download")).toBe(true);
    expect(isPeerBackupPath("/api/peer/backupfoo")).toBe(false);
    expect(isPeerBackupPath("/api/peer/backup")).toBe(true);
    // and nothing unrelated joins the bucket
    expect(isPeerBackupPath("/api/server-sync/pull")).toBe(false);
    expect(isPeerBackupPath("/api/auth/login")).toBe(false);
  });
});

describe("the staff picker's roster read — bucketed apart from the credentials", () => {
  it("does not draw on the credential-exchange budget", () => {
    // The regression this guards. Since the login split the roster read fires on
    // *every* visit to a business's origin: src/app/page.tsx sends a signed-out
    // visitor to /login, and the picker is that page's only content. Sharing the
    // 20/min per-IP login bucket meant a few tills behind one café address — one
    // public IP, and behind no proxy at all they share the key `ip:unknown` —
    // spent it on page loads alone, after which POST /api/auth/pin-login answered
    // 429 too and nobody could sign in until the window turned over. The screen
    // said «دریافت فهرست کارکنان ممکن نشد» over a business that had staff.
    expect(isStaffRosterPath("/api/auth/pin-login/roster")).toBe(true);
    expect(isAuthRateLimitedPath("/api/auth/pin-login/roster")).toBe(false);
  });

  it("still rate-limits the credential exchanges it precedes", () => {
    // Brute-forcing the PIN itself stays bounded here, and again by the
    // per-employee lockout in employee-service.ts.
    expect(isAuthRateLimitedPath("/api/auth/pin-login")).toBe(true);
    expect(isAuthRateLimitedPath("/api/auth/login")).toBe(true);
    expect(isAuthRateLimitedPath("/api/auth/webauthn/login/verify")).toBe(true);
    // ...and the roster is not smuggled in as a near-miss of either name.
    expect(isStaffRosterPath("/api/auth/pin-login")).toBe(false);
    expect(isStaffRosterPath("/api/auth/pin-login/rosters")).toBe(false);
  });
});

describe("a POST aimed at a server action this app does not have", () => {
  const id = "0123456789abcdef0123456789abcdef0123456789"; // 42 hex: Next's own shape
  const page = "/platform/cms/connection";

  it("refuses the malformed ids that Next only warns about", () => {
    // The noise this removes: `next-action: 0` and friends are a scanner probing
    // the Server Action surface, and Next answers one with a 404 *and* a logged
    // error with a stack, once per request — which buries the deployment log an
    // operator reads to find a broken café. Middleware says the same 4xx in one
    // line and stays quiet.
    for (const probed of ["", "0", "1", "x", "action"]) {
      expect(isStrayServerActionCall("POST", page, probed), probed).toBe(true);
    }
    expect(isStrayServerActionCall("POST", page, `${id}deadbeef`)).toBe(true);
    // Right length, wrong alphabet: a hash is hex, a probe is anything.
    expect(isStrayServerActionCall("POST", page, "z".repeat(42))).toBe(true);
  });

  it("passes a well-formed id through, so a future action still resolves normally", () => {
    // Middleware cannot read the body, so it cannot tell a real action from a
    // forged id of the right shape — and it must not try. Next's own manifest
    // lookup ("Failed to find Server Action … from an older or newer deployment")
    // is the correct answer for that case, and a guard here would break the day
    // someone adds the app's first server action.
    expect(isStrayServerActionCall("POST", page, id)).toBe(false);
    expect(isStrayServerActionCall("POST", page, null)).toBe(false);
  });

  it("stays out of /api/**, where the header is not read and nothing is logged", () => {
    // A route handler answers on its own terms, so this guard exists purely for
    // the page render path. Applying it to the documented public API, the print
    // agent or a peer server would change their behaviour to silence a log line
    // they never write.
    expect(isStrayServerActionCall("POST", "/api/v1/orders", "x")).toBe(false);
    expect(isStrayServerActionCall("POST", "/api/health", "x")).toBe(false);
    expect(isStrayServerActionCall("POST", "/api/auth/login", "x")).toBe(false);
    // ...and the exemption is the prefix, not anything that merely starts with
    // the letters: `/apix` is a page path like any other.
    expect(isStrayServerActionCall("POST", "/apix", "x")).toBe(true);
  });

  it("does not touch a method that cannot be an action", () => {
    // Next's own gate is `POST + a next-action header`, so nothing else is
    // examined here: a GET carrying the header is an ordinary page request.
    // Refusing it would be a new behaviour, not a quieter one.
    expect(isStrayServerActionCall("GET", page, "x")).toBe(false);
    expect(isStrayServerActionCall("HEAD", page, "x")).toBe(false);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(isStrayServerActionCall(method, page, "x")).toBe(false);
    }
    expect(isStrayServerActionCall("POST", page, "x")).toBe(true);
  });
});
