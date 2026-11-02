import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("./plugin-service", () => ({
  authenticatePlugin: mocks.authenticate,
  pluginSiteMismatch: (c: { plugin_site_url: string | null }, reported: string) =>
    c.plugin_site_url && reported && c.plugin_site_url !== reported
      ? { expectedSiteUrl: c.plugin_site_url, reportedSiteUrl: reported }
      : null,
}));

import { NextRequest } from "next/server";
import { pluginRoute } from "./plugin-route";
import { POST as ping } from "@/app/api/integrations/wordpress/ping/route";

const request = (body: string) => new NextRequest("http://localhost/api/integrations/wordpress/ping", { method: "POST", body });
const connection = { id: "c1", name: "Shop", status: "active", plugin_site_url: "https://shop.example" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ ok: true, connection, nonce: "n" });
});

describe("pluginRoute body limit (issue #1149, C4)", () => {
  it("counts bytes, not characters: 1.1M Persian letters are 2.2 MB", async () => {
    const handler = vi.fn();
    const res = await pluginRoute(handler)(request("ا".repeat(1_100_000)));
    expect(res.status).toBe(413);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("still accepts a body under the limit", async () => {
    const res = await pluginRoute(async () => new Response("{}") as never)(request(JSON.stringify({ a: "ا".repeat(1000) })));
    expect(res.status).toBe(200);
  });

  it("returns the server clock with a stale_timestamp, so the plugin can print the skew", async () => {
    mocks.authenticate.mockResolvedValue({ ok: false, error: "stale_timestamp", status: 401, serverTime: "2026-10-26T12:00:00.000Z" });
    const res = await pluginRoute(vi.fn())(request("{}"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "stale_timestamp", serverTime: "2026-10-26T12:00:00.000Z" });
  });
});

describe("ping (B1)", () => {
  it("answers 409 site_mismatch with the address the app expected", async () => {
    const res = await ping(request(JSON.stringify({ siteUrl: "https://other.example" })));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "site_mismatch", expectedSiteUrl: "https://shop.example" });
  });

  it("reports serverStatus, so a paused connection is told apart from a healthy one", async () => {
    mocks.authenticate.mockResolvedValue({ ok: true, connection: { ...connection, status: "paused" }, nonce: "n" });
    const res = await ping(request(JSON.stringify({ siteUrl: "https://shop.example" })));
    expect(await res.json()).toMatchObject({ ok: true, serverStatus: "paused" });
  });

  it("an older plugin that sends no siteUrl still gets a healthy answer", async () => {
    const res = await ping(request("[]"));
    expect(await res.json()).toMatchObject({ ok: true, serverStatus: "active" });
  });
});
