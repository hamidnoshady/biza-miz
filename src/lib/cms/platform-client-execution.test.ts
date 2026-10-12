import { describe, expect, it, vi } from "vitest";

import { CmsApiError } from "./client";
import {
  createCmsDeployTarget,
  fetchCmsDeployTargets,
  fetchCmsThemePackages,
  pollCmsSiteDeployment,
  sanitizeDeployTarget,
  updateCmsDeployTarget,
} from "./platform-client-execution";

const config = { apiKey: "eshobe_live_test", baseUrl: "https://cms.example.com" };

describe("sanitizeDeployTarget", () => {
  it("drops credential columns", () => {
    const row = sanitizeDeployTarget({
      apiToken: "secret",
      id: "1",
      name: "Tehran",
      tokenSummary: "••••",
    });
    expect(row).toEqual({ id: "1", name: "Tehran", tokenSummary: "••••" });
    expect("apiToken" in row).toBe(false);
  });
});

describe("fetchCmsThemePackages", () => {
  it("calls the platform theme-packages list", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, packages: [{ id: "p1", key: "bazaar", name: "بازار" }] }), {
        status: 200,
      }),
    );
    const packages = await fetchCmsThemePackages(config, { fetchImpl });
    expect(packages).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalled();
    const url = String((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url).toContain("/api/platform/theme-packages");
  });
});

describe("pollCmsSiteDeployment", () => {
  it("surfaces CMS refusal", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: "رد شد", ok: false }), { status: 400 }),
    );
    await expect(
      pollCmsSiteDeployment(config, "site-1", "dep-1", { fetchImpl }),
    ).rejects.toBeInstanceOf(CmsApiError);
  });
});

/**
 * Deploy-target calls use the platform-key routes (audit F05). The collection's own
 * REST routes are session-only on the CMS, so these must not drift back to them.
 */
describe("deploy-target platform-key routes (audit F05)", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const calledWith = (fn: ReturnType<typeof vi.fn>) => {
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    return { method: init?.method ?? "GET", url: String(url) };
  };

  it("lists through the platform-list route and sanitizes each row", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ docs: [{ apiToken: "secret", id: "t1", name: "Tehran" }], ok: true }),
    );
    const rows = await fetchCmsDeployTargets(config, { fetchImpl });
    const call = calledWith(fetchImpl);
    expect(call.url).toContain("/api/deploy-targets/platform-list");
    expect(call.url).not.toMatch(/\/api\/deploy-targets(\?|$)/);
    expect(call.method).toBe("GET");
    expect(rows).toEqual([{ id: "t1", name: "Tehran" }]);
  });

  it("creates through platform-save with POST and no id", async () => {
    const fetchImpl = vi.fn(async () => json({ doc: { id: "t2", name: "Shiraz" }, ok: true }));
    await createCmsDeployTarget(config, { name: "Shiraz" }, { fetchImpl });
    const call = calledWith(fetchImpl);
    expect(call.url).toContain("/api/deploy-targets/platform-save");
    expect(call.method).toBe("POST");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: "Shiraz" });
  });

  it("updates through platform-save with POST, carrying the id in the body", async () => {
    const fetchImpl = vi.fn(async () => json({ doc: { id: "t2", name: "Shiraz 2" }, ok: true }));
    await updateCmsDeployTarget(config, "t2", { name: "Shiraz 2" }, { fetchImpl });
    const call = calledWith(fetchImpl);
    expect(call.url).toContain("/api/deploy-targets/platform-save");
    expect(call.url).not.toContain("/api/deploy-targets/t2");
    expect(call.method).toBe("POST");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ id: "t2", name: "Shiraz 2" });
  });
});
