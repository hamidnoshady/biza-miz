/**
 * Issue #799 Wave 11 — the industry *family*, not "not F&B", decides the shape.
 *
 * Four shared engines used to branch on `industry !== "food_service"` and call
 * the result "retail". That is wrong for the trade this issue is about: an
 * architecture/construction business sells no goods, so a web-store product or
 * an order has nowhere to land — writing it as retail inventory invents stock
 * the business never had, and posting its revenue invents a sale.
 *
 * The unit suite (`src/lib/industry-coverage.test.ts`) scans the sources; this
 * file proves the behaviour against real rows, for all three families side by
 * side in one database:
 *
 *   - `food_service` (F&B)      → `menu_items`, the original WooCommerce path
 *   - `jewelry`      (retail)   → `items` / `item_stock`
 *   - `architecture_construction` (project-based) → refused, by name
 *
 * The refusal has to be visible to the operator, so the two ingest doors are
 * asserted on their own failure plumbing: `cms_store_order_inbox.status`
 * ('failed' + the message) for the CMS webhook, and
 * `integration_webhook_events.status` for the WooCommerce one.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";
import type { CmsOrder } from "../src/lib/cms/types";
import type { WooOrder } from "../src/lib/integrations/woocommerce-client";
import type { WooProduct } from "../src/lib/integrations/woocommerce-client";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "ab".repeat(32);

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let sync: typeof import("../src/lib/integrations/sync-service");
let woIngest: typeof import("../src/lib/integrations/webhook-ingest-service");
let cmsIngest: typeof import("../src/lib/cms/order-ingest-service");
let connections: typeof import("../src/lib/integrations/connections-service");

type Shop = { id: string; locationId: string; connectionId: string };
const shops: Record<"fnb" | "retail" | "aec", Shop> = {
  fnb: { id: "", locationId: "", connectionId: "" },
  retail: { id: "", locationId: "", connectionId: "" },
  aec: { id: "", locationId: "", connectionId: "" },
};
let aecSiteId = "";

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

/** One plain, stock-tracking product at 150,000 rial. */
function product(id: number, name: string): WooProduct {
  return {
    id,
    type: "simple",
    name,
    sku: `SKU-${id}`,
    price: "150000",
    regular_price: "150000",
    sale_price: "",
    manage_stock: true,
    stock_quantity: 7,
    stock_status: "instock",
    status: "publish",
    attributes: [],
    categories: [{ id: 3, name: "عمومی", slug: "general" }],
    images: [],
  };
}

/** A paid order with one line, in the shape the WooCommerce webhook sends. */
function wooOrder(id: number): WooOrder {
  return {
    id,
    number: String(3000 + id),
    status: "processing",
    total: "150000",
    total_tax: "0",
    currency: "IRT",
    date_created: new Date().toISOString(),
    payment_method: "cod",
    customer_id: 0,
    billing: { first_name: "سارا", last_name: "احمدی", phone: "09123456789" },
    line_items: [
      { id: 1, name: "کالا", product_id: id, quantity: 1, price: "150000", total: "150000" },
    ],
  };
}

