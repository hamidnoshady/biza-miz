/**
 * Issue #894 Wave 4b — reading a shop back from Torob, against real Postgres.
 *
 * The unit tests own the wire (`shop-api-client.test.ts`) and the sentences
 * (`observed-state.test.ts`). What only a database can settle is what a read does
 * to the stored state, which is where an "observed" surface starts lying:
 *
 *  - a complete scan replaces the shop's rows, and a product Torob stopped
 *    returning is gone from the snapshot;
 *  - a **truncated** scan deletes nothing, because absence from page 21 of 40
 *    proves nothing;
 *  - a failed read records itself and leaves `observed_at` — and the summary it
 *    belongs to — exactly where it was;
 *  - a channel that is off, unauthorized or without a credential is never read at
 *    all, so a "disconnect" really does stop talking to Torob;
 *  - one tenant cannot observe another's shop, and the screen's cached read
 *    answers for its own business only.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const BASE = "https://torob.test/shop-api/v1/";
const env = { TOROB_SHOP_API_BASE_URL: BASE, INTEGRATIONS_ENCRYPTION_KEY: "ab".repeat(32) } as Record<
  string,
  string | undefined
>;

let databaseName: string;
let db: Client;
let withTenant: typeof import("../src/lib/db").withTenant;
let shops: typeof import("../src/lib/torob/shop-service");
let publication: typeof import("../src/lib/torob/shop-publication");
let status: typeof import("../src/lib/torob/status-service");

const alpha = { businessId: "", wooId: "", shopId: "", a: "", b: "", c: "" };
const beta = { businessId: "", wooId: "", shopId: "", productId: "" };

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
        webhook_secret_ciphertext, currency_unit, sync_products)
     VALUES ($1, $2, $3, 'x', 'x', 'x', 'toman', true) RETURNING id`,
    [businessId, `woo-${baseUrl}`, baseUrl],
  );
  return rows[0].id;
}

async function seedProduct(businessId: string, name: string, price: number): Promise<string> {
  const { rows: loc } = await db.query<{ id: string }>(
    "SELECT id FROM locations WHERE business_id = $1 ORDER BY created_at LIMIT 1",
    [businessId],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, name, price, image_url, is_active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [loc[0].id, name, price, "https://cdn.example.com/p.jpg"],
  );
  return rows[0].id;
}

/** Torob's `GET /shop/` answer, with a summary whose groups add up. */
function shopBody(overrides: Record<string, unknown> = {}) {
  return {
    domain: "shop.alpha.example",
    name: "فروشگاه آلفا",
    shop_status: "active",
    product_summary: {
      calculated_at: "2026-10-07T13:00:00Z",
      total: 3,
      available: 2,
      not_available: 1,
      not_accessible: 0,
      not_active: 0,
      deleted: 0,
      not_accessible_errors: [],
    },
    ...overrides,
  };
}

function productRow(id: string, statuses: string[] = [], errorTitle = "") {
  return {
    product_id: id,
    page_url: `https://shop.alpha.example/product/${id}`,
    statuses,
    price: 100_000,
    availability: !statuses.includes("page_not_available"),
    error_title: errorTitle,
    updated_at: "2026-10-07T08:15:30.120000+00:00",
  };
}

/**
 * A scripted Torob: the shop answer first, then one entry per product page.
 *
 * `calls` is what the assertions inspect — the authorization header proves which
 * credential was used, and its length proves whether the platform called Torob at
 * all for a shop it should have left alone.
 */
