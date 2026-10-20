/**
 * Issue #911 — what the website catalogue may publish, against a real
 * database.
 *
 * `src/lib/website/catalog-service.test.ts` pins the predicate (no database
 * there); only a real one can prove what the predicate *does*: retiring a
 * category must take its products off the published catalogue, because the
 * till stops selling them the moment the category goes inactive — the POS
 * index has always dropped both an item in an inactive category and an item
 * with no category. Reactivating has to bring them straight back, and none of
 * it may reach across branches.
 *
 * `npm run test:db` (needs Postgres; not part of `npm test`).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

/** Imported after DATABASE_URL is pointed at the scratch DB. */
let dbLib: typeof import("../src/lib/db");
let catalog: typeof import("../src/lib/website/catalog-service");

let businessId = "";
let mainId = "";
let otherId = "";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

async function insertCategory(locationId: string, name: string, isActive = true): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name, is_active) VALUES ($1, $2, $3) RETURNING id",
    [locationId, name, isActive],
  );
  return rows[0].id;
}

async function insertItem(
  locationId: string,
  name: string,
  options: { categoryId?: string | null; isActive?: boolean } = {},
): Promise<string> {
  const { categoryId = null, isActive = true } = options;
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [locationId, categoryId, name, 120_000, isActive],
  );
  return rows[0].id;
}

/** The catalogue as the owner's screen sees it — a tenant-scoped read, like the request path. */
async function catalogue(locationId = mainId) {
  return dbLib.withTenant(businessId, () => catalog.listWebsiteCatalog(businessId, locationId), {
    locationId,
  });
}

async function listedMenuIds(locationId = mainId): Promise<string[]> {
  const rows = await catalogue(locationId);
  return rows.filter((row) => row.localKind === "menu_item").map((row) => row.localId);
}

beforeAll(async () => {
  databaseName = `pos_catalog_sellable_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  catalog = await import("../src/lib/website/catalog-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM businesses");

  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Cafe', $1) RETURNING id",
    [`cafe-${randomUUID().slice(0, 8)}`],
  );
  businessId = biz.rows[0].id;

  const locations = await db.query<{ id: string; name: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Other')
     RETURNING id, name`,
    [businessId],
  );
  mainId = locations.rows.find((r) => r.name === "Main")!.id;
  otherId = locations.rows.find((r) => r.name === "Other")!.id;
});

describe("listWebsiteCatalog — the sellable rule", () => {
  it("publishes an active item in an active category", async () => {
    const category = await insertCategory(mainId, `نوشیدنی ${randomUUID().slice(0, 8)}`);
    const item = await insertItem(mainId, "لاته", { categoryId: category });

    expect(await listedMenuIds()).toEqual([item]);
  });

  it("drops an item whose category is retired, and restores it on reactivation", async () => {
    const category = await insertCategory(mainId, `شیرینی ${randomUUID().slice(0, 8)}`);
    const item = await insertItem(mainId, "کیک", { categoryId: category });
    expect(await listedMenuIds()).toEqual([item]);

    // Retiring the category retires everything in it — this is the bug: the
    // till stops selling these, the website did not.
    await db.query("UPDATE menu_categories SET is_active = false WHERE id = $1", [category]);
    expect(await listedMenuIds()).not.toContain(item);

    // Reactivation brings it straight back, with no other change to the row.
    await db.query("UPDATE menu_categories SET is_active = true WHERE id = $1", [category]);
    expect(await listedMenuIds()).toContain(item);
  });

  it("keeps an inactive item and an item with no category unpublished", async () => {
    const category = await insertCategory(mainId, `نوشیدنی ${randomUUID().slice(0, 8)}`);
    const inactive = await insertItem(mainId, "موکا", {
      categoryId: category,
      isActive: false,
    });
    const uncategorised = await insertItem(mainId, "بدون دسته");

    const listed = await listedMenuIds();
    expect(listed).not.toContain(inactive);
    // The till never offers an item that sits in no category; the catalogue
    // does not either.
    expect(listed).not.toContain(uncategorised);
  });

  it("never publishes another branch's menu", async () => {
    const mainCategory = await insertCategory(mainId, `نوشیدنی ${randomUUID().slice(0, 8)}`);
    const mainItem = await insertItem(mainId, "لاته", {
      categoryId: mainCategory,
    });
    const otherCategory = await insertCategory(otherId, `نوشیدنی ${randomUUID().slice(0, 8)}`);
    const otherItem = await insertItem(otherId, "چای", {
      categoryId: otherCategory,
    });

    expect(await listedMenuIds(mainId)).toEqual([mainItem]);
    expect(await listedMenuIds(otherId)).toEqual([otherItem]);
  });
});
