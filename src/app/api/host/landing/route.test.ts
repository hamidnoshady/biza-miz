import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #1003 item 8 — `/` answered with a real 307. Middleware rewrites the
 * root here; the decision itself is `resolveRootLanding` (root-landing.test.ts
 * covers every branch). This file pins the HTTP shape: status, a *relative*
 * Location (a route handler's request.url is the internal origin), no caching,
 * and a usable answer when the database cannot be asked.
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasAnyUser: vi.fn(),
  isSetupComplete: vi.fn(),
  resolveBusinessByLabel: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/setup-state", () => ({
  hasAnyUser: mocks.hasAnyUser,
  isSetupComplete: mocks.isSetupComplete,
}));
vi.mock("@/lib/host-resolution", () => ({ resolveBusinessByLabel: mocks.resolveBusinessByLabel }));

import { GET } from "./route";

function landing(host = "127.0.0.1:3000") {
  // The internal origin a route handler sees behind a proxy, deliberately
  // different from the Host the browser used.
  return GET(new NextRequest("http://localhost:3000/api/host/landing", { headers: { host } }));
}

beforeEach(() => {
  vi.stubEnv("ROOT_DOMAIN", "");
  mocks.getSession.mockResolvedValue(null);
  mocks.hasAnyUser.mockResolvedValue(true);
  mocks.isSetupComplete.mockResolvedValue(true);
  mocks.resolveBusinessByLabel.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/host/landing", () => {
  it("answers 307 with a relative Location and no caching", async () => {
    const response = await landing();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("sends an empty install to the first-run wizard and a signed-in member to the dashboard", async () => {
    mocks.hasAnyUser.mockResolvedValue(false);
    expect((await landing()).headers.get("location")).toBe("/welcome");

    mocks.getSession.mockResolvedValue({ role: "waiter", businessId: "biz-1" });
    expect((await landing()).headers.get("location")).toBe("/dashboard");

    mocks.getSession.mockResolvedValue({ role: "owner", businessId: "biz-1" });
    mocks.isSetupComplete.mockResolvedValue(false);
    expect((await landing()).headers.get("location")).toBe("/setup");
  });

  it("sends a direct visit on the apex back to / to render the directory there", async () => {
    vi.stubEnv("ROOT_DOMAIN", "pos.example.com");
    const response = await landing("pos.example.com");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/");
  });

  it("falls back to the dashboard's own guards when the database cannot answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getSession.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const response = await landing();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(error).toHaveBeenCalledTimes(1);
  });
});
