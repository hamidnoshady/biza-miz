import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./client";
import { publishOwnerContent } from "./owner-bridge";

vi.mock("./connections", () => ({
  listCmsConnections: vi.fn(async () => [
    { siteId: "11111111-1111-1111-1111-111111111111", baseUrl: "https://cms.test" },
  ]),
  CmsConnectionError: class CmsConnectionError extends Error {},
}));

vi.mock("./platform-control-service", () => ({
  resolvePlatformCmsConfig: vi.fn(async () => ({
    baseUrl: "https://cms.test",
    apiKey: "eshobe_live_platform",
  })),
}));

describe("publishOwnerContent", () => {
  it("calls the platform publish bridge", async () => {
    const calls: [string, RequestInit][] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push([url, init]);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };
    const result = await publishOwnerContent(
      "biz-1",
      "posts",
      "22222222-2222-2222-2222-222222222222",
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toContain("/api/platform/sites/11111111-1111-1111-1111-111111111111/publish");
    expect(calls[0]![1].method).toBe("POST");
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({
      collection: "posts",
      id: "22222222-2222-2222-2222-222222222222",
    });
  });
});
