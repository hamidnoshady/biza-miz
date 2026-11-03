/**
 * Issue #1194 — a site runtime cannot serve the Central Superadmin realm.
 *
 * Middleware already answers 404 for `/platform/*` and `/api/platform/*`, and
 * the desktop runtime no longer contains those modules. These tests cover the
 * layer in between: the *authorization* code, which must deny the realm even
 * when a handler is invoked directly (a unit test, an internal call, a future
 * router change, or a customer who patched their own middleware).
 *
 * The last case is the one the issue's acceptance criterion is really about:
 * a platform session minted on a desktop (which signs with its own generated
 * JWT secret) must not verify against Central, and a Central session must not
 * verify on a desktop. Neither side can be talked into trusting the other by
 * editing local roles, cookies or code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { platformRealmDenialForRole, platformRealmUnavailable } from "./platform-runtime-guard";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the Central realm is a deployment-role decision, not a cookie decision", () => {
  it("answers 404 deployment_unsupported on a site and nothing on central", async () => {
    const site = platformRealmDenialForRole("site");
    expect(site?.status).toBe(404);
    expect(site?.headers.get("cache-control")).toContain("no-store");
    expect(await site?.json()).toEqual({ error: "deployment_unsupported" });

    expect(platformRealmDenialForRole("central")).toBeNull();
  });

  it("reads the process role, defaulting an unconfigured install to site", () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    expect(platformRealmUnavailable()?.status).toBe(404);

    vi.stubEnv("DEPLOYMENT_ROLE", "central");
    expect(platformRealmUnavailable()).toBeNull();

    // Unset role + no sync/domain hints is the desktop's shape, and inference
    // resolves it to "site" (src/lib/deployment-role.ts).
    vi.stubEnv("DEPLOYMENT_ROLE", "");
    vi.stubEnv("REMOTE_SYNC_TOKEN", "");
    vi.stubEnv("POS_DOMAIN", "");
    vi.stubEnv("ROOT_DOMAIN", "");
    expect(platformRealmUnavailable()?.status).toBe(404);
  });

  it("denies a directly invoked platform handler without touching the database", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    // Importing the route is enough: the guard runs before any credential read
    // or query, so a request that never reaches `pg` still gets the denial.
    const { POST } = await import("../app/api/platform/auth/login/route");
    const response = await POST(
      new NextRequest("http://localhost:3000/api/platform/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", password: "irrelevant" }),
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "deployment_unsupported" });
  });

  it("every platform entry point carries the guard", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const root = process.cwd();
    // Unauthenticated entrances (no requirePlatformAdmin to inherit the check)
    // must call the guard themselves.
    for (const file of [
      "src/app/api/platform/auth/login/route.ts",
      "src/app/api/platform/auth/mfa/challenge/route.ts",
      "src/app/api/platform/auth/mfa/enrol/route.ts",
      "src/app/api/platform/auth/mfa/verify/route.ts",
      "src/app/api/platform/mcp/route.ts",
      "src/app/api/platform/mcp/oauth/authorize/route.ts",
      "src/app/api/platform/mcp/oauth/register/route.ts",
      "src/app/api/platform/mcp/oauth/revoke/route.ts",
      "src/app/api/platform/mcp/oauth/token/route.ts",
      "src/app/api/platform/pairing/redeem/route.ts",
    ]) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source, file).toContain("platformRealmUnavailable");
    }
    // The authenticated choke points do too.
    const auth = readFileSync(path.join(root, "src", "lib", "platform-auth.ts"), "utf8");
    expect(auth.match(/platformRealmUnavailable\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("cross-install platform sessions", () => {
  const SITE_SECRET = "site-install-generated-secret-0123456789abcdef0123456789";
  const CENTRAL_SECRET = "central-install-generated-secret-fedcba9876543210fedcba98";

  it("a desktop-minted platform token does not verify against central's secret", async () => {
    vi.stubEnv("JWT_SECRET", SITE_SECRET);
    vi.resetModules();
    const desktop = await import("./platform-auth-edge");
    const desktopToken = await desktop.signPlatformSession({
      padmin: "locally-inserted-admin",
      role: "owner",
      fullName: "Local Tinkerer",
      email: "local@example.invalid",
    });
    // Sanity: it round-trips on the install that minted it…
    expect(await desktop.verifyPlatformSession(desktopToken)).not.toBeNull();

    // …and Central, running with its own generated secret, rejects it.
    vi.stubEnv("JWT_SECRET", CENTRAL_SECRET);
    vi.resetModules();
    const central = await import("./platform-auth-edge");
    expect(await central.verifyPlatformSession(desktopToken)).toBeNull();

    // A Central platform session does not verify back on the desktop either.
    const centralToken = await central.signPlatformSession({
      padmin: "central-admin",
      role: "owner",
      fullName: "Central",
      email: "central@example.invalid",
    });
    vi.stubEnv("JWT_SECRET", SITE_SECRET);
    vi.resetModules();
    const desktopAgain = await import("./platform-auth-edge");
    expect(await desktopAgain.verifyPlatformSession(centralToken)).toBeNull();
  });

  it("neither realm accepts the other's session token", async () => {
    vi.stubEnv("JWT_SECRET", CENTRAL_SECRET);
    vi.resetModules();
    const platformEdge = await import("./platform-auth-edge");
    const tenantEdge = await import("./auth-edge");

    const tenantToken = await tenantEdge.signSession({
      sub: "user-1",
      role: "owner",
      businessId: "biz-1",
      locationId: null,
      fullName: "Owner",
    });
    const platformToken = await platformEdge.signPlatformSession({
      padmin: "admin-1",
      role: "owner",
      fullName: "Admin",
      email: "admin@example.invalid",
    });

    expect(await platformEdge.verifyPlatformSession(tenantToken)).toBeNull();
    expect(await tenantEdge.verifySession(platformToken)).toBeNull();
    // A tenant session that *claims* platform authority is still a tenant
    // token: the realm claim is what the verifier checks, not the payload.
    const forged = await tenantEdge.signSession({
      sub: "user-1",
      role: "superadmin",
      businessId: "biz-1",
      locationId: null,
      fullName: "Not Central",
      ...({ realm: "platform", padmin: "user-1" } as object),
    } as never);
    expect(await platformEdge.verifyPlatformSession(forged)).toBeNull();
  });
});
