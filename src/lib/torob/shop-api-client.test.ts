/**
 * Issue #894 Wave 4b — the Shop API client, against a scripted Torob.
 *
 * The rules worth a test are the ones where a mistake is invisible in production:
 * a request without a credential, a pagination link followed to another host, a
 * `429` treated as an outage, a `page_size` above the provider's ceiling, a status
 * list quietly rewritten into a status Torob never sent. Every case below scripts
 * the response and asserts on the request that produced it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  TOROB_SHOP_API_PAGE_SIZE,
  TorobShopApiError,
  createShopApiThrottle,
  cursorFromLink,
  listTorobProducts,
  readTorobShopInfo,
  torobShopApiBaseUrl,
} from "./shop-api-client";

const BASE = "https://torob.test/shop-api/v1/";
const env = { TOROB_SHOP_API_BASE_URL: BASE } as Record<string, string | undefined>;

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** A fetch that answers the queued responses in order and records its calls. */
function scripted(...responses: (Response | (() => Response))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const shopBody = {
  domain: "shop.alpha.example",
  name: "فروشگاه نمونه",
  shop_status: "active",
  product_summary: {
    calculated_at: "2026-10-07T13:00:00Z",
    total: 900,
    available: 600,
    not_available: 100,
    not_accessible: 100,
    not_active: 50,
    deleted: 50,
    not_accessible_errors: [
      { error_title: "404:download_http_status_error", count: 70 },
      { error_title: "500:timeout", count: 30 },
    ],
  },
};

const product = (id: string, statuses: string[] = []) => ({
  product_id: id,
  page_url: `https://shop.alpha.example/product/${id}`,
  statuses,
  price: 1_250_000,
  availability: statuses.includes("page_not_available") ? false : true,
  error_title: "",
  updated_at: "2026-10-07T08:15:30.120000+00:00",
});

describe("the base URL", () => {
  it("defaults to Torob's documented endpoint", () => {
    expect(torobShopApiBaseUrl({})).toBe("https://api.torob.com/shop-api/v1/");
  });

  it("accepts an override, with or without its trailing slash", () => {
    expect(torobShopApiBaseUrl({ TOROB_SHOP_API_BASE_URL: "https://x.test/shop-api/v1" })).toBe(
      "https://x.test/shop-api/v1/",
    );
  });
});

describe("GET /shop/", () => {
  it("authenticates with the bearer token and names the shop by domain", async () => {
    const { fetchImpl, calls } = scripted(json(shopBody));
    const info = await readTorobShopInfo({ token: "secret-token", domain: "Shop.Alpha.Example", env, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}shop/?domain=shop.alpha.example`);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    // Never in the URL: a token in a query string ends up in every access log.
    expect(calls[0].url).not.toContain("secret-token");

    expect(info.shopStatus).toBe("active");
    expect(info.summary).toMatchObject({ total: 900, available: 600, notAvailable: 100, notAccessible: 100 });
    expect(info.summary.calculatedAt).toBe("2026-10-07T13:00:00.000Z");
    // Largest first, as the panel lists them.
    expect(info.summary.notAccessibleErrors.map((entry) => entry.count)).toEqual([70, 30]);
  });

  it("refuses before the network when there is no credential", async () => {
    const { fetchImpl, calls } = scripted();
    await expect(readTorobShopInfo({ token: "  ", domain: "a.example", env, fetchImpl })).rejects.toMatchObject({
      code: "not_configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses before the network when there is no domain", async () => {
    const { fetchImpl, calls } = scripted();
    await expect(readTorobShopInfo({ token: "t", domain: "", env, fetchImpl })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [400, "invalid_request"],
    [500, "provider_error"],
    [503, "provider_error"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const { fetchImpl } = scripted(json({ detail: "no" }, { status }));
    await expect(readTorobShopInfo({ token: "t", domain: "a.example", env, fetchImpl })).rejects.toMatchObject({
      code,
    });
  });

  it("refuses a shop_status outside the documented four", async () => {
    const { fetchImpl } = scripted(json({ ...shopBody, shop_status: "on_fire" }));
    await expect(readTorobShopInfo({ token: "t", domain: "a.example", env, fetchImpl })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("refuses a body without a product summary instead of inventing zeros", async () => {
    const { fetchImpl } = scripted(json({ domain: "a.example", shop_status: "active" }));
    await expect(readTorobShopInfo({ token: "t", domain: "a.example", env, fetchImpl })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("retries a 429 and honours the provider's Retry-After", async () => {
    const { fetchImpl, calls } = scripted(
      json({}, { status: 429, headers: { "retry-after": "1" } }),
      json(shopBody),
    );
    const info = await readTorobShopInfo({
      token: "t",
      domain: "a.example",
      env,
      fetchImpl,
      maxRetryDelayMs: 5,
    });
    expect(calls).toHaveLength(2);
    expect(info.shopStatus).toBe("active");
  });

  it("gives up as rate_limited once the retries are spent", async () => {
    const throttle = { take: vi.fn(async () => {}) };
    const { fetchImpl, calls } = scripted(
      json({}, { status: 429 }),
      json({}, { status: 429 }),
      json({}, { status: 429 }),
    );
    await expect(
      readTorobShopInfo({ token: "t", domain: "a.example", env, fetchImpl, maxRetries: 2, throttle }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    // One attempt plus the two retries — and every attempt went through the gate.
    expect(calls).toHaveLength(3);
    expect(throttle.take).toHaveBeenCalledTimes(3);
  });

  it("maps a timeout to its own code rather than a generic failure", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch;
    await expect(readTorobShopInfo({ token: "t", domain: "a.example", env, fetchImpl })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("reports an unreadable body as invalid_response, not as success", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const error = await readTorobShopInfo({ token: "t", domain: "a.example", env, fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(TorobShopApiError);
    expect(error.code).toBe("invalid_response");
  });
});

describe("POST /products/", () => {
  it("paginates by cursor and sends the same body to every page", async () => {
    const { fetchImpl, calls } = scripted(
      json({
        previous: null,
        next: `${BASE}products/?cursor=cD0xMjM0NQ%3D%3D&domain=a.example&page_size=100`,
        results: [product("p1"), product("p2")],
      }),
      json({ previous: null, next: null, results: [product("p3")] }),
    );

    const scan = await listTorobProducts({ token: "t", domain: "a.example", env, fetchImpl, status: "page_not_available" });

    expect(scan.products.map((row) => row.pageUnique)).toEqual(["p1", "p2", "p3"]);
    expect(scan.pages).toBe(2);
    expect(scan.truncated).toBe(false);
    expect(calls[0].url).toBe(`${BASE}products/?domain=a.example&page_size=${TOROB_SHOP_API_PAGE_SIZE}`);
    expect(calls[1].url).toContain("cursor=cD0xMjM0NQ%3D%3D");
    // The same filter body on both pages, as the document requires.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ status: "page_not_available" });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ status: "page_not_available" });
    expect(calls[0].init.method).toBe("POST");
  });

  it("never follows a `next` link to another host — only its cursor", async () => {
    const { fetchImpl, calls } = scripted(
      json({ next: "https://evil.example/steal?cursor=abc123", results: [product("p1")] }),
      json({ next: null, results: [] }),
    );
    await listTorobProducts({ token: "secret", domain: "a.example", env, fetchImpl });
    expect(calls[1].url.startsWith(BASE)).toBe(true);
    expect(calls[1].url).toContain("cursor=abc123");
    expect(calls.some((call) => call.url.includes("evil.example"))).toBe(false);
  });

  it("stops at the page bound and says the scan was truncated", async () => {
    const { fetchImpl, calls } = scripted(
      json({ next: `${BASE}products/?cursor=a`, results: [product("p1")] }),
      json({ next: `${BASE}products/?cursor=b`, results: [product("p2")] }),
      json({ next: `${BASE}products/?cursor=c`, results: [product("p3")] }),
    );
    const scan = await listTorobProducts({ token: "t", domain: "a.example", env, fetchImpl, maxPages: 2 });
    expect(calls).toHaveLength(2);
    expect(scan.truncated).toBe(true);
    expect(scan.products).toHaveLength(2);
  });

  it("clamps page_size to the provider's 500 ceiling", async () => {
    const { fetchImpl, calls } = scripted(json({ next: null, results: [] }));
    await listTorobProducts({ token: "t", domain: "a.example", env, fetchImpl, pageSize: 5_000 });
    expect(calls[0].url).toContain("page_size=500");
  });

  it("keeps Torob's own status order and takes the main status from the first", async () => {
    const { fetchImpl } = scripted(
      json({
        next: null,
        results: [product("p1", ["page_not_active", "price_not_valid"])],
      }),
    );
    const scan = await listTorobProducts({ token: "t", domain: "a.example", env, fetchImpl });
    expect(scan.products[0].statuses).toEqual(["page_not_active", "price_not_valid"]);
    expect(scan.products[0].mainStatus).toBe("page_not_active");
    expect(scan.products[0].availability).toBe(true);
  });

  it("counts a status this build does not know instead of folding it into a neighbour", async () => {
    const { fetchImpl } = scripted(
      json({ next: null, results: [product("p1", ["page_price_outlier", "page_not_available"])] }),
    );
    const scan = await listTorobProducts({ token: "t", domain: "a.example", env, fetchImpl });
    expect(scan.unknownStatuses).toBe(1);
    expect(scan.products[0].statuses).toEqual(["page_not_available"]);
    expect(scan.products[0].mainStatus).toBe("page_not_available");
  });

  it("refuses a product without an id", async () => {
    const { fetchImpl } = scripted(json({ next: null, results: [{ statuses: [] }] }));
    await expect(
      listTorobProducts({ token: "t", domain: "a.example", env, fetchImpl }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("refuses a page with no results array", async () => {
    const { fetchImpl } = scripted(json({ next: null }));
    await expect(
      listTorobProducts({ token: "t", domain: "a.example", env, fetchImpl }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("sends product_ids only when it was asked for a bounded lookup", async () => {
    const { fetchImpl, calls } = scripted(json({ next: null, results: [] }));
    await listTorobProducts({ token: "t", domain: "a.example", env, fetchImpl, productIds: ["p1", "p2"] });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ product_ids: ["p1", "p2"] });
  });
});

describe("cursorFromLink", () => {
  it("takes the cursor out of an absolute link", () => {
    expect(cursorFromLink(`${BASE}products/?cursor=abc&domain=a.example`)).toBe("abc");
  });

  it("answers null for anything that is not a usable link", () => {
    expect(cursorFromLink(null)).toBeNull();
    expect(cursorFromLink("not a url")).toBeNull();
    expect(cursorFromLink(`${BASE}products/?domain=a.example`)).toBeNull();
  });
});

describe("the per-shop rate gate", () => {
  it("spaces calls evenly instead of firing a burst", async () => {
    let clock = 0;
    const slept: number[] = [];
    const throttle = createShopApiThrottle({
      perSecond: 5,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await throttle.take();
    await throttle.take();
    await throttle.take();

    // The first call waits for nothing; the next two are a fifth of a second apart.
    expect(slept).toEqual([200, 200]);
  });

  it("does not wait when real time already passed the slot", async () => {
    let clock = 0;
    const slept: number[] = [];
    const throttle = createShopApiThrottle({
      perSecond: 1,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await throttle.take();
    clock += 5_000; // a slow provider, not a fast client
    await throttle.take();
    expect(slept).toEqual([]);
  });
});
