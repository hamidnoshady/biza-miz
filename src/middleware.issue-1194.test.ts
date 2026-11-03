/**
 * Issue #1194 — Hybrid and Full Offline installs must deny the Central
 * Superadmin realm, including when the caller brings a credential.
 *
 * The desktop package no longer contains the platform routes, and
 * `src/lib/platform-runtime-guard.ts` denies them in the authorization layer.
 * This file covers the request-time edge in between: middleware must answer
 * 404 *before* any session is read, for every platform path and every shape of
 * credential a local tinkerer can present —
 *
 *   - a valid tenant session cookie replayed as the platform cookie,
 *   - a forged platform cookie shaped like a real one,
 *   - a tenant token whose payload claims `realm: "platform"`,
 *   - an admin-host request (host routing must not re-enable the realm),
 *
 * and it must do so without setting a cookie, redirecting to a login page or
 * otherwise mutating Local or Central state. The last case proves the same
 * paths still pass through on the central runtime, so the denial is a
 * deployment-role boundary rather than a blanket block.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware, isPlatformRealmPath, unsupportedOnThisRuntime } from "./middleware";

interface CallOptions {
  ip: string;
  host?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, { ip, host = "localhost:3000", headers = {} }: CallOptions) {
  const response = await middleware(
    new NextRequest(`http://${host}${path}`, {
      method,
      headers: { host, "x-forwarded-for": ip, ...headers },
    }),
  );
  const passed = response.headers.get("x-middleware-next") === "1";
  const bodyText = passed ? "" : await response.clone().text();
  let body: unknown = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = null;
  }
  return { response, status: response.status, passed, body, bodyText };
}

const PLATFORM_PATHS = [
  { method: "GET", path: "/platform" },
  { method: "GET", path: "/platform/login" },
  { method: "GET", path: "/platform/businesses" },
  { method: "GET", path: "/api/platform/auth/me" },
  { method: "POST", path: "/api/platform/auth/login" },
  { method: "POST", path: "/api/platform/auth/mfa/challenge" },
  { method: "POST", path: "/api/platform/pairing/redeem" },
  { method: "POST", path: "/api/platform/mcp" },
  { method: "GET", path: "/api/platform/mcp/oauth/authorize" },
];

const HOSTILE_CREDENTIALS = {
  tenantReplayedAsPlatform:
    "pos_session=eyJhbGciOiJIUzI1NiJ9.tenant; pos_platform_session=eyJhbGciOiJIUzI1NiJ9.tenant",
  forgedPlatform: "pos_platform_session=eyJhbGciOiJIUzI1NiJ9.eyJyZWFsbSI6InBsYXRmb3JtIn0.forged",
  forgedRealmClaim:
    "pos_session=eyJhbGciOiJIUzI1NiJ9.eyJyZWFsbSI6InBsYXRmb3JtIiwicGFkbWluIjoieCJ9.forged",
};

beforeEach(() => {
  // The durable rate-limit counter is reached over loopback HTTP; refusing it
  // keeps the limiter on its in-memory fallback, which is all this test needs.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("no network in unit tests");
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("issue #1194 — the platform realm on a site runtime", () => {
  it("answers 404 without a cookie, a redirect or a mutation for every platform path", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    let ipCounter = 0;
    for (const [label, cookie] of Object.entries(HOSTILE_CREDENTIALS)) {
      for (const probe of PLATFORM_PATHS) {
        ipCounter += 1;
        const result = await call(probe.method, probe.path, {
          ip: `198.51.100.${ipCounter % 250}`,
          headers: { cookie },
        });
        expect(result.status, `${label} ${probe.method} ${probe.path}`).toBe(404);
        expect(result.passed, `${probe.path} must not pass through`).toBe(false);
        expect(result.response.headers.get("set-cookie"), probe.path).toBeNull();
        expect(result.response.headers.get("location"), probe.path).toBeNull();
        if (probe.path.startsWith("/api/")) {
          expect(result.body, probe.path).toEqual({ error: "deployment_unsupported" });
        } else {
          expect(result.bodyText, probe.path).toBe("Not Found");
        }
      }
    }
  });

  it("denies the realm on an admin-host request too", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    vi.stubEnv("ROOT_DOMAIN", "example.com");
    vi.stubEnv("ADMIN_HOST_LABEL", "admin");
    const result = await call("GET", "/platform/login", {
      ip: "198.51.100.99",
      host: "admin.example.com",
      headers: { cookie: HOSTILE_CREDENTIALS.forgedPlatform },
    });
    expect(result.status).toBe(404);
    expect(result.passed).toBe(false);
  });

  it("keeps tenant doors working while refusing the platform cookie", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    // A platform cookie in the jar confers nothing on the tenant realm: the
    // tenant doors remain the tenant doors, and no tenant page becomes a
    // platform page.
    for (const [method, path] of [
      ["POST", "/api/auth/pin-login"],
      ["POST", "/api/auth/login"],
      ["GET", "/api/setup/state"],
      ["GET", "/welcome"],
    ] as const) {
      const result = await call(method, path, {
        ip: "198.51.100.100",
        headers: { cookie: HOSTILE_CREDENTIALS.forgedPlatform },
      });
      expect(result.passed, `${method} ${path}`).toBe(true);
      expect(result.status, `${method} ${path}`).not.toBe(404);
    }
  });

  it("classifies every console path as the realm and every tenant path as not", () => {
    for (const path of [
      "/platform",
      "/platform/",
      "/platform/login",
      "/platform/businesses/abc/billing",
      "/api/platform",
      "/api/platform/auth/me",
      "/api/platform/mcp/oauth/token",
    ]) {
      expect(isPlatformRealmPath(path), path).toBe(true);
    }
    for (const path of [
      "/platformx",
      "/api/platformx",
      "/dashboard",
      "/dashboard/platform",
      "/api/auth/login",
      "/api/setup/state",
      "/api/local-activation/cloud",
    ]) {
      expect(isPlatformRealmPath(path), path).toBe(false);
    }
  });

  it("still serves the platform realm on the central runtime", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "central");
    // `unsupportedOnThisRuntime` must not deny; the handler's own guard is the
    // next layer (and is covered in platform-realm-isolation.test.ts).
    for (const path of ["/platform/login", "/api/platform/auth/login", "/api/platform/auth/me"]) {
      expect(unsupportedOnThisRuntime(path), path).toBeNull();
    }
    const result = await call("POST", "/api/platform/auth/login", {
      ip: "198.51.100.101",
      headers: { cookie: HOSTILE_CREDENTIALS.forgedPlatform },
    });
    expect(result.status).not.toBe(404);
    expect(result.passed).toBe(true);
  });
});
