/**
 * Issue #894 Wave 5b — the webhook queue against real Postgres.
 *
 * The unit tests own the rules (`webhook.test.ts`) and the wire
 * (`webhook-client.test.ts`). What only a database can settle is whether a shop's
 * changes actually reach Torob exactly the way the rules promise:
 *
 *  - a fill queues one row per **page of the built feed**, so a product the
 *    merchant excluded (§6d) is never announced;
 *  - a second change coalesces onto the same row instead of growing the queue;
 *  - a page that leaves the feed loses its row, because announcing it would invite
 *    Torob to fetch something the shop no longer serves;
 *  - an accepted batch marks rows sent, records the batch, and never claims more;
 *  - a refused credential dead-letters and marks the shop unhealthy, while a rate
 *    limit keeps the rows pending for the next run;
 *  - a switched-off or unauthorized channel is not drained at all;
 *  - one business cannot see or drain another's queue.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const env = { TOROB_WEBHOOK_URL: "https://torob.test/update/webhook/v1/" } as Record<string, string | undefined>;

let databaseName: string;
let db: Client;
let withTenant: typeof import("../src/lib/db").withTenant;
let shops: typeof import("../src/lib/torob/shop-service");
let publication: typeof import("../src/lib/torob/shop-publication");
let webhook: typeof import("../src/lib/torob/webhook-service");

const alpha = { businessId: "", wooId: "", shopId: "", a: "", b: "", c: "" };
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

/** A scripted Torob webhook: the queued responses, plus every request it saw. */
function scriptedTorob(...responses: (Response | (() => Response))[]) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: typeof init?.body === "string" ? init.body : "",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const accepted = () =>
  new Response(JSON.stringify({ message: "success" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function fill() {
  return withTenant(alpha.businessId, () =>
    webhook.enqueueChangedPages({ businessId: alpha.businessId, shopId: alpha.shopId }),
  );
}

async function drain(overrides: Record<string, unknown> = {}) {
  return withTenant(alpha.businessId, () =>
    webhook.drainWebhookQueue({
      businessId: alpha.businessId,
      shopId: alpha.shopId,
      env,
      ...overrides,
    }),
  );
}

async function queueRows() {
  const { rows } = await db.query<{
    page_unique: string;
    state: string;
    attempts: number;
    reason: string;
    last_error: string | null;
    sent_at: Date | null;
  }>(
    `SELECT page_unique, state, attempts, reason, last_error, sent_at
       FROM torob_webhook_outbox WHERE shop_id = $1 ORDER BY page_unique`,
    [alpha.shopId],
  );
  return rows;
}

/** The three products these cases are about (the catalogue is the business's). */
async function ourQueued(): Promise<string[]> {
  return (await queueRows())
    .map((row) => row.page_unique)
    .filter((unique) => [alpha.a, alpha.b, alpha.c].includes(unique))
    .sort();
}

beforeAll(async () => {
  databaseName = `pos_torobhook_${randomUUID().replaceAll("-", "")}`;
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
  webhook = await import("../src/lib/torob/webhook-service");

  alpha.businessId = await seedBusiness("آلفا", "torobhook-alpha");
  beta.businessId = await seedBusiness("بتا", "torobhook-beta");
  alpha.wooId = await seedWoo(alpha.businessId, "https://shop.alpha.example");
  beta.wooId = await seedWoo(beta.businessId, "https://shop.beta.example");
  await seedProduct(beta.businessId, "کالای بتا", 900_000);

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

  // A shop token, because the webhook token is a shop token (a generator token
  // cannot send this at all).
  await withTenant(alpha.businessId, () =>
    shops.authorizeTorobShopWithToken({
      businessId: alpha.businessId,
      shopId: alpha.shopId,
      token: "shop-webhook-token-0123456789",
    }),
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

describe("filling the queue", () => {
  it("queues one row per page of the built feed, and only pages the shop serves", async () => {
    await fill();
    expect(await ourQueued()).toEqual([alpha.a, alpha.b, alpha.c].sort());

    const rows = await queueRows();
    const a = rows.find((row) => row.page_unique === alpha.a);
    expect(a).toMatchObject({ state: "pending", attempts: 0, reason: "added", last_error: null });
  });

  it("coalesces a second change onto the same row instead of growing the queue", async () => {
    const before = await queueRows();
    // A price edit: the product's `updated_at` moves, so the page is due again.
    await db.query("UPDATE menu_items SET price = price + 1000, updated_at = now() + interval '1 second' WHERE id = $1", [
      alpha.a,
    ]);
    const result = await fill();
    // One row re-armed, not a second row.
    expect(result.queued).toBeGreaterThanOrEqual(1);
    const after = await queueRows();
    expect(after).toHaveLength(before.length);
    expect(after.filter((row) => row.page_unique === alpha.a)).toHaveLength(1);
  });

  it("forgets a page the merchant takes out of the feed", async () => {
    await withTenant(alpha.businessId, () =>
      publication.setProductDecision({
        businessId: alpha.businessId,
        shopId: alpha.shopId,
        productIds: [alpha.c],
        decision: "exclude",
      }),
    );
    try {
      const result = await fill();
      expect(result.dropped).toBeGreaterThanOrEqual(1);
      // Excluded under «همه» means it is not in the feed, so announcing it would
      // invite Torob to fetch a page the shop no longer offers.
      expect(await ourQueued()).toEqual([alpha.a, alpha.b].sort());
    } finally {
      await withTenant(alpha.businessId, () =>
        publication.setProductDecision({
          businessId: alpha.businessId,
          shopId: alpha.shopId,
          productIds: [alpha.c],
          decision: null,
        }),
      );
      await fill();
    }
  });
});

describe("draining the queue", () => {
  it("sends the pending pages, marks them sent, and records the acceptance", async () => {
    const torob = scriptedTorob(accepted);
    const result = await drain({ fetchImpl: torob.fetchImpl });

    expect(result.accepted).toBe(1);
    expect(result.stoppedBy).toBeNull();
    expect(result.sentPages).toBeGreaterThanOrEqual(3);

    // One request, with the shop's own token, carrying only the two documented fields.
    expect(torob.calls).toHaveLength(1);
    expect(torob.calls[0].headers.authorization).toBe("Bearer shop-webhook-token-0123456789");
    const body = JSON.parse(torob.calls[0].body) as { items: Record<string, string>[] };
    expect(body.items.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(body.items[0]).sort()).toEqual(["page_unique", "page_url"]);
    // Every page in the batch is on the shop's own domain, and its URL is absolute.
    for (const entry of body.items) {
      expect(entry.page_url.startsWith("https://shop.alpha.example/")).toBe(true);
    }

    expect((await ourQueued()).length).toBe(3);
    const rows = await queueRows();
    expect(rows.every((row) => row.state === "sent" || row.state === "pending")).toBe(true);
    expect(rows.filter((row) => row.state === "sent").length).toBeGreaterThanOrEqual(3);
    expect(rows.find((row) => row.page_unique === alpha.a)?.sent_at).not.toBeNull();

    const { rows: batches } = await db.query<{ items: number; outcome: string; error: string | null }>(
      "SELECT items, outcome, error FROM torob_webhook_batches WHERE shop_id = $1",
      [alpha.shopId],
    );
    expect(batches.at(-1)).toMatchObject({ outcome: "accepted", error: null });
    expect(batches.at(-1)?.items).toBeGreaterThanOrEqual(3);
  });

  it("records a subsequent change as an update, not a first announcement", async () => {
    await db.query("UPDATE menu_items SET updated_at = now() + interval '5 seconds' WHERE id = $1", [alpha.b]);
    await fill();
    const b = (await queueRows()).find((row) => row.page_unique === alpha.b);
    // The row was `sent`, so this is a new cycle with a fresh attempt count.
    expect(b).toMatchObject({ state: "pending", attempts: 0 });
  });

  it("dead-letters the batch when Torob refuses the credential, and marks the shop unhealthy", async () => {
    const torob = scriptedTorob(new Response("", { status: 401 }));
    const result = await drain({ fetchImpl: torob.fetchImpl });

    expect(result).toMatchObject({ accepted: 0, failed: 1, stoppedBy: "unauthorized" });
    expect(result.deadLettered).toBeGreaterThanOrEqual(1);

    const rows = await queueRows();
    const dead = rows.filter((row) => row.state === "dead");
    expect(dead.length).toBeGreaterThanOrEqual(1);
    expect(dead[0].last_error).toBe("unauthorized");

    const { rows: shop } = await db.query<{ health: string; health_reason: string | null }>(
      "SELECT health, health_reason FROM torob_shops WHERE id = $1",
      [alpha.shopId],
    );
    expect(shop[0]).toMatchObject({ health: "attention", health_reason: "unauthorized" });

    const { rows: batches } = await db.query<{ outcome: string; error: string | null; items: number }>(
      "SELECT outcome, error, items FROM torob_webhook_batches WHERE shop_id = $1 ORDER BY finished_at DESC LIMIT 1",
      [alpha.shopId],
    );
    expect(batches[0]).toMatchObject({ outcome: "failed", error: "unauthorized", items: 0 });
  });

  it("puts stopped pages back in the queue on request", async () => {
    const retried = await withTenant(alpha.businessId, () =>
      webhook.retryDeadPages({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    expect(retried).toBeGreaterThanOrEqual(1);
    const rows = await queueRows();
    expect(rows.filter((row) => row.state === "dead")).toHaveLength(0);
    expect(rows.every((row) => row.attempts === 0)).toBe(true);
  });

  it("keeps the rows pending after a rate limit, because that is what a retry fixes", async () => {
    const torob = scriptedTorob(new Response("", { status: 429 }));
    const result = await drain({ fetchImpl: torob.fetchImpl });
    expect(result.stoppedBy).toBe("rate_limited");
    expect(result.deadLettered).toBe(0);

    const rows = await queueRows();
    const pending = rows.filter((row) => row.state === "pending");
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0].last_error).toBe("rate_limited");
    expect(pending[0].attempts).toBe(1);
  });

  it("clears the failure once a later run is accepted", async () => {
    // The rows are due a moment later; the claim is honouring `next_attempt_at`.
    await db.query("UPDATE torob_webhook_outbox SET next_attempt_at = now() WHERE shop_id = $1 AND state = 'pending'", [
      alpha.shopId,
    ]);
    const torob = scriptedTorob(accepted);
    const result = await drain({ fetchImpl: torob.fetchImpl });
    expect(result.accepted).toBe(1);

    const rows = await queueRows();
    expect(rows.filter((row) => row.state === "pending")).toHaveLength(0);
    expect(rows.every((row) => row.last_error === null)).toBe(true);
  });
});

describe("a channel that must not send", () => {
  it("does not call Torob when the shop's switch is off", async () => {
    await withTenant(alpha.businessId, () =>
      shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: false }),
    );
    try {
      const torob = scriptedTorob(accepted);
      const result = await drain({ fetchImpl: torob.fetchImpl });
      expect(result.stoppedBy).not.toBeNull();
      expect(result.batches).toBe(0);
      expect(torob.calls).toHaveLength(0);
    } finally {
      await withTenant(alpha.businessId, () =>
        shops.setTorobShopEnabled({ businessId: alpha.businessId, shopId: alpha.shopId, enabled: true }),
      );
    }
  });

  it("does not call Torob for an unauthorized shop", async () => {
    await db.query(
      `UPDATE torob_shops SET authorization_state = 'revoked', token_ciphertext = NULL, token_hint = NULL WHERE id = $1`,
      [alpha.shopId],
    );
    try {
      const torob = scriptedTorob(accepted);
      const result = await drain({ fetchImpl: torob.fetchImpl });
      expect(result.stoppedBy).toBe("unauthorized");
      expect(torob.calls).toHaveLength(0);
    } finally {
      await withTenant(alpha.businessId, () =>
        shops.authorizeTorobShopWithToken({
          businessId: alpha.businessId,
          shopId: alpha.shopId,
          token: "shop-webhook-token-0123456789",
        }),
      );
    }
  });

  it("refuses another business's shop outright", async () => {
    await expect(
      withTenant(beta.businessId, () =>
        webhook.drainWebhookQueue({ businessId: beta.businessId, shopId: alpha.shopId, env }),
      ),
    ).rejects.toMatchObject({ code: "shop_not_found" });
    expect(await withTenant(beta.businessId, () =>
      webhook.readWebhookQueue({ businessId: beta.businessId, shopId: alpha.shopId }),
    )).toBeNull();
  });

  it("reports only its own shop's queue", async () => {
    const mine = await withTenant(beta.businessId, () =>
      webhook.readWebhookQueue({ businessId: beta.businessId, shopId: beta.shopId }),
    );
    expect(mine?.counts.pending).toBe(0);
    expect(mine?.dead).toHaveLength(0);
  });
});

describe("the middle stage of the channel", () => {
  it("reports `sent` only after a batch was accepted, and never claims more", async () => {
    const capability = await withTenant(alpha.businessId, () =>
      webhook.webhookCapability({ businessId: alpha.businessId, shopId: alpha.shopId }),
    );
    expect(capability.sent).toBe(true);
    expect(capability.dead).toBe(0);

    const untouched = await withTenant(beta.businessId, () =>
      webhook.webhookCapability({ businessId: beta.businessId, shopId: beta.shopId }),
    );
    expect(untouched.sent).toBe(false);
  });
});
