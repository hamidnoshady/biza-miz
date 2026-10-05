/**
 * The canonical price service and the atomic reorder, against a real
 * database — both write in one transaction, so a unit test can only prove the
 * pure helpers (issue #844's `menu-price-service.test.ts`); this pins the
 * contract the screen and every writer depend on:
 *
 *  1. a price change locks → validates → updates the current price → appends
 *     exactly one immutable `menu_item_price_history` row → writes the
 *     `menu.item.price_changed` audit event, all in one transaction;
 *  2. `old == new` writes nothing (no history, no audit) — a no-op PATCH is
 *     not a price change;
 *  3. an invalid price is refused before anything is written;
 *  4. the recorded source comes from the calling path, never a request body;
 *  5. `updateMenuItem` routes a price patch through the service (and a patch
 *     without price leaves history alone);
 *  6. `changeMenuItemPriceWith` joins the caller's transaction: a rolled-back
 *     caller loses its history row with the price write;
 *  7. reorder rewrites every ordinal in ONE statement — a full ordering lands
 *     with no duplicate sort_order, duplicates in the id list are refused
 *     before any write, and ids from another branch fail the whole call.
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
let priceService: typeof import("../src/lib/menu-price-service");
let menuService: typeof import("../src/lib/menu-service");
let menuValidation: typeof import("../src/lib/menu-validation");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let mainId = "";
let otherId = "";
let userId = "";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

async function insertItem(locationId: string, name: string, price = 40_000): Promise<string> {
  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Drinks') RETURNING id",
    [locationId],
  );
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, $3, $4) RETURNING id",
    [locationId, category.rows[0].id, name, price],
  );
  return rows[0].id;
}

async function readItem(id: string) {
  const { rows } = await db.query<{ price: string }>("SELECT price FROM menu_items WHERE id = $1", [
    id,
  ]);
  return rows[0];
}

async function historyRows(menuItemId: string) {
  const { rows } = await db.query<{
    old_price_rial: string;
    new_price_rial: string;
    source: string;
    changed_by: string | null;
    reason: string | null;
    source_ref: string | null;
  }>(
    `SELECT old_price_rial, new_price_rial, source, changed_by, reason, source_ref
       FROM menu_item_price_history WHERE menu_item_id = $1 ORDER BY changed_at, id`,
    [menuItemId],
  );
  return rows;
}

async function auditRows(action: string) {
  const { rows } = await db.query<{ payload: Record<string, unknown>; user_id: string | null }>(
    `SELECT payload, user_id FROM audit_log WHERE business_id = $1 AND action = $2
      ORDER BY created_at DESC, id DESC`,
    [businessId, action],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_price_history_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  priceService = await import("../src/lib/menu-price-service");
  menuService = await import("../src/lib/menu-service");
  menuValidation = await import("../src/lib/menu-validation");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
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

  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [businessId, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );
  userId = owner.rows[0].id;
});

describe("changeMenuItemPrice", () => {
  it("updates the current price and appends exactly one history row", async () => {
    const item = await insertItem(mainId, "لاته", 40_000);

    const result = await priceService.changeMenuItemPrice({
      businessId,
      locationId: mainId,
      menuItemId: item,
      newPrice: 45_000,
      source: "manual",
      changedBy: userId,
      reason: "گران شدن شیر",
    });

    expect(result).toMatchObject({ ok: true, changed: true, oldPrice: 40_000, newPrice: 45_000 });
    expect(Number((await readItem(item)).price)).toBe(45_000);

    const history = await historyRows(item);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      old_price_rial: "40000",
      new_price_rial: "45000",
      source: "manual",
      changed_by: userId,
      reason: "گران شدن شیر",
    });
  });

  it("writes the shared menu.item.price_changed audit event with the change", async () => {
    const item = await insertItem(mainId, "موکا", 30_000);
    await priceService.changeMenuItemPrice({
      businessId,
      locationId: mainId,
      menuItemId: item,
      newPrice: 33_000,
      source: "ai",
      changedBy: userId,
      sourceRef: "proposal-1",
    });

    const audits = await auditRows("menu.item.price_changed");
    expect(audits).toHaveLength(1);
    expect(audits[0].user_id).toBe(userId);
    expect(audits[0].payload).toMatchObject({
      oldPrice: 30_000,
      newPrice: 33_000,
      source: "ai",
      sourceRef: "proposal-1",
    });
  });

  it("writes nothing when old == new", async () => {
    const item = await insertItem(mainId, "هات چاکلت", 25_000);

    const result = await priceService.changeMenuItemPrice({
      businessId,
      locationId: mainId,
      menuItemId: item,
      newPrice: 25_000,
      source: "manual",
      changedBy: userId,
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(await historyRows(item)).toHaveLength(0);
    expect(await auditRows("menu.item.price_changed")).toHaveLength(0);
  });

  it("refuses an invalid price before touching anything", async () => {
    const item = await insertItem(mainId, "آب پرتقال", 20_000);

    const result = await priceService.changeMenuItemPrice({
      businessId,
      locationId: mainId,
      menuItemId: item,
      newPrice: -1,
      source: "manual",
      changedBy: userId,
    });

    expect(result).toEqual({ ok: false, error: "invalid_price", status: 400 });
    expect(Number((await readItem(item)).price)).toBe(20_000);
    expect(await historyRows(item)).toHaveLength(0);
  });

  it("404s an item of another branch without writing", async () => {
    const theirs = await insertItem(otherId, "چای شعبهٔ دیگر", 15_000);

    const result = await priceService.changeMenuItemPrice({
      businessId,
      locationId: mainId,
      menuItemId: theirs,
      newPrice: 99_000,
      source: "manual",
      changedBy: userId,
    });

    expect(result).toEqual({ ok: false, error: "item_not_found", status: 404 });
    expect(await historyRows(theirs)).toHaveLength(0);
  });

  it("joins the caller's pinned transaction, so a rollback undoes price and history together", async () => {
    const item = await insertItem(mainId, "لاتهٔ دوبل", 50_000);

    await expect(
      dbLib.withTenantTransaction(businessId, async () => {
        // Inside withTenantTransaction, ambient query() IS the transaction:
        // changeMenuItemPrice detects the pin and joins it (no new BEGIN).
        const change = await priceService.changeMenuItemPrice({
          businessId,
          locationId: mainId,
          menuItemId: item,
          newPrice: 55_000,
          source: "import",
        });
        expect(change).toMatchObject({ ok: true, changed: true });

        // The write is visible before commit — it happened in this tx.
        expect(Number((await dbLib.query<{ price: string }>(
          "SELECT price FROM menu_items WHERE id = $1",
          [item],
        )).rows[0].price)).toBe(55_000);
        expect(
          (await dbLib.query("SELECT id FROM menu_item_price_history WHERE menu_item_id = $1", [item]))
            .rows,
        ).toHaveLength(1);

        throw new Error("caller rolled back");
      }),
    ).rejects.toThrow("caller rolled back");

    // Neither half of the change survived.
    expect(Number((await readItem(item)).price)).toBe(50_000);
    expect(await historyRows(item)).toHaveLength(0);
  });
});

describe("updateMenuItem price routing", () => {
  /**
   * The route's call: body validated as PATCH /api/menu/items/[id] validates
   * it, then the service runs inside the tenant scope.
   */
  function patchItem(
    id: string,
    body: unknown,
    context?: Parameters<typeof menuService.updateMenuItem>[4],
  ) {
    return dbLib.withTenant(businessId, async () => {
      const parsed = menuValidation.validateMenuItemPatch(body);
      if (!parsed.ok) return { ok: false as const, error: parsed.error, status: 400 };
      return menuService.updateMenuItem(mainId, id, parsed.value, businessId, context);
    });
  }

  it("routes a price patch through the service, recording the given source", async () => {
    const item = await insertItem(mainId, "کاپوچینو", 35_000);

    const updated = await patchItem(
      item,
      { price: 38_000 },
      { changedBy: userId, source: "integration", sourceRef: "api-key" },
    );

    expect(updated).toEqual({ ok: true });
    expect(Number((await readItem(item)).price)).toBe(38_000);
    const history = await historyRows(item);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      source: "integration",
      source_ref: "api-key",
      old_price_rial: "35000",
      new_price_rial: "38000",
    });
  });

  it("leaves history alone for a patch that carries no price", async () => {
    const item = await insertItem(mainId, "اسپرسو", 18_000);

    const updated = await patchItem(
      item,
      { name: "اسپرسو دوبل" },
      { changedBy: userId, source: "manual" },
    );

    expect(updated).toEqual({ ok: true });
    expect(await historyRows(item)).toHaveLength(0);
    expect(Number((await readItem(item)).price)).toBe(18_000);
  });
});

