/**
 * Issue #911 — one item edit, and one record of it, against a real database.
 *
 * The two contracts that cannot be proven without a database:
 *
 *  1. a patch carrying BOTH generic fields and a price is all-or-nothing. The
 *     old order wrote the fields with an UPDATE and only then ran the price
 *     change, so a refused price left the rename/activation committed and
 *     reported failure for an edit that had already half happened;
 *  2. every write records exactly one lifecycle event — business-, branch- and
 *     actor-scoped, with the before/after of the fields that changed — and
 *     price is never among them: a price has its own `menu.item.price_changed`
 *     event and its own append-only history row, and must not appear twice.
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
let menuService: typeof import("../src/lib/menu-service");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let mainId = "";
let otherId = "";
let userId = "";

/** The six lifecycle events this service writes — price deliberately absent. */
const LIFECYCLE_ACTIONS = [
  "menu.item.created",
  "menu.item.updated",
  "menu.item.moved",
  "menu.item.activated",
  "menu.item.deactivated",
  "menu.item.deleted",
] as const;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

async function insertCategory(locationId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, $2) RETURNING id",
    [locationId, `Drinks ${randomUUID().slice(0, 8)}`],
  );
  return rows[0].id;
}

async function insertItem(
  locationId: string,
  name = "لاته",
  price = 40_000,
  isActive = true,
): Promise<string> {
  const categoryId = await insertCategory(locationId);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [locationId, categoryId, name, price, isActive],
  );
  return rows[0].id;
}

async function readItem(id: string) {
  const { rows } = await db.query<{
    name: string;
    sku: string | null;
    is_active: boolean;
    category_id: string | null;
    price: string;
  }>(
    "SELECT name, sku, is_active, category_id, price::text AS price FROM menu_items WHERE id = $1",
    [id],
  );
  return rows[0];
}

/** Every lifecycle row of this business, newest last. */
async function lifecycleRows() {
  const { rows } = await db.query<{
    action: string;
    entity: string;
    entity_id: string;
    user_id: string | null;
    location_id: string | null;
    business_id: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT action, entity, entity_id, user_id, location_id, business_id, payload
       FROM audit_log
      WHERE action = ANY($1::text[])
      ORDER BY created_at, id`,
    [[...LIFECYCLE_ACTIONS]],
  );
  return rows;
}

async function priceEventRows() {
  const { rows } = await db.query<{ action: string; entity_id: string }>(
    "SELECT action, entity_id FROM audit_log WHERE action = 'menu.item.price_changed'",
  );
  return rows;
}

async function historyRows(menuItemId: string) {
  const { rows } = await db.query<{
    old_price_rial: string;
    new_price_rial: string;
  }>("SELECT old_price_rial, new_price_rial FROM menu_item_price_history WHERE menu_item_id = $1", [
    menuItemId,
  ]);
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_menu_lifecycle_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  menuService = await import("../src/lib/menu-service");
  dbLib = await import("../src/lib/db");

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

  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [businessId, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );
  userId = owner.rows[0].id;
});

describe("updateMenuItem — one edit, or none", () => {
  it("commits a combined edit: the new fields and the new price together", async () => {
    const item = await insertItem(mainId, "لاته", 40_000);

    const result = await menuService.updateMenuItem(
      mainId,
      item,
      { name: "لاتهٔ کارامل", price: 45_000 },
      businessId,
      { changedBy: userId, source: "manual" },
    );

    expect(result).toEqual({ ok: true });
    const row = await readItem(item);
    expect(row.name).toBe("لاتهٔ کارامل");
    expect(Number(row.price)).toBe(45_000);
  });

  it("leaves no field behind when the price step is refused", async () => {
    const item = await insertItem(mainId, "لاته", 40_000);
    const before = await readItem(item);

    // A price the canonical service will not accept, alongside three fields
    // it would happily have written. The price is checked before the first
    // statement now — the old order wrote the fields first and then refused.
    const result = await menuService.updateMenuItem(
      mainId,
      item,
      { name: "لاتهٔ کارامل", sku: "LAT-01", isActive: false, price: -1 },
      businessId,
      { changedBy: userId },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid_price",
      status: 400,
    });

    // Nothing persisted — not the name, not the SKU, not the switch.
    const after = await readItem(item);
    expect(after.name).toBe(before.name);
    expect(after.sku).toBe(before.sku);
    expect(after.is_active).toBe(before.is_active);
    expect(after.price).toBe(before.price);
    // And no record of an edit that did not happen.
    expect(await lifecycleRows()).toHaveLength(0);
    expect(await historyRows(item)).toHaveLength(0);
  });

  it("refuses another branch's item without touching it", async () => {
    const item = await insertItem(otherId, "چای", 20_000);

    const result = await menuService.updateMenuItem(
      mainId,
      item,
      { name: "چای دیگر" },
      businessId,
      { changedBy: userId },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "item_not_found",
      status: 404,
    });
    expect((await readItem(item)).name).toBe("چای");
  });
});

describe("updateMenuItem — the record of the edit", () => {
  it("writes exactly one lifecycle event for a field-only edit", async () => {
    const item = await insertItem(mainId, "لاته", 40_000);

    const result = await menuService.updateMenuItem(
      mainId,
      item,
      { name: "لاتهٔ کارامل", sku: "LAT-01" },
      businessId,
      { changedBy: userId },
    );
    expect(result).toEqual({ ok: true });

    const audits = await lifecycleRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "menu.item.updated",
      entity: "menu_item",
      entity_id: item,
      business_id: businessId,
      location_id: mainId,
      user_id: userId,
    });
    expect(audits[0].payload).toMatchObject({
      changed: ["name", "sku"],
      before: { name: "لاته", sku: null },
      after: { name: "لاتهٔ کارامل", sku: "LAT-01" },
    });
  });

  it("names the event for what the edit did: move, activate, deactivate", async () => {
    const item = await insertItem(mainId, "لاته", 40_000);
    const destination = await insertCategory(mainId);

    await menuService.updateMenuItem(mainId, item, { categoryId: destination }, businessId, {
      changedBy: userId,
    });
    await menuService.updateMenuItem(mainId, item, { isActive: false }, businessId, {
      changedBy: userId,
    });
    await menuService.updateMenuItem(mainId, item, { isActive: true }, businessId, {
      changedBy: userId,
    });

    // One row per write — never two for the same edit.
    const audits = await lifecycleRows();
    expect(audits.map((row) => row.action)).toEqual([
      "menu.item.moved",
      "menu.item.deactivated",
      "menu.item.activated",
    ]);
    for (const row of audits) {
      expect(row.business_id).toBe(businessId);
      expect(row.location_id).toBe(mainId);
      expect(row.user_id).toBe(userId);
    }
  });

  it("records a price in its own history only — never as a lifecycle event", async () => {
    const item = await insertItem(mainId, "لاته", 40_000);

    await menuService.updateMenuItem(mainId, item, { price: 45_000 }, businessId, {
      changedBy: userId,
    });

    // The price's own event and row …
    expect(await priceEventRows()).toHaveLength(1);
    expect(await historyRows(item)).toHaveLength(1);
    // … and no lifecycle row for the same write: one write, one record.
    expect(await lifecycleRows()).toHaveLength(0);
  });

  it("records one lifecycle row for a combined edit, on top of the price's own", async () => {
    const item = await insertItem(mainId, "لاته", 40_000);

    await menuService.updateMenuItem(
      mainId,
      item,
      { name: "لاتهٔ کارامل", price: 45_000 },
      businessId,
      {
        changedBy: userId,
      },
    );

    const audits = await lifecycleRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("menu.item.updated");
    // `changed` names the fields only — price is recorded elsewhere.
    expect(audits[0].payload).toMatchObject({ changed: ["name"] });
    expect(await historyRows(item)).toHaveLength(1);
  });

  it("attributes the edit to the actor who made it", async () => {
    const item = await insertItem(mainId, "لاته", 40_000);
    const other = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'manager', 'Manager', $2, 'x') RETURNING id`,
      [businessId, `manager-${randomUUID().slice(0, 8)}@example.test`],
    );

    await menuService.updateMenuItem(mainId, item, { name: "موکا" }, businessId, {
      changedBy: other.rows[0].id,
    });

    const audits = await lifecycleRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].user_id).toBe(other.rows[0].id);
    expect(audits[0].user_id).not.toBe(userId);
  });
});

