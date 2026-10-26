/**
 * Issue #943, item 1 — the catalogue page is read in SQL, scoped to one
 * tenant + one connection, and it stays honest at a real catalogue size.
 *
 * What is proven here, against a real database:
 *
 *   1. SCALE + STABILITY: a connection with >1000 mapped products pages
 *      through SQL with a stable order (name → remote id tie-breaker): a
 *      full sweep visits every row exactly once, and repeated reads of the
 *      same page return the same rows.
 *   2. INTERLEAVED UPDATES: renames, quantity flips, type changes, mapping
 *      deletions and inserts between sweeps are visible immediately (no
 *      stale cache, no in-memory snapshot), and the post-update sweep is
 *      still complete and duplicate-free.
 *   3. SCOPING: another tenant's products never appear, and a second
 *      connection of the SAME tenant is its own catalogue — search terms
 *      that exist only in the other scope return zero rows.
 *   4. SEMANTIC PARITY: search / type facets / summary counts computed in
 *      SQL equal what the pure in-memory helpers (catalogueRowMatches,
 *      catalogueSummary) compute over the same rows — the two readings of
 *      the one rule cannot drift silently.
 *   5. UNTRACKED HONESTY (item 4): variable/grouped/external rows never
 *      carry a fabricated quantity, and never count as out-of-stock.
 *   6. F&B: the menu_items branch returns the same page shape.
 *   7. ROUTE-LEVEL CROSS-TENANT MATRIX (item 6): the real GET handler,
 *      backed by the real database and the real connection accessor, 404s
 *      another tenant's session and serves the owning one.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";
import {
  catalogueRowMatches,
  catalogueSummary,
  sortCatalogueRows,
  type CatalogueListRow,
} from "../src/lib/integrations/woo-catalogue";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "ab".repeat(32);

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let sync: typeof import("../src/lib/integrations/sync-service");

const A = { id: "", locationId: "", conn1: "", conn2: "", userId: "" };
const B = { id: "", locationId: "", conn1: "", userId: "" };
const C = { id: "", locationId: "", conn1: "" };

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

async function seedBusiness(slug: string, industry: string): Promise<{ id: string; locationId: string }> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
    [`Biz ${slug}`, slug, industry],
  );
  const id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [id],
  );
  return { id, locationId: locRow.rows[0].id };
}

async function seedConnection(businessId: string, locationId: string, currency: "toman" | "rial"): Promise<string> {
  const row = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
     VALUES ($1, $2, 'Store', 'https://shop.example.com', $3, $4, $5, $6, true, true, true, true, true)
     RETURNING id`,
    [
      businessId,
      locationId,
      encryptSecret("ck_test", Buffer.from(KEY, "hex")),
      encryptSecret("cs_test", Buffer.from(KEY, "hex")),
      encryptSecret("wh_test", Buffer.from(KEY, "hex")),
      currency,
    ],
  );
  return row.rows[0].id;
}

/** A membership the connection accessor can resolve (role + branch scope). */
async function seedUser(businessId: string, role: "owner" | "manager"): Promise<string> {
  const row = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash)
     VALUES ($1, $2::user_role, 'Test Owner', 'x') RETURNING id`,
    [businessId, role],
  );
  return row.rows[0].id;
}

/** One mapping row with the metadata `recordProductShape` would have written. */
async function seedMapping(
  businessId: string,
  connectionId: string,
  remoteId: string,
  localId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
     VALUES ($1, $2, 'product', $3, $4, $5::jsonb)`,
    [businessId, connectionId, remoteId, localId, JSON.stringify(meta)],
  );
}

