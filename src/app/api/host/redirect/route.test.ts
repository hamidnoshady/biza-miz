import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * /api/host/redirect — "this host isn't the one that serves you".
 *
 * Issue #1003 item 3: with no ROOT_DOMAIN (the desktop) the handler built
 * `http:///` and answered 500. It now stays on this origin; the host-routed
 * behaviour is pinned alongside so the fix cannot have moved it.
 */
const mocks = vi.hoisted(() => ({
  resolveBusinessByLabel: vi.fn(),
  resolveBusinessBySlug: vi.fn(),
}));
vi.mock("@/lib/host-resolution", () => mocks);

import { GET } from "./route";

function redirect(query: string, host = "127.0.0.1:3000", headers: Record<string, string> = {}) {
  return GET(
    new NextRequest(`http://localhost:3000/api/host/redirect${query}`, { headers: { host, ...headers } }),
  );
}

beforeEach(() => {
  mocks.resolveBusinessByLabel.mockResolvedValue(null);
  mocks.resolveBusinessBySlug.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /api/host/redirect — no root domain (the desktop)", () => {
  beforeEach(() => vi.stubEnv("ROOT_DOMAIN", ""));

  it("continues to / with no parameters instead of answering 500", async () => {
    const response = await redirect("");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/");
  });

  it("carries a same-site `next` through, query string included", async () => {
    const response = await redirect(`?next=${encodeURIComponent("/dashboard/orders?tab=open")}`);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/dashboard/orders?tab=open");
  });

  it("never turns `next` into another origin", async () => {
    for (const next of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "/\t/evil.example",
      "/%0d%0aSet-Cookie:x=1".replace(/%0d%0a/, "\r\n"),
      "javascript:alert(1)",
    ]) {
      const response = await redirect(`?next=${encodeURIComponent(next)}`);
      expect(response.status, JSON.stringify(next)).toBe(307);
      expect(response.headers.get("location"), JSON.stringify(next)).toBe("/");
    }
  });

  it("has nothing to look up, so it never asks the database", async () => {
    await redirect("?slug=acme&next=/dashboard");
    expect(mocks.resolveBusinessBySlug).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessByLabel).not.toHaveBeenCalled();
  });
});

describe("GET /api/host/redirect — host routing", () => {
  beforeEach(() => vi.stubEnv("ROOT_DOMAIN", "pos.example.com"));

  it("sends a host that serves nobody to the apex", async () => {
    const response = await redirect("", "gone.pos.example.com", { "x-forwarded-proto": "https" });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://pos.example.com/");
  });

  it("hands a visitor on the right host that host's login, keeping `next`", async () => {
    mocks.resolveBusinessByLabel.mockResolvedValue({
      businessId: "b1",
      name: "Acme",
      subdomain: "acme",
      status: "active",
      viaAlias: false,
    });
    const response = await redirect("?next=/dashboard", "acme.pos.example.com", { "x-forwarded-proto": "https" });
    expect(response.headers.get("location")).toBe("https://acme.pos.example.com/login?next=%2Fdashboard");
  });

  it("moves a renamed host to the current one with a 308", async () => {
    mocks.resolveBusinessByLabel.mockResolvedValue({
      businessId: "b1",
      name: "Acme",
      subdomain: "acme",
      status: "active",
      viaAlias: true,
    });
    const response = await redirect("?next=/menu", "old.pos.example.com", { "x-forwarded-proto": "https" });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://acme.pos.example.com/menu");
  });
});
