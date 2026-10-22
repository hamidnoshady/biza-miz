/**
 * Issue #910 — whose order wins when a group's global position and the item's
 * own attachment order disagree.
 *
 * The documented rule is: **the item's attachment order wins** in every surface
 * that offers add-ons (POS tile, waiter panel, open-order editor). The editor's
 * arrows write `menu_item_modifier_groups.sort_order`; `buildRestaurantMenuIndex`
 * used to sort the attached groups by the group's *global* `sort_order` again,
 * which silently discarded that sequence — the manager reordered the groups,
 * the cashier saw them in another order, and the arrows looked like a lie.
 *
 * This suite pins the rule against real rows, for the two paths that can write
 * the order (attach appends, the atomic reorder reassigns), and shows that all
 * three surfaces resolve through the one index that implements it.
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

let menuService: typeof import("../src/lib/menu-service");
let dbLib: typeof import("../src/lib/db");
let restaurantMenu: typeof import("../src/lib/restaurant-menu");

let businessId = "";
let locationId = "";
let itemId = "";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function insertGroup(name: string, sortOrder: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO modifier_groups (location_id, name, sort_order, min_select, max_select)
     VALUES ($1, $2, $3, 0, 2) RETURNING id`,
    [locationId, name, sortOrder],
  );
  return rows[0].id;
}

async function insertOption(groupId: string, name: string, sortOrder = 0): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO modifiers (location_id, group_id, name, price_delta, sort_order)
     VALUES ($1, $2, $3, 0, $4) RETURNING id`,
    [locationId, groupId, name, sortOrder],
  );
  return rows[0].id;
}

/** The order the POS/waiter/order-editor actually render for one item. */
async function renderedOrder(): Promise<string[]> {
  const tree = await dbLib.withTenant(businessId, () =>
    menuService.getMenuTree(locationId),
  );
  const index = restaurantMenu.buildRestaurantMenuIndex(restaurantMenu.toRestaurantMenu(tree));
  return (index.groupsByItem.get(itemId) ?? []).map((group) => group.id);
}

beforeAll(async () => {
  databaseName = `pos_menu_order_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
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
  restaurantMenu = await import("../src/lib/restaurant-menu");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
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

  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  locationId = location.rows[0].id;

  const item = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, name, price) VALUES ($1, 'لاته', 100000) RETURNING id",
    [locationId],
  );
  itemId = item.rows[0].id;
});

describe("per-item group ordering — the item's own order wins", () => {
  it("renders the attachment order, not the groups' global order", async () => {
    // Global order is size, milk, extras (0,1,2); the item was configured the
    // other way round, which is exactly the case the old code lost.
    const size = await insertGroup("اندازه", 0);
    const milk = await insertGroup("شیر", 1);
    const extras = await insertGroup("افزودنی‌ها", 2);
    for (const group of [extras, size, milk]) {
      await insertOption(group, "گزینه");
      await dbLib.withTenant(businessId, () =>
        menuService.attachModifierGroupToItem(locationId, itemId, group),
      );
    }

    expect(await renderedOrder()).toEqual([extras, size, milk]);
  });

  it("follows the atomic reorder the editor's arrows call", async () => {
    const size = await insertGroup("اندازه", 0);
    const milk = await insertGroup("شیر", 1);
    const extras = await insertGroup("افزودنی‌ها", 2);
    for (const group of [size, milk, extras]) {
      await insertOption(group, "گزینه");
      await dbLib.withTenant(businessId, () =>
        menuService.attachModifierGroupToItem(locationId, itemId, group),
      );
    }
    expect(await renderedOrder()).toEqual([size, milk, extras]);

    expect(
      await dbLib.withTenant(businessId, () =>
        menuService.reorderItemModifierGroups(locationId, itemId, [milk, extras, size]),
      ),
    ).toEqual({ ok: true });
    expect(await renderedOrder()).toEqual([milk, extras, size]);
  });

  it("keeps the order stable when a group is detached from the middle", async () => {
    const first = await insertGroup("اول", 0);
    const second = await insertGroup("دوم", 1);
    const third = await insertGroup("سوم", 2);
    for (const group of [first, second, third]) {
      await insertOption(group, "گزینه");
      await dbLib.withTenant(businessId, () =>
        menuService.attachModifierGroupToItem(locationId, itemId, group),
      );
    }

    await dbLib.withTenant(businessId, () =>
      menuService.detachModifierGroupFromItem(locationId, itemId, second),
    );
    expect(await renderedOrder()).toEqual([first, third]);
  });

  it("drops an inactive link, an inactive group and an inactive option", async () => {
    const active = await insertGroup("فعال", 0);
    const inactiveGroup = await insertGroup("گروه غیرفعال", 1);
    const inactiveLink = await insertGroup("اتصال غیرفعال", 2);
    for (const group of [active, inactiveGroup, inactiveLink]) {
      await insertOption(group, "گزینه");
      await dbLib.withTenant(businessId, () =>
        menuService.attachModifierGroupToItem(locationId, itemId, group),
      );
    }
    await db.query("UPDATE modifier_groups SET is_active = false WHERE id = $1", [
      inactiveGroup,
    ]);
    await db.query(
      "UPDATE menu_item_modifier_groups SET is_active = false WHERE modifier_group_id = $1",
      [inactiveLink],
    );

    expect(await renderedOrder()).toEqual([active]);
  });

  it("offers the item's groups in the per-item order the manager saved, once deactivated groups are gone", async () => {
    // The end-to-end shape of the acceptance item: configure, reorder, disable
    // one, and read the rendered order back — the same call every surface makes.
    const size = await insertGroup("اندازه", 0);
    const milk = await insertGroup("شیر", 1);
    const extras = await insertGroup("افزودنی‌ها", 2);
    for (const group of [size, milk, extras]) {
      await insertOption(group, "گزینه");
      await dbLib.withTenant(businessId, () =>
        menuService.attachModifierGroupToItem(locationId, itemId, group),
      );
    }
    await dbLib.withTenant(businessId, () =>
      menuService.reorderItemModifierGroups(locationId, itemId, [extras, size, milk]),
    );
    await db.query("UPDATE modifier_groups SET is_active = false WHERE id = $1", [size]);

    expect(await renderedOrder()).toEqual([extras, milk]);

    // Re-enabling restores it in its saved slot, not at the end.
    await db.query("UPDATE modifier_groups SET is_active = true WHERE id = $1", [size]);
    expect(await renderedOrder()).toEqual([extras, size, milk]);
  });
});