describe("reorderMenuCollection", () => {
  async function insertCategories(locationId: string, names: string[]): Promise<string[]> {
    const ids: string[] = [];
    let order = 0;
    for (const name of names) {
      const { rows } = await db.query<{ id: string }>(
        "INSERT INTO menu_categories (location_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id",
        [locationId, name, order++],
      );
      ids.push(rows[0].id);
    }
    return ids;
  }

  async function readOrders(ids: string[]): Promise<number[]> {
    const { rows } = await db.query<{ id: string; sort_order: number }>(
      "SELECT id, sort_order FROM menu_categories WHERE id = ANY($1::uuid[])",
      [ids],
    );
    const byId = new Map(rows.map((row) => [row.id, row.sort_order]));
    return ids.map((id) => byId.get(id)!);
  }

  it("applies a full ordering in one call with no duplicate positions", async () => {
    const [a, b, c] = await insertCategories(mainId, ["نوشیدنی سرد", "نوشیدنی گرم", "دسر"]);

    const result = await dbLib.withTenant(businessId, () =>
      menuService.reorderMenuCollection(mainId, "categories", [c, a, b]),
    );

    expect(result).toEqual({ ok: true });
    // The reversed list is renumbered 0..n-1 in a single UPDATE.
    expect(await readOrders([a, b, c])).toEqual([1, 2, 0]);
    const { rows } = await db.query<{ sort_order: number }>(
      "SELECT sort_order FROM menu_categories WHERE location_id = $1",
      [mainId],
    );
    expect(rows.map((r) => r.sort_order).sort()).toEqual([0, 1, 2]);
  });

  it("refuses duplicate ids before writing anything", async () => {
    const [a, b] = await insertCategories(mainId, ["کیک", "شیرینی"]);
    const before = await readOrders([a, b]);

    const result = await dbLib.withTenant(businessId, () =>
      menuService.reorderMenuCollection(mainId, "categories", [a, b, a]),
    );

    expect(result).toEqual({ ok: false, error: "bad_request", status: 400 });
    expect(await readOrders([a, b])).toEqual(before);
  });

  it("refuses an id from another branch instead of renumbering it", async () => {
    const [a, b] = await insertCategories(mainId, ["قهوه", "چای"]);
    const [theirs] = await insertCategories(otherId, ["چیز"]);
    const before = await readOrders([a, b]);

    const result = await dbLib.withTenant(businessId, () =>
      menuService.reorderMenuCollection(mainId, "categories", [a, theirs, b]),
    );

    expect(result).toEqual({ ok: false, error: "reorder_mismatch", status: 400 });
    expect(await readOrders([a, b])).toEqual(before);
    const { rows } = await db.query<{ sort_order: number }>(
      "SELECT sort_order FROM menu_categories WHERE id = $1",
      [theirs],
    );
    expect(rows[0].sort_order).toBe(0);
  });

  it("is a no-op for an empty list", async () => {
    expect(
      await dbLib.withTenant(businessId, () =>
        menuService.reorderMenuCollection(mainId, "categories", []),
      ),
    ).toEqual({ ok: true });
  });
});

