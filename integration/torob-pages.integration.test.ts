/**
 * Issue #894 Wave 5c — switching a page on or off **on Torob**, and «تعمیر».
 *
 * These two actions are the only places in the feature where our side changes what
 * a shopper sees, so the tests are about what must *not* happen:
 *
 *  - a shop that is switched off, unauthorized or without a credential is never
 *    asked to change anything, and nothing reaches the network;
 *  - an id Torob did not confirm is reported as not acted on, never counted as a
 *    success because the request itself succeeded;
 *  - our copy of the page's state is not rewritten from the answer — the next read
 *    is what may change it, so `torob_product_states` stays a record of what Torob
 *    said rather than a prediction;
 *  - one tenant cannot switch another's pages;
 *  - «تعمیر» runs announce → tell → read, in that order, and reports each step.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const SHOP_API = "https://torob.test/shop-api/v1/";
const WEBHOOK = "https://torob.test/update/webhook/v1/";
const env = {
  TOROB_SHOP_API_BASE_URL: SHOP_API,
  TOROB_WEBHOOK_URL: WEBHOOK,
  INTEGRATIONS_ENCRYPTION_KEY: "cd".repeat(32),
} as Record<string, string | undefined>;

/** Partner mode: the platform's own token authenticates a partner-authorized shop. */
const authedEnv = { ...env, TOROB_PARTNER_TOKEN: "partner-token" };

let databaseName: string;
let db: Client;
let withTenant: typeof import("../src/lib/db").withTenant;
let shops: typeof import("../src/lib/torob/shop-service");
let status: typeof import("../src/lib/torob/status-service");

const alpha = { businessId: "", wooId: "", shopId: "", a: "", b: "" };
const beta = { businessId: "", wooId: "", shopId: "" };

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function shopBody(domain: string) {
  return {
    domain,
    name: "فروشگاه نمونه",
    shop_status: "active",
    product_summary: {
      calculated_at: "2026-10-07T13:00:00Z",
      total: 2,
      available: 1,
      not_available: 1,
      not_accessible: 0,
      not_active: 0,
      deleted: 0,
      not_accessible_errors: [],
    },
  };
}

function productRow(domain: string, id: string, statuses: string[] = []) {
  return {
    product_id: id,
    page_url: `https://${domain}/product/${id}`,
    statuses,
    price: 100_000,
    availability: !statuses.includes("page_not_available"),
    error_title: "",
    updated_at: "2026-10-07T08:15:30+00:00",
  };
}

/**
 * A Torob that answers by route instead of by queue, because «تعمیر» makes several
 * different calls and the order is one of the things under test.
 */
