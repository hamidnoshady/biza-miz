/**
 * Issue #894 Wave 4 — the merchant's publication decision, against real Postgres.
 *
 * The unit tests decide what the two rules mean (`publication.test.ts`); what only a
 * database can answer is whether the decision **reaches the feed the crawler gets**.
 * Every case below is a way that breaks silently:
 *
 *  - an exclusion under «همه» really removes the product from the built feed, so a
 *    merchant who switched one off does not still see it on Torob;
 *  - a selection under «فقط انتخابی» publishes exactly the chosen products — and
 *    choosing nothing publishes nothing, rather than the whole catalogue;
 *  - switching the rule back and forth keeps the stored decisions, so nothing the
 *    merchant marked is lost;
 *  - a product id from another business cannot be attached to this shop, and the
 *    endpoint's counts say it was refused;
 *  - clearing a decision returns the product to the rule, which is not the same as
 *    switching it off.
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
let publication: typeof import("../src/lib/torob/shop-publication");
let feed: typeof import("../src/lib/torob/feed-service");
let TOROB_FEED_SKIP_COPY: typeof import("../src/lib/torob/feed").TOROB_FEED_SKIP_COPY;

const alpha = {
  businessId: "",
  wooId: "",
  shopId: "",
  a: "",
  b: "",
  c: "",
  /** A storefront that prices in **Rial**, so a Rial figure can be inexact in Toman. */
  rialShopId: "",
  oddProduct: "",
};
const beta = { businessId: "", wooId: "", productId: "" };

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

