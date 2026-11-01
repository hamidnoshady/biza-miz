/**
 * Issue #894 Wave 3 — the Shop Generator approval flow against real Postgres.
 *
 * `shop-generator.test.ts` proves the client speaks Torob's API; this file proves
 * the *row* only moves because Torob said so, and that every way the flow can go
 * wrong leaves the shop in a state a merchant can act on:
 *
 *  - a request leaves the shop `pending_approval` with a stored `approve_url` and
 *    the moment the 15-minute window opened — never `authorized`;
 *  - the code only lands on the shop whose stored `provider_shop_id` the callback
 *    names, so a link for another shop (or another business) resolves to nothing;
 *  - a window that ran out is refused here without being sent to Torob, and the row
 *    says `expired` rather than looking like a network fault;
 *  - a denial is `revoked` with a reason, and an approval replay is a no-op instead
 *    of a second confirm of a spent code;
 *  - the schema itself refuses a `pending_approval` row with no window start, so
 *    the invariant does not depend on this file being the only writer.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let withTenant: typeof import("../src/lib/db").withTenant;
let shops: typeof import("../src/lib/torob/shop-service");
let auth: typeof import("../src/lib/torob/authorization-service");

const ENV = { TOROB_PARTNER_TOKEN: "partner-token" };
const alpha = { businessId: "", wooId: "" };
const beta = { businessId: "", wooId: "", shopId: "" };

/** A provider stand-in: scripted answers, and a record of what was asked. */
const provider = {
  calls: [] as string[],
  /** What `POST /connections/` says. */
  status: "pending" as "pending" | "active",
  /** What `confirm/` says. */
  confirm: "active" as "active" | "pending",
  connectionId: "",
  approveUrl: "https://api.torob.com/shop-panel/shop-connections/x/approve/" as string | null,
};

const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
  const href = String(url);
  provider.calls.push(`${init.method ?? "GET"} ${href}`);
  const body = href.includes("/confirm/")
    ? { connection_id: provider.connectionId, shop_domain: "shop.alpha.example", status: provider.confirm, approve_url: null }
    : {
        connection_id: provider.connectionId,
        shop_domain: "shop.alpha.example",
        status: provider.status,
        approve_url: provider.status === "pending" ? provider.approveUrl : null,
      };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

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

/** A fresh eligible website for alpha, so each case owns its shop. */
let sequence = 0;
async function alphaShop(): Promise<string> {
  sequence += 1;
  const connection = await seedWoo(alpha.businessId, `https://s${sequence}.alpha.example`);
  return shopFor(alpha.businessId, connection);
}

async function shopFor(businessId: string, connectionId: string): Promise<string> {
  const { shop } = await withTenant(businessId, () =>
    shops.connectTorobShop({ businessId, kind: "woocommerce", connectionId }),
  );
  return shop.id;
}

beforeAll(async () => {
  databaseName = `pos_torobauth_${randomUUID().replaceAll("-", "")}`;
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
  auth = await import("../src/lib/torob/authorization-service");

  alpha.businessId = await seedBusiness("آلفا", "torobauth-alpha");
  beta.businessId = await seedBusiness("بتا", "torobauth-beta");
  alpha.wooId = await seedWoo(alpha.businessId, "https://shop.alpha.example");
  beta.wooId = await seedWoo(beta.businessId, "https://shop.beta.example");
  beta.shopId = await shopFor(beta.businessId, beta.wooId);
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
  provider.calls = [];
  provider.status = "pending";
  provider.confirm = "active";
  provider.approveUrl = "https://api.torob.com/shop-panel/shop-connections/x/approve/";
  provider.connectionId = randomUUID();
});

const RETURN_URL = "https://app.alpha.example/api/growth/torob/authorize/callback";