function torobFake(options: { toggleFound?: (id: string) => boolean } = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({
      url: target,
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });

    if (target.includes("/products/activate/") || target.includes("/products/deactivate/")) {
      const sent = (JSON.parse(body ?? "{}") as { product_ids?: string[] }).product_ids ?? [];
      return jsonResponse({
        results: sent.map((id) => ({ product_id: id, found: options.toggleFound ? options.toggleFound(id) : true })),
      });
    }
    if (target.includes("/update/webhook/v1/")) {
      return jsonResponse({ message: "success" });
    }
    if (target.includes("/products/")) {
      return jsonResponse({
        previous: null,
        next: null,
        results: [productRow("shop.alpha.example", alpha.a), productRow("shop.alpha.example", alpha.b, ["page_not_active"])],
      });
    }
    if (target.includes("/shop/")) {
      return jsonResponse(shopBody("shop.alpha.example"));
    }
    throw new Error(`unexpected request to ${target}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function toggle(
  pageUniques: string[],
  active: boolean,
  fetchImpl: typeof fetch,
  useEnv: Record<string, string | undefined> = authedEnv,
) {
  return withTenant(alpha.businessId, () =>
    status.setPagesOnTorob({
      businessId: alpha.businessId,
      shopId: alpha.shopId,
      pageUniques,
      active,
      env: useEnv,
      fetchImpl,
    }),
  );
}

async function stateRows() {
  const { rows } = await db.query<{ page_unique: string; main_status: string | null }>(
    `SELECT page_unique, main_status FROM torob_product_states WHERE shop_id = $1 ORDER BY page_unique`,
    [alpha.shopId],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_torobpages_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "cd".repeat(32);

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  ({ withTenant } = await import("../src/lib/db"));
  shops = await import("../src/lib/torob/shop-service");
  status = await import("../src/lib/torob/status-service");

  alpha.businessId = await seedBusiness("آلفا", "torobpages-alpha");
  beta.businessId = await seedBusiness("بتا", "torobpages-beta");
  alpha.wooId = await seedWoo(alpha.businessId, "https://shop.alpha.example");
  beta.wooId = await seedWoo(beta.businessId, "https://shop.beta.example");
  alpha.a = await seedProduct(alpha.businessId, "الف", 100_000);
  alpha.b = await seedProduct(alpha.businessId, "ب", 200_000);

  const { shop } = await withTenant(alpha.businessId, () =>
    shops.connectTorobShop({ businessId: alpha.businessId, kind: "woocommerce", connectionId: alpha.wooId }),
  );
  alpha.shopId = shop.id;
  const other = await withTenant(beta.businessId, () =>
    shops.connectTorobShop({ businessId: beta.businessId, kind: "woocommerce", connectionId: beta.wooId }),
  );
  beta.shopId = other.shop.id;

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

describe("switching pages on Torob", () => {
  it("sends the shop's domain and the ids, and reports what Torob confirmed", async () => {
    const torob = torobFake({ toggleFound: (id) => id === alpha.a });
    // A partner token covers a partner-authorized shop, so no per-shop credential
    // is needed for this to work at all.
    const result = await toggle([alpha.a, alpha.b], false, torob.fetchImpl);

    expect(result).toEqual({ status: "applied", found: [alpha.a], missing: [alpha.b] });
    expect(torob.calls).toHaveLength(1);
    expect(torob.calls[0].method).toBe("POST");
    expect(torob.calls[0].url).toBe(`${SHOP_API}products/deactivate/?domain=shop.alpha.example`);
    expect(JSON.parse(String(torob.calls[0].body))).toEqual({ product_ids: [alpha.a, alpha.b] });
    // The deployment's partner token is what authenticates the shop when the
    // platform was the one that connected it.
    expect(torob.calls[0].headers.authorization).toBe("Bearer partner-token");
  });

  it("does not rewrite our snapshot from Torob's answer", async () => {
    // `torob_product_states` is what Torob said on the last read. A deactivate that
    // wrote `page_not_active` here would make the screen show a state only our own
    // request claims; the next read is what must be allowed to change it.
    const torob = torobFake();
    const result = await toggle([alpha.a], false, torob.fetchImpl);
    expect(result).toEqual({ status: "applied", found: [alpha.a], missing: [] });
    expect(torob.calls).toHaveLength(1);
    const rows = await stateRows();
    expect(rows).toEqual([]);
  });

  it("refuses a shop that is switched off, unauthorized or without a credential, without a request", async () => {
    const torob = torobFake();
    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: false }),
    );
    expect(await toggle([alpha.a], false, torob.fetchImpl)).toEqual({
      status: "blocked",
      error: "channel_disabled",
    });

    await db.query(`UPDATE torob_shops SET authorization_state = 'revoked' WHERE id = $1`, [alpha.shopId]);
    expect(await toggle([alpha.a], false, torob.fetchImpl)).toEqual({
      status: "blocked",
      error: "not_authorized",
    });

    // Authorized and switched on, but nothing to authenticate with: still nothing
    // is sent, because a request Torob will reject costs the shop's rate budget.
    await db.query(`UPDATE torob_shops SET authorization_state = 'authorized' WHERE id = $1`, [alpha.shopId]);
    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: true }),
    );
    await db.query(`UPDATE torob_shops SET token_ciphertext = NULL WHERE id = $1`, [alpha.shopId]);
    expect(await toggle([alpha.a], false, torob.fetchImpl, env)).toEqual({
      status: "blocked",
      error: "not_configured",
    });

    expect(torob.calls).toHaveLength(0);
  });

  it("will not switch another tenant's pages", async () => {
    const torob = torobFake();
    await expect(
      withTenant(beta.businessId, () =>
        status.setPagesOnTorob({
          businessId: beta.businessId,
          shopId: alpha.shopId,
          pageUniques: [alpha.a],
          active: false,
          env,
          fetchImpl: torob.fetchImpl,
        }),
      ),
    ).rejects.toMatchObject({ code: "shop_not_found" });
    expect(torob.calls).toHaveLength(0);
  });
});

describe("«تعمیر»", () => {
  it("announces, tells Torob, then reads Torob back — in that order", async () => {
    const torob = torobFake();
    const result = await withTenant(alpha.businessId, () =>
      status.repairShop({
        businessId: alpha.businessId,
        shopId: alpha.shopId,
        env: { ...authedEnv, TOROB_WEBHOOK_TOKEN: "webhook-token" },
        fetchImpl: torob.fetchImpl,
      }),
    );

    expect(result.fill.queued).toBeGreaterThan(0);
    expect(result.drain?.stoppedBy).toBeNull();
    expect(result.drain?.accepted).toBeGreaterThan(0);
    expect(result.observe.status).toBe("observed");

    // Order, not just presence: the webhook is the middle step, and the read comes
    // after it so the merchant sees Torob's answer to what was just announced.
    const kinds = torob.calls.map((call) =>
      call.url.includes("/update/webhook/v1/") ? "webhook" : call.url.includes("/products/") ? "read" : "shop",
    );
    const announced = kinds.indexOf("webhook");
    expect(announced).toBeGreaterThanOrEqual(0);
    // Nothing is read before Torob has been told: a read first would show the
    // merchant yesterday's view of the shop they are repairing.
    expect(kinds.slice(0, announced)).not.toContain("shop");
    expect(kinds.slice(0, announced)).not.toContain("read");
    expect(kinds.indexOf("shop")).toBeGreaterThan(announced);
    expect(kinds.lastIndexOf("read")).toBeGreaterThan(announced);
  });

  it("reports a switched-off channel as stopped rather than sending", async () => {
    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: false }),
    );
    const torob = torobFake();
    const result = await withTenant(alpha.businessId, () =>
      status.repairShop({
        businessId: alpha.businessId,
        shopId: alpha.shopId,
        env: { ...authedEnv, TOROB_WEBHOOK_TOKEN: "webhook-token" },
        fetchImpl: torob.fetchImpl,
      }),
    );
    expect(result.drain?.stoppedBy).not.toBeNull();
    expect(torob.calls.some((call) => call.url.includes("/update/webhook/v1/"))).toBe(false);

    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: true }),
    );
  });
});