async function seedWoo(
  businessId: string,
  baseUrl: string,
  currencyUnit: "toman" | "rial" = "toman",
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, name, base_url, consumer_key_ciphertext, consumer_secret_ciphertext,
        webhook_secret_ciphertext, currency_unit, sync_products)
     VALUES ($1, $2, $3, 'x', 'x', 'x', $4, true) RETURNING id`,
    [businessId, `woo-${baseUrl}`, baseUrl, currencyUnit],
  );
  return rows[0].id;
}

async function seedProduct(businessId: string, name: string, price: number, image: string | null = "https://cdn.example.com/p.jpg"): Promise<string> {
  const { rows: loc } = await db.query<{ id: string }>(
    "SELECT id FROM locations WHERE business_id = $1 ORDER BY created_at LIMIT 1",
    [businessId],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, name, price, image_url, is_active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [loc[0].id, name, price, image],
  );
  return rows[0].id;
}

/** The feed a crawler would receive for one shop, as `page_unique` values. */
async function feedIds(shopId: string = alpha.shopId): Promise<string[]> {
  const result = await withTenant(alpha.businessId, () =>
    feed.buildShopFeed({ businessId: alpha.businessId, shopId }),
  );
  return (result.firstPage?.products ?? []).map((product) => product.page_unique).sort();
}

/**
 * The three products these cases are about.
 *
 * The business also owns a fourth (the one priced 100 005 Rial, which is inexact
 * on the Rial shop), so the assertions name their own set instead of assuming the
 * catalogue is exactly three rows — the feed is the business's catalogue, and that
 * is the point.
 */
function among(ids: string[]): string[] {
  return ids.filter((id) => [alpha.a, alpha.b, alpha.c].includes(id));
}

beforeAll(async () => {
  databaseName = `pos_torobpub_${randomUUID().replaceAll("-", "")}`;
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
  publication = await import("../src/lib/torob/shop-publication");
  feed = await import("../src/lib/torob/feed-service");
  ({ TOROB_FEED_SKIP_COPY } = await import("../src/lib/torob/feed"));

  alpha.businessId = await seedBusiness("آلفا", "torobpub-alpha");
  beta.businessId = await seedBusiness("بتا", "torobpub-beta");
  alpha.wooId = await seedWoo(alpha.businessId, "https://shop.alpha.example");
  beta.wooId = await seedWoo(beta.businessId, "https://shop.beta.example");
  beta.productId = await seedProduct(beta.businessId, "کالای بتا", 900_000);

  alpha.a = await seedProduct(alpha.businessId, "الف", 100_000);
  alpha.b = await seedProduct(alpha.businessId, "ب", 200_000);
  alpha.c = await seedProduct(alpha.businessId, "ج", 300_000);

  // A second storefront in Rial, with a price that is not a whole Toman: the one
  // case the feed refuses on price, and the screen has to say so.
  alpha.oddProduct = await seedProduct(alpha.businessId, "قیمت ناجور", 100_005);
  const rialWoo = await seedWoo(alpha.businessId, "https://rial.alpha.example", "rial");

  const { shop } = await withTenant(alpha.businessId, () =>
    shops.connectTorobShop({ businessId: alpha.businessId, kind: "woocommerce", connectionId: alpha.wooId }),
  );
  alpha.shopId = shop.id;
  const rial = await withTenant(alpha.businessId, () =>
    shops.connectTorobShop({ businessId: alpha.businessId, kind: "woocommerce", connectionId: rialWoo }),
  );
  alpha.rialShopId = rial.shop.id;
  // Authorized + enabled, the state in which a feed exists at all.
  await db.query(`UPDATE torob_shops SET authorization_state = 'authorized', provider_shop_id = 'x' WHERE id = $1`, [
    alpha.shopId,
  ]);
  await withTenant(alpha.businessId, () =>
    shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: true }),
  );
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

describe("under the «all» rule", () => {
  it("publishes every product, and an exclusion reaches the built feed", async () => {
    expect(among(await feedIds())).toEqual([alpha.a, alpha.b, alpha.c].sort());

    await withTenant(alpha.businessId, () =>
      publication.setProductDecision({
        businessId: alpha.businessId,
        shopId: alpha.shopId,
        productIds: [alpha.b],
        decision: "exclude",
      }),
    );
    expect(among(await feedIds())).toEqual([alpha.a, alpha.c].sort());

    // …and the screen says why, in the merchant's own terms, not as a failure.
    const view = await withTenant(alpha.businessId, () =>
      publication.readShopPublication({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    expect(view?.counts).toMatchObject({ total: 4, published: 3, excluded: 1, blocked: 0 });
    expect(view?.products.find((row) => row.id === alpha.b)?.state).toBe("excluded");
    // An excluded product is not reported with a skip reason: nothing is wrong
    // with it, the merchant simply said no.
    expect(view?.products.find((row) => row.id === alpha.b)?.reasonCopy).toBeNull();
  });

  it("returns a product to the rule when its decision is cleared", async () => {
    await withTenant(alpha.businessId, () =>
      publication.setProductDecision({
        businessId: alpha.businessId,
        shopId: alpha.shopId,
        productIds: [alpha.b],
        decision: null,
      }),
    );
    expect(among(await feedIds())).toEqual([alpha.a, alpha.b, alpha.c].sort());
    const { rows } = await db.query("SELECT 1 FROM torob_shop_products WHERE shop_id = $1", [alpha.shopId]);
    expect(rows).toHaveLength(0);
  });
});

describe("under the «selected» rule", () => {
  it("publishes exactly the chosen products, and nothing else", async () => {
    await withTenant(alpha.businessId, () =>
      publication.setPublicationRule({ businessId: alpha.businessId, shopId: alpha.shopId, rule: "selected" }),
    );
    try {
      // With nothing chosen the shop publishes nothing — which is what the choice
      // means, not the whole catalogue by accident.
      expect(await feedIds()).toEqual([]);

      await withTenant(alpha.businessId, () =>
        publication.setProductDecision({
          businessId: alpha.businessId,
          shopId: alpha.shopId,
          productIds: [alpha.a, alpha.c],
          decision: "include",
        }),
      );
      expect(among(await feedIds())).toEqual([alpha.a, alpha.c].sort());

      const view = await withTenant(alpha.businessId, () =>
        publication.readShopPublication({ businessId: alpha.businessId, shopId: alpha.shopId }),
      );
      expect(view?.counts).toMatchObject({ total: 4, published: 2, unselected: 2 });
      expect(view?.products.find((row) => row.id === alpha.b)?.state).toBe("unselected");
    } finally {
      await withTenant(alpha.businessId, () =>
        publication.setPublicationRule({ businessId: alpha.businessId, shopId: alpha.shopId, rule: "all" }),
      );
    }
  });

  it("keeps the decisions when the rule changes back, so nothing is lost", async () => {
    // `a` and `c` are still marked `include` after the rule returned to «all».
    expect(among(await feedIds())).toEqual([alpha.a, alpha.b, alpha.c].sort());
    const { rows } = await db.query<{ product_id: string; decision: string }>(
      `SELECT product_id, decision FROM torob_shop_products WHERE shop_id = $1 ORDER BY product_id`,
      [alpha.shopId],
    );
    expect(rows.map((row) => row.decision)).toEqual(["include", "include"]);
    expect(rows.map((row) => row.product_id).sort()).toEqual([alpha.a, alpha.c].sort());
  });
});

describe("isolation and bounds", () => {
  it("refuses a product id from another business, and says how many it refused", async () => {
    const result = await withTenant(alpha.businessId, () =>
      publication.setProductDecision({
        businessId: alpha.businessId,
        shopId: alpha.shopId,
        productIds: [alpha.a, beta.productId],
        decision: "exclude",
      }),
    );
    // The other business's product is never attached; the caller's own one is.
    expect(result).toEqual({ applied: 1, skipped: 1 });
    const { rows } = await db.query("SELECT 1 FROM torob_shop_products WHERE product_id = $1", [beta.productId]);
    expect(rows).toHaveLength(0);

    await withTenant(alpha.businessId, () =>
      publication.setProductDecision({
        businessId: alpha.businessId,
        shopId: alpha.shopId,
        productIds: [alpha.a],
        decision: null,
      }),
    );
  });

  it("refuses a shop id from another business", async () => {
    await expect(
      withTenant(beta.businessId, () =>
        publication.setProductDecision({
          businessId: beta.businessId,
          shopId: alpha.shopId,
          productIds: [beta.productId],
          decision: "include",
        }),
      ),
    ).rejects.toMatchObject({ code: "shop_not_found" });

    const view = await withTenant(beta.businessId, () =>
      publication.readShopPublication({ businessId: beta.businessId, shopId: alpha.shopId }),
    );
    expect(view).toBeNull();
  });

  it("refuses a batch larger than the endpoint accepts", async () => {
    const ids = Array.from({ length: 101 }, () => randomUUID());
    await expect(
      withTenant(alpha.businessId, () =>
        publication.setProductDecision({
          businessId: alpha.businessId,
          shopId: alpha.shopId,
          productIds: ids,
          decision: "include",
        }),
      ),
    ).rejects.toMatchObject({ code: "selection_batch_too_large" });
  });

  it("removes a shop's decisions with the shop, never leaving them behind", async () => {
    const fresh = await seedWoo(alpha.businessId, "https://second.alpha.example");
    const { shop } = await withTenant(alpha.businessId, () =>
      shops.connectTorobShop({ businessId: alpha.businessId, kind: "woocommerce", connectionId: fresh }),
    );
    await withTenant(alpha.businessId, () =>
      publication.setProductDecision({
        businessId: alpha.businessId,
        shopId: shop.id,
        productIds: [alpha.a],
        decision: "include",
        createdBy: null,
      }),
    );
    await db.query("DELETE FROM torob_shops WHERE id = $1", [shop.id]);
    const { rows } = await db.query("SELECT 1 FROM torob_shop_products WHERE shop_id = $1", [shop.id]);
    expect(rows).toHaveLength(0);
  });
});

describe("the screen's read", () => {
  it("reports the same summary the feed preview does", async () => {
    const view = await withTenant(alpha.businessId, () =>
      publication.readShopPublication({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    const preview = await withTenant(alpha.businessId, () =>
      feed.buildShopFeed({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    expect(view?.summary).toEqual(preview.summary);
  });

  it("finds a product by name and pages the list", async () => {
    const found = await withTenant(alpha.businessId, () =>
      publication.readShopPublication({ businessId: alpha.businessId, shopId: alpha.shopId, search: "ب" }),
    );
    expect(found?.page.matching).toBe(1);
    expect(found?.products[0]?.id).toBe(alpha.b);

    const paged = await withTenant(alpha.businessId, () =>
      publication.readShopPublication({ businessId: alpha.businessId, shopId: alpha.shopId, page: 99 }),
    );
    expect(paged?.page.page).toBe(1);
    expect(paged?.page.totalPages).toBe(1);
  });

  it("shows a price that has no exact Toman form as unknown, not rounded", async () => {
    // The Rial storefront holds 100 005 Rial, which has no whole-Toman form. The
    // screen must not round it into a number the shop never charged, and the feed
    // must refuse it for the same reason.
    const view = await withTenant(alpha.businessId, () =>
      publication.readShopPublication({
        businessId: alpha.businessId,
        shopId: alpha.rialShopId,
        search: "ناجور",
      }),
    );
    const row = view?.products.find((product) => product.id === alpha.oddProduct);
    expect(row?.priceToman).toBeNull();
    expect(row?.state).toBe("blocked");
    expect(row?.skipReason).toBe("price_not_whole_toman");
    expect(row?.reasonCopy).toBe(TOROB_FEED_SKIP_COPY.price_not_whole_toman);

    // The very same row is publishable on the Toman storefront, because there the
    // number *is* a whole Toman: the refusal belongs to the shop's currency, not to
    // the product.
    expect(await feedIds(alpha.shopId)).toContain(alpha.oddProduct);
    expect(await feedIds(alpha.rialShopId)).not.toContain(alpha.oddProduct);
  });
});