describe("createMenuItem and deleteMenuItem — the ends of the lifecycle", () => {
  it("records the creation with the actor and the item as created", async () => {
    const categoryId = await insertCategory(mainId);

    const created = await menuService.createMenuItem(
      mainId,
      businessId,
      { categoryId, name: "لاته", price: 40_000 },
      { changedBy: userId },
    );
    expect(created.ok).toBe(true);

    const audits = await lifecycleRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "menu.item.created",
      entity_id: created.id,
      business_id: businessId,
      location_id: mainId,
      user_id: userId,
    });
    expect(audits[0].payload).toMatchObject({
      after: { name: "لاته", isActive: true },
    });
    // Creating an item is not a price change: no history row, no price event.
    expect(await priceEventRows()).toHaveLength(0);
  });

  it("records a delete as a delete, and a refusal to delete as a deactivation", async () => {
    const deletable = await insertItem(mainId, "لاته", 40_000);
    const kept = await insertItem(mainId, "موکا", 30_000);
    // An order line is what forces «deactivate instead».
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, status, total)
       VALUES ($1, 1, 'open', 30000) RETURNING id`,
      [mainId],
    );
    await db.query(
      `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, quantity, unit_price)
       VALUES ($1, $2, $3, 'موکا', 1, 30000)`,
      [mainId, order.rows[0].id, kept],
    );

    const deleted = await menuService.deleteMenuItem(mainId, deletable, businessId, {
      changedBy: userId,
    });
    const deactivated = await menuService.deleteMenuItem(mainId, kept, businessId, {
      changedBy: userId,
    });

    expect(deleted).toEqual({ ok: true, deactivated: false });
    expect(deactivated).toEqual({ ok: true, deactivated: true });
    expect(
      (await db.query("SELECT id FROM menu_items WHERE id = $1", [deletable])).rows,
    ).toHaveLength(0);
    expect((await readItem(kept)).is_active).toBe(false);

    const audits = await lifecycleRows();
    expect(audits.map((row) => row.action)).toEqual(["menu.item.deleted", "menu.item.deactivated"]);
    for (const row of audits) {
      expect(row.business_id).toBe(businessId);
      expect(row.location_id).toBe(mainId);
      expect(row.user_id).toBe(userId);
    }
  });
});
