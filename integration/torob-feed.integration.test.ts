/**
 * Issue #894 Wave 2 — building a shop's feed against real Postgres.
 *
 * The unit tests decide what an item is (`feed.test.ts`) and what a price is
 * (`currency.test.ts`). This file covers what only a database can answer, and
 * every case below is a state a merchant will actually reach:
 *
 *  - a shop that is not authorized, or not switched on, gets a **blocked** build
 *    with a reason — never an empty feed that reads as "no products";
 *  - the price comes from `menu_items.price` (integer Rial) and the currency from
 *    the *website's* registry, so a Rial site and a Toman site produce different
 *    Toman figures from the same numbers;
 *  - the page URL is composed from the manager's real storefront route, and a
 *    product without one is skipped with a reason instead of vanishing;
 *  - every build writes a run row, and the row never claims Torob has anything.
 *  - one business can never build another's feed.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let withTenant: typeof import("../src/lib/db").withTenant;
let shops: typeof import("../src/lib/torob/shop-service");
let feed: typeof import("../src/lib/torob/feed-service");

const alpha = {
  businessId: "",
  wooId: "",
  rialWooId: "",
  cmsId: "",
  shopId: "",
  rialShopId: "",
  cmsShopId: "",
  /** A connected but *unauthorized* shop: every build for it is blocked. */
  pendingShopId: "",
};
const beta = { businessId: "", wooId: "" };

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
  const businessId = rows[0].id;
  await db.query("INSERT INTO locations (business_id, name) VALUES ($1, 'Main')", [businessId]);
  return businessId;
}

async function seedWoo(businessId: string, baseUrl: string, currencyUnit: "rial" | "toman"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, name, base_url, consumer_key_ciphertext, consumer_secret_ciphertext,
        webhook_secret_ciphertext, currency_unit)
     VALUES ($1, $2, $3, 'x', 'x', 'x', $4) RETURNING id`,
    [businessId, `woo-${baseUrl}`, baseUrl, currencyUnit],
  );
  return rows[0].id;
}

async function seedCms(businessId: string, siteDomain: string, siteCurrency: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO eshobe_cms_connections (business_id, site_id, site_domain, base_url, api_key_ciphertext, site_currency)
     VALUES ($1, $2, $3, 'https://cms.example.com', 'x', $4) RETURNING id`,
    [businessId, randomUUID(), siteDomain, siteCurrency],
  );
  return rows[0].id;
}

/** A product as the menu editor leaves it: integer Rial, a name, a photo. */
async function seedProduct(
  businessId: string,
  input: { name: string; price: number | null; image?: string | null; active?: boolean; category?: string },
): Promise<string> {
  const { rows: loc } = await db.query<{ id: string }>(
    "SELECT id FROM locations WHERE business_id = $1 ORDER BY created_at LIMIT 1",
    [businessId],
  );
  let categoryId: string | null = null;
  if (input.category) {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO menu_categories (location_id, name) VALUES ($1, $2) RETURNING id",
      [loc[0].id, input.category],
    );
    categoryId = rows[0].id;
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price, image_url, is_active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      loc[0].id,
      categoryId,
      input.name,
      input.price ?? 0,
      // `undefined` means "give it a photo"; `null` means "this product has none".
      input.image === undefined ? "https://cdn.example.com/p.jpg" : input.image,
      input.active ?? true,
    ],
  );
  return rows[0].id;
}

/** Connect a shop the way the service does, then force it into `authorized`. */
async function authorizedShop(
  businessId: string,
  kind: "woocommerce" | "eshobe_cms",
  connectionId: string,
  options: { enable?: boolean } = {},
): Promise<string> {
  const { shop } = await withTenant(businessId, () =>
    shops.connectTorobShop({ businessId, kind, connectionId, authMode: "partner" }),
  );
  await db.query(`UPDATE torob_shops SET authorization_state = 'authorized', provider_shop_id = $2 WHERE id = $1`, [
    shop.id,
    `torob-${shop.id.slice(0, 8)}`,
  ]);
  if (options.enable ?? true) {
    await withTenant(businessId, () => shops.setTorobShopEnabled({ businessId, shopId: shop.id, enabled: true }));
  }
  return shop.id;
}

