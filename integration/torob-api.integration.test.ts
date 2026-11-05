/**
 * Issue #894 Wave 3 — Torob's Product API v3, served from a real database.
 *
 * The unit tests (`product-api.test.ts`, `contract.test.ts`, `auth.test.ts`) prove
 * the order of operations and the contract in isolation. Only a database can answer
 * the questions that decide whether a real crawler succeeds:
 *
 *  - does the endpoint resolve a shop from nothing but the id in its path, and does
 *    it refuse a shop that may not be published without saying which reason;
 *  - does the audience check hold when two shops of two businesses are live at
 *    once, so a token minted for one cannot open the other;
 *  - does a page really hold 100 products, does the cursor walk the whole catalogue
 *    exactly once, and do `page_urls`/`page_uniques` answer with the product;
 *  - is a withdrawn product *absent* — from lists and from a direct lookup — rather
 *    than sent as an out-of-stock page Torob would keep showing.
 */
import { randomUUID } from "node:crypto";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let withTenant: typeof import("../src/lib/db").withTenant;
let shops: typeof import("../src/lib/torob/shop-service");
let api: typeof import("../src/lib/torob/product-api");
let privateKey: CryptoKey;

/** Two businesses, deliberately: cross-shop is the property that matters. */
const alpha = { businessId: "", wooId: "", shopId: "", domain: "shop.alpha.example", withdrawnId: "", productId: "" };
const beta = { businessId: "", wooId: "", shopId: "", domain: "shop.beta.example" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function seedBusiness(name: string, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  await db.query("INSERT INTO locations (business_id, name) VALUES ($1, 'Main')", [rows[0].id]);
  return rows[0].id;
}

async function seedWoo(businessId: string, baseUrl: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, name, base_url, consumer_key_ciphertext, consumer_secret_ciphertext,
        webhook_secret_ciphertext, currency_unit)
     VALUES ($1, $2, $3, 'x', 'x', 'x', 'toman') RETURNING id`,
    [businessId, `woo-${baseUrl}`, baseUrl],
  );
  return rows[0].id;
}

async function seedProduct(
  businessId: string,
  input: { name: string; price: number; active?: boolean; image?: string | null },
): Promise<string> {
  const { rows: loc } = await db.query<{ id: string }>(
    "SELECT id FROM locations WHERE business_id = $1 ORDER BY created_at LIMIT 1",
    [businessId],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, name, price, image_url, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      loc[0].id,
      input.name,
      input.price,
      input.image === undefined ? "https://cdn.example.com/p.jpg" : input.image,
      input.active ?? true,
    ],
  );
  return rows[0].id;
}

async function authorizedShop(businessId: string, kind: "woocommerce", connectionId: string): Promise<string> {
  const { shop } = await withTenant(businessId, () =>
    shops.connectTorobShop({ businessId, kind, connectionId, authMode: "partner" }),
  );
  await db.query(
    `UPDATE torob_shops SET authorization_state = 'authorized', provider_shop_id = $2 WHERE id = $1`,
    [shop.id, `torob-${shop.id.slice(0, 8)}`],
  );
  await withTenant(businessId, () => shops.setTorobShopEnabled({ businessId, shopId: shop.id, enabled: true }));
  return shop.id;
}

/** A token as Torob mints it: EdDSA, `aud` = the API hostname, a short lifetime. */
async function torobToken(audience: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", v: 1 })
    .setAudience(audience)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);
}

async function ask(shopId: string, body: unknown, options: { aud?: string; token?: string | null } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.token !== null) {
    headers.set("x-torob-token", options.token ?? (await torobToken(options.aud ?? alpha.domain)));
    headers.set("x-torob-token-version", "1");
  }
  return api.handleTorobProductRequest({ shopId, headers, rawBody: JSON.stringify(body) });
}

beforeAll(async () => {
  databaseName = `pos_torobapi_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "ab".repeat(32);

  const pair = await generateKeyPair("EdDSA");
  privateKey = pair.privateKey;
  process.env.TOROB_API_PUBLIC_KEY = await exportSPKI(pair.publicKey);

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  ({ withTenant } = await import("../src/lib/db"));
  shops = await import("../src/lib/torob/shop-service");
  api = await import("../src/lib/torob/product-api");

  alpha.businessId = await seedBusiness("آلفا", "torobapi-alpha");
  beta.businessId = await seedBusiness("بتا", "torobapi-beta");

  alpha.wooId = await seedWoo(alpha.businessId, `https://${alpha.domain}`);

  // 105 publishable products: enough to need a second page at the contract's 100.
  for (let index = 0; index < 105; index += 1) {
    const id = await seedProduct(alpha.businessId, {
      name: `محصول ${String(index).padStart(3, "0")}`,
      price: 100_000 + index * 1_000,
    });
    if (index === 0) alpha.productId = id;
  }
  alpha.withdrawnId = await seedProduct(alpha.businessId, {
    name: "محصول جمع‌شده",
    price: 500_000,
    active: false,
  });

  alpha.shopId = await authorizedShop(alpha.businessId, "woocommerce", alpha.wooId);

  beta.wooId = await seedWoo(beta.businessId, `https://${beta.domain}`);
  await seedProduct(beta.businessId, { name: "کالای بتا", price: 900_000 });
  beta.shopId = await authorizedShop(beta.businessId, "woocommerce", beta.wooId);
}, 180_000);

