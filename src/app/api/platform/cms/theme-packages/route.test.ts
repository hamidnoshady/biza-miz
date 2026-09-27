import { describe, expect, it, vi } from "vitest";

import { fetchCmsThemePackages } from "@/lib/cms/platform-client";

describe("GET /api/platform/cms/theme-packages proxy", () => {
  it("uses the typed client path", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, packages: [] }), { status: 200 }),
    );
    await fetchCmsThemePackages(
      { apiKey: "k", baseUrl: "https://cms.test" },
      { fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalled();
    expect(String((fetchImpl.mock.calls[0] as unknown as [string])[0])).toContain("/api/platform/theme-packages");
  });
});
