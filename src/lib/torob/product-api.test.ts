import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #894 Wave 3 — the public product endpoint's order of operations.
 *
 * What is worth testing here is not the feed (that is `feed.test.ts`) but the
 * *sequence*: rate limit, resolve, refuse, authenticate, parse, serve. Two of those
 * steps are security properties — a hostile caller must not be able to learn that a
 * shop exists, and must not be able to make the platform build a catalogue without a
 * valid signature.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTenant: vi.fn(async (_businessId: string, fn: () => unknown) => fn()),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => unknown) => fn()),
  resolveServeableShop: vi.fn(),
  buildServedFeed: vi.fn(),
}));

vi.mock("../db", () => ({
  query: mocks.query,
  withTenant: mocks.withTenant,
  withoutTenantScope: mocks.withoutTenantScope,
}));

vi.mock("./feed-service", () => ({
  resolveServeableShop: mocks.resolveServeableShop,
  buildServedFeed: mocks.buildServedFeed,
}));

const {
  TOROB_MAX_BODY_BYTES,
  TOROB_SHOP_LIMIT,
  allowTorobShopRequest,
  bodyTooLarge,
  handleTorobProductRequest,
  resetTorobShopWindows,
} = await import("./product-api");

const SHOP_ID = "8d0a2f8e-1111-4222-8333-444455556666";
const BUSINESS_ID = "0b7c4f1a-9999-4aaa-8bbb-ccccddddeeee";
const DOMAIN = "shop.example.com";

let privateKey: CryptoKey;
let publicKeyPem: string;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA");
  privateKey = pair.privateKey;
  publicKeyPem = await exportSPKI(pair.publicKey);
});