afterAll(async () => {
  const dbLib = await import("../src/lib/db");
  await dbLib.closeDatabasePool();
  await db?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(() => {
  // The limiter is per shop and per second; a test may ask more than five times.
  api.resetTorobShopWindows();
});

describe("the page modes", () => {
  it("serves page 1 in Torob's envelope, 100 products at a time", async () => {
    const result = await ask(alpha.shopId, { page: 1, sort: "date_added_desc" });
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error(JSON.stringify(result.body));
    expect(result.body).toMatchObject({ api_version: "torob_api_v3", current_page: 1, total: 105, max_pages: 2 });
    expect(result.body.products).toHaveLength(100);
    expect(result.body.next_cursor).toBeNull();
  });

  it("serves the remainder on page 2 and never more pages than exist", async () => {
    const page2 = await ask(alpha.shopId, { page: 2, sort: "date_added_desc" });
    expect(page2.status).toBe(200);
    if (page2.status !== 200) throw new Error("page 2 failed");
    expect(page2.body.products).toHaveLength(5);
    expect(page2.body.current_page).toBe(2);

    // A stale page number is clamped rather than answered with nothing: an empty
    // 200 reads to Torob as "the shop deleted everything".
    const stale = await ask(alpha.shopId, { page: 9, sort: "date_added_desc" });
    expect(stale.status).toBe(200);
    if (stale.status !== 200) throw new Error("stale page failed");
    expect(stale.body.current_page).toBe(2);
    expect(stale.body.products).toHaveLength(5);
  });

  it("walks the whole catalogue by cursor, exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 5; guard += 1) {
      const result = await ask(alpha.shopId, { cursor, sort: "product_id_desc" });
      expect(result.status).toBe(200);
      if (result.status !== 200) throw new Error("cursor page failed");
      // Cursor pages carry no page number: there is no such thing there.
      expect("current_page" in result.body).toBe(false);
      seen.push(...result.body.products.map((product) => product.page_unique));
      if (!result.body.next_cursor) break;
      cursor = result.body.next_cursor;
    }
    expect(seen).toHaveLength(105);
    expect(new Set(seen).size).toBe(105);
  });
});

describe("direct lookups", () => {
  it("answers page_urls with the product the URL names", async () => {
    const pageUrl = `https://${alpha.domain}/product/${alpha.productId}`;
    const result = await ask(alpha.shopId, { page_urls: [pageUrl] });
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error("lookup failed");
    expect(result.body.total).toBe(1);
    expect(result.body.products[0]).toMatchObject({
      page_unique: alpha.productId,
      page_url: pageUrl,
      current_price: 100_000,
      availability: true,
      spec: {},
    });
  });

  it("answers page_uniques with the same product", async () => {
    const result = await ask(alpha.shopId, { page_uniques: [alpha.productId] });
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error("lookup failed");
    expect(result.body.products.map((product) => product.page_unique)).toEqual([alpha.productId]);
  });

  it("answers a withdrawn product's lookup with an empty list, not a stub", async () => {
    const gone = await ask(alpha.shopId, {
      page_urls: [`https://${alpha.domain}/product/${alpha.withdrawnId}`],
    });
    expect(gone).toMatchObject({ status: 200, body: { total: 0, products: [] } });

    const byUnique = await ask(alpha.shopId, { page_uniques: [alpha.withdrawnId] });
    expect(byUnique).toMatchObject({ status: 200, body: { total: 0, products: [] } });
  });
});

describe("isolation", () => {
  it("refuses a token minted for another shop of another business", async () => {
    // This is the attack the audience check exists for: the caller knows both shop
    // ids and sends shop B's token to shop A's endpoint.
    const result = await ask(alpha.shopId, { page: 1, sort: "date_added_desc" }, { aud: beta.domain });
    expect(result).toEqual({ status: 401, body: { error: "unauthorized: audience_mismatch" } });
  });

  it("serves each shop only its own catalogue", async () => {
    const result = await ask(beta.shopId, { page: 1, sort: "date_added_desc" }, { aud: beta.domain });
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error("beta failed");
    expect(result.body.products.map((product) => product.title)).toEqual(["کالای بتا"]);
  });

  it("answers an unauthorized shop exactly like an id that does not exist", async () => {
    const pendingConnection = await seedWoo(alpha.businessId, "https://pending.alpha.example");
    const { shop } = await withTenant(alpha.businessId, () =>
      shops.connectTorobShop({
        businessId: alpha.businessId,
        kind: "woocommerce",
        connectionId: pendingConnection,
        authMode: "partner",
      }),
    );
    const pending = await ask(shop.id, { page: 1, sort: "date_added_desc" }, { aud: alpha.domain });
    const unknown = await ask(randomUUID(), { page: 1, sort: "date_added_desc" }, { aud: alpha.domain });
    expect(pending).toEqual({ status: 404, body: { error: "not_found" } });
    expect(unknown).toEqual(pending);
  });

  it("answers a switched-off shop the same way", async () => {
    await withTenant(beta.businessId, () =>
      shops.setTorobShopEnabled({ businessId: beta.businessId, shopId: beta.shopId, enabled: false }),
    );
    try {
      expect(await ask(beta.shopId, { page: 1, sort: "date_added_desc" }, { aud: beta.domain })).toEqual({
        status: 404,
        body: { error: "not_found" },
      });
    } finally {
      await withTenant(beta.businessId, () =>
        shops.setTorobShopEnabled({ businessId: beta.businessId, shopId: beta.shopId, enabled: true }),
      );
    }
  });

  it("needs a token at all, and does not leak the shop while refusing", async () => {
    const result = await ask(alpha.shopId, { page: 1, sort: "date_added_desc" }, { token: null });
    expect(result).toEqual({ status: 401, body: { error: "unauthorized: missing_token" } });
  });
});

describe("the contract's refusals", () => {
  it("refuses a request with no mode or no sort in Torob's own words", async () => {
    expect(await ask(alpha.shopId, {})).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("page_urls") },
    });
    expect(await ask(alpha.shopId, { page: 1 })).toEqual({
      status: 400,
      body: { error: "sort parameter is not provided" },
    });
  });
});
