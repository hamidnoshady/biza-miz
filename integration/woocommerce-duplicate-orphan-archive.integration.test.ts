/**
 * Dashboard audit F13 — clearing the creation-race orphans the pre-fix code left
 * behind, proved against a real database: only an unmapped twin of a live
 * WooCommerce-mapped item that nothing references is archived; everything else
 * is blocked and untouched; the archive is audited, reversible and confined to
 * the one business.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "ef".repeat(32);

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let sync: typeof import("../src/lib/integrations/sync-service");
let connections: typeof import("../src/lib/integrations/connections-service");
let resolve: typeof import("../src/lib/duplicate-items-resolve-service");

const biz = { id: "", locationId: "", connectionId: "", otherBizId: "", otherLocationId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function simpleProduct(id: number, sku: string, stock: number) {
  return {
    id,
    type: "simple",
    name: "اسپری دوفاز ضد موخوره",
    sku,
    price: "1027000",
    regular_price: "1027000",
    sale_price: "",
    manage_stock: true,
    stock_quantity: stock,
    stock_status: "instock",
    status: "publish",
    attributes: [],
    categories: [],
    images: [],
  };
}

/** Maps one remote product through the real sync, returning the kept twin's item id. */
async function mapProduct(remoteId: number, sku: string): Promise<string> {
  const connection = (await connections.getConnection(biz.id, biz.connectionId))!;
  await dbLib.withTenant(biz.id, () => sync.upsertProductFromWoo(connection, biz.locationId, simpleProduct(remoteId, sku, 1)));
  const { rows } = await db.query<{ local_id: string }>(
    `SELECT local_id::text FROM integration_mappings WHERE connection_id = $1 AND remote_id = $2`,
    [biz.connectionId, String(remoteId)],
  );
  return rows[0].local_id;
}

/** An unmapped twin, as the pre-fix race left it: same name and SKU, a frozen stock snapshot. */
async function insertOrphan(sku: string, locationId = biz.locationId): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `WITH i AS (INSERT INTO items (location_id, name, sku, kind) VALUES ($1, 'اسپری دوفاز ضد موخوره', $2, 'simple') RETURNING id),
          s AS (INSERT INTO item_stock (item_id, quantity) SELECT id, 1 FROM i)
     SELECT id::text FROM i`,
    [locationId, sku],
  );
  return rows[0].id;
}

async function isActive(itemId: string): Promise<boolean> {
  const { rows } = await db.query<{ is_active: boolean }>(`SELECT is_active FROM items WHERE id = $1`, [itemId]);
  return rows[0].is_active;
}