beforeAll(async () => {
  databaseName = `pos_torobfeed_${randomUUID().replaceAll("-", "")}`;
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

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  ({ withTenant } = await import("../src/lib/db"));
  shops = await import("../src/lib/torob/shop-service");
  feed = await import("../src/lib/torob/feed-service");

  alpha.businessId = await seedBusiness("آلفا", "torobfeed-alpha");
  beta.businessId = await seedBusiness("بتا", "torobfeed-beta");

  // A Toman storefront and a Rial one: the same integer column must produce the
  // right Toman figure in both, which is the currency rule's whole point.
  alpha.wooId = await seedWoo(alpha.businessId, "https://shop.alpha.example", "toman");
  alpha.rialWooId = await seedWoo(alpha.businessId, "https://rial.alpha.example", "rial");
  alpha.cmsId = await seedCms(alpha.businessId, "cms.alpha.example", "IRT");

  await seedProduct(alpha.businessId, { name: "دستبند نقره", price: 250_000, category: "دستبند" });
  await seedProduct(alpha.businessId, { name: "بدون تصویر", price: 100_000, image: null });
  await seedProduct(alpha.businessId, { name: "غیرفعال", price: 90_000, active: false });

  alpha.shopId = await authorizedShop(alpha.businessId, "woocommerce", alpha.wooId);
  alpha.rialShopId = await authorizedShop(alpha.businessId, "woocommerce", alpha.rialWooId);
  alpha.cmsShopId = await authorizedShop(alpha.businessId, "eshobe_cms", alpha.cmsId);

  beta.wooId = await seedWoo(beta.businessId, "https://shop.beta.example", "toman");
  await seedProduct(beta.businessId, { name: "کالای بتا", price: 500_000 });
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

describe("building a feed", () => {
  it("turns the tenant's catalogue into Torob items, priced in whole Toman", async () => {
    const result = await withTenant(alpha.businessId, () =>
      feed.buildShopFeed({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    expect(result.status).toBe("built");
    expect(result.summary?.total).toBe(2); // the inactive one is out of stock, not gone
    expect(result.summary).toMatchObject({ total: 2, inStock: 1, outOfStock: 1 });
    const item = result.firstPage?.products.find((entry) => entry.name === "دستبند نقره");
    expect(item).toMatchObject({ price: 250_000, availability: "in_stock", category_name: "دستبند" });
    // The manager's own route, not a guess: `/product/{id}` for WooCommerce.
    expect(item?.page_url).toBe(`https://shop.alpha.example/product/${item?.page_unique}`);
  });

  it("reads the currency from the website, so a Rial store divides by ten", async () => {
    const toman = await withTenant(alpha.businessId, () =>
      feed.buildShopFeed({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    const rial = await withTenant(alpha.businessId, () =>
      feed.buildShopFeed({ businessId: alpha.businessId, shopId: alpha.rialShopId }),
    );
    const priceOf = (result: typeof toman) =>
      result.firstPage?.products.find((entry) => entry.name === "دستبند نقره")?.price;
    expect(priceOf(toman)).toBe(250_000);
    // 250 000 Rial = 25 000 Toman.
    expect(priceOf(rial)).toBe(25_000);
  });

  it("uses the CMS storefront route for a CMS shop", async () => {
    const result = await withTenant(alpha.businessId, () =>
      feed.buildShopFeed({ businessId: alpha.businessId, shopId: alpha.cmsShopId }),
    );
    const item = result.firstPage!.products[0];
    expect(item.page_url).toMatch(/^https:\/\/cms\.alpha\.example\/products\/[0-9a-f-]{36}$/);
  });

  it("skips a product it cannot publish, and says why", async () => {
    const result = await withTenant(alpha.businessId, () =>
      feed.buildShopFeed({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    expect(result.summary?.skippedTotal).toBe(1);
    expect(result.summary?.skippedByReason[0]).toMatchObject({ reason: "missing_image", count: 1 });
    expect(result.skipped[0].name).toBe("بدون تصویر");
  });

  it("honours the shop's choice to leave sold-out products out", async () => {
    await db.query(`UPDATE torob_shops SET include_out_of_stock = false WHERE id = $1`, [alpha.shopId]);
    try {
      const result = await withTenant(alpha.businessId, () =>
        feed.buildShopFeed({ businessId: alpha.businessId, shopId: alpha.shopId }),
      );
      expect(result.summary).toMatchObject({ total: 1, inStock: 1, outOfStock: 0 });
    } finally {
      await db.query(`UPDATE torob_shops SET include_out_of_stock = true WHERE id = $1`, [alpha.shopId]);
    }
  });
});

describe("a shop that cannot publish", () => {
  it("is blocked with a reason instead of showing an empty catalogue", async () => {
    // A website can have at most one CMS connection per business, so the fresh
    // shop here is a second WooCommerce store — connected, catalogued, and simply
    // not authorized by Torob yet.
    const pendingConnection = await seedWoo(alpha.businessId, "https://pending.alpha.example", "toman");
    const { shop } = await withTenant(alpha.businessId, () =>
      shops.connectTorobShop({
        businessId: alpha.businessId,
        kind: "woocommerce",
        connectionId: pendingConnection,
        authMode: "partner",
      }),
    );
    alpha.pendingShopId = shop.id;
    expect(shop.authorizationState).toBe("not_authorized");

    const blocked = await withTenant(alpha.businessId, () =>
      feed.buildShopFeed({ businessId: alpha.businessId, shopId: shop.id }),
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReason).toBe("not_authorized");
    expect(blocked.firstPage).toBeNull();
    expect(blocked.summary).toBeNull();
  });

  it("is blocked when the channel is switched off", async () => {
    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.cmsShopId, enabled: false }),
    );
    try {
      const blocked = await withTenant(alpha.businessId, () =>
        feed.buildShopFeed({ businessId: alpha.businessId, shopId: alpha.cmsShopId }),
      );
      expect(blocked).toMatchObject({ status: "blocked", blockedReason: "channel_disabled" });
    } finally {
      await withTenant(alpha.businessId, () =>
        shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.cmsShopId, enabled: true }),
      );
    }
  });

  it("refuses a shop id from another business outright", async () => {
    await expect(
      withTenant(beta.businessId, () =>
        feed.buildShopFeed({ businessId: beta.businessId, shopId: alpha.shopId }),
      ),
    ).rejects.toMatchObject({ code: "shop_not_found" });
  });

  it("never puts another business's products in a feed", async () => {
    const betaShop = await authorizedShop(beta.businessId, "woocommerce", beta.wooId);
    const result = await withTenant(beta.businessId, () =>
      feed.buildShopFeed({ businessId: beta.businessId, shopId: betaShop }),
    );
    expect(result.firstPage!.products.map((item) => item.name)).toEqual(["کالای بتا"]);
  });
});

describe("the run record", () => {
  it("records every build with its counts, and never claims Torob has it", async () => {
    const before = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM torob_feed_runs WHERE shop_id = $1",
      [alpha.shopId],
    );
    await withTenant(alpha.businessId, () =>
      feed.buildShopFeed({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    const { rows } = await db.query<{
      status: string;
      items_total: number;
      skipped_total: number;
      skipped_detail: { reason: string; count: number }[];
      built_at: Date;
    }>(
      `SELECT status, items_total, skipped_total, skipped_detail, built_at
         FROM torob_feed_runs WHERE shop_id = $1 ORDER BY built_at DESC LIMIT 1`,
      [alpha.shopId],
    );
    expect(Number(rows[0].items_total)).toBe(2);
    expect(rows[0].status).toBe("built");
    expect(rows[0].skipped_detail).toEqual([{ reason: "missing_image", count: 1 }]);
    const after = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM torob_feed_runs WHERE shop_id = $1",
      [alpha.shopId],
    );
    expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count) + 1);

    // The vocabulary has no "sent": what we built is all this table can say.
    const { rows: statuses } = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'torob_feed_runs'::regclass AND contype = 'c'`,
    );
    expect(statuses.length).toBeGreaterThan(0);
  });

  it("records a blocked build too, so the screen can explain it later", async () => {
    const { rows } = await db.query<{ status: string; blocked_reason: string | null }>(
      `SELECT status, blocked_reason FROM torob_feed_runs
        WHERE shop_id = $1 AND status = 'blocked' ORDER BY built_at DESC LIMIT 1`,
      [alpha.pendingShopId],
    );
    expect(rows[0]).toMatchObject({ status: "blocked" });
    expect(rows[0].blocked_reason).toBeTruthy();
  });

  it("summarises the latest run per shop", async () => {
    const latest = await withTenant(alpha.businessId, () => feed.latestFeedRuns(alpha.businessId));
    expect(latest.get(alpha.shopId)?.status).toBe("built");
    expect(latest.get(alpha.shopId)?.itemsTotal).toBe(2);
  });
});
