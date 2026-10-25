import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

/**
 * Issue #1126 — the platform MCP endpoint must be reachable by the machine
 * clients it exists for.
 *
 * Before this, `POST /api/platform/mcp` with a `pospmcp_` bearer but no
 * platform session cookie was 307'd to `/platform/login` by the console's own
 * session gate: every generated client config pointed at an endpoint that
 * answered JSON-RPC to nobody. Now the route's own bearer guard is the
 * authentication (like `/api/mcp` for tenants), the admin-host redirect still
 * steers wrong-host clients to the canonical origin, and the per-credential
 * MCP rate-limit bucket covers the new surface.
 *
 * Each test uses its own client address and credential: the limiter's buckets
 * are module state shared by every test in this file.
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

describe("issue #1126 — bearer clients reach /api/platform/mcp", () => {
  it("passes a session-less POST on the admin origin through to the route's own guard", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "central");
    vi.stubEnv("ROOT_DOMAIN", "app.eshobe.com");
    const result = await call("POST", "/api/platform/mcp", {
      ip: "203.0.113.31",
      host: "admin.app.eshobe.com",
      proto: "https",
      headers: { authorization: "Bearer pospmcp_test_credential_a" },
    });
    expect(result.passed).toBe(true);
  });

  it("passes a session-less GET probe too (the route answers 405 guidance itself)", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "central");
    vi.stubEnv("ROOT_DOMAIN", "app.eshobe.com");
    const result = await call("GET", "/api/platform/mcp", {
      ip: "203.0.113.32",
      host: "admin.app.eshobe.com",
      proto: "https",
    });
    expect(result.passed).toBe(true);
  });

  it("still steers a wrong-host client to the canonical admin origin", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "central");
    vi.stubEnv("ROOT_DOMAIN", "app.eshobe.com");
    const result = await call("POST", "/api/platform/mcp", {
      ip: "203.0.113.33",
      host: "titea.app.eshobe.com",
      proto: "https",
      headers: { authorization: "Bearer pospmcp_test_credential_b" },
    });
    expect(result.passed).toBe(false);
    expect(result.status).toBe(307);
    const location = result.response.headers.get("location") ?? "";
    expect(location).toContain("admin.app.eshobe.com");
    expect(location).toContain("/api/platform/mcp");
  });

  it("rate-limits per credential, like the tenant endpoint", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "central");
    vi.stubEnv("ROOT_DOMAIN", "app.eshobe.com");
    const ip = "203.0.113.34";
    const host = "admin.app.eshobe.com";
    const credentialA = "Bearer pospmcp_test_credential_c";
    let limited = false;
    // Past the 240/min MCP budget: the route must start refusing the tired
    // credential while a fresh one on the same IP still passes.
    for (let round = 0; round < 280 && !limited; round++) {
      const result = await call("POST", "/api/platform/mcp", {
        ip,
        host,
        proto: "https",
        headers: { authorization: credentialA },
      });
      limited = result.status === 429;
    }
    expect(limited).toBe(true);
    const fresh = await call("POST", "/api/platform/mcp", {
      ip,
      host,
      proto: "https",
      headers: { authorization: "Bearer pospmcp_test_credential_d" },
    });
    expect(fresh.passed).toBe(true);
  });

  it("answers 404 on a site runtime, like the rest of the platform realm", async () => {
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    const result = await call("POST", "/api/platform/mcp", {
      ip: "203.0.113.35",
      headers: { authorization: "Bearer pospmcp_test_credential_e" },
    });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "deployment_unsupported" });
  });
});
