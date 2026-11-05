/**
 * Issue #894 Wave 6 — the failure drills, against a real database.
 *
 * The epic's acceptance criteria end with a sentence that is easy to implement and
 * hard to prove: *"Disabling/disconnecting a website stops managed operations safely
 * without deleting its external shop; recovery is idempotent."* Every clause of it is
 * one lost row or one duplicated announcement away from being false, and each of the
 * four failure classes the channel can hit arrives through a different door:
 *
 * | drill | door | what must be true afterwards |
 * | --- | --- | --- |
 * | expired / wrong-audience token | the crawler's own JWT | 401 with the claim that failed, and no catalogue read |
 * | rejected domain | the Shop API's 403 | the shop's `health` says attention, the last good observation stays |
 * | feed refused | our own publication rules | the crawler answers 404 and the queue does not send |
 * | shop deleted on Torob's side | the Shop API's `shop_not_active` | the page is dead-lettered, the shop is still here |
 * | disconnect → reconnect | our own switch | nothing sent while off, **nothing duplicated** when back on |
 *
 * The last row is the one no unit test can hold: idempotent recovery means the outbox
 * rows are the same rows, the second drain sends each page once, and the shop row was
 * never deleted — so a merchant who flips the switch twice costs Torob one request,
 * not two.
 */
import { randomUUID } from "node:crypto";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const SHOP_API = "https://torob.test/shop-api/v1/";
const WEBHOOK = "https://torob.test/update/webhook/v1/";
const env = {
  TOROB_SHOP_API_BASE_URL: SHOP_API,
  TOROB_WEBHOOK_URL: WEBHOOK,
  TOROB_PARTNER_TOKEN: "partner-token",
  TOROB_WEBHOOK_TOKEN: "webhook-token",
  INTEGRATIONS_ENCRYPTION_KEY: "ef".repeat(32),
} as Record<string, string | undefined>;

let databaseName: string;
let db: Client;
let withTenant: typeof import("../src/lib/db").withTenant;
let shops: typeof import("../src/lib/torob/shop-service");
let status: typeof import("../src/lib/torob/status-service");
let webhook: typeof import("../src/lib/torob/webhook-service");
let api: typeof import("../src/lib/torob/product-api");
let privateKey: CryptoKey;

const alpha = { businessId: "", wooId: "", shopId: "", domain: "shop.alpha.example", a: "", b: "" };

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
        webhook_secret_ciphertext, currency_unit, sync_products, provider)
     VALUES ($1, $2, $3, 'x', 'x', 'x', 'toman', true, 'woocommerce') RETURNING id`,
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
    name: "فروشگاه آلفا",
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

function productRow(domain: string, id: string) {
  return {
    product_id: id,
    page_url: `https://${domain}/product/${id}`,
    statuses: [],
    price: 100_000,
    availability: true,
    error_title: "",
    updated_at: "2026-10-07T08:15:30+00:00",
  };
}

