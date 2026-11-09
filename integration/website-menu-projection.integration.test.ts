/** ESH-145 — the complete café projection, two independent sites, and withdrawal. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let connection: typeof import("../src/lib/website/connection-service");
let sync: typeof import("../src/lib/website/sync-service");
let catalog: typeof import("../src/lib/website/catalog-service");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_menu_projection_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE "${databaseName}"`); } finally { await maintenance.end(); }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.JWT_SECRET ??= "menu-projection-test-secret";
  dbLib = await import("../src/lib/db");
  connection = await import("../src/lib/website/connection-service");
  sync = await import("../src/lib/website/sync-service");
  catalog = await import("../src/lib/website/catalog-service");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { "content-type": "image/png", "content-length": "4" },
  }));
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try { await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await maintenance.end(); }
});

describe("ESH-145 — complete Accounting café menu projection", () => {
  it("publishes categories/media/add-ons once per site, edits in place, and withdraws without deleting", async () => {
    const business = (await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug) VALUES ('Menu', $1) RETURNING id`, [`menu-${randomUUID()}`],
    )).rows[0].id;
    const locationId = (await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`, [business],
    )).rows[0].id;
    const categoryId = (await db.query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name, description, sort_order) VALUES ($1, 'قهوه', 'گرم', 2) RETURNING id`, [locationId],
    )).rows[0].id;
    const itemId = (await db.query<{ id: string }>(
      `INSERT INTO menu_items (location_id, category_id, name, description, sku, price, image_url, sort_order)
       VALUES ($1, $2, 'لاته', 'با شیر تازه', 'LAT-1', 1200000, 'https://images.example.test/latte.png', 4) RETURNING id`,
      [locationId, categoryId],
    )).rows[0].id;
    const groupId = (await db.query<{ id: string }>(
      `INSERT INTO modifier_groups (location_id, name, min_select, max_select) VALUES ($1, 'افزودنی', 0, 2) RETURNING id`, [locationId],
    )).rows[0].id;
    const optionId = (await db.query<{ id: string }>(
      `INSERT INTO modifiers (location_id, group_id, name, price_delta, sort_order) VALUES ($1, $2, 'شات اضافه', 300000, 1) RETURNING id`,
      [locationId, groupId],
    )).rows[0].id;
    await db.query(
      `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id, min_select_override, max_select_override, sort_order)
       VALUES ($1, $2, 1, 1, 0)`, [itemId, groupId],
    );

    const sites: { id: string; mock: ReturnType<typeof connection.mockAdapterFor> }[] = [];
    await dbLib.withTenant(business, async () => {
      for (const domain of ["a.example.test", "b.example.test"]) {
        const result = await connection.connectWebsite(business, { adapterKey: "mock", baseUrl: "", siteDomain: domain, apiKey: "" });
        if (!result.ok) throw new Error(result.error);
        await connection.updateWebsiteSyncSettings(business, { connectionId: result.connection.id, syncLocationId: locationId, pushStock: true });
        sites.push({ id: result.connection.id, mock: connection.mockAdapterFor(business, result.connection.id) });
      }
      // Explicit opt-in on site A only. Site B must not inherit the mark.
      await sync.setProductSync(business, "menu_item", itemId, true, sites[0].id);
      expect(await sync.syncWebsiteForBusiness(business, undefined, sites[0].id)).toMatchObject({ sent: 1, failed: 0 });
      expect(await sync.syncWebsiteForBusiness(business, undefined, sites[1].id)).toEqual({ queued: 0, sent: 0, failed: 0 });
    });
    expect(sites[1].mock.products).toHaveLength(0);
    const first = sites[0].mock.products[0];
    expect(first).toMatchObject({ title: "لاته", summary: "با شیر تازه", sku: "LAT-1", priceRial: 1_200_000, stock: null, menuOrder: 4, available: true });
    expect(first.categoryTermId).toBeTruthy();
    expect(first.imageId).toBeTruthy();
    expect(first.modifierGroups?.[0]).toMatchObject({ sourceId: groupId, minSelect: 1, maxSelect: 1 });
    expect(first.modifierGroups?.[0].options[0]).toMatchObject({ sourceId: optionId, priceDeltaRial: 300_000 });

    const objects = await db.query<{ kind: string; remote_id: string }>(
      `SELECT kind, remote_id FROM website_menu_object_map WHERE business_id = $1 AND connection_id = $2`, [business, sites[0].id],
    );
    expect(objects.rows.map((row) => row.kind).sort()).toEqual(["category", "media", "modifier", "modifier_group", "taxonomy"]);
    expect((await db.query(`SELECT 1 FROM website_menu_object_map WHERE business_id = $1 AND connection_id = $2`, [business, sites[1].id])).rowCount).toBe(0);

    await dbLib.withTenant(business, async () => {
      await sync.setProductSync(business, "menu_item", itemId, true, sites[1].id);
      await sync.syncWebsiteForBusiness(business, undefined, sites[1].id);
      // Edit the Accounting source, not either remote row.
      await db.query(`UPDATE menu_categories SET description = 'نوشیدنی گرم' WHERE id = $1`, [categoryId]);
      await db.query(`UPDATE modifiers SET price_delta = 350000 WHERE id = $1`, [optionId]);
      await sync.syncWebsiteForBusiness(business, undefined, sites[0].id);
    });
    const edited = sites[0].mock.products[0];
    expect(edited.id).toBe(first.id);
    expect(edited.modifierGroups?.[0].remoteId).toBe(first.modifierGroups?.[0].remoteId);
    expect(edited.modifierGroups?.[0].options[0].remoteId).toBe(first.modifierGroups?.[0].options[0].remoteId);
    expect(edited.modifierGroups?.[0].options[0].priceDeltaRial).toBe(350_000);
    expect(sites[0].mock.calls.filter((call) => call.method === "uploadMedia")).toHaveLength(1);
    expect(sites[1].mock.products).toHaveLength(1);
    const maps = await db.query<{ connection_id: string; remote_id: string }>(
      `SELECT connection_id, remote_id FROM website_product_map WHERE business_id = $1 AND local_id = $2`, [business, itemId],
    );
    expect(maps.rows).toHaveLength(2);
    expect(new Set(maps.rows.map((row) => row.connection_id)).size).toBe(2);

    await dbLib.withTenant(business, async () => {
      await sync.setProductSync(business, "menu_item", itemId, false, sites[0].id);
      await sync.syncWebsiteForBusiness(business, undefined, sites[0].id);
      const aCatalog = await catalog.listWebsiteCatalog(business, locationId, sites[0].id);
      const bCatalog = await catalog.listWebsiteCatalog(business, locationId, sites[1].id);
      expect(aCatalog.find((row) => row.localId === itemId)?.syncEnabled).toBe(false);
      expect(bCatalog.find((row) => row.localId === itemId)?.syncEnabled).toBe(true);
      await db.query(`UPDATE menu_items SET is_active = false WHERE id = $1`, [itemId]);
      await sync.syncWebsiteForBusiness(business, undefined, sites[1].id);
    });
    expect(sites[0].mock.products).toHaveLength(1);
    expect(sites[0].mock.products[0]).toMatchObject({ status: "draft", available: false });
    expect(sites[1].mock.products[0].available).toBe(false);
    const withdrawn = await db.query<{ last_pushed_published: boolean; remote_id: string }>(
      `SELECT last_pushed_published, remote_id FROM website_product_map WHERE business_id = $1 AND connection_id = $2 AND local_id = $3`,
      [business, sites[0].id, itemId],
    );
    expect(withdrawn.rows[0]).toMatchObject({ last_pushed_published: false, remote_id: first.id });

    // Disconnect/reconnect is a pause, not an identity reset.
    await dbLib.withTenant(business, async () => {
      await connection.disconnectWebsite(business, sites[0].id);
      const reconnected = await connection.connectWebsite(business, { adapterKey: "mock", baseUrl: "", siteDomain: "a.example.test", apiKey: "" });
      if (!reconnected.ok) throw new Error(reconnected.error);
      expect(reconnected.connection.id).toBe(sites[0].id);
      await sync.syncWebsiteForBusiness(business, undefined, sites[0].id);
    });
    expect(sites[0].mock.products).toHaveLength(1);
    expect(sites[0].mock.products[0].id).toBe(first.id);
  }, 60_000);
});
