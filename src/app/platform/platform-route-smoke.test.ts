/**
 * The super-admin equivalent of `../route-smoke.test.ts`.
 *
 * The tenant and platform consoles intentionally use separate cookies and
 * separate middleware branches. This test keeps the platform route list tied
 * to its grouped IA, while checking authentication at the route boundary — a
 * hidden navigation item must never be the only protection for its page/API.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { middleware } from "@/middleware";
import { signSession, type SessionPayload } from "@/lib/auth-edge";
import {
  PLATFORM_SESSION_COOKIE,
  signPlatformSession,
  type PlatformSessionPayload,
} from "@/lib/platform-auth-edge";
import { NAV_GROUPS } from "./_lib/navigation";

const ORIGIN = "http://localhost:3000";
const PLATFORM_ADMIN: PlatformSessionPayload = {
  padmin: "platform-admin-1",
  role: "owner",
  fullName: "مدیر سکو",
  email: "owner@example.test",
};
const TENANT_OWNER: SessionPayload = {
  sub: "tenant-user-1",
  role: "owner",
  businessId: "business-1",
  locationId: null,
  fullName: "مالک کسب‌وکار",
};

let platformCookie = "";
let tenantCookie = "";

const originalDeploymentRole = process.env.DEPLOYMENT_ROLE;
beforeAll(async () => {
  process.env.DEPLOYMENT_ROLE = "central";
  [platformCookie, tenantCookie] = await Promise.all([
    signPlatformSession(PLATFORM_ADMIN),
    signSession(TENANT_OWNER),
  ]);
});
afterAll(() => {
  if (originalDeploymentRole === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = originalDeploymentRole;
});

function request(
  pathname: string,
  cookies: { platform?: boolean; tenant?: boolean } = {},
): NextRequest {
  const req = new NextRequest(new URL(pathname, ORIGIN), { method: "GET" });
  if (cookies.platform) req.cookies.set(PLATFORM_SESSION_COOKIE, platformCookie);
  if (cookies.tenant) req.cookies.set("pos_session", tenantCookie);
  return req;
}

async function visit(pathname: string, cookies: { platform?: boolean; tenant?: boolean } = {}) {
  const response = await middleware(request(pathname, cookies));
  const location = response.headers.get("location");
  return {
    response,
    location: location ? new URL(location, ORIGIN) : null,
  };
}

/** Top-level IA plus every platform detail/context route with a page. */
const PLATFORM_ROUTES: readonly string[] = [
  ...NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href)),
  "/platform/cms/billing-sync",
  "/platform/cms/connection",
  "/platform/cms/infrastructure",
  "/platform/cms/logs",
  "/platform/cms/sites",
  "/platform/cms/sites/site-1",
  "/platform/cms/sync",
  "/platform/cms/themes",
  "/platform/system/logs",
  "/platform/businesses/business-1",
  "/platform/businesses/business-1/settings",
  "/platform/businesses/business-1/plan",
  "/platform/businesses/business-1/billing",
  "/platform/businesses/business-1/features",
  "/platform/businesses/business-1/support",
  "/platform/businesses/business-1/danger",
];

describe("platform route boundary", () => {
  it("does not expose the central console from a Local or Hybrid site process", async () => {
    process.env.DEPLOYMENT_ROLE = "site";
    try {
      expect((await visit("/platform/login")).response.status).toBe(404);
      expect((await visit("/api/platform/auth/me")).response.status).toBe(404);
    } finally {
      process.env.DEPLOYMENT_ROLE = "central";
    }
  });
  it("serves every console IA and detail route to a platform session", async () => {
    for (const pathname of PLATFORM_ROUTES) {
      const { response } = await visit(pathname, { platform: true });
      expect(response.status, `${pathname} should pass platform middleware`).toBe(200);
      expect(response.headers.get("x-middleware-next"), `${pathname} should be served`).toBe("1");
    }
  });

  it("sends every protected console route to the separate platform login", async () => {
    for (const pathname of PLATFORM_ROUTES) {
      const { response, location } = await visit(pathname);
      expect(response.status, `${pathname} should require a platform session`).toBe(307);
      expect(location?.pathname).toBe("/platform/login");
    }
  });

  it("keeps the platform login public without opening the rest of the console", async () => {
    const { response } = await visit("/platform/login");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not accept a tenant session as a platform session, or the reverse", async () => {
    const platformWithTenant = await visit("/platform/businesses", { tenant: true });
    expect(platformWithTenant.response.status).toBe(307);
    expect(platformWithTenant.location?.pathname).toBe("/platform/login");

    const tenantWithPlatform = await visit("/dashboard", { platform: true });
    expect(tenantWithPlatform.response.status).toBe(307);
    expect(tenantWithPlatform.location?.pathname).toBe("/login");
  });

  it("protects the console API boundary independently from menu visibility", async () => {
    const anonymous = await visit("/api/platform/overview");
    expect(anonymous.response.status).toBe(307);
    expect(anonymous.location?.pathname).toBe("/platform/login");

    const authenticated = await visit("/api/platform/overview", { platform: true });
    expect(authenticated.response.status).toBe(200);
    expect(authenticated.response.headers.get("x-middleware-next")).toBe("1");
  });
});