beforeEach(() => {
  // The endpoint verifies with the deployment's configured key.
  vi.stubEnv("TOROB_API_PUBLIC_KEY", publicKeyPem);
  resetTorobShopWindows();
  mocks.query.mockReset();
  mocks.resolveServeableShop.mockReset();
  mocks.buildServedFeed.mockReset();
  // The default world: a shop that exists, is publishable, and has one product.
  mocks.query.mockResolvedValue({ rows: [{ business_id: BUSINESS_ID }] });
  mocks.resolveServeableShop.mockResolvedValue({
    status: "available",
    shop: { businessId: BUSINESS_ID, shopId: SHOP_ID, domain: DOMAIN },
  });
  mocks.buildServedFeed.mockResolvedValue({
    items: [
      {
        page_unique: SHOP_ID,
        page_url: "https://shop.example.com/product/1/",
        title: "گوشی موبایل",
        current_price: 2_500_000,
        availability: true,
        image_links: ["https://shop.example.com/1.jpg"],
        spec: {},
        date_added: "2026-01-05T10:00:00.000Z",
      },
    ],
    skipped: [],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function token(aud = DOMAIN) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", v: 1 })
    .setAudience(aud)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);
}

function headers(jwt?: string, version = "1") {
  const result = new Headers({ "content-type": "application/json" });
  if (jwt) result.set("x-torob-token", jwt);
  if (version) result.set("x-torob-token-version", version);
  return result;
}

function ask(body: unknown, jwt: string, overrides: Partial<{ shopId: string; headers: Headers }> = {}) {
  return handleTorobProductRequest({
    shopId: overrides.shopId ?? SHOP_ID,
    headers: overrides.headers ?? headers(jwt),
    rawBody: JSON.stringify(body),
  });
}

describe("a shop that may not be served", () => {
  it("answers an unknown id exactly like a blocked one", async () => {
    // Nothing in the response may say whether the uuid exists.
    mocks.query.mockResolvedValueOnce({ rows: [] });
    expect(await ask({ page: 1, sort: "date_added_desc" }, await token())).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });

  it("answers a shop that is not authorized or switched off the same way", async () => {
    for (const reason of ["not_authorized", "channel_disabled", "website_missing", "website_inactive"]) {
      mocks.resolveServeableShop.mockResolvedValueOnce({ status: "blocked", reason });
      const result = await ask({ page: 1, sort: "date_added_desc" }, await token());
      expect(result, reason).toEqual({ status: 404, body: { error: "not_found" } });
    }
    // The shop's own state is never echoed back to an anonymous caller.
    expect(JSON.stringify(await ask({ page: 1, sort: "date_added_desc" }, await token()))).not.toContain("authorized");
  });

  it("does not look up a shop id that is not a uuid", async () => {
    const result = await ask({ page: 1, sort: "date_added_desc" }, await token(), { shopId: "../../etc/passwd" });
    expect(result.status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("the token", () => {
  it("is required before any catalogue is read", async () => {
    const result = await handleTorobProductRequest({
      shopId: SHOP_ID,
      headers: headers(),
      rawBody: JSON.stringify({ page: 1, sort: "date_added_desc" }),
    });
    expect(result).toEqual({ status: 401, body: { error: "unauthorized: missing_token" } });
    expect(mocks.buildServedFeed).not.toHaveBeenCalled();
  });

  it("must name this shop's domain, not the caller's Host", async () => {
    const result = await handleTorobProductRequest({
      shopId: SHOP_ID,
      // A caller arriving on the right host with a token minted for another shop is
      // the exact attack the audience check exists for.
      headers: new Headers({ ...Object.fromEntries(headers(await token("other.example.com")).entries()), host: DOMAIN }),
      rawBody: JSON.stringify({ page: 1, sort: "date_added_desc" }),
    });
    expect(result).toEqual({ status: 401, body: { error: "unauthorized: audience_mismatch" } });
    expect(mocks.buildServedFeed).not.toHaveBeenCalled();
  });

  it("must carry a supported token version", async () => {
    const result = await handleTorobProductRequest({
      shopId: SHOP_ID,
      headers: headers(await token(), "2"),
      rawBody: "{}",
    });
    expect(result.status).toBe(401);
  });
});

describe("the request", () => {
  it("refuses a body that is not JSON", async () => {
    const result = await handleTorobProductRequest({ shopId: SHOP_ID, headers: headers(await token()), rawBody: "<xml/>" });
    expect(result).toEqual({ status: 400, body: { error: "request body must be JSON" } });
  });

  it("refuses a body with no mode instead of defaulting to page 1", async () => {
    expect(await ask({}, await token())).toEqual({
      status: 400,
      body: { error: "request body is empty: send page_urls, page_uniques, page, or cursor" },
    });
    expect(mocks.buildServedFeed).not.toHaveBeenCalled();
  });

  it("answers in Torob's envelope once authenticated", async () => {
    const result = await ask({ page: 1, sort: "date_added_desc" }, await token());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      api_version: "torob_api_v3",
      current_page: 1,
      total: 1,
      max_pages: 1,
      next_cursor: null,
    });
    expect(result.status === 200 && result.body.products).toHaveLength(1);
  });

  it("answers a page_urls lookup for a product the shop withdrew with an empty list", async () => {
    // Withdrawn products are absent from the built feed, so the lookup finds nothing
    // — which is the document's "removed product" answer, not a 404.
    const result = await ask({ page_urls: ["https://shop.example.com/product/gone/"] }, await token());
    expect(result).toMatchObject({ status: 200, body: { total: 0, products: [] } });
  });
});

describe("the shop's rate limit", () => {
  it("allows five requests in a second and refuses the sixth", async () => {
    const now = 1_000_000;
    for (let i = 0; i < TOROB_SHOP_LIMIT; i += 1) expect(allowTorobShopRequest(SHOP_ID, now), String(i)).toBe(true);
    expect(allowTorobShopRequest(SHOP_ID, now)).toBe(false);
    // The next window is a clean slate.
    expect(allowTorobShopRequest(SHOP_ID, now + 1_000)).toBe(true);
  });

  it("keys per shop, so one crawl cannot spend another's budget", () => {
    const now = 2_000_000;
    for (let i = 0; i < TOROB_SHOP_LIMIT; i += 1) allowTorobShopRequest("shop-a", now);
    expect(allowTorobShopRequest("shop-a", now)).toBe(false);
    expect(allowTorobShopRequest("shop-b", now)).toBe(true);
  });

  it("answers 429 rather than reaching the database", async () => {
    for (let i = 0; i < TOROB_SHOP_LIMIT; i += 1) {
      await handleTorobProductRequest({
        shopId: SHOP_ID,
        headers: headers(await token()),
        rawBody: JSON.stringify({ page: 1, sort: "date_added_desc" }),
      });
    }
    mocks.query.mockClear();
    const refused = await handleTorobProductRequest({
      shopId: SHOP_ID,
      headers: headers(await token()),
      rawBody: JSON.stringify({ page: 1, sort: "date_added_desc" }),
    });
    expect(refused).toEqual({ status: 429, body: { error: "too_many_requests" } });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("the body cap", () => {
  it("refuses an oversized Content-Length and allows an honest one", () => {
    expect(bodyTooLarge(String(TOROB_MAX_BODY_BYTES + 1))).toBe(true);
    expect(bodyTooLarge(String(TOROB_MAX_BODY_BYTES))).toBe(false);
    // No header is not evidence of a large body; the route still reads and bounds.
    expect(bodyTooLarge(null)).toBe(false);
    expect(bodyTooLarge("not-a-number")).toBe(false);
  });

  it("is roomy enough for the contract's largest request", () => {
    // 100 allowed page_urls at the 1 500-character field limit.
    expect(TOROB_MAX_BODY_BYTES).toBeGreaterThan(100 * 1_500);
  });
});
