/**
 * Issue #894 Wave 1 — the Torob foundation, against real Postgres.
 *
 * The unit tests beside `eligibility.ts` decide which website *may* enroll; this
 * file proves the half that needs a database, and each case is one way a channel
 * integration goes wrong in the field:
 *
 *  - a connection id from a request is a **claim**: one business can never enroll
 *    (or revoke, or switch) another business's website or shop, even holding the
 *    real uuid. `tenant-isolation.integration.test.ts` proves the table's policy
 *    generically; this proves the service never leans on it alone.
 *  - connecting twice is one shop, because a double-click must not mint a second
 *    Torob registration.
 *  - a shop that says `authorized` has a credential, and one that says `revoked`
 *    does not: the CHECK is the backstop for a state machine that drifts.
 *  - disconnecting stops the work and keeps the registration — the issue is
 *    explicit that a merchant's Torob shop is never deleted by a switch.
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
let torob: typeof import("../src/lib/torob/shop-service");

const alpha = { businessId: "", wooId: "", activeWooId: "", cmsId: "" };
const beta = { businessId: "", wooId: "" };

const TOKEN = "torob_live_abcdefghijklmnop1234";

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
  return rows[0].id;
}

/** A live WooCommerce connection, as the connections screen would leave it. */
async function seedWoo(
  businessId: string,
  baseUrl: string,
  options: { status?: "active" | "paused" | "error"; syncProducts?: boolean } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, name, base_url, consumer_key_ciphertext, consumer_secret_ciphertext,
        webhook_secret_ciphertext, status, sync_products)
     VALUES ($1, $2, $3, 'x', 'x', 'x', $4, $5) RETURNING id`,
    [businessId, `woo-${baseUrl}`, baseUrl, options.status ?? "active", options.syncProducts ?? true],
  );
  return rows[0].id;
}

async function seedCms(businessId: string, siteDomain: string, status: "active" | "disabled" = "active"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO eshobe_cms_connections (business_id, site_id, site_domain, base_url, api_key_ciphertext, status)
     VALUES ($1, $2, $3, 'https://cms.example.com', 'x', $4) RETURNING id`,
    [businessId, randomUUID(), siteDomain, status],
  );
  return rows[0].id;
}

