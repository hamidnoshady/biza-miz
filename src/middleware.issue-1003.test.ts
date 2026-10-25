import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware, isPlatformRealmPath, unsupportedOnThisRuntime } from "./middleware";
import { ROOT_LANDING_PATH } from "./lib/root-landing";

/**
 * Issue #1003 — the parts of the web-server review that live in middleware:
 *
 *  - item 5: a site process (the desktop included) answers the platform realm
 *    and the cloud execution APIs with a 404 *before* the rate limiter, so a
 *    probe neither shows up as a 429 "live login" nor spends the per-IP bucket
 *    the staff PIN login needs;
 *  - item 8: `/` is a real redirect — middleware rewrites it to the landing
 *    route that answers 307 — except on the hosts whose answer is a page;
 *  - item 1: the CSP names this origin's own socket instead of every socket,
 *    reports somewhere, and the collector is reachable without a session.
 *
 * Each test uses its own client address: the limiter's buckets are module
 * state shared by every test in this file.
 */

interface CallOptions {
  ip: string;
  host?: string;
  proto?: "http" | "https";
  headers?: Record<string, string>;
}

async function call(method: string, path: string, { ip, host = "localhost:3000", proto, headers = {} }: CallOptions) {
  const response = await middleware(
    new NextRequest(`http://${host}${path}`, {
      method,
      headers: {
        host,
        "x-forwarded-for": ip,
        ...(proto ? { "x-forwarded-proto": proto } : {}),
        ...headers,
      },
    }),
  );
  const passed = response.headers.get("x-middleware-next") === "1";
  const rewrite = response.headers.get("x-middleware-rewrite");
  const body =
    passed || rewrite ? null : await response.clone().json().catch(() => null);
  return { response, status: response.status, passed, rewrite, body };
}

beforeEach(() => {
  // The durable rate-limit counter is reached over loopback HTTP; refusing it
  // puts the limiter on its in-memory fallback, which is all a unit test needs.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in unit tests"); }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("issue #1003 item 5 — what a site does not have costs nothing", () => {
  const PLATFORM_SIGN_IN = [
    "/api/platform/auth/login",
    "/api/platform/auth/mfa/challenge",
    "/api/platform/auth/mfa/verify",
    "/api/platform/auth/mfa/enrol",
    "/api/platform/pairing/redeem",
  ];

  it("answers the platform realm's sign-in endpoints 404 on a site, however often they are probed", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    const ip = "203.0.113.11";
    // Far past the 20/min credential budget: before the fix the limiter ran
    // first, so these turned into 429s within the first round.
    for (let round = 0; round < 10; round++) {
      for (const path of PLATFORM_SIGN_IN) {
        const result = await call("POST", path, { ip });
        expect(result.status, path).toBe(404);
        expect(result.body, path).toEqual({ error: "deployment_unsupported" });
      }
    }
    // …and the bucket the staff PIN login draws on was never touched.
    const pin = await call("POST", "/api/auth/pin-login", { ip });
    expect(pin.status).not.toBe(429);
    expect(pin.passed).toBe(true);
  });

  it("answers cloud execution APIs 404 on a site before the limiter too", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    const ip = "203.0.113.12";
    for (let round = 0; round < 15; round++) {
      for (const path of ["/api/pairing/redeem", "/api/telegram/session"]) {
        const result = await call("POST", path, { ip });
        expect(result.status, path).toBe(404);
        expect(result.body, path).toEqual({ error: "not_found" });
      }
    }
    expect((await call("POST", "/api/auth/pin-login", { ip })).passed).toBe(true);
  });

  it("hides the console pages on a site as well", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    const result = await call("GET", "/platform/login", { ip: "203.0.113.13" });
    expect(result.status).toBe(404);
    expect(await result.response.text()).toBe("Not Found");
  });

  it("still serves and rate-limits the platform sign-in on the central runtime", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "central");
    const ip = "203.0.113.14";
    const first = await call("POST", "/api/platform/auth/login", { ip });
    expect(first.passed).toBe(true);
    let limited = false;
    for (let i = 0; i < 30 && !limited; i++) {
      limited = (await call("POST", "/api/platform/auth/login", { ip })).status === 429;
    }
    expect(limited).toBe(true);
  });

  it("classifies the realm and the runtime the same way handle() does", () => {
    for (const path of ["/platform", "/platform/login", "/api/platform/auth/login", "/api/platform"]) {
      expect(isPlatformRealmPath(path), path).toBe(true);
    }
    for (const path of ["/platformx", "/api/auth/login", "/dashboard/platform"]) {
      expect(isPlatformRealmPath(path), path).toBe(false);
    }
    vi.stubEnv("DEPLOYMENT_ROLE", "central");
    expect(unsupportedOnThisRuntime("/api/platform/auth/login")).toBeNull();
    expect(unsupportedOnThisRuntime("/api/pairing/redeem")).toBeNull();
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    expect(unsupportedOnThisRuntime("/api/platform/auth/login")?.status).toBe(404);
    expect(unsupportedOnThisRuntime("/api/pairing/redeem")?.status).toBe(404);
    expect(unsupportedOnThisRuntime("/api/auth/pin-login")).toBeNull();
    expect(unsupportedOnThisRuntime("/dashboard")).toBeNull();
  });
});

