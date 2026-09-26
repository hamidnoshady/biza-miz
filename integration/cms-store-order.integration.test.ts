/**
 * Phase G — CMS store order.paid webhook → inbox → accounting import.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";
import { eshobeSignature } from "../src/lib/cms/webhook";
import type { CmsOrder } from "../src/lib/cms/types";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required");

const KEY = "ab".repeat(32);
const WEBHOOK_SECRET = "cms-webhook-test-secret";

let databaseName: string;
let db: Client;
let ingest: typeof import("../src/lib/cms/order-ingest-service");

const biz = { id: "", locationId: "", connectionId: "", siteId: "" };

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

function paidOrder(id: string): CmsOrder {
  return {
    id,
    reference: "CMS-1001",
    status: "paid",
    product: "prod-1",
    productTitle: "کیف چرم",
    quantity: 1,
    unitPrice: 500_000,
    total: 500_000,
    currency: "IRT",
    buyer: { name: "سارا رضایی", phone: "09121234567", email: null, note: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function signedBody(body: object): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  return { raw, signature: eshobeSignature(raw, WEBHOOK_SECRET) };
}

beforeAll(async () => {
  databaseName = `pos_cms_order_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  process.env.ESHOBE_CMS_WEBHOOK_SECRET = WEBHOOK_SECRET;

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  ingest = await import("../src/lib/cms/order-ingest-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('CMS Shop', $1) RETURNING id",
    [`cms-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = loc.rows[0].id;
  biz.siteId = `site-${randomUUID()}`;

  await db.query(
    `INSERT INTO accounts (business_id, code, name, type) VALUES
       ($1, '1100', 'Cash', 'asset'),
       ($1, '1120', 'Card clearing', 'asset'),
       ($1, '4330', 'Delivery', 'revenue')`,
    [biz.id],
  );

  const cipher = encryptSecret("eshobe_live_test_key", Buffer.from(KEY, "hex"));
  const conn = await db.query<{ id: string }>(
    `INSERT INTO eshobe_cms_connections (business_id, site_id, site_domain, base_url, api_key_ciphertext)
     VALUES ($1, $2, 'shop.test', 'https://cms.test', $3) RETURNING id`,
    [biz.id, biz.siteId, cipher],
  );
  biz.connectionId = conn.rows[0].id;
});

afterAll(async () => {
  await db?.end().catch(() => {});
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("CMS store order ingest", () => {
  it("imports a paid order once and dedupes the delivery", async () => {
    const order = paidOrder(`ord-${randomUUID()}`);
    const deliveryId = `del-${randomUUID()}`;
    const notice = {
      siteId: biz.siteId,
      deliveryId,
      event: "order.paid",
      order,
    };

    const first = await ingest.handleCmsStoreOrderWebhook(notice);
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson).toMatchObject({ status: "processed" });

    const second = await ingest.handleCmsStoreOrderWebhook(notice);
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.status).toMatch(/duplicate|processed/);

    const orders = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders o
         JOIN locations l ON l.id = o.location_id
        WHERE l.business_id = $1`,
      [biz.id],
    );
    expect(Number(orders.rows[0].count)).toBe(1);

    const inbox = await db.query<{ status: string }>(
      `SELECT status FROM cms_store_order_inbox WHERE cms_connection_id = $1 AND cms_order_id = $2`,
      [biz.connectionId, order.id],
    );
    expect(inbox.rows[0]?.status).toBe("processed");
  });
});
