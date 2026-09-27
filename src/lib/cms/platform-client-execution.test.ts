import { describe, expect, it, vi } from "vitest";

import { CmsApiError } from "./client";
import {
  fetchCmsThemePackages,
  pollCmsSiteDeployment,
  sanitizeDeployTarget,
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