describe("issue #1003 item 8 — `/` is a real redirect", () => {
  it("rewrites GET and HEAD / to the landing route on an install without host routing", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    vi.stubEnv("ROOT_DOMAIN", "");
    for (const method of ["GET", "HEAD"]) {
      const result = await call(method, "/?utm_source=x", { ip: "203.0.113.21" });
      expect(result.rewrite, method).not.toBeNull();
      const target = new URL(result.rewrite!);
      expect(target.pathname).toBe(ROOT_LANDING_PATH);
      expect(target.search).toBe("");
      // The rewritten response still carries the security headers.
      expect(result.response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("leaves other methods and other paths alone", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    vi.stubEnv("ROOT_DOMAIN", "");
    expect((await call("POST", "/", { ip: "203.0.113.22" })).rewrite).toBeNull();
    expect((await call("GET", "/login", { ip: "203.0.113.22" })).rewrite).toBeNull();
  });

  it("rewrites a business host, but leaves the apex directory and an unknown host to the page", async () => {
    vi.stubEnv("ROOT_DOMAIN", "pos.example.com");
    vi.stubEnv("SUBDOMAIN_ROUTING", "on");
    const business = await call("GET", "/", { ip: "203.0.113.23", host: "acme.pos.example.com" });
    expect(new URL(business.rewrite!).pathname).toBe(ROOT_LANDING_PATH);

    const apex = await call("GET", "/", { ip: "203.0.113.23", host: "pos.example.com" });
    expect(apex.rewrite).toBeNull();
    expect(apex.passed).toBe(true);

    const unknown = await call("GET", "/", { ip: "203.0.113.23", host: "stray.example.net" });
    expect(unknown.rewrite).toBeNull();
    expect(unknown.passed).toBe(true);
  });
});

describe("issue #1003 item 1 — the policy middleware sends", () => {
  it("allows this origin's own socket rather than every ws:/wss: endpoint", async () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const result = await call("GET", "/login", { ip: "203.0.113.31", host: "127.0.0.1:3000" });
    const csp = result.response.headers.get("content-security-policy")!;
    const connectSrc = csp.split("; ").find((part) => part.startsWith("connect-src "))!;
    expect(connectSrc).toContain("ws://127.0.0.1:3000");
    expect(connectSrc.split(" ")).not.toContain("ws:");
    expect(connectSrc.split(" ")).not.toContain("wss:");
    expect(csp).toContain("report-uri /api/csp-report");
    // Plain HTTP: no Reporting API endpoint, which would not be trustworthy.
    expect(result.response.headers.get("reporting-endpoints")).toBeNull();
    expect(csp).not.toContain("report-to");
  });

  it("names the Reporting API endpoint on HTTPS, in report-only mode too", async () => {
    vi.stubEnv("CSP_MODE", "report-only");
    const result = await call("GET", "/login", { ip: "203.0.113.32", proto: "https" });
    const csp = result.response.headers.get("content-security-policy-report-only")!;
    expect(csp).toContain("report-to csp-endpoint");
    expect(result.response.headers.get("reporting-endpoints")).toBe('csp-endpoint="/api/csp-report"');
  });

  it("sends no reporting endpoint when CSP is off", async () => {
    vi.stubEnv("CSP_MODE", "off");
    const result = await call("GET", "/login", { ip: "203.0.113.33", proto: "https" });
    expect(result.response.headers.get("reporting-endpoints")).toBeNull();
  });

  it("lets a browser post a violation report without a session", async () => {
    const result = await call("POST", "/api/csp-report", {
      ip: "203.0.113.34",
      headers: { "content-type": "application/csp-report" },
    });
    expect(result.passed).toBe(true);
  });
});