beforeAll(async () => {
  databaseName = `pos_woo_page_${randomUUID().replaceAll("-", "")}`;

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

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // -----------------------------------------------------------------------
  // Tenant A (retail): conn1 is the >1000-row catalogue; conn2 is a small
  // hand-built set with exact expected contents (semantic parity + snapshot
  // fields). Tenant B is the cross-tenant probe. Tenant C is F&B.
  // -----------------------------------------------------------------------
  Object.assign(A, await seedBusiness(`a-${randomUUID().slice(0, 8)}`, "accessories"));
  A.conn1 = await seedConnection(A.id, A.locationId, "toman");
  A.conn2 = await seedConnection(A.id, A.locationId, "rial");
  Object.assign(B, await seedBusiness(`b-${randomUUID().slice(0, 8)}`, "accessories"));
  B.conn1 = await seedConnection(B.id, B.locationId, "toman");
  Object.assign(C, await seedBusiness(`c-${randomUUID().slice(0, 8)}`, "food_service"));
  C.conn1 = await seedConnection(C.id, C.locationId, "toman");
  A.userId = await seedUser(A.id, "owner");
  B.userId = await seedUser(B.id, "owner");

  // --- A/conn1: 1010 simples (deterministic quantities, categories, legacy
  // metadata, remote images), 50 variable parents + 100 variations, and the
  // non-tracked / extension shapes. Total: 1210 mappings.
  await db.query(
    `WITH new_items AS (
       INSERT INTO items (location_id, name, sku, kind)
       SELECT $2, 'محصول ' || lpad(i::text, 4, '0'), 'SKU-' || lpad(i::text, 4, '0'), 'simple'
       FROM generate_series(1, 1010) AS i
       RETURNING id, sku
     ), stocked AS (
       INSERT INTO item_stock (item_id, quantity, unit_price)
       SELECT id, (substr(sku, 5)::int % 10), 15000 FROM new_items
       RETURNING 1
     )
     INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
     SELECT $1, $3, 'product', substr(ni.sku, 5)::int::text, ni.id,
            CASE
              WHEN substr(ni.sku, 5)::int % 101 = 0 THEN '{}'::jsonb  -- legacy: no recorded shape
              WHEN substr(ni.sku, 5)::int % 50 = 0 THEN jsonb_build_object(
                'wooType', 'simple', 'remoteStatus', 'publish', 'remoteManageStock', true,
                'remoteRegularPriceRial', '15000',
                'remoteImageSrc', 'https://shop.example/img/' || substr(ni.sku, 5) || '.jpg',
                'remoteImageAlt', 'تصویر ' || substr(ni.sku, 5))
              ELSE jsonb_build_object(
                'wooType', 'simple', 'remoteStatus', 'publish', 'remoteManageStock', true,
                'remoteRegularPriceRial', '15000')
            END
     FROM new_items ni`,
    [A.id, A.locationId, A.conn1],
  );
  // Ten percent of the simples are in the remote category «دسته ویژه».
  await db.query(
    `INSERT INTO integration_woo_terms (business_id, connection_id, taxonomy, remote_id, name, slug)
     VALUES ($1, $2, 'product_cat', '900', 'دسته ویژه', 'special')`,
    [A.id, A.conn1],
  );
  await db.query(
    `INSERT INTO integration_woo_product_terms (business_id, connection_id, remote_id, taxonomy, term_remote_id)
     SELECT $1, $2, remote_id, 'product_cat', '900'
       FROM integration_mappings
      WHERE connection_id = $2 AND entity_type = 'product'
        AND remote_id ~ '^[0-9]+$' AND remote_id::int <= 1010 AND remote_id::int % 3 = 0`,
    [A.id, A.conn1],
  );

  // 50 variable parents (no stock row — a container holds no quantity).
  await db.query(
    `WITH new_items AS (
       INSERT INTO items (location_id, name, sku, kind)
       SELECT $2, 'والد ' || lpad(j::text, 4, '0'), 'VAR-' || lpad(j::text, 4, '0'), 'variant_parent'
       FROM generate_series(1, 50) AS j
       RETURNING id, sku
     )
     INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
     SELECT $1, $3, 'product', (2000 + substr(ni.sku, 5)::int)::text, ni.id,
            jsonb_build_object('wooType', 'variable', 'remoteStatus', 'publish', 'remoteManageStock', false)
     FROM new_items ni`,
    [A.id, A.locationId, A.conn1],
  );
  // 100 variations (two per parent), each with its colour attribute.
  await db.query(
    `WITH parents AS (
       SELECT id, substr(sku, 5)::int AS j FROM items
        WHERE location_id = $2 AND sku LIKE 'VAR-%' AND kind = 'variant_parent'
     ), new_items AS (
       INSERT INTO items (location_id, parent_item_id, name, sku, kind)
       SELECT $2, p.id,
              CASE WHEN g.c = 0 THEN 'تنوع قرمز ' || lpad(p.j::text, 4, '0') ELSE 'تنوع آبی ' || lpad(p.j::text, 4, '0') END,
              'VAR-' || lpad(p.j::text, 4, '0') || CASE WHEN g.c = 0 THEN '-R' ELSE '-B' END,
              'variant_child'
       FROM parents p CROSS JOIN generate_series(0, 1) AS g(c)
       RETURNING id, sku
     ), stocked AS (
       INSERT INTO item_stock (item_id, quantity, unit_price)
       SELECT id, 5, 16000 FROM new_items RETURNING 1
     ), attrs AS (
       INSERT INTO item_variant_attributes (item_id, name, value)
       SELECT id, 'رنگ', CASE WHEN sku LIKE '%-R' THEN 'قرمز' ELSE 'آبی' END FROM new_items
       RETURNING 1
     )
     INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
     SELECT $1, $3, 'product',
            (3000 + (substr(ni.sku, 5, 4)::int - 1) * 2 + CASE WHEN ni.sku LIKE '%-R' THEN 0 ELSE 1 END)::text,
            ni.id,
            jsonb_build_object('wooType', 'variation',
                               'remoteParentId', (2000 + substr(ni.sku, 5, 4)::int)::text,
                               'remoteStatus', 'publish', 'remoteManageStock', true,
                               'remoteRegularPriceRial', '16000')
     FROM new_items ni`,
    [A.id, A.locationId, A.conn1],
  );
  // The shapes that must never carry a fabricated quantity: grouped shelves
  // and external listings get STALE stock rows on purpose — the reader has
  // to null them out by shape, not by the absence of a row.
  const shapeSeeds: [prefix: string, base: number, kind: string, wooType: string, qty: number | null, count: number][] = [
    ["GRP", 4000, "variant_parent", "grouped", 7, 10],
    ["EXT", 4100, "simple", "external", 0, 10],
    ["BND", 4200, "simple", "bundle", 3, 10],
    ["CMP", 4300, "simple", "composite", 2, 5],
    ["SUB", 4400, "simple", "subscription", 2, 5],
    ["UNK", 4500, "simple", "unknown", 1, 10],
  ];
  for (const [prefix, base, kind, wooType, qty, count] of shapeSeeds) {
    await db.query(
      `WITH new_items AS (
         INSERT INTO items (location_id, name, sku, kind)
         SELECT $2, $4 || ' ' || k::text, $3 || '-' || k::text, $5
         FROM generate_series(1, $8) AS k
         RETURNING id, sku
       ), stocked AS (
         INSERT INTO item_stock (item_id, quantity, unit_price)
         SELECT id, $6::numeric, 12000 FROM new_items WHERE $6::numeric IS NOT NULL RETURNING 1
       )
       INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
       SELECT $1, $9, 'product', ($7 + substr(ni.sku, length($3) + 2)::int)::text, ni.id,
              jsonb_build_object('wooType', $4, 'remoteStatus', 'publish', 'remoteManageStock', $6::numeric IS NOT NULL)
       FROM new_items ni`,
      [A.id, A.locationId, prefix, wooType, kind, qty, base, count, A.conn1],
    );
  }
  // Twenty simples share one name: the remote-id tie-breaker is what keeps
  // their page boundary from wobbling between reads.
  await db.query(
    `UPDATE items SET name = 'نام یکسان'
      WHERE location_id = $1 AND sku LIKE 'SKU-%' AND substr(sku, 5)::int BETWEEN 900 AND 919`,
    [A.locationId],
  );

  // --- A/conn2: five hand-built rows with exact expected contents.
  const a2: [remoteId: string, name: string, sku: string, kind: string, qty: number | null, price: number | null, meta: Record<string, unknown>][] = [
    ["1", "الف", "A2-1", "simple", 2, 1000, { remoteStatus: "draft", remoteManageStock: true, remoteImageSrc: "https://a2.example/1.jpg", remoteImageAlt: "تصویر الف" }],
    ["2", "ب", "A2-2", "variant_parent", null, null, { wooType: "variable", remoteStatus: "publish", remoteManageStock: false }],
    ["3", "پ", "A2-3", "variant_child", 0, 2500, { wooType: "variation", remoteParentId: "2", remoteStatus: "publish", remoteManageStock: true }],
    ["4", "delta External", "A2-4", "simple", 0, 900, { wooType: "external", remoteStatus: "publish", remoteManageStock: false }],
    ["5", "الف", "A2-5", "simple", 5, 3000, { wooType: "simple", remoteStatus: "publish", remoteManageStock: true }],
  ];
  for (const [remoteId, name, sku, kind, qty, price, meta] of a2) {
    const itemRow = await db.query<{ id: string }>(
      `INSERT INTO items (location_id, name, sku, kind, parent_item_id)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'variant_child'
         THEN (SELECT id FROM items WHERE location_id = $1 AND sku = 'A2-2') ELSE NULL END)
       RETURNING id`,
      [A.locationId, name, sku, kind],
    );
    if (qty !== null) {
      await db.query(`INSERT INTO item_stock (item_id, quantity, unit_price) VALUES ($1, $2, $3)`, [
        itemRow.rows[0].id,
        qty,
        price,
      ]);
    } else if (price !== null) {
      await db.query(`INSERT INTO item_stock (item_id, unit_price) VALUES ($1, $2)`, [itemRow.rows[0].id, price]);
    }
    await seedMapping(A.id, A.conn2, remoteId, itemRow.rows[0].id, meta);
  }
  await db.query(`INSERT INTO item_variant_attributes (item_id, name, value)
     SELECT id, 'رنگ', 'قرمز' FROM items WHERE location_id = $1 AND sku = 'A2-3'`, [A.locationId]);
  await db.query(`INSERT INTO item_variant_attributes (item_id, name, value)
     SELECT id, '', 'L' FROM items WHERE location_id = $1 AND sku = 'A2-3'`, [A.locationId]);
  await db.query(
    `INSERT INTO integration_woo_terms (business_id, connection_id, taxonomy, remote_id, name, slug)
     VALUES ($1, $2, 'product_cat', '700', 'دسته آلفا', 'alpha')`,
    [A.id, A.conn2],
  );
  await db.query(
    `INSERT INTO integration_woo_product_terms (business_id, connection_id, remote_id, taxonomy, term_remote_id)
     VALUES ($1, $2, '1', 'product_cat', '700')`,
    [A.id, A.conn2],
  );

  // --- Tenant B: five products whose names exist nowhere in tenant A.
  await db.query(
    `WITH new_items AS (
       INSERT INTO items (location_id, name, sku, kind)
       SELECT $2, 'B-ONLY TOKEN ' || i::text, 'BSKU-' || i::text, 'simple'
       FROM generate_series(1, 5) AS i
       RETURNING id, sku
     ), stocked AS (
       INSERT INTO item_stock (item_id, quantity, unit_price) SELECT id, 3, 999 FROM new_items RETURNING 1
     )
     INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
     SELECT $1, $3, 'product', substr(ni.sku, 6), ni.id, jsonb_build_object('wooType', 'simple')
     FROM new_items ni`,
    [B.id, B.locationId, B.conn1],
  );

  // --- Tenant C (F&B): three menu items.
  await db.query(
    `WITH new_items AS (
       INSERT INTO menu_items (location_id, name, sku, price)
       VALUES ($2, 'پیتزا مارگاریتا', 'MZ-1', 250000),
              ($2, 'سالاد سزار', 'MZ-2', 180000),
              ($2, 'نوشابه', 'MZ-3', 30000)
       RETURNING id, sku
     )
     INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
     SELECT $1, $3, 'product', substr(ni.sku, 4), ni.id,
            CASE ni.sku WHEN 'MZ-2' THEN jsonb_build_object('wooType', 'simple', 'remoteStatus', 'draft',
                 'remoteImageSrc', 'https://c.example/salad.jpg', 'remoteImageAlt', 'سالاد')
            ELSE '{}'::jsonb END
     FROM new_items ni`,
    [C.id, C.locationId, C.conn1],
  );
  await db.query(
    `INSERT INTO integration_woo_terms (business_id, connection_id, taxonomy, remote_id, name, slug)
     VALUES ($1, $2, 'product_cat', '11', 'گرم', 'hot')`,
    [C.id, C.conn1],
  );
  await db.query(
    `INSERT INTO integration_woo_product_terms (business_id, connection_id, remote_id, taxonomy, term_remote_id)
     VALUES ($1, $2, '1', 'product_cat', '11')`,
    [C.id, C.conn1],
  );
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
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

describe("the catalogue page: scoped, stable, honest at 1210 rows", () => {
  it("counts the whole scoped catalogue and nothing from anyone else's", async () => {
    const a1 = await sync.cataloguePageFor(A.id, A.conn1);
    expect(a1.mappedTotal).toBe(1210);
    expect(a1.total).toBe(1210);
    expect(a1.rows).toHaveLength(25); // default page size
    expect(a1.totalPages).toBe(Math.ceil(1210 / 25));

    const a2 = await sync.cataloguePageFor(A.id, A.conn2);
    expect(a2.mappedTotal).toBe(5);

    const b1 = await sync.cataloguePageFor(B.id, B.conn1);
    expect(b1.mappedTotal).toBe(5);

    // The other tenant's connection id under this tenant: no mappings, no
    // rows, no error — an empty register, never someone else's products.
    const crossed = await sync.cataloguePageFor(A.id, B.conn1);
    expect(crossed.mappedTotal).toBe(0);
    expect(crossed.rows).toEqual([]);

    // A search term that exists only in tenant B finds nothing in tenant A.
    const probe = await sync.cataloguePageFor(A.id, A.conn1, { search: "b-only token" });
    expect(probe.total).toBe(0);
    const probeSku = await sync.cataloguePageFor(B.id, B.conn1, { search: "sku-0007" });
    expect(probeSku.total).toBe(0);
  });

  it("sweeps every page exactly once at the maximum page size — no duplicate, no miss", async () => {
    const seen = new Set<string>();
    let pages = 0;
    for (let page = 1; pages < 13; page += 1) {
      const result = await sync.cataloguePageFor(A.id, A.conn1, { page, pageSize: 100 });
      expect(result.page).toBe(page);
      expect(result.pageSize).toBe(100);
      expect(result.total).toBe(1210);
      if (result.rows.length === 0) break;
      pages += 1;
      for (const row of result.rows) {
        expect(seen.has(row.remoteId), `duplicate ${row.remoteId} on page ${page}`).toBe(false);
        seen.add(row.remoteId);
      }
      // The tie-breaker holds inside every page: rows sharing a name are
      // ordered by remote id, which is what makes the boundary stable.
      for (let i = 1; i < result.rows.length; i += 1) {
        if (result.rows[i - 1].name === result.rows[i].name) {
          expect(result.rows[i - 1].remoteId < result.rows[i].remoteId).toBe(true);
        }
      }
    }
    expect(pages).toBe(13); // ceil(1210 / 100)
    expect(seen.size).toBe(1210);

    // The same page twice is the same page: an ordering that wobbled between
    // identical reads would move rows across boundaries on every refresh.
    const first = await sync.cataloguePageFor(A.id, A.conn1, { page: 5, pageSize: 100 });
    const again = await sync.cataloguePageFor(A.id, A.conn1, { page: 5, pageSize: 100 });
    expect(again.rows.map((r) => r.remoteId)).toEqual(first.rows.map((r) => r.remoteId));
  }, 60_000);

  it("computes the summary and the facets over the WHOLE catalogue, by shape not by guess", async () => {
    const result = await sync.cataloguePageFor(A.id, A.conn1, { pageSize: 10 });
    expect(result.summary).toEqual({
      total: 1210,
      // 1210 − 50 variable parents − 10 grouped shelves; external stays sellable.
      sellable: 1150,
      containers: 60,
      variations: 100,
      // Only TRACKED products at zero: 101 simples whose index ends in 0.
      // The stale zero on the external listings and the grouped shelf's 7
      // are not quantities this app may count — they are not tracked shapes.
      outOfStock: 101,
      uncategorised: 1210 - 336,
    });
    // Facets: every type in the scope, C-ordered, regardless of the page.
    expect(result.types).toEqual([
      "bundle", "composite", "external", "grouped", "simple", "subscription", "unknown", "variable", "variation",
    ]);
  });

  it("nulls the quantity of every untracked shape, even with a stale stock row", async () => {
    const grouped = await sync.cataloguePageFor(A.id, A.conn1, { type: "grouped", pageSize: 10 });
    expect(grouped.total).toBe(10);
    for (const row of grouped.rows) {
      expect(row.stockTracked).toBe(false);
      expect(row.quantity).toBeNull(); // the seed planted a 7 on every one
      expect(row.sellable).toBe(false);
    }
    const external = await sync.cataloguePageFor(A.id, A.conn1, { type: "external", pageSize: 10 });
    expect(external.total).toBe(10);
    for (const row of external.rows) {
      expect(row.stockTracked).toBe(false);
      expect(row.quantity).toBeNull(); // the seed planted a 0 on every one
      expect(row.sellable).toBe(true); // sold elsewhere, still a real product
    }
    const variable = await sync.cataloguePageFor(A.id, A.conn1, { type: "variable", pageSize: 50 });
    expect(variable.total).toBe(50);
    for (const row of variable.rows) {
      expect(row.stockTracked).toBe(false);
      expect(row.quantity).toBeNull();
      expect(row.sellable).toBe(false);
      expect(row.itemKind).toBe("variant_parent");
    }
    const simple = await sync.cataloguePageFor(A.id, A.conn1, { search: "sku-0007", pageSize: 10 });
    expect(simple.rows).toHaveLength(1);
    expect(simple.rows[0].stockTracked).toBe(true);
    expect(simple.rows[0].quantity).toBe(7); // 7 % 10
    expect(simple.rows[0].priceRial).toBe(15000n);
    expect(simple.rows[0].remoteImageSrc).toBeNull(); // 7 % 50 ≠ 0
  });

  it("searches name, SKU, type, category and attribute — one predicate, case-insensitive", async () => {
    const byName = await sync.cataloguePageFor(A.id, A.conn1, { search: "محصول 0007" });
    expect(byName.total).toBe(1);
    const bySkuUpper = await sync.cataloguePageFor(A.id, A.conn1, { search: "SKU-0007" });
    expect(bySkuUpper.total).toBe(1);
    expect(bySkuUpper.rows[0].remoteId).toBe(byName.rows[0].remoteId);
    // The type is part of the haystack, exactly like the pure predicate.
    const byType = await sync.cataloguePageFor(A.id, A.conn1, { search: "composite" });
    expect(byType.total).toBe(5);
    const byCategory = await sync.cataloguePageFor(A.id, A.conn1, { search: "دسته ویژه" });
    expect(byCategory.total).toBe(336);
    const byAttribute = await sync.cataloguePageFor(A.id, A.conn1, { search: "رنگ: قرمز" });
    expect(byAttribute.total).toBe(50); // the red half of the 100 variations
    const byParentBadge = await sync.cataloguePageFor(A.id, A.conn1, { search: "والد 0003" });
    expect(byParentBadge.total).toBe(1);
    const nothing = await sync.cataloguePageFor(A.id, A.conn1, { search: "چیزی که وجود ندارد" });
    expect(nothing.total).toBe(0);
    expect(nothing.rows).toEqual([]);
    // Search AND type compose: the facets stay whole while the list narrows.
    const composed = await sync.cataloguePageFor(A.id, A.conn1, { search: "تنوع", type: "variation" });
    expect(composed.total).toBe(100);
    expect(composed.summary.total).toBe(1210);
    expect(composed.types.length).toBe(9);
  });

  it("filters by taxonomy term, status and stock, offers the facets, and mirrors the gallery", async () => {
    // A tag on the first ten simples, plus a two-image gallery on one of them.
    await db.query(
      `INSERT INTO integration_woo_terms (business_id, connection_id, taxonomy, remote_id, name, slug)
       VALUES ($1, $2, 'product_tag', '910', 'پرفروش', 'best')`,
      [A.id, A.conn1],
    );
    await db.query(
      `INSERT INTO integration_woo_product_terms (business_id, connection_id, remote_id, taxonomy, term_remote_id)
       SELECT $1, $2, remote_id, 'product_tag', '910'
         FROM integration_mappings
        WHERE connection_id = $2 AND entity_type = 'product' AND remote_id ~ '^[0-9]+$' AND remote_id::int BETWEEN 1 AND 10`,
      [A.id, A.conn1],
    );
    await db.query(
      `UPDATE integration_mappings
          SET last_pushed_payload = last_pushed_payload || jsonb_build_object(
                'remoteGallery', jsonb_build_array(
                  jsonb_build_object('src', 'https://shop.example/g1.jpg', 'alt', 'اول'),
                  jsonb_build_object('src', 'https://shop.example/g2.jpg', 'alt', 'دوم'),
                  jsonb_build_object('alt', 'بدون نشانی')))
        WHERE connection_id = $1 AND entity_type = 'product' AND remote_id = '5'`,
      [A.conn1],
    );

    const byCategory = await sync.cataloguePageFor(A.id, A.conn1, { taxonomy: "product_cat", term: "900" });
    expect(byCategory.total).toBe(336);
    const byTag = await sync.cataloguePageFor(A.id, A.conn1, { taxonomy: "product_tag", term: "910" });
    expect(byTag.total).toBe(10);
    expect(byTag.rows.every((row) => row.tags.includes("پرفروش"))).toBe(true);
    // A tag is searchable and shown, like a category.
    expect((await sync.cataloguePageFor(A.id, A.conn1, { search: "پرفروش" })).total).toBe(10);
    // Both halves of a term filter are needed; one alone filters nothing.
    expect((await sync.cataloguePageFor(A.id, A.conn1, { taxonomy: "product_tag" })).total).toBe(1210);
    expect((await sync.cataloguePageFor(A.id, A.conn1, { term: "910" })).total).toBe(1210);
    // Filters compose with each other and with search.
    const tagAndCat = await sync.cataloguePageFor(A.id, A.conn1, {
      taxonomy: "product_tag",
      term: "910",
      search: "محصول 0003",
    });
    expect(tagAndCat.total).toBe(1);
    // A term of another taxonomy under the same id does not leak across.
    expect((await sync.cataloguePageFor(A.id, A.conn1, { taxonomy: "product_cat", term: "910" })).total).toBe(0);

    // Stock: tracked at zero, tracked above zero, and shapes with no quantity.
    const out = await sync.cataloguePageFor(A.id, A.conn1, { stock: "out" });
    const inStock = await sync.cataloguePageFor(A.id, A.conn1, { stock: "in" });
    const untracked = await sync.cataloguePageFor(A.id, A.conn1, { stock: "untracked" });
    expect(out.total + inStock.total + untracked.total).toBe(1210);
    expect(out.rows.every((row) => row.stockTracked && row.quantity === 0)).toBe(true);
    expect(untracked.rows.every((row) => !row.stockTracked && row.quantity === null)).toBe(true);
    expect(out.total).toBe(out.summary.outOfStock);
    // An unknown stock word is no filter, not an empty page.
    expect((await sync.cataloguePageFor(A.id, A.conn1, { stock: "sideways" })).total).toBe(1210);

    // Status.
    const published = await sync.cataloguePageFor(A.id, A.conn1, { status: "publish" });
    expect(published.rows.every((row) => row.remoteStatus === "publish")).toBe(true);
    const publishCount = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM integration_mappings
        WHERE connection_id = $1 AND entity_type = 'product' AND last_pushed_payload->>'remoteStatus' = 'publish'`,
      [A.conn1],
    );
    expect(published.total).toBe(publishCount.rows[0].n);
    expect((await sync.cataloguePageFor(A.id, A.conn1, { status: "no-such-status" })).total).toBe(0);

    // Facets cover the whole scoped catalogue, unfiltered, with counts.
    const faceted = await sync.cataloguePageFor(A.id, A.conn1, { taxonomy: "product_tag", term: "910" });
    expect(faceted.facets.categories).toEqual([{ remoteId: "900", name: "دسته ویژه", count: 336 }]);
    expect(faceted.facets.tags).toEqual([{ remoteId: "910", name: "پرفروش", count: 10 }]);
    expect(faceted.facets.statuses).toContain("publish");
    // …and never another connection's or tenant's terms.
    const other = await sync.cataloguePageFor(A.id, A.conn2, {});
    expect(other.facets.categories.map((term) => term.remoteId)).not.toContain("900");
    expect(other.facets.tags).toEqual([]);
    const tenantB = await sync.cataloguePageFor(B.id, B.conn1, {});
    expect(tenantB.facets.tags).toEqual([]);

    // The gallery survives, malformed entries dropped.
    const gallery = await sync.cataloguePageFor(A.id, A.conn1, { taxonomy: "product_tag", term: "910", search: "SKU-0005" });
    expect(gallery.rows[0].remoteGallery).toEqual([
      { src: "https://shop.example/g1.jpg", alt: "اول" },
      { src: "https://shop.example/g2.jpg", alt: "دوم" },
    ]);
    expect(byTag.rows.find((row) => row.remoteId !== "5")?.remoteGallery).toEqual([]);
  });

  it("agrees with the pure in-memory helpers on the hand-built connection", async () => {
    // The SQL reader replaced an in-memory pipeline; on a connection small
    // enough to hold in one page, the pure helpers (the old rule, kept and
    // unit-tested) must compute the very same answers over the same rows.
    const all = await sync.cataloguePageFor(A.id, A.conn2, { pageSize: 100 });
    expect(all.rows).toHaveLength(5);

    const asListRows: CatalogueListRow[] = all.rows.map((r) => ({
      remoteId: r.remoteId, name: r.name, sku: r.sku, wooType: r.wooType,
      sellable: r.sellable, quantity: r.quantity, categories: r.categories, attributes: r.attributes,
    }));
    // Same order the pure sort produces (fa name order, remote-id tie-break).
    expect(all.rows.map((r) => r.remoteId)).toEqual(sortCatalogueRows(asListRows).map((r) => r.remoteId));

    for (const search of ["الف", "a2-3", "variation", "دسته آلفا", "قرمز", "external", ""]) {
      const sql = await sync.cataloguePageFor(A.id, A.conn2, { search: search || undefined, pageSize: 100 });
      const pure = asListRows.filter((r) => catalogueRowMatches(r, { search }));
      expect(sql.rows.map((r) => r.remoteId), `search «${search}»`).toEqual(pure.map((r) => r.remoteId));
    }
    for (const type of ["simple", "variable", "variation", "external", "grouped"]) {
      const sql = await sync.cataloguePageFor(A.id, A.conn2, { type, pageSize: 100 });
      const pure = asListRows.filter((r) => catalogueRowMatches(r, { type }));
      expect(sql.rows.map((r) => r.remoteId), `type «${type}»`).toEqual(pure.map((r) => r.remoteId));
    }

    // The summary parity runs over the rows as the pure helper sees them —
    // with untracked quantities already nulled, exactly as SQL returns them.
    const pureSummary = catalogueSummary(asListRows as never);
    expect(all.summary).toEqual({ ...pureSummary, total: 5 });
    expect(all.summary).toMatchObject({ sellable: 4, containers: 1, variations: 1, outOfStock: 1, uncategorised: 4 });
  });

  it("carries the full row contract: snapshots, images, attributes, parents, legacy fallbacks", async () => {
    const all = await sync.cataloguePageFor(A.id, A.conn2, { pageSize: 100 });
    const byId = new Map(all.rows.map((r) => [r.remoteId, r]));

    const legacy = byId.get("1")!;
    expect(legacy.wooType).toBe("simple"); // no recorded shape → the item kind decides
    expect(legacy.itemKind).toBe("simple");
    expect(legacy.categories).toEqual(["دسته آلفا"]);
    expect(legacy.attributes).toEqual([]);
    expect(legacy.remoteStatus).toBe("draft");
    expect(legacy.remoteManageStock).toBe(true);
    expect(legacy.remoteImageSrc).toBe("https://a2.example/1.jpg");
    expect(legacy.remoteImageAlt).toBe("تصویر الف");
    expect(legacy.priceRial).toBe(1000n);
    expect(legacy.quantity).toBe(2);
    expect(typeof legacy.lastSyncedAt).toBe("string");

    const parent = byId.get("2")!;
    expect(parent.wooType).toBe("variable");
    expect(parent.sellable).toBe(false);
    expect(parent.quantity).toBeNull();

    const variation = byId.get("3")!;
    expect(variation.parentRemoteId).toBe("2");
    expect(variation.itemKind).toBe("variant_child");
    expect(variation.attributes).toEqual(["L", "رنگ: قرمز"]); // ORDER BY name: '' first
    expect(variation.quantity).toBe(0);
    expect(variation.stockTracked).toBe(true);

    const external = byId.get("4")!;
    expect(external.sellable).toBe(true);
    expect(external.stockTracked).toBe(false);
    expect(external.quantity).toBeNull(); // stale 0 in item_stock, nulled by shape

    // The two «الف» rows keep the remote-id tie-break.
    expect(all.rows.filter((r) => r.name === "الف").map((r) => r.remoteId)).toEqual(["1", "5"]);
  });

  it("clamps page and pageSize and normalises the search, like the dashboard expects", async () => {
    const tiny = await sync.cataloguePageFor(A.id, A.conn1, { pageSize: 1 });
    expect(tiny.pageSize).toBe(10);
    const huge = await sync.cataloguePageFor(A.id, A.conn1, { pageSize: 10_000 });
    expect(huge.pageSize).toBe(100);
    const zeroPage = await sync.cataloguePageFor(A.id, A.conn1, { page: 0 });
    expect(zeroPage.page).toBe(1);
    const junk = await sync.cataloguePageFor(A.id, A.conn1, { page: Number.NaN, pageSize: Number.NaN });
    expect(junk.page).toBe(1);
    expect(junk.pageSize).toBe(25);
    // Past the end: an honest empty page, with the totals still true.
    const pastEnd = await sync.cataloguePageFor(A.id, A.conn1, { page: 999, pageSize: 100 });
    expect(pastEnd.rows).toEqual([]);
    expect(pastEnd.total).toBe(1210);
    expect(pastEnd.totalPages).toBe(13);
    // Padded search: trimmed, lower-cased, capped at 200 characters.
    const padded = await sync.cataloguePageFor(A.id, A.conn1, { search: `  SKU-0007  ${"x".repeat(300)}` });
    expect(padded.total).toBe(0); // the padding pushed the term past 200 chars — cut, not crashed
    const short = await sync.cataloguePageFor(A.id, A.conn1, { search: "  sku-0007 " });
    expect(short.total).toBe(1);
  });

  it("reads the F&B branch with the same page shape", async () => {
    const fnb = await sync.cataloguePageFor(C.id, C.conn1, { pageSize: 10 });
    expect(fnb.industry).toBe("food_service");
    expect(fnb.mappedTotal).toBe(3);
    const pizza = fnb.rows.find((r) => r.name === "پیتزا مارگاریتا")!;
    expect(pizza.itemKind).toBeNull();
    expect(pizza.wooType).toBe("simple"); // legacy mapping → the F&B default
    expect(pizza.quantity).toBeNull(); // a menu item has no stock model here
    expect(pizza.priceRial).toBe(250000n);
    expect(pizza.attributes).toEqual([]);
    expect(pizza.categories).toEqual(["گرم"]);
    const salad = fnb.rows.find((r) => r.name === "سالاد سزار")!;
    expect(salad.remoteStatus).toBe("draft");
    expect(salad.remoteImageSrc).toBe("https://c.example/salad.jpg");
    expect(fnb.summary.outOfStock).toBe(0); // null is never zero
    expect(fnb.summary.uncategorised).toBe(2);
    const search = await sync.cataloguePageFor(C.id, C.conn1, { search: "پیتزا" });
    expect(search.total).toBe(1);
  });
});

describe("the catalogue page under interleaved updates", () => {
  it("sees renames, deletions, inserts and type flips between sweeps — and stays complete", async () => {
    const before = await sync.cataloguePageFor(A.id, A.conn1, { pageSize: 100, page: 1 });
    expect(before.mappedTotal).toBe(1210);

    // A page read, then the ground moves mid-sweep: thirty renames (rows
    // travel through the order), a quantity flips to zero, the bundles are
    // re-typed as simples, five grouped mappings are deleted (the products
    // were removed remotely), and three new products arrive.
    const partial = await sync.cataloguePageFor(A.id, A.conn1, { pageSize: 100, page: 2 });
    expect(partial.rows.length).toBeGreaterThan(0);

    await db.query(
      `UPDATE items SET name = 'محصول رتبه‌بالا ' || lpad(substr(sku, 5), 4, '0')
        WHERE location_id = $1 AND sku LIKE 'SKU-%' AND substr(sku, 5)::int <= 30`,
      [A.locationId],
    );
    await db.query(
      `UPDATE item_stock SET quantity = 0
        WHERE item_id = (SELECT id FROM items WHERE location_id = $1 AND sku = 'SKU-0011')`,
      [A.locationId],
    );
    await db.query(
      `UPDATE integration_mappings SET last_pushed_payload = last_pushed_payload || '{"wooType":"simple"}'::jsonb
        WHERE connection_id = $1 AND entity_type = 'product' AND remote_id::int BETWEEN 4201 AND 4210`,
      [A.conn1],
    );
    await db.query(
      `DELETE FROM integration_mappings
        WHERE connection_id = $1 AND entity_type = 'product' AND remote_id::int BETWEEN 4001 AND 4005`,
      [A.conn1],
    );
    await db.query(
      `WITH new_items AS (
         INSERT INTO items (location_id, name, sku, kind)
         SELECT $2, 'تازه‌وارد ' || i::text, 'NEW-' || i::text, 'simple'
         FROM generate_series(1, 3) AS i
         RETURNING id, sku
       ), stocked AS (
         INSERT INTO item_stock (item_id, quantity, unit_price) SELECT id, 4, 8000 FROM new_items RETURNING 1
       )
       INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
       SELECT $1, $3, 'product', (9000 + substr(ni.sku, 5)::int)::text, ni.id, jsonb_build_object('wooType', 'simple')
       FROM new_items ni`,
      [A.id, A.locationId, A.conn1],
    );

    // Every number follows the database, immediately — nothing is cached
    // from the previous read.
    const after = await sync.cataloguePageFor(A.id, A.conn1, { pageSize: 100, page: 1 });
    expect(after.mappedTotal).toBe(1208); // 1210 − 5 deleted + 3 inserted
    expect(after.summary).toMatchObject({
      total: 1208,
      containers: 55, // five grouped shelves went away
      sellable: 1153,
      variations: 100,
      outOfStock: 102, // SKU-0011 joined the zero club
    });
    expect(after.types).toEqual([
      "composite", "external", "grouped", "simple", "subscription", "unknown", "variable", "variation",
    ]); // 'bundle' is gone: the facet list is not a museum
    const bundles = await sync.cataloguePageFor(A.id, A.conn1, { type: "bundle" });
    expect(bundles.total).toBe(0);
    const reTyped = await sync.cataloguePageFor(A.id, A.conn1, { search: "bnd-" });
    expect(reTyped.total).toBe(10);
    expect(reTyped.rows.every((r) => r.wooType === "simple")).toBe(true);

    // The renames moved rows through the order — the fresh sweep is still
    // complete and duplicate-free, which is the property that matters: a
    // page boundary may shift when the data shifts, but no row is lost.
    const seen = new Set<string>();
    for (let page = 1; page <= 13; page += 1) {
      const result = await sync.cataloguePageFor(A.id, A.conn1, { page, pageSize: 100 });
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        expect(seen.has(row.remoteId), `duplicate ${row.remoteId} on page ${page} after updates`).toBe(false);
        seen.add(row.remoteId);
      }
    }
    expect(seen.size).toBe(1208);

    // And the renamed rows are findable under their new names at once.
    const renamed = await sync.cataloguePageFor(A.id, A.conn1, { search: "رتبه‌بالا 0001" });
    expect(renamed.total).toBe(1);
    const fresh = await sync.cataloguePageFor(A.id, A.conn1, { search: "تازه‌وارد" });
    expect(fresh.total).toBe(3);
  }, 90_000);
});

describe("the catalogue route across tenants, against the real database", () => {
  it("serves the owning tenant and 404s everyone else, through the real handler", async () => {
    // Only the identity check is mocked (a test cannot mint a session); the
    // route, the tenant scope, the connection accessor, the SQL reader and
    // the database are all real — this is the tenant axis of the item-6
    // role matrix, with the permission axis covered in the route's own
    // unit suite (which asserts the woocommerce.view gate and pass-through
    // of a denial).
    let session: { businessId: string; sub: string; role: string } = {
      businessId: A.id,
      sub: A.userId,
      role: "owner",
    };
    vi.resetModules();
    vi.doMock("../src/lib/auth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/auth")>();
      return {
        ...actual,
        // The cookie reader needs Next's request store, which does not
        // exist in vitest; the identity it would produce is exactly the
        // mocked session below. Everything else — the connection access
        // check, the SQL reader, the queue states — stays real.
        withTenantScope: (handler: (...args: unknown[]) => Promise<unknown>) => handler,
        requirePermission: vi.fn(async () => ({ session, error: null })),
      };
    });
    const { GET } = await import("../src/app/api/integrations/connections/[id]/catalogue/route");

    const request = new Request(
      `http://localhost/api/integrations/connections/${A.conn1}/catalogue?page=1&pageSize=10`,
    );
    const context = { params: Promise.resolve({ id: A.conn1 }) };
    const ok = await GET(request as never, context as never);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body.mappedTotal).toBe(1208); // the state the previous describe left behind
    expect(Array.isArray(body.products)).toBe(true);

    // Tenant B's session asking for tenant A's connection: 404, and none of
    // A's catalogue in the body.
    session = { businessId: B.id, sub: B.userId, role: "owner" };
    const denied = await GET(request as never, context as never);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "not_found" });
    vi.doUnmock("../src/lib/auth");
  });
});