describe("the history reads the screen uses", () => {
  it("lists newest first and filters by source; latest-per-item answers the items column", async () => {
    const itemA = await insertItem(mainId, "لاته", 40_000);
    const itemB = await insertItem(mainId, "موکا", 30_000);

    // B first so that DESC by changed_at puts A's second change on top.
    await priceService.changeMenuItemPrice({
      businessId,
      locationId: mainId,
      menuItemId: itemB,
      newPrice: 33_000,
      source: "integration",
      changedBy: null,
    });
    await priceService.changeMenuItemPrice({
      businessId,
      locationId: mainId,
      menuItemId: itemA,
      newPrice: 42_000,
      source: "manual",
      changedBy: userId,
    });
    await priceService.changeMenuItemPrice({
      businessId,
      locationId: mainId,
      menuItemId: itemA,
      newPrice: 45_000,
      source: "ai",
      changedBy: userId,
    });

    const all = await dbLib.withTenant(businessId, () => priceService.listPriceHistory(mainId));
    expect(all.map((row) => row.menuItemId)).toEqual([itemA, itemA, itemB]);
    expect(all[0]).toMatchObject({ newPriceRial: 45_000, oldPriceRial: 42_000, source: "ai" });
    expect(all[0].deltaPercent).toBe(7.1);

    const manualOnly = await dbLib.withTenant(businessId, () =>
      priceService.listPriceHistory(mainId, { sources: ["manual"] }),
    );
    expect(manualOnly).toHaveLength(1);
    expect(manualOnly[0].menuItemId).toBe(itemA);

    const latest = await dbLib.withTenant(businessId, () =>
      priceService.latestPriceChangesByItem(mainId),
    );
    expect(latest[itemA]).toMatchObject({ newPriceRial: 45_000, source: "ai" });
    expect(latest[itemB]).toMatchObject({ newPriceRial: 33_000, source: "integration" });

    const search = await dbLib.withTenant(businessId, () =>
      priceService.listPriceHistory(mainId, { search: "موکا" }),
    );
    expect(search).toHaveLength(1);
    expect(search[0].menuItemId).toBe(itemB);
  });
});