describe("requesting a connection", () => {
  it("leaves the shop pending with the approval page and the window's start", async () => {
    const shopId = await alphaShop();
    const { shop, connection } = await withTenant(alpha.businessId, () =>
      auth.beginPartnerAuthorization({ businessId: alpha.businessId, shopId, returnUrl: RETURN_URL, env: ENV, fetchImpl }),
    );

    expect(connection.status).toBe("pending");
    expect(shop.authorizationState).toBe("pending_approval");
    expect(shop.providerShopId).toBe(provider.connectionId);
    expect(shop.approveUrl).toBe(provider.approveUrl);
    expect(shop.authorizationRequestedAt).not.toBeNull();
    expect(shop.authorizationError).toBeNull();
    // Nothing is published until the merchant approves: `enabled` is still off.
    expect(shop.enabled).toBe(false);
    expect(provider.calls[0]).toMatch(/^POST .*\/connections\/$/);
  });

  it("marks the shop authorized when Torob already has an active connection", async () => {
    provider.status = "active";
    const shopId = await alphaShop();
    const { shop } = await withTenant(alpha.businessId, () =>
      auth.beginPartnerAuthorization({ businessId: alpha.businessId, shopId, returnUrl: RETURN_URL, env: ENV, fetchImpl }),
    );
    expect(shop.authorizationState).toBe("authorized");
    expect(shop.approveUrl).toBeNull();
    expect(shop.authMode).toBe("partner");
  });

  it("records why the request failed and leaves the state alone", async () => {
    const shopId = await alphaShop();
    await expect(
      withTenant(alpha.businessId, () =>
        auth.beginPartnerAuthorization({
          businessId: alpha.businessId,
          shopId,
          returnUrl: RETURN_URL,
          env: {},
          fetchImpl,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(provider.calls).toEqual([]);

    const { rows } = await db.query<{ authorization_state: string; authorization_error: string | null }>(
      `SELECT authorization_state, authorization_error FROM torob_shops WHERE id = $1`,
      [shopId],
    );
    expect(rows[0]).toEqual({ authorization_state: "not_authorized", authorization_error: "not_configured" });
  });
});

describe("confirming the approval", () => {
  /** Begin a real pending approval and return its shop id and connection id. */
  async function pending(): Promise<{ shopId: string; connectionId: string }> {
    const shopId = await alphaShop();
    provider.connectionId = randomUUID();
    await withTenant(alpha.businessId, () =>
      auth.beginPartnerAuthorization({ businessId: alpha.businessId, shopId, returnUrl: RETURN_URL, env: ENV, fetchImpl }),
    );
    provider.calls = [];
    return { shopId, connectionId: provider.connectionId };
  }

  it("turns the shop authorized with Torob's connection id", async () => {
    const { connectionId } = await pending();
    const shop = await withTenant(alpha.businessId, () =>
      auth.completePartnerAuthorization({
        businessId: alpha.businessId,
        connectionId,
        code: "hgx8duhEXiUmcMnxiULEzt-ZccOYFD3pfs-NEXXNeP0",
        env: ENV,
        fetchImpl,
      }),
    );

    expect(shop.authorizationState).toBe("authorized");
    expect(shop.providerShopId).toBe(connectionId);
    expect(shop.approveUrl).toBeNull();
    expect(shop.authorizationRequestedAt).toBeNull();
    expect(provider.calls[0]).toMatch(/\/confirm\/$/);
  });

  it("is a no-op for an approval that already landed", async () => {
    const { connectionId } = await pending();
    const args = {
      businessId: alpha.businessId,
      connectionId,
      code: "code",
      env: ENV,
      fetchImpl,
    };
    await withTenant(alpha.businessId, () => auth.completePartnerAuthorization(args));
    provider.calls = [];

    // A browser refresh replays the callback with a code Torob has already spent.
    const replay = await withTenant(alpha.businessId, () => auth.completePartnerAuthorization(args));
    expect(replay.authorizationState).toBe("authorized");
    expect(provider.calls).toEqual([]);
  });

  it("refuses a connection that is not this business's", async () => {
    const { connectionId } = await pending();
    await expect(
      withTenant(beta.businessId, () =>
        auth.completePartnerAuthorization({
          businessId: beta.businessId,
          connectionId,
          code: "code",
          env: ENV,
          fetchImpl,
        }),
      ),
    ).rejects.toMatchObject({ code: "shop_not_found" });
    expect(provider.calls).toEqual([]);
  });

  it("refuses a code that arrives after the 15 minutes, without asking Torob", async () => {
    const { shopId, connectionId } = await pending();
    await db.query(
      `UPDATE torob_shops SET authorization_requested_at = now() - interval '16 minutes' WHERE id = $1`,
      [shopId],
    );
    provider.calls = [];

    await expect(
      withTenant(alpha.businessId, () =>
        auth.completePartnerAuthorization({
          businessId: alpha.businessId,
          connectionId,
          code: "late",
          env: ENV,
          fetchImpl,
        }),
      ),
    ).rejects.toMatchObject({ code: "code_invalid" });
    expect(provider.calls).toEqual([]);

    const { rows } = await db.query<{ authorization_state: string; authorization_error: string | null }>(
      `SELECT authorization_state, authorization_error FROM torob_shops WHERE id = $1`,
      [shopId],
    );
    expect(rows[0]).toEqual({ authorization_state: "not_authorized", authorization_error: "expired" });
  });

  it("does not claim success when Torob answers something that is not active", async () => {
    const { shopId, connectionId } = await pending();
    provider.confirm = "pending";

    await expect(
      withTenant(alpha.businessId, () =>
        auth.completePartnerAuthorization({
          businessId: alpha.businessId,
          connectionId,
          code: "code",
          env: ENV,
          fetchImpl,
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_error" });

    const { rows } = await db.query<{ authorization_state: string }>(
      `SELECT authorization_state FROM torob_shops WHERE id = $1`,
      [shopId],
    );
    expect(rows[0].authorization_state).toBe("pending_approval");
  });
});

describe("a denial", () => {
  it("revokes with a reason and stops the channel", async () => {
    const shopId = await alphaShop();
    provider.connectionId = randomUUID();
    await withTenant(alpha.businessId, () =>
      auth.beginPartnerAuthorization({ businessId: alpha.businessId, shopId, returnUrl: RETURN_URL, env: ENV, fetchImpl }),
    );

    const shop = await withTenant(alpha.businessId, () =>
      auth.denyPartnerAuthorization({ businessId: alpha.businessId, connectionId: provider.connectionId }),
    );
    expect(shop.authorizationState).toBe("revoked");
    expect(shop.authorizationError).toBe("denied");
    expect(shop.approveUrl).toBeNull();
    expect(shop.enabled).toBe(false);
  });
});

describe("the schema's own invariants", () => {
  it("refuses a pending shop with no window start", async () => {
    // The state may only exist because a request was made at a known moment, and
    // no writer — this service, a migration, the console — may create it without one.
    const shopId = await alphaShop();
    await expect(
      db.query(
        `UPDATE torob_shops
            SET authorization_state = 'pending_approval',
                approve_url = 'https://api.torob.com/approve/'
          WHERE id = $1`,
        [shopId],
      ),
    ).rejects.toThrow(/torob_shops_pending_has_request_time/);
  });

  it("refuses an approval URL on a shop that is not waiting", async () => {
    await expect(
      db.query(`UPDATE torob_shops SET approve_url = 'https://api.torob.com/approve/' WHERE id = $1`, [beta.shopId]),
    ).rejects.toThrow(/torob_shops_approve_url_only_pending/);
  });
});
