import { describe, expect, it, vi } from "vitest";

import {
  CmsApiError,
  CmsNetworkError,
  absoluteCmsMediaUrl,
  cmsHeaders,
  cmsQueryString,
  cmsRequest,
  cmsUrl,
  createPost,
  deletePost,
  fetchPages,
  fetchSiteDescriptor,
  issueSiteApiKey,
  normalizeCmsBaseUrl,
  provisionSite,
  updatePost,
  updateSiteDomain,
  type CmsConfig,
  type FetchLike,
} from "./client";

const CONFIG: CmsConfig = {
  baseUrl: "https://cms.eshobe.com",
  siteDomain: "acme.ir",
  apiKey: "eshobe_live_testkey",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A FetchLike that records its call and returns a canned Response. */
function fakeFetch(status: number, body: unknown): { fetchImpl: FetchLike; calls: [string, RequestInit][] } {
  const calls: [string, RequestInit][] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push([url, init]);
    return Promise.resolve(jsonResponse(status, body));
  };
  return { fetchImpl, calls };
}

describe("normalizeCmsBaseUrl", () => {
  it("strips a trailing slash", () => {
    expect(normalizeCmsBaseUrl("https://cms.eshobe.com/")).toBe("https://cms.eshobe.com");
    expect(normalizeCmsBaseUrl("https://cms.eshobe.com///")).toBe("https://cms.eshobe.com");
  });
  it("rejects a relative URL", () => {
    expect(() => normalizeCmsBaseUrl("cms.eshobe.com")).toThrow("invalid_connection_url");
  });
});

describe("cmsQueryString", () => {
  it("encodes where filters and skips empty values", () => {
    const qs = cmsQueryString({
      "where[slug][equals]": "about us",
      limit: 10,
      page: undefined,
      locale: null,
    });
    expect(qs).toContain("limit=10");
    expect(qs).not.toContain("page");
    expect(qs).not.toContain("locale");
    expect(qs).toContain("where%5Bslug%5D%5Bequals%5D=about+us");
  });
  it("returns an empty string for no query", () => {
    expect(cmsQueryString()).toBe("");
  });
});

describe("cmsUrl", () => {
  it("joins the origin, path and query", () => {
    expect(cmsUrl(CONFIG, { path: "/api/pages", query: { limit: 5 } })).toBe(
      "https://cms.eshobe.com/api/pages?limit=5",
    );
  });
});

describe("cmsHeaders", () => {
  it("carries the tenant in Host and the site key in Authorization", () => {
    const headers = cmsHeaders(CONFIG, { path: "/api/site" });
    expect(headers.get("Host")).toBe("acme.ir");
    expect(headers.get("Authorization")).toBe("Bearer eshobe_live_testkey");
  });
  it("sets JSON content-type only when there is a body", () => {
    expect(cmsHeaders(CONFIG, { path: "/api/site" }).get("content-type")).toBeNull();
    expect(cmsHeaders(CONFIG, { path: "/api/products", body: {} }).get("content-type")).toBe("application/json");
  });
  it("omits Host and Authorization when not configured (anonymous host read)", () => {
    const headers = cmsHeaders({ baseUrl: CONFIG.baseUrl }, { path: "/api/site" });
    expect(headers.get("Host")).toBeNull();
    expect(headers.get("Authorization")).toBeNull();
  });
});

describe("cmsRequest", () => {
  it("performs the call and parses JSON", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { docs: [] });
    const result = await cmsRequest<{ docs: unknown[] }>(CONFIG, { path: "/api/pages", fetchImpl });
    expect(result).toEqual({ docs: [] });
    expect(calls[0][0]).toBe("https://cms.eshobe.com/api/pages");
    expect((calls[0][1].headers as Headers).get("Host")).toBe("acme.ir");
  });

  it("redacts provider error bodies while preserving typed status", async () => {
    const { fetchImpl } = fakeFetch(403, { message: "You are not allowed", errors: [{ message: "role denied" }] });
    await expect(cmsRequest(CONFIG, { path: "/api/products", fetchImpl })).rejects.toMatchObject({
      name: "CmsApiError",
      status: 403,
      body: { message: "cms_request_failed_403" },
    });
  });

  it("wraps transport failures in CmsNetworkError", async () => {
    const fetchImpl: FetchLike = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(cmsRequest(CONFIG, { path: "/api/site", fetchImpl })).rejects.toBeInstanceOf(CmsNetworkError);
  });
});