/** A Torob that answers by route, so a drill can make one door fail and no other. */
function torobFake(options: { shopApi?: Response; webhook?: Response } = {}) {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, method: String(init?.method ?? "GET"), body: typeof init?.body === "string" ? init.body : null });
    if (target.includes("/update/webhook/v1/")) return options.webhook ?? jsonResponse({ message: "success" });
    if (target.includes("/products/")) {
      return jsonResponse({ previous: null, next: null, results: [productRow(alpha.domain, alpha.a), productRow(alpha.domain, alpha.b)] });
    }
    if (target.includes("/shop/")) return options.shopApi ?? jsonResponse(shopBody(alpha.domain));
    throw new Error(`unexpected request to ${target}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function shopState() {
  const { rows } = await db.query<{
    health: string;
    health_reason: string | null;
    observed_at: Date | null;
    observed_error: string | null;
    observed_status: string | null;
    enabled: boolean;
    authorization_state: string;
  }>(
    `SELECT health, health_reason, observed_at, observed_error, observed_status, enabled, authorization_state
       FROM torob_shops WHERE id = $1`,
    [alpha.shopId],
  );
  return rows[0];
}

async function outboxRows() {
  const { rows } = await db.query<{ id: string; page_unique: string; state: string; attempts: number }>(
    `SELECT id, page_unique, state, attempts FROM torob_webhook_outbox
      WHERE shop_id = $1 ORDER BY page_unique`,
    [alpha.shopId],
  );
  return rows;
}

async function torobToken(audience: string, options: { expiresIn?: number; notBefore?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  let builder = new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", v: 1 })
    .setIssuedAt(now)
    .setAudience(audience)
    .setExpirationTime(now + (options.expiresIn ?? 300));
  if (options.notBefore !== undefined) builder = builder.setNotBefore(options.notBefore);
  return builder.sign(privateKey);
}

async function crawl(body: unknown, options: { aud?: string; token?: string | null } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.token !== null) {
    headers.set("x-torob-token", options.token ?? (await torobToken(options.aud ?? alpha.domain)));
    headers.set("x-torob-token-version", "1");
  }
  return api.handleTorobProductRequest({
    shopId: alpha.shopId,
    headers,
    rawBody: JSON.stringify(body),
  });
}

beforeAll(async () => {
  databaseName = `pos_torobdrills_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "ef".repeat(32);

  const pair = await generateKeyPair("EdDSA");
  privateKey = pair.privateKey;
  process.env.TOROB_API_PUBLIC_KEY = await exportSPKI(pair.publicKey);

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  ({ withTenant } = await import("../src/lib/db"));
  shops = await import("../src/lib/torob/shop-service");
  status = await import("../src/lib/torob/status-service");
  webhook = await import("../src/lib/torob/webhook-service");
  api = await import("../src/lib/torob/product-api");

  alpha.businessId = await seedBusiness("آلفا", "torobdrills-alpha");
  alpha.wooId = await seedWoo(alpha.businessId, `https://${alpha.domain}`);
  alpha.a = await seedProduct(alpha.businessId, "الف", 100_000);
  alpha.b = await seedProduct(alpha.businessId, "ب", 200_000);

  const { shop } = await withTenant(alpha.businessId, () =>
    shops.connectTorobShop({ businessId: alpha.businessId, kind: "woocommerce", connectionId: alpha.wooId }),
  );
  alpha.shopId = shop.id;
  await db.query(
    `UPDATE torob_shops SET authorization_state = 'authorized', provider_shop_id = 'conn-1' WHERE id = $1`,
    [alpha.shopId],
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

// Every drill is its own scenario, so the crawler's per-shop rate window starts
// empty for each one: the 429 lane has its own tests, and folding it into these
// would hide the status the drill is actually about.
beforeEach(() => {
  api.resetTorobShopWindows();
});

describe("a token that cannot open the shop", () => {
  it("refuses an expired, not-yet-valid, wrong-audience or missing token — and says which", async () => {
    const now = Math.floor(Date.now() / 1000);

    const expired = await crawl({ page: 1, sort: "date_added_desc" }, { token: await torobToken(alpha.domain, { expiresIn: -60 }) });
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual({ error: "unauthorized: expired" });

    const early = await crawl({ page: 1, sort: "date_added_desc" }, { token: await torobToken(alpha.domain, { notBefore: now + 600 }) });
    expect(early.status).toBe(401);
    expect(early.body).toEqual({ error: "unauthorized: not_yet_valid" });

    // A token minted for another shop is the failure the audience check exists for:
    // it must not open this one, and it must say so rather than "invalid".
    const wrongShop = await crawl({ page: 1, sort: "date_added_desc" }, { aud: "shop.other.example" });
    expect(wrongShop.status).toBe(401);
    expect(wrongShop.body).toEqual({ error: "unauthorized: audience_mismatch" });

    const anonymous = await crawl({ page: 1, sort: "date_added_desc" }, { token: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ error: "unauthorized: missing_token" });

    // The door stays shut for a *valid* token in the same shape, which is what makes
    // the four above evidence about the claims rather than about the shop.
    const good = await crawl({ page: 1, sort: "date_added_desc" });
    expect(good.status).toBe(200);
  });

  it("refuses a malformed body only after the token, so an anonymous caller learns nothing", async () => {
    const anonymous = await crawl({ nonsense: true }, { token: null });
    expect(anonymous).toMatchObject({ status: 401 });

    const authenticated = await crawl({ nonsense: true });
    expect(authenticated.status).toBe(400);
    // Torob's own sentence for a body that names no mode — never a defaulted page 1.
    expect(authenticated.body).toEqual({ error: "request body is empty: send page_urls, page_uniques, page, or cursor" });
  });
});

describe("a domain Torob rejects", () => {
  it("records the failure, moves health to attention, and keeps the last good observation", async () => {
    const before = await shopState();
    expect(before.observed_at).toBeNull();

    // First a good read, so there is something to keep.
    const good = torobFake();
    const observed = await withTenant(alpha.businessId, () =>
      status.observeTorobShop({ businessId: alpha.businessId, shopId: alpha.shopId, env, fetchImpl: good.fetchImpl }),
    );
    expect(observed.status).toBe("observed");
    const afterGood = await shopState();
    expect(afterGood.health).toBe("healthy");

    // Then Torob refuses the domain — the documented `403 Shop domain does not match
    // the credentials given`.
    const refusing = torobFake({ shopApi: jsonResponse({ error: "Shop domain does not match" }, 403) });
    const failed = await withTenant(alpha.businessId, () =>
      status.observeTorobShop({ businessId: alpha.businessId, shopId: alpha.shopId, env, fetchImpl: refusing.fetchImpl }),
    );
    expect(failed.status).toBe("failed");

    const afterFailure = await shopState();
    expect(afterFailure.health).toBe("attention");
    expect(afterFailure.observed_error).not.toBeNull();
    // The snapshot does not move: the summary it belongs to is still what Torob last
    // said, and the screen shows that date beside the failure.
    expect(afterFailure.observed_at?.toISOString()).toBe(afterGood.observed_at?.toISOString());
    expect(afterFailure.observed_status).toBe("active");
  });
});

describe("a feed we refuse to serve", () => {
  it("answers 404 while the channel is off, and the queue sends nothing", async () => {
    // Fill the queue while the channel is on, so "nothing sent" is a real choice
    // rather than an empty queue.
    await withTenant(alpha.businessId, () => webhook.enqueueChangedPages({ businessId: alpha.businessId, shopId: alpha.shopId }));
    const queued = await outboxRows();
    expect(queued.length).toBeGreaterThan(0);

    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: false }),
    );

    const refused = await crawl({ page: 1, sort: "date_added_desc" });
    // Indistinguishable from an unknown shop: one that may not be served must not be
    // discoverable through the crawler.
    expect(refused).toEqual({ status: 404, body: { error: "not_found" } });

    const torob = torobFake();
    const drain = await withTenant(alpha.businessId, () =>
      webhook.drainWebhookQueue({ businessId: alpha.businessId, shopId: alpha.shopId, env, fetchImpl: torob.fetchImpl }),
    );
    expect(drain.stoppedBy).not.toBeNull();
    expect(drain.accepted).toBe(0);
    expect(torob.calls).toHaveLength(0);
    expect((await outboxRows()).map((row) => row.state)).toEqual(queued.map((row) => row.state));
  });
});