async function auditRows(itemId: string) {
  const { rows } = await db.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM audit_log WHERE action = 'item.duplicate_orphan_archived' AND entity_id = $1`,
    [itemId],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_woo_orphan_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(rootDatabaseUrl!);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
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
  connections = await import("../src/lib/integrations/connections-service");
  resolve = await import("../src/lib/duplicate-items-resolve-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Beauty', $1, 'cosmetics') RETURNING id",
    [`woo-orphan-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  biz.locationId = (
    await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [biz.id])
  ).rows[0].id;
  biz.connectionId = (
    await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, base_url,
          consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
          currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
       VALUES ($1, $2, 'Store', 'https://beauty.example.com', $3, $4, $5, 'toman', true, true, true, false, false)
       RETURNING id`,
      [
        biz.id,
        biz.locationId,
        encryptSecret("ck", Buffer.from(KEY, "hex")),
        encryptSecret("cs", Buffer.from(KEY, "hex")),
        encryptSecret("ws", Buffer.from(KEY, "hex")),
      ],
    )
  ).rows[0].id;

  // A second business with its own race orphan, which no run on the first may touch.
  biz.otherBizId = (
    await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Other', $1, 'cosmetics') RETURNING id",
      [`woo-orphan-o-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  biz.otherLocationId = (
    await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Other') RETURNING id", [biz.otherBizId])
  ).rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  const maintenanceUrl = new URL(rootDatabaseUrl!);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("archiving the losing twin of the creation race", () => {
  it("plans without writing, then archives only the orphan and audits it", async () => {
    const kept = await mapProduct(5023, "zza05023");
    const orphan = await insertOrphan("zza05023");
    const otherOrphan = await insertOrphan("zza05023", biz.otherLocationId);

    const mappingsBefore = await db.query(`SELECT count(*)::int AS n FROM integration_mappings`);
    const plans = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "zza05023" });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ orphanItemId: orphan, twinItemId: kept, status: "archive", blockers: [] });
    // The plan is read-only.
    expect(await isActive(orphan)).toBe(true);
    expect(await auditRows(orphan)).toHaveLength(0);

    const result = await resolve.archiveDuplicateOrphans(biz.id, plans);
    expect(result.archived.map((p) => p.orphanItemId)).toEqual([orphan]);
    expect(result.changedSincePlan).toEqual([]);

    expect(await isActive(orphan)).toBe(false);
    expect(await isActive(kept)).toBe(true);
    // Reversible and non-destructive: the row, its stock snapshot and every mapping stay.
    const stock = await db.query(`SELECT quantity::text FROM item_stock WHERE item_id = $1`, [orphan]);
    expect(Number(stock.rows[0].quantity)).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM integration_mappings`)).rows[0].n).toBe(mappingsBefore.rows[0].n);
    // Another business's orphan is untouched.
    expect(await isActive(otherOrphan)).toBe(true);
    // The audit row names the twin it duplicated.
    const audit = await auditRows(orphan);
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ sku: "zza05023", twinItemId: kept });
    expect(Number(audit[0].payload.orphanQuantity)).toBe(1);

    // Running it again finds nothing left to do.
    const again = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "zza05023" });
    expect(again.map((p) => p.status)).toEqual(["already_archived"]);
  });

  it("does not let the sync's own opening price row block an orphan", async () => {
    await mapProduct(5100, "zza05100");
    const orphan = await insertOrphan("zza05100");
    await db.query(
      `INSERT INTO product_price_history (business_id, location_id, item_id, price_kind, new_price, source, reason)
       VALUES ($1, $2, $3, 'sale', 1027000, 'sync', 'woocommerce_product_created')`,
      [biz.id, biz.locationId, orphan],
    );
    const [plan] = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "zza05100" });
    expect(plan.status).toBe("archive");
  });

  it("blocks an orphan with a barcode or a manual price change, and leaves it active", async () => {
    await mapProduct(5200, "zza05200");
    const withBarcode = await insertOrphan("zza05200");
    await db.query(`INSERT INTO item_barcodes (location_id, item_id, code, symbology) VALUES ($1, $2, '2000000052001', 'internal')`, [
      biz.locationId,
      withBarcode,
    ]);
    await mapProduct(5201, "zza05201");
    const withPrice = await insertOrphan("zza05201");
    await db.query(
      `INSERT INTO product_price_history (business_id, location_id, item_id, price_kind, new_price, source)
       VALUES ($1, $2, $3, 'sale', 1100000, 'manual')`,
      [biz.id, biz.locationId, withPrice],
    );

    const plans = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "zza05200" });
    expect(plans[0].status).toBe("blocked");
    expect(plans[0].references).toEqual([{ table: "item_barcodes", column: "item_id", count: 1 }]);
    const priced = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "zza05201" });
    expect(priced[0].status).toBe("blocked");
    expect(priced[0].references[0]).toMatchObject({ table: "product_price_history", count: 1 });

    const result = await resolve.archiveDuplicateOrphans(biz.id, [...plans, ...priced]);
    expect(result.archived).toEqual([]);
    expect(await isActive(withBarcode)).toBe(true);
    expect(await isActive(withPrice)).toBe(true);
  });

  it("re-checks under lock and leaves an orphan that gained a reference after the plan", async () => {
    await mapProduct(5300, "zza05300");
    const orphan = await insertOrphan("zza05300");
    const plans = await resolve.planDuplicateOrphanArchives(biz.id, { sku: "zza05300" });
    expect(plans[0].status).toBe("archive");

    await db.query(`INSERT INTO item_barcodes (location_id, item_id, code, symbology) VALUES ($1, $2, '2000000053000', 'internal')`, [
      biz.locationId,
      orphan,
    ]);
    const result = await resolve.archiveDuplicateOrphans(biz.id, plans);
    expect(result.archived).toEqual([]);
    expect(result.changedSincePlan).toHaveLength(1);
    expect(result.changedSincePlan[0].blockers).toEqual(["has_references"]);
    expect(await isActive(orphan)).toBe(true);
    expect(await auditRows(orphan)).toHaveLength(0);
  });

  it("ignores duplicate groups that are not a creation race", async () => {
    // Two hand-made rows, days apart: the report calls this unmapped_duplicate, never an orphan.
    await db.query(
      `INSERT INTO items (location_id, name, sku, created_at) VALUES
         ($1, 'سرم', 'MANUAL-1', now() - interval '2 days'), ($1, 'سرم', 'MANUAL-1', now())`,
      [biz.locationId],
    );
    expect(await resolve.planDuplicateOrphanArchives(biz.id, { sku: "MANUAL-1" })).toEqual([]);
  });
});