function scriptedTorob(options: {
  shop?: Response | (() => Response);
  pages?: (Response | (() => Response))[];
}) {
  const calls: { url: string; headers: Record<string, string>; body: string | null }[] = [];
  const queue: (Response | (() => Response))[] = [
    options.shop ?? (() => jsonResponse(shopBody())),
    ...(options.pages ?? []),
  ];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${String(url)}`);
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A single page carrying every product, so one call is a complete scan. */
function onePage(products: unknown[]) {
  return () => jsonResponse({ previous: null, next: null, results: products });
}

async function observe(overrides: Record<string, unknown> = {}) {
  return withTenant(alpha.businessId, () =>
    status.observeTorobShop({
      businessId: alpha.businessId,
      shopId: alpha.shopId,
      env,
      throttle: { take: async () => {} },
      ...overrides,
    }),
  );
}

async function shopRow() {
  const { rows } = await db.query<{
    observed_status: string | null;
    observed_summary: Record<string, unknown> | null;
    observed_at: Date | null;
    observed_error: string | null;
    health: string;
    health_reason: string | null;
    last_checked_at: Date | null;
  }>(
    `SELECT observed_status, observed_summary, observed_at, observed_error, health, health_reason, last_checked_at
       FROM torob_shops WHERE id = $1`,
    [alpha.shopId],
  );
  return rows[0];
}

async function stateRows() {
  const { rows } = await db.query<{
    page_unique: string;
    product_id: string | null;
    main_status: string | null;
    statuses: string[];
    price_toman: string | null;
    availability: boolean | null;
  }>(
    `SELECT page_unique, product_id, main_status, statuses, price_toman, availability
       FROM torob_product_states WHERE shop_id = $1 ORDER BY page_unique`,
    [alpha.shopId],
  );
  return rows;
}

async function runRows() {
  const { rows } = await db.query<{
    outcome: string;
    shop_status: string | null;
    products_seen: number;
    products_with_problem: number;
    truncated: boolean;
    error: string | null;
  }>(
    `SELECT outcome, shop_status, products_seen, products_with_problem, truncated, error
       FROM torob_status_runs WHERE shop_id = $1 ORDER BY finished_at, started_at`,
    [alpha.shopId],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_torobstatus_${randomUUID().replaceAll("-", "")}`;
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
  status = await import("../src/lib/torob/status-service");

  alpha.businessId = await seedBusiness("آلفا", "torobstatus-alpha");
  beta.businessId = await seedBusiness("بتا", "torobstatus-beta");
  alpha.wooId = await seedWoo(alpha.businessId, "https://shop.alpha.example");
  beta.wooId = await seedWoo(beta.businessId, "https://shop.beta.example");
  beta.productId = await seedProduct(beta.businessId, "کالای بتا", 900_000);

  alpha.a = await seedProduct(alpha.businessId, "الف", 100_000);
  alpha.b = await seedProduct(alpha.businessId, "ب", 200_000);
  alpha.c = await seedProduct(alpha.businessId, "ج", 300_000);

  const { shop } = await withTenant(alpha.businessId, () =>
    shops.connectTorobShop({ businessId: alpha.businessId, kind: "woocommerce", connectionId: alpha.wooId }),
  );
  alpha.shopId = shop.id;
  const other = await withTenant(beta.businessId, () =>
    shops.connectTorobShop({ businessId: beta.businessId, kind: "woocommerce", connectionId: beta.wooId }),
  );
  beta.shopId = other.shop.id;

  // Authorized in partner mode: the platform's generator token does the reading.
  await db.query(
    `UPDATE torob_shops SET authorization_state = 'authorized', provider_shop_id = 'conn-1' WHERE id = ANY($1::uuid[])`,
    [[alpha.shopId, beta.shopId]],
  );
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

describe("a successful read", () => {
  it("stores the shop's own status, summary and the moment it was read", async () => {
    const torob = scriptedTorob({
      pages: [onePage([productRow(alpha.a), productRow(alpha.b, ["page_not_available"]), productRow(alpha.c)])],
    });
    const result = await observe({ fetchImpl: torob.fetchImpl, env: { ...env, TOROB_PARTNER_TOKEN: "partner-token" } });

    if (result.status !== "observed") throw new Error(`expected an observation, got ${result.error}`);
    expect(result.productsSeen).toBe(3);
    expect(result.productsWithProblem).toBe(1);
    expect(result.truncated).toBe(false);

    // The generator token is the credential for a partner-authorized shop, and the
    // shop is named by its domain rather than by an id we made up.
    expect(torob.calls[0].headers.authorization).toBe("Bearer partner-token");
    expect(torob.calls[0].url).toContain("domain=shop.alpha.example");
    expect(torob.calls[1].url).toContain(`domain=shop.alpha.example`);

    const row = await shopRow();
    expect(row.observed_status).toBe("active");
    expect(row.observed_error).toBeNull();
    expect(row.observed_at).not.toBeNull();
    expect(row.health).toBe("healthy");
    expect(row.last_checked_at).not.toBeNull();
    expect((row.observed_summary as { total: number }).total).toBe(3);

    const states = await stateRows();
    expect(states.map((state) => state.page_unique)).toEqual([alpha.a, alpha.b, alpha.c].sort());
    // The catalogue link comes from the page id, so a screen can join the two.
    expect(states.find((state) => state.page_unique === alpha.b)?.product_id).toBe(alpha.b);
    expect(states.find((state) => state.page_unique === alpha.b)?.main_status).toBe("page_not_available");
    expect(states.find((state) => state.page_unique === alpha.a)?.main_status).toBeNull();
    expect(Number(states.find((state) => state.page_unique === alpha.a)?.price_toman)).toBe(100_000);

    const runs = await runRows();
    expect(runs.at(-1)).toMatchObject({ outcome: "observed", shop_status: "active", products_seen: 3 });
  });

  it("shows Torob's own status beside each product on the per-shop screen", async () => {
    const view = await withTenant(alpha.businessId, () =>
      publication.readShopPublication({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    const byId = new Map(view!.products.map((row) => [row.id, row]));
    // A product the merchant publishes and Torob shows as out of stock: two
    // separate facts, side by side, neither overwriting the other.
    expect(byId.get(alpha.b)?.state).toBe("published");
    expect(byId.get(alpha.b)?.torobStatus).toBe("page_not_available");
    expect(byId.get(alpha.a)?.state).toBe("published");
    expect(byId.get(alpha.a)?.torobStatus).toBeNull();
    expect(byId.get(alpha.a)?.torobPages).toBe(1);
  });

  it("answers the panel's read from the platform's tables, and claims a listing only now", async () => {
    const view = await withTenant(alpha.businessId, () =>
      status.readShopObservation({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    expect(view?.observation?.shopStatus).toBe("active");
    expect(view?.observation?.summary.total).toBe(3);
    expect(view?.observation?.error).toBeNull();
    expect(view?.states).toMatchObject({ total: 3, withProblem: 1 });
    expect(view?.states.byStatus).toEqual([{ status: "page_not_available", count: 1 }]);
    expect(view?.latestRun?.outcome).toBe("observed");
    // The three stages: ours, not yet (no webhook), and Torob's own answer.
    expect(view?.capabilities).toEqual({ feed: true, sent: false, listing: true });
  });

  it("drops a page Torob no longer returns, because a complete scan is a snapshot", async () => {
    const torob = scriptedTorob({ pages: [onePage([productRow(alpha.a), productRow(alpha.b)])] });
    await observe({ fetchImpl: torob.fetchImpl, env: { ...env, TOROB_PARTNER_TOKEN: "partner-token" } });

    const states = await stateRows();
    expect(states.map((state) => state.page_unique)).toEqual([alpha.a, alpha.b].sort());
  });

  it("keeps every row when the scan was truncated — absence from page 2 proves nothing", async () => {
    // A complete scan first, so the shop has a row this truncated scan will not
    // mention — the case the rule is about.
    const complete = scriptedTorob({
      pages: [onePage([productRow(alpha.a), productRow(alpha.b), productRow(alpha.c)])],
    });
    await observe({ fetchImpl: complete.fetchImpl, env: { ...env, TOROB_PARTNER_TOKEN: "partner-token" } });
    expect((await stateRows()).map((state) => state.page_unique)).toContain(alpha.c);

    const torob = scriptedTorob({
      pages: [
        () => jsonResponse({ next: `${BASE}products/?cursor=abc`, results: [productRow(alpha.a)] }),
        () => jsonResponse({ next: `${BASE}products/?cursor=def`, results: [productRow(alpha.b)] }),
      ],
    });
    const result = await observe({
      fetchImpl: torob.fetchImpl,
      env: { ...env, TOROB_PARTNER_TOKEN: "partner-token" },
      maxPages: 2,
    });
    expect(result.status === "observed" && result.truncated).toBe(true);

    // `alpha.c` is not in this scan, and is still stored: the scan did not finish.
    const states = await stateRows();
    expect(states.map((state) => state.page_unique)).toContain(alpha.c);
    expect((await runRows()).at(-1)?.truncated).toBe(true);
  });

  it("counts a status this build does not know without inventing one", async () => {
    const torob = scriptedTorob({
      pages: [onePage([productRow(alpha.a, ["page_price_outlier"]), productRow(alpha.b)])],
    });
    const result = await observe({ fetchImpl: torob.fetchImpl, env: { ...env, TOROB_PARTNER_TOKEN: "partner-token" } });
    expect(result.status === "observed" && result.unknownStatuses).toBe(1);

    const states = await stateRows();
    const a = states.find((state) => state.page_unique === alpha.a);
    expect(a?.main_status).toBeNull();
    expect(a?.statuses).toEqual([]);
  });
});

describe("a read that fails", () => {
  it("records the failure and keeps the last good answer and its date", async () => {
    const before = await shopRow();
    const torob = scriptedTorob({ shop: () => jsonResponse({ detail: "Unauthorized" }, 401) });
    const result = await observe({ fetchImpl: torob.fetchImpl, env: { ...env, TOROB_PARTNER_TOKEN: "partner-token" } });

    expect(result).toMatchObject({ status: "failed", error: "unauthorized" });
    // Only the shop call happened: once the credential is refused there is
    // nothing to ask about products.
    expect(torob.calls).toHaveLength(1);

    const after = await shopRow();
    expect(after.observed_error).toBe("unauthorized");
    // The summary belongs to the success it came from, so its timestamp does not move.
    expect(after.observed_at?.toISOString()).toBe(before.observed_at?.toISOString());
    expect((after.observed_summary as { total: number }).total).toBe(3);
    expect(after.health).toBe("attention");
    expect(after.health_reason).toBe("unauthorized");

    const runs = await runRows();
    expect(runs.at(-1)).toMatchObject({ outcome: "failed", error: "unauthorized", products_seen: 0 });
  });

  it("clears the failure on the next success", async () => {
    const torob = scriptedTorob({ pages: [onePage([productRow(alpha.a)])] });
    await observe({ fetchImpl: torob.fetchImpl, env: { ...env, TOROB_PARTNER_TOKEN: "partner-token" } });
    const row = await shopRow();
    expect(row.observed_error).toBeNull();
    expect(row.health).toBe("healthy");
    expect(row.health_reason).toBeNull();
  });
});

describe("a shop that must not be read", () => {
  it("does not call Torob at all when the channel is off", async () => {
    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: false }),
    );
    try {
      const torob = scriptedTorob({});
      const result = await observe({ fetchImpl: torob.fetchImpl, env: { ...env, TOROB_PARTNER_TOKEN: "partner-token" } });
      expect(result).toMatchObject({ status: "failed", error: "channel_disabled" });
      expect(torob.calls).toHaveLength(0);
    } finally {
      await withTenant(alpha.businessId, () =>
        shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: true }),
      );
    }
  });

  it("does not call Torob for a shop that is not authorized", async () => {
    await db.query(`UPDATE torob_shops SET authorization_state = 'not_authorized', provider_shop_id = NULL WHERE id = $1`, [
      alpha.shopId,
    ]);
    try {
      const torob = scriptedTorob({});
      const result = await observe({ fetchImpl: torob.fetchImpl, env: { ...env, TOROB_PARTNER_TOKEN: "partner-token" } });
      expect(result).toMatchObject({ status: "failed", error: "not_authorized" });
      expect(torob.calls).toHaveLength(0);
    } finally {
      await db.query(`UPDATE torob_shops SET authorization_state = 'authorized', provider_shop_id = 'conn-1' WHERE id = $1`, [
        alpha.shopId,
      ]);
    }
  });

  it("reports a missing credential as not_configured rather than as Torob's fault", async () => {
    const torob = scriptedTorob({});
    // No partner token in this deployment, and a partner-authorized shop has none
    // of its own: the platform cannot read anything, and says so.
    const result = await observe({ fetchImpl: torob.fetchImpl, env });
    expect(result).toMatchObject({ status: "failed", error: "not_configured" });
    expect(torob.calls).toHaveLength(0);
  });

  it("reports a shop that has never been read as never read, not as empty", async () => {
    const view = await withTenant(beta.businessId, () =>
      status.readShopObservation({ businessId: beta.businessId, shopId: beta.shopId }),
    );
    // Never observed: an absent observation, not an empty summary, and no claim of
    // a listing.
    expect(view?.observation).toBeNull();
    expect(view?.capabilities.listing).toBe(false);
    expect(view?.states.total).toBe(0);
  });

  it("refuses another business's shop", async () => {
    await expect(
      withTenant(beta.businessId, () =>
        status.observeTorobShop({
          businessId: beta.businessId,
          shopId: alpha.shopId,
          env: { ...env, TOROB_PARTNER_TOKEN: "partner-token" },
          throttle: { take: async () => {} },
        }),
      ),
    ).rejects.toMatchObject({ code: "shop_not_found" });

    const view = await withTenant(beta.businessId, () =>
      status.readShopObservation({ businessId: beta.businessId, shopId: alpha.shopId }),
    );
    expect(view).toBeNull();
  });
});

describe("the merchant's own token", () => {
  it("is what reads a manually authorized shop, and it never reaches the database in clear", async () => {
    const token = "merchant-token-0123456789";
    await withTenant(alpha.businessId, () =>
      shops.authorizeTorobShopWithToken({ businessId: alpha.businessId, shopId: alpha.shopId, token }),
    );

    const torob = scriptedTorob({ pages: [onePage([productRow(alpha.a)])] });
    const result = await observe({ fetchImpl: torob.fetchImpl, env });
    expect(result.status).toBe("observed");
    expect(torob.calls[0].headers.authorization).toBe(`Bearer ${token}`);
    // Manual mode needs no partner token, which is the point of the fallback.
    expect(torob.calls[0].url).not.toContain(token);

    const { rows } = await db.query<{ token_ciphertext: string | null; token_hint: string | null }>(
      "SELECT token_ciphertext, token_hint FROM torob_shops WHERE id = $1",
      [alpha.shopId],
    );
    expect(rows[0].token_ciphertext).not.toBeNull();
    expect(rows[0].token_ciphertext).not.toContain(token);
    expect(rows[0].token_hint).toBe("6789");
  });
});
