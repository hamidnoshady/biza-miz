import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./client";
import { createOwnerEmbedSession, publishOwnerContent } from "./owner-bridge";

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

describe("createOwnerEmbedSession", () => {
  const SITE = "11111111-1111-1111-1111-111111111111";
  const DOC = "22222222-2222-2222-2222-222222222222";
  const reply = (body: unknown, status = 200): FetchLike => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("asks the platform embed bridge for one document and returns only the url", async () => {
    const calls: [string, RequestInit][] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push([url, init]);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, url: "https://cms.test/api/embed/enter?code=abc", extra: "x" }), {
          status: 200,
        }),
      );
    };
    const result = await createOwnerEmbedSession(
      "biz-1",
      { collection: "pages", id: DOC, canPublish: true },
      { fetchImpl },
    );
    expect(result).toEqual({ ok: true, data: { url: "https://cms.test/api/embed/enter?code=abc" } });
    expect(calls[0]![0]).toContain(`/api/platform/sites/${SITE}/embed-session`);
    expect(calls[0]![1].method).toBe("POST");
    // The platform key authenticates the call; the body names no site, only the document.
    expect(new Headers(calls[0]![1].headers).get("authorization")).toBe("Bearer eshobe_live_platform");
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ collection: "pages", id: DOC, canPublish: true });
  });

  it("omits id for «new» and never sends a non-boolean canPublish", async () => {
    const calls: [string, RequestInit][] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push([url, init]);
      return Promise.resolve(new Response(JSON.stringify({ url: "https://cms.test/x" }), { status: 200 }));
    };
    await createOwnerEmbedSession(
      "biz-1",
      { collection: "posts", canPublish: "yes" as unknown as boolean },
      { fetchImpl },
    );
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ collection: "posts", canPublish: false });
  });

  it("refuses a url that is not on the CMS origin it dialled", async () => {
    for (const url of ["https://evil.example/api/embed/enter?code=a", "javascript:alert(1)", 42, undefined]) {
      const result = await createOwnerEmbedSession(
        "biz-1",
        { collection: "posts", canPublish: false },
        { fetchImpl: reply({ ok: true, url }) },
      );
      expect(result).toEqual({ ok: false, error: "cms_error" });
    }
  });

  it("tells a missing document from a CMS that predates the route", async () => {
    const missing = await createOwnerEmbedSession(
      "biz-1",
      { collection: "pages", id: DOC, canPublish: false },
      { fetchImpl: reply({ ok: false, message: "سند متعلق به این سایت نیست." }, 404) },
    );
    expect(missing).toEqual({ ok: false, error: "not_found" });

    const old = await createOwnerEmbedSession(
      "biz-1",
      { collection: "pages", canPublish: false },
      { fetchImpl: reply({ message: "Route not found" }, 404) },
    );
    expect(old).toEqual({ ok: false, error: "cms_old_version" });

    const down = await createOwnerEmbedSession(
      "biz-1",
      { collection: "pages", canPublish: false },
      { fetchImpl: reply({ message: "boom" }, 500) },
    );
    expect(down).toEqual({ ok: false, error: "cms_error" });
  });
});