describe("typed helpers", () => {
  it("fetchPages narrows with a slug filter and never widens", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { docs: [] });
    await fetchPages(CONFIG, { slug: "home", fetchImpl });
    const url = calls[0][0];
    expect(url).toContain("where%5Bslug%5D%5Bequals%5D=home");
    expect(url).not.toContain("where%5Bsite%5D");
  });

  it("fetchSiteDescriptor hits /api/site with no filters", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { domain: "acme.ir" });
    await fetchSiteDescriptor(CONFIG, { fetchImpl });
    expect(calls[0][0]).toBe("https://cms.eshobe.com/api/site");
  });

  it("createProduct/updateOrderStatus POST/PATCH JSON bodies", async () => {
    const create = fakeFetch(201, { id: "p1", title: "Espresso", price: 50000 });
    await provisionSite(CONFIG, { name: "Acme", domain: "acme.ir", type: "business" }, { fetchImpl: create.fetchImpl });
    expect(create.calls[0][1].method).toBe("POST");
    expect(JSON.parse(String(create.calls[0][1].body))).toMatchObject({ domain: "acme.ir" });

    const key = fakeFetch(201, { id: "k1", key: "eshobe_live_xyz", prefix: "eshobe_live_xyz", role: "site", name: "POS" });
    await issueSiteApiKey(CONFIG, { siteId: "s1", name: "POS", role: "site" }, { fetchImpl: key.fetchImpl });
    expect(key.calls[0][0]).toBe("https://cms.eshobe.com/api/api-keys/issue");
  });
});

describe("post writes", () => {
  it("createPost/updatePost/deletePost hit the right path and method", async () => {
    const create = fakeFetch(201, { id: "post1", title: "خبر تازه" });
    await createPost(CONFIG, { title: "خبر تازه", content: { root: {} } }, { fetchImpl: create.fetchImpl });
    expect(create.calls[0][0]).toBe("https://cms.eshobe.com/api/posts");
    expect(create.calls[0][1].method).toBe("POST");

    const update = fakeFetch(200, { id: "post1", title: "ویرایش‌شده" });
    await updatePost(CONFIG, "post1", { title: "ویرایش‌شده" }, { fetchImpl: update.fetchImpl });
    expect(update.calls[0][0]).toBe("https://cms.eshobe.com/api/posts/post1");
    expect(update.calls[0][1].method).toBe("PATCH");

    const del = fakeFetch(200, null);
    await deletePost(CONFIG, "post1", { fetchImpl: del.fetchImpl });
    expect(del.calls[0][0]).toBe("https://cms.eshobe.com/api/posts/post1");
    expect(del.calls[0][1].method).toBe("DELETE");
  });
});

describe("updateSiteDomain", () => {
  it("PATCHes /api/site/domain with the new domain", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { domain: "acme-new.ir", domainVerified: false });
    const result = await updateSiteDomain(CONFIG, "acme-new.ir", { fetchImpl });
    expect(calls[0][0]).toBe("https://cms.eshobe.com/api/site/domain");
    expect(calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ domain: "acme-new.ir" });
    expect(result).toEqual({ domain: "acme-new.ir", domainVerified: false });
  });
});

describe("absoluteCmsMediaUrl", () => {
  it("joins a relative media URL against the site origin", () => {
    expect(absoluteCmsMediaUrl({ url: "/api/media/file/pic.png" }, "https://acme.ir")).toBe(
      "https://acme.ir/api/media/file/pic.png",
    );
  });
  it("passes an absolute URL through", () => {
    expect(absoluteCmsMediaUrl({ url: "https://cdn.example.com/pic.png" }, "https://acme.ir")).toBe(
      "https://cdn.example.com/pic.png",
    );
  });
  it("handles null/empty media", () => {
    expect(absoluteCmsMediaUrl(null, "https://acme.ir")).toBeNull();
    expect(absoluteCmsMediaUrl(undefined, "https://acme.ir")).toBeNull();
    expect(absoluteCmsMediaUrl({ url: null }, "https://acme.ir")).toBeNull();
  });
});
