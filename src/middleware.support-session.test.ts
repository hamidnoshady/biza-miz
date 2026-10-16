import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, signSession, type SessionPayload } from "./lib/auth-edge";
import { middleware } from "./middleware";

/**
 * The Edge half of support-session enforcement. Middleware cannot see the
 * database, so it only judges the signed claims: whether a support mode may
 * make this request at all. Whether the grant is still *live* (ended, revoked,
 * expired) is the Node half — `withTenantScope`/`getSession` → `activeGrant` —
 * and is covered end to end in integration/support-session-end.integration.test.ts.
 */

type Mode = "read_only" | "controlled" | "full";

async function token(mode?: Mode) {
  const payload: SessionPayload = {
    sub: "00000000-0000-4000-8000-000000000001",
    role: "owner",
    businessId: "00000000-0000-4000-8000-000000000002",
    locationId: null,
    fullName: "Owner",
    ...(mode
      ? { imp: { grantId: "00000000-0000-4000-8000-000000000003", adminId: "00000000-0000-4000-8000-000000000004", mode, allowedCapabilities: mode === "controlled" ? ["printer.test"] : [] } }
      : {}),
  };
  return signSession(payload);
}

async function call(method: string, path: string, cookie: string) {
  const response = await middleware(
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: { host: "localhost", origin: "http://localhost", cookie: `${SESSION_COOKIE}=${cookie}` },
    }),
  );
  const passed = response.headers.get("x-middleware-next") === "1";
  const body = passed ? null : await response.json().catch(() => null);
  return { status: response.status, passed, body };
}

beforeEach(() => {
  // The durable rate-limit counter is reached over loopback HTTP; refusing it
  // puts the limiter on its in-memory fallback, which is all a unit test needs.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in unit tests"); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("middleware — support-session mode enforcement", () => {
  it("a read-only session may read tenant APIs and pages", async () => {
    const t = await token("read_only");
    expect((await call("GET", "/api/orders", t)).passed).toBe(true);
    expect((await call("GET", "/api/support-access", t)).passed).toBe(true);
    expect((await call("GET", "/dashboard", t)).passed).toBe(true);
  });

  it("a read-only session may not mutate", async () => {
    const t = await token("read_only");
    for (const [method, path] of [["POST", "/api/orders"], ["PATCH", "/api/menu/items/1"], ["DELETE", "/api/orders/1"], ["PUT", "/api/settings"], ["PATCH", "/api/support-access"]]) {
      const result = await call(method, path, t);
      expect(result, `${method} ${path}`).toMatchObject({ status: 403, passed: false, body: { error: "impersonation_read_only" } });
    }
  });

  it("a read-only session may END itself — the «پایان نشست» regression", async () => {
    expect((await call("DELETE", "/api/support-access", await token("read_only"))).passed).toBe(true);
  });

  it("a support session may sign itself out — «خروج» reaches the route that closes its grant", async () => {
    for (const mode of ["read_only", "controlled"] as const) {
      expect((await call("POST", "/api/auth/logout", await token(mode))).passed, mode).toBe(true);
    }
    // Exactly that request: not another method on it, and not a look-alike path.
    expect(await call("DELETE", "/api/auth/logout", await token("read_only"))).toMatchObject({
      status: 403,
      body: { error: "impersonation_read_only" },
    });
    expect(await call("POST", "/api/auth/logoutx", await token("read_only"))).toMatchObject({
      status: 403,
      body: { error: "impersonation_read_only" },
    });
  });

  it("a controlled session gets only its granted technical writes, plus its own exit", async () => {
    const t = await token("controlled");
    expect((await call("POST", "/api/printing/test", t)).passed).toBe(true);
    expect(await call("POST", "/api/orders", t)).toMatchObject({ status: 403, body: { error: "support_capability_denied" } });
    expect((await call("DELETE", "/api/support-access", t)).passed).toBe(true);
  });

  it("full support and ordinary tenant sessions are not restricted here", async () => {
    expect((await call("POST", "/api/orders", await token("full"))).passed).toBe(true);
    expect((await call("POST", "/api/orders", await token())).passed).toBe(true);
    expect((await call("DELETE", "/api/support-access", await token())).passed).toBe(true);
  });

  it("an expired support token is refused before any mode decision", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 48 * 60 * 60_000);
    const expired = await token("read_only");
    vi.useRealTimers();
    expect(await call("DELETE", "/api/support-access", expired)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect(await call("GET", "/api/orders", expired)).toMatchObject({ status: 401 });
  });
});