beforeAll(async () => {
  databaseName = `pos_torob_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  // Deterministic realm key: the shop's token is encrypted with it, and the test
  // asserts the round-trip as well as the columns that must never hold it.
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "ab".repeat(32);

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  ({ withTenant } = await import("../src/lib/db"));
  torob = await import("../src/lib/torob/shop-service");

  alpha.businessId = await seedBusiness("آلفا", "torob-alpha");
  beta.businessId = await seedBusiness("بتا", "torob-beta");

  alpha.activeWooId = await seedWoo(alpha.businessId, "https://shop.alpha.example/", { syncProducts: true });
  alpha.wooId = await seedWoo(alpha.businessId, "https://paused.alpha.example", { status: "paused" });
  alpha.cmsId = await seedCms(alpha.businessId, "www.alpha.example");
  beta.wooId = await seedWoo(beta.businessId, "https://shop.beta.example");
}, 180_000);

afterAll(async () => {
  // Close the pooled pool before dropping the database: an idle pooled
  // connection would otherwise log a termination error as the test ends.
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

describe("the registries the platform already owns", () => {
  it("lists only this business's websites, from both registries", async () => {
    const websites = await withTenant(alpha.businessId, () => torob.listManagedWebsites(alpha.businessId));
    const keys = websites.map((website) => `${website.kind}:${website.connectionId}`).sort();
    expect(keys).toEqual(
      [
        `woocommerce:${alpha.activeWooId}`,
        `woocommerce:${alpha.wooId}`,
        `eshobe_cms:${alpha.cmsId}`,
      ].sort(),
    );
    // Nothing of beta's, even though its connection is equally live.
    expect(keys).not.toContain(`woocommerce:${beta.wooId}`);
  });

  it("normalises the host each registry stores, its own way", async () => {
    const websites = await withTenant(alpha.businessId, () => torob.listManagedWebsites(alpha.businessId));
    const byId = new Map(websites.map((website) => [website.connectionId, website]));
    // WooCommerce stores a full base_url with a trailing slash; Eshobe a bare domain.
    expect(byId.get(alpha.activeWooId)?.domain).toBe("shop.alpha.example");
    expect(byId.get(alpha.cmsId)?.domain).toBe("www.alpha.example");
  });

  it("states, per website, whether a catalogue is ready and what pauses it", async () => {
    const websites = await withTenant(alpha.businessId, () => torob.listManagedWebsites(alpha.businessId));
    const byId = new Map(websites.map((website) => [website.connectionId, website]));
    expect(byId.get(alpha.activeWooId)?.connection).toMatchObject({ active: true, catalogueReady: true });
    expect(byId.get(alpha.wooId)?.connection).toMatchObject({ active: false, catalogueReady: false });
    expect(byId.get(alpha.wooId)?.connection.disabledReason).toBe("connection_paused");
  });

  it("omits a connection whose address is not a public website", async () => {
    const localId = await seedWoo(alpha.businessId, "http://localhost:8080");
    const websites = await withTenant(alpha.businessId, () => torob.listManagedWebsites(alpha.businessId));
    expect(websites.map((website) => website.connectionId)).not.toContain(localId);
  });
});

describe("enrolling a website", () => {
  it("creates a partner shop that waits on Torob, not one that claims to be authorized", async () => {
    const { shop, created } = await withTenant(alpha.businessId, () =>
      torob.connectTorobShop({
        businessId: alpha.businessId,
        kind: "woocommerce",
        connectionId: alpha.activeWooId,
      }),
    );
    expect(created).toBe(true);
    expect(shop.authorizationState).toBe("not_authorized");
    expect(shop.authMode).toBe("partner");
    expect(shop.enabled).toBe(false);
    expect(shop.domain).toBe("shop.alpha.example");
  });

  it("is idempotent: the same website twice is one shop", async () => {
    const second = await withTenant(alpha.businessId, () =>
      torob.connectTorobShop({
        businessId: alpha.businessId,
        kind: "woocommerce",
        connectionId: alpha.activeWooId,
      }),
    );
    expect(second.created).toBe(false);
    const shops = await withTenant(alpha.businessId, () => torob.listShops(alpha.businessId));
    expect(shops.filter((shop) => shop.connectionId === alpha.activeWooId)).toHaveLength(1);
  });

  it("refuses a connection id another business owns, even a real one", async () => {
    await expect(
      withTenant(alpha.businessId, () =>
        torob.connectTorobShop({ businessId: alpha.businessId, kind: "woocommerce", connectionId: beta.wooId }),
      ),
    ).rejects.toMatchObject({ code: "website_not_found" });
  });

  it("refuses a paused connection and one whose product sync is off", async () => {
    await expect(
      withTenant(alpha.businessId, () =>
        torob.connectTorobShop({ businessId: alpha.businessId, kind: "woocommerce", connectionId: alpha.wooId }),
      ),
    ).rejects.toMatchObject({ code: "website_inactive" });

    const noSync = await seedWoo(alpha.businessId, "https://nosync.alpha.example", { syncProducts: false });
    await expect(
      withTenant(alpha.businessId, () =>
        torob.connectTorobShop({ businessId: alpha.businessId, kind: "woocommerce", connectionId: noSync }),
      ),
    ).rejects.toMatchObject({ code: "catalogue_unavailable" });
  });

  it("keeps one shop per domain, and the database refuses the duplicate", async () => {
    // Two managed websites at one host is legitimate (a WooCommerce plugin and the
    // CMS site it runs inside); one Torob shop per domain is the rule. The
    // resolver explains it before anyone clicks; this is the constraint behind it.
    await withTenant(beta.businessId, () =>
      torob.connectTorobShop({ businessId: beta.businessId, kind: "woocommerce", connectionId: beta.wooId }),
    );
    const sameHost = await seedCms(beta.businessId, "shop.beta.example");
    await expect(
      withTenant(beta.businessId, () =>
        torob.connectTorobShop({ businessId: beta.businessId, kind: "eshobe_cms", connectionId: sameHost }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("credentials", () => {
  it("authorizes with the merchant's own token, stores it encrypted, and returns only a hint", async () => {
    const shop = await withTenant(alpha.businessId, async () => {
      const { shop: pending } = await torob.connectTorobShop({
        businessId: alpha.businessId,
        kind: "eshobe_cms",
        connectionId: alpha.cmsId,
      });
      return torob.authorizeTorobShopWithToken({ businessId: alpha.businessId, shopId: pending.id, token: TOKEN });
    });
    expect(shop.authorizationState).toBe("authorized");
    expect(shop.authMode).toBe("manual_token");
    expect(shop.tokenHint).toBe(TOKEN.slice(-4));

    const { rows } = await db.query<{ token_ciphertext: string | null }>(
      "SELECT token_ciphertext FROM torob_shops WHERE id = $1",
      [shop.id],
    );
    expect(rows[0].token_ciphertext).toBeTruthy();
    expect(rows[0].token_ciphertext).not.toContain(TOKEN);

    // The one function that may return it does, decrypted and intact.
    const read = await withTenant(alpha.businessId, () =>
      torob.readTorobShopToken({ businessId: alpha.businessId, shopId: shop.id }),
    );
    expect(read?.token).toBe(TOKEN);
  });

  it("rejects what is certainly not a token, and never stores it", async () => {
    const shops = await withTenant(alpha.businessId, () => torob.listShops(alpha.businessId));
    const shop = shops.find((candidate) => candidate.connectionId === alpha.cmsId)!;
    await expect(
      withTenant(alpha.businessId, () =>
        torob.authorizeTorobShopWithToken({
          businessId: alpha.businessId,
          shopId: shop.id,
          token: "https://torob.com/dashboard",
        }),
      ),
    ).rejects.toMatchObject({ code: "token_invalid" });

    // The previous credential survived a refused replacement.
    const read = await withTenant(alpha.businessId, () =>
      torob.readTorobShopToken({ businessId: alpha.businessId, shopId: shop.id }),
    );
    expect(read?.token).toBe(TOKEN);
  });

  it("refuses a row that claims authorization it cannot have", async () => {
    // The state machine's backstop. Each of these three is a row the service can
    // never write, and the constraint is what keeps a future path from writing it
    // by accident.
    const insert = (state: string, mode: string, ciphertext: string | null) =>
      db.query(
        `INSERT INTO torob_shops
           (business_id, website_kind, source_connection_id, domain, authorization_state, auth_mode, token_ciphertext, token_hint)
         VALUES ($1, 'woocommerce', $2, $3, $4, $5, $6, $7)`,
        [
          alpha.businessId,
          randomUUID(),
          `${state}-${mode}.alpha.example`,
          state,
          mode,
          ciphertext,
          ciphertext ? "1234" : null,
        ],
      );

    // authorized, partner mode, no Torob shop id: nothing was approved.
    await expect(insert("authorized", "partner", null)).rejects.toMatchObject({ code: "23514" });
    // authorized, manual mode, no token: nothing to authorize with.
    await expect(insert("authorized", "manual_token", null)).rejects.toMatchObject({ code: "23514" });
    // revoked while still holding the secret nobody may use.
    await expect(insert("revoked", "manual_token", "cipher")).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the channel switch and disconnecting", () => {
  it("will not switch on a shop that is not authorized", async () => {
    const shops = await withTenant(alpha.businessId, () => torob.listShops(alpha.businessId));
    const waiting = shops.find((shop) => shop.connectionId === alpha.activeWooId)!;
    expect(waiting.authorizationState).toBe("not_authorized");
    await expect(
      withTenant(alpha.businessId, () =>
        torob.setTorobShopEnabled({ businessId: alpha.businessId, shopId: waiting.id, enabled: true }),
      ),
    ).rejects.toMatchObject({ code: "not_authorizable" });
  });

  it("switches an authorized shop on, and publishes it only while on", async () => {
    const shops = await withTenant(alpha.businessId, () => torob.listShops(alpha.businessId));
    const authorized = shops.find((shop) => shop.connectionId === alpha.cmsId)!;

    const on = await withTenant(alpha.businessId, () =>
      torob.setTorobShopEnabled({ businessId: alpha.businessId, shopId: authorized.id, enabled: true }),
    );
    expect(on.enabled).toBe(true);
    let enabled = await withTenant(alpha.businessId, () => torob.enabledTorobShops(alpha.businessId));
    expect(enabled.map((shop) => shop.id)).toEqual([authorized.id]);

    await withTenant(alpha.businessId, () =>
      torob.setTorobShopEnabled({ businessId: alpha.businessId, shopId: authorized.id, enabled: false }),
    );
    enabled = await withTenant(alpha.businessId, () => torob.enabledTorobShops(alpha.businessId));
    expect(enabled).toEqual([]);
  });

  it("revokes without deleting: the row stays, the credential goes, the channel stops", async () => {
    const shops = await withTenant(alpha.businessId, () => torob.listShops(alpha.businessId));
    const shop = shops.find((candidate) => candidate.connectionId === alpha.cmsId)!;
    await withTenant(alpha.businessId, () =>
      torob.setTorobShopEnabled({ businessId: alpha.businessId, shopId: shop.id, enabled: true }),
    );

    const revoked = await withTenant(alpha.businessId, () =>
      torob.revokeTorobShop({ businessId: alpha.businessId, shopId: shop.id }),
    );
    expect(revoked.authorizationState).toBe("revoked");
    expect(revoked.enabled).toBe(false);
    expect(revoked.tokenHint).toBeNull();

    const { rows } = await db.query<{ token_ciphertext: string | null; domain: string }>(
      "SELECT token_ciphertext, domain FROM torob_shops WHERE id = $1",
      [shop.id],
    );
    expect(rows[0].token_ciphertext).toBeNull();
    // The shop itself is still ours to show and to reconnect; the domain is kept.
    expect(rows[0].domain).toBe("www.alpha.example");

    const read = await withTenant(alpha.businessId, () =>
      torob.readTorobShopToken({ businessId: alpha.businessId, shopId: shop.id }),
    );
    expect(read).toBeNull();
  });

  it("shows the revoked website as re-enrollable rather than as a failure", async () => {
    const rows = await withTenant(alpha.businessId, () => torob.torobWebsiteOverview(alpha.businessId));
    const row = rows.find((candidate) => candidate.connectionId === alpha.cmsId)!;
    expect(row.state).toBe("disconnected");
    expect(row.reason).toBe("revoked_by_merchant");
  });
});

describe("one business can never touch another's channel", () => {
  it("does not read a shop it does not own", async () => {
    const alphaShops = await withTenant(alpha.businessId, () => torob.listShops(alpha.businessId));
    const betaShops = await withTenant(beta.businessId, () => torob.listShops(beta.businessId));
    expect(alphaShops.length).toBeGreaterThan(0);
    expect(betaShops.length).toBeGreaterThan(0);
    // Each list is its own tenant's, with no row in common.
    const alphaIds = new Set(alphaShops.map((shop) => shop.id));
    expect(betaShops.some((shop) => alphaIds.has(shop.id))).toBe(false);
    expect(betaShops.every((shop) => shop.businessId === beta.businessId)).toBe(true);
    // And the overview — the screen's own read — is populated only from the
    // tenant's registries, so beta never sees alpha's websites either.
    const betaRows = await withTenant(beta.businessId, () => torob.torobWebsiteOverview(beta.businessId));
    expect(betaRows.map((row) => row.domain)).not.toContain("www.alpha.example");
  });

  it("cannot revoke, switch or authorize another business's shop", async () => {
    const [shop] = await withTenant(alpha.businessId, () => torob.listShops(alpha.businessId));
    await expect(
      withTenant(beta.businessId, () => torob.revokeTorobShop({ businessId: beta.businessId, shopId: shop.id })),
    ).rejects.toMatchObject({ code: "shop_not_found" });
    await expect(
      withTenant(beta.businessId, () =>
        torob.setTorobShopEnabled({ businessId: beta.businessId, shopId: shop.id, enabled: false }),
      ),
    ).rejects.toMatchObject({ code: "shop_not_found" });
    await expect(
      withTenant(beta.businessId, () =>
        torob.authorizeTorobShopWithToken({ businessId: beta.businessId, shopId: shop.id, token: TOKEN }),
      ),
    ).rejects.toMatchObject({ code: "shop_not_found" });
  });

  it("cannot enroll a website into the other business's shop by id", async () => {
    await expect(
      withTenant(beta.businessId, () =>
        torob.connectTorobShop({ businessId: beta.businessId, kind: "eshobe_cms", connectionId: alpha.cmsId }),
      ),
    ).rejects.toMatchObject({ code: "website_not_found" });
  });
});