async function seedShop(slug: string, industry: string): Promise<Shop> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
    [`Family ${slug}`, `${slug}-${randomUUID().slice(0, 8)}`, industry],
  );
  const id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [id],
  );
  const connRow = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
     VALUES ($1, $2, 'Store', 'https://shop.example.com', $3, $4, $5, 'toman', true, true, true, true, true)
     RETURNING id`,
    [
      id,
      locRow.rows[0].id,
      encryptSecret("ck_test", Buffer.from(KEY, "hex")),
      encryptSecret("cs_test", Buffer.from(KEY, "hex")),
      encryptSecret("whsec_test", Buffer.from(KEY, "hex")),
    ],
  );
  return { id, locationId: locRow.rows[0].id, connectionId: connRow.rows[0].id };
}

beforeAll(async () => {
  databaseName = `pos_industry_family_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;

  dbLib = await import("../src/lib/db");
  sync = await import("../src/lib/integrations/sync-service");
  woIngest = await import("../src/lib/integrations/webhook-ingest-service");
  cmsIngest = await import("../src/lib/cms/order-ingest-service");
  connections = await import("../src/lib/integrations/connections-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  shops.fnb = await seedShop("fnb", "food_service");
  shops.retail = await seedShop("retail", "jewelry");
  shops.aec = await seedShop("aec", "architecture_construction");

  // The AEC business has a website too — its shopfront is a brochure/lead form,
  // and it can still be wired to a CMS. The order door is what must refuse.
  aecSiteId = `site-${randomUUID()}`;
  await db.query(
    `INSERT INTO eshobe_cms_connections (business_id, site_id, site_domain, base_url, api_key_ciphertext)
     VALUES ($1, $2, 'build.test', 'https://cms.test', $3)`,
    [shops.aec.id, aecSiteId, encryptSecret("eshobe_live_test_key", Buffer.from(KEY, "hex"))],
  );
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("a synced product lands in the register its family owns", () => {
  it("routes F&B to menu items, retail to items, and a project business nowhere", async () => {
    const fnb = (await connections.getConnection(shops.fnb.id, shops.fnb.connectionId))!;
    const retail = (await connections.getConnection(shops.retail.id, shops.retail.connectionId))!;
    const aec = (await connections.getConnection(shops.aec.id, shops.aec.connectionId))!;

    expect(await sync.upsertProductFromWoo(fnb, shops.fnb.locationId, product(101, "کاپوچینو"))).toBe("created");
    expect(await sync.upsertProductFromWoo(retail, shops.retail.locationId, product(201, "دستبند"))).toBe("created");
    expect(await sync.upsertProductFromWoo(aec, shops.aec.locationId, product(301, "خدمات نظارت"))).toBe("skipped");

    const menu = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM menu_items WHERE location_id = $1",
      [shops.fnb.locationId],
    );
    expect(Number(menu.rows[0].count)).toBe(1);

    const items = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM items WHERE location_id = $1",
      [shops.retail.locationId],
    );
    expect(Number(items.rows[0].count)).toBe(1);

    // Nothing was written for the AEC business, in either register, and no
    // mapping row was recorded that would make the next sync think otherwise.
    const aecItems = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM items WHERE location_id = $1",
      [shops.aec.locationId],
    );
    const aecMenu = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM menu_items WHERE location_id = $1",
      [shops.aec.locationId],
    );
    const aecMappings = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM integration_mappings WHERE business_id = $1 AND entity_type = 'product'",
      [shops.aec.id],
    );
    expect(Number(aecItems.rows[0].count)).toBe(0);
    expect(Number(aecMenu.rows[0].count)).toBe(0);
    expect(Number(aecMappings.rows[0].count)).toBe(0);
  });

  it("answers the catalogue panel with an empty register, not another table's rows", async () => {
    const fnb = await sync.catalogueFor(shops.fnb.id, shops.fnb.connectionId);
    const retail = await sync.catalogueFor(shops.retail.id, shops.retail.connectionId);
    const aec = await sync.catalogueFor(shops.aec.id, shops.aec.connectionId);

    expect(fnb.industry).toBe("food_service");
    expect(fnb.rows).toHaveLength(1);
    expect(fnb.rows[0].itemKind).toBeNull();

    expect(retail.industry).toBe("jewelry");
    expect(retail.rows).toHaveLength(1);
    expect(retail.rows[0].itemKind).not.toBeNull();

    expect(aec).toEqual({ industry: "architecture_construction", rows: [] });
  });
});

describe("an order from a trade that sells no goods is refused, by name", () => {
  it("fails the CMS inbox row instead of importing a retail sale", async () => {
    const order: CmsOrder = {
      id: `ord-${randomUUID()}`,
      reference: "CMS-9001",
      status: "paid",
      product: "prod-1",
      productTitle: "مشاوره",
      quantity: 1,
      unitPrice: 500_000,
      total: 500_000,
      currency: "IRT",
      buyer: { name: "شرکت کارفرما", phone: "09121112233", email: null, note: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const res = await cmsIngest.handleCmsStoreOrderWebhook({
      siteId: aecSiteId,
      deliveryId: `del-${randomUUID()}`,
      event: "order.paid",
      order,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "industry_not_storefront" });

    const inbox = await db.query<{ status: string; error: string | null }>(
      `SELECT i.status, i.error FROM cms_store_order_inbox i
         JOIN eshobe_cms_connections c ON c.id = i.cms_connection_id
        WHERE c.business_id = $1 AND i.cms_order_id = $2`,
      [shops.aec.id, order.id],
    );
    expect(inbox.rows[0]?.status).toBe("failed");
    expect(inbox.rows[0]?.error).toBe("industry_not_storefront");

    const orders = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders o
         JOIN locations l ON l.id = o.location_id
        WHERE l.business_id = $1`,
      [shops.aec.id],
    );
    expect(Number(orders.rows[0].count)).toBe(0);
  });

  it("fails the WooCommerce webhook event instead of posting revenue", async () => {
    const connection = (await connections.getConnection(shops.aec.id, shops.aec.connectionId))!;
    const order = wooOrder(501);
    const deliveryId = `d-${randomUUID()}`;

    const outcome = await woIngest.ingestRemoteOrder(connection, order, deliveryId);
    expect(outcome).toEqual({ status: "failed", error: "industry_not_storefront" });

    const event = await db.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM integration_webhook_events
        WHERE connection_id = $1 AND delivery_id = $2`,
      [shops.aec.connectionId, deliveryId],
    );
    expect(event.rows[0]?.status).toBe("failed");
    expect(event.rows[0]?.error).toBe("industry_not_storefront");

    // The refund door refuses on the same ground, so a reversal can never be
    // the way a storefront-less business acquires a sale row.
    const refund = await woIngest.ingestRemoteRefund(
      connection,
      { id: 502, parent_id: 501, date_created: new Date().toISOString(), total: "-150000" } as never,
      `d-${randomUUID()}`,
    );
    expect(refund.status).toBe("failed");
  });
});
