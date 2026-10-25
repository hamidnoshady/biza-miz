import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * /api/host/resolve — issue #1003 / SECURITY_AUDIT L5. `?debug=1` echoes the
 * routing headers and configuration (behind a managed platform, the
 * container's internal hostname) to anyone, so a production server ignores it
 * unless HOST_RESOLVE_DEBUG=on. The answer itself is unchanged either way.
 */
const mocks = vi.hoisted(() => ({ resolveBusinessByLabel: vi.fn() }));
vi.mock("@/lib/host-resolution", () => mocks);

import { GET } from "./route";

function resolve(query: string) {
  return GET(
    new NextRequest(`http://localhost:3000/api/host/resolve${query}`, {
      headers: { host: "acme.pos.example.com", "x-forwarded-host": "web-1234.internal:3000" },
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("ROOT_DOMAIN", "pos.example.com");
  mocks.resolveBusinessByLabel.mockResolvedValue({
    businessId: "b1",
    name: "Acme",
    subdomain: "acme",
    status: "active",
    viaAlias: false,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /api/host/resolve?debug=1", () => {
  it("ignores debug=1 on a production server, answering exactly as without it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const withDebug = await (await resolve("?debug=1")).json();
    const without = await (await resolve("")).json();
    expect(withDebug).toEqual(without);
    expect(withDebug).not.toHaveProperty("request");
    expect(JSON.stringify(withDebug)).not.toContain("web-1234.internal");
    expect(withDebug.business).toMatchObject({ name: "Acme", subdomain: "acme" });
  });

  it("answers it on a production server an operator switched it on for", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HOST_RESOLVE_DEBUG", "on");
    const body = await (await resolve("?debug=1")).json();
    expect(body.request).toMatchObject({
      host: "acme.pos.example.com",
      forwardedHost: "web-1234.internal:3000",
      usedForTenancy: "acme.pos.example.com",
      rootDomain: "pos.example.com",
    });
  });

  it("always answers it in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const body = await (await resolve("?debug=1")).json();
    expect(body.request).toMatchObject({ host: "acme.pos.example.com" });
  });
});