describe("a shop Torob has deleted", () => {
  it("dead-letters the page and flags a human, without deleting our shop", async () => {
    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: true }),
    );

    const torob = torobFake({ webhook: jsonResponse({ error: "shop is not active" }, 403) });
    const drain = await withTenant(alpha.businessId, () =>
      webhook.drainWebhookQueue({ businessId: alpha.businessId, shopId: alpha.shopId, env, fetchImpl: torob.fetchImpl }),
    );

    expect(drain.deadLettered).toBeGreaterThan(0);
    expect(torob.calls.some((call) => call.url.includes("/update/webhook/v1/"))).toBe(true);

    // A shop that Torob no longer knows is a state a human has to fix — retrying the
    // same body forever would spend the shop's rate budget on a refusal.
    const state = await shopState();
    expect(state.health).toBe("attention");
    expect((await outboxRows()).every((row) => row.state === "sent" || row.state === "dead")).toBe(true);

    // And our row survives: disconnect never means delete.
    const { rows } = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM torob_shops WHERE id = $1", [
      alpha.shopId,
    ]);
    expect(rows[0].count).toBe("1");
  });
});

describe("disconnect and reconnect", () => {
  it("sends nothing while off, and announces each page once when the switch goes back on", async () => {
    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: false }),
    );

    const off = torobFake();
    await withTenant(alpha.businessId, () =>
      webhook.drainWebhookQueue({ businessId: alpha.businessId, shopId: alpha.shopId, env, fetchImpl: off.fetchImpl }),
    );
    expect(off.calls).toHaveLength(0);

    // Revive the dead rows the Torob-side deletion left behind, then reconnect: the
    // recovery has to clean up after the failure, not start a second queue.
    await withTenant(alpha.businessId, () => webhook.retryDeadPages({ businessId: alpha.businessId, shopId: alpha.shopId }));
    const before = await outboxRows();

    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: true }),
    );
    const fill = await withTenant(alpha.businessId, () =>
      webhook.enqueueChangedPages({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    // Filling again re-arms the same rows: one row per page, never a second queue.
    expect(fill.queued).toBe(0);
    expect(await outboxRows()).toHaveLength(before.length);

    const on = torobFake();
    const drain = await withTenant(alpha.businessId, () =>
      webhook.drainWebhookQueue({ businessId: alpha.businessId, shopId: alpha.shopId, env, fetchImpl: on.fetchImpl }),
    );
    const webhookCalls = on.calls.filter((call) => call.url.includes("/update/webhook/v1/"));
    expect(webhookCalls.length).toBeGreaterThan(0);

    // Each page announced once, whatever the batching: no page id appears in two
    // requests, which is what "idempotent recovery" has to mean for a merchant who
    // flips the switch twice.
    const announced = webhookCalls.flatMap(
      (call) => (JSON.parse(String(call.body)) as { items: { page_unique: string }[] }).items.map((item) => item.page_unique),
    );
    expect(new Set(announced).size).toBe(announced.length);
    expect(new Set(announced)).toEqual(new Set(await outboxRows().then((rows) => rows.map((row) => row.page_unique))));
    expect(drain.stoppedBy).toBeNull();
  });
});
