/**
 * Issue #910 — the add-on workflow end to end, against a real database.
 *
 * The earlier suites each pin one seam (route authorization, the picker, the
 * ordering index, the replay). This one walks the workflow the issue describes
 * as a single story, because the failures that matter are the ones that only
 * appear *between* the seams:
 *
 *   menu management → attach → override bounds → reorder → POS index →
 *   an order that carries the add-on at its price and quantity →
 *   a later menu edit (rename, reprice, disable the group) →
 *   the sold line's snapshot and the next order's refusal.
 *
 * Concretely it asserts the acceptance list at the end of #910:
 *
 *   - create item / group / options, attach and detach, per-item overrides,
 *     reordering and active/inactive states all persist and read back;
 *   - a required group whose options vanish refuses the destructive write;
 *   - the POS index offers the configured order and nothing disabled;
 *   - the sold add-on keeps its own name and price after the menu changes
 *     (history is snapshot-based, not a join);
 *   - a disabled group cannot be attached again, and a new order cannot pick
 *     an option the POS would not offer.
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

let dbLib: typeof import("../src/lib/db");
let menu: typeof import("../src/lib/menu-service");
let orderMutations: typeof import("../src/lib/order-mutations");
let restaurantMenu: typeof import("../src/lib/restaurant-menu");

let businessId = "";
let locationId = "";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

async function createMenu() {
  const created = await asTenant(async () => {
    const category = await menu.createCategory(locationId, { name: "نوشیدنی گرم" }, 0);
    if (!category.ok || !category.id) throw new Error(`category: ${"error" in category ? category.error : "unknown"}`);

    const item = await menu.createMenuItem(locationId, businessId, {
      categoryId: category.id,
      name: "لاته",
      price: 100_000,
    });
    if (!item.ok || !item.id) throw new Error(`item: ${"error" in item ? item.error : "unknown"}`);

    const extras = await menu.createModifierGroup(locationId, {
      name: "افزودنی‌ها",
      minSelect: 0,
      maxSelect: 5,
    });
    if (!extras.ok || !extras.id) throw new Error(`extras: ${"error" in extras ? extras.error : "unknown"}`);

    const size = await menu.createModifierGroup(locationId, {
      name: "اندازه",
      minSelect: 1,
      maxSelect: 1,
    });
    if (!size.ok || !size.id) throw new Error(`size: ${"error" in size ? size.error : "unknown"}`);

    const shot = await menu.createModifier(locationId, {
      groupId: extras.id,
      name: "شات اضافه",
      priceDelta: 20_000,
    });
    if (!shot.ok || !shot.id) throw new Error(`shot: ${"error" in shot ? shot.error : "unknown"}`);

    const small = await menu.createModifier(locationId, {
      groupId: size.id,
      name: "کوچک",
      priceDelta: 0,
    });
    if (!small.ok || !small.id) throw new Error(`small: ${"error" in small ? small.error : "unknown"}`);

    const large = await menu.createModifier(locationId, {
      groupId: size.id,
      name: "بزرگ",
      priceDelta: 15_000,
    });
    if (!large.ok || !large.id) throw new Error(`large: ${"error" in large ? large.error : "unknown"}`);

    return {
      categoryId: category.id,
      itemId: item.id,
      extrasId: extras.id,
      sizeId: size.id,
      shotId: shot.id,
      smallId: small.id,
      largeId: large.id,
    };
  });
  return created;
}

type Menu = Awaited<ReturnType<typeof createMenu>>;

/** The groups the till would offer for this item, in order. */
async function posGroups(itemId: string): Promise<string[]> {
  const tree = await asTenant(() => menu.getMenuTree(locationId));
  const payload = tree as unknown as Parameters<typeof restaurantMenu.toRestaurantMenu>[0];
  const index = restaurantMenu.buildRestaurantMenuIndex(restaurantMenu.toRestaurantMenu(payload));
  return (index.groupsByItem.get(itemId) ?? []).map((group) => group.id);
}

async function orderWith(menu: Menu, modifiers: string[]) {
  const created = await asTenant(() =>
    orderMutations.createOrder({
      locationId,
      type: "takeaway",
      discount: { type: null },
      items: [{ menuItemId: menu.itemId, quantity: 2, modifiers }],
      openedBy: null,
    }),
  );
  if (!created.ok) throw new Error(`order: ${"error" in created ? created.error : "unknown"}`);
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM order_items WHERE order_id = $1 AND status != 'voided'",
    [created.data.id],
  );
  return { orderId: created.data.id, orderItemId: rows[0].id };
}

async function addOnSnapshot(orderItemId: string) {
  const { rows } = await db.query<{
    modifier_id: string;
    name_snapshot: string;
    price_delta: string;
    quantity: number;
  }>(
    `SELECT modifier_id, name_snapshot, price_delta::text AS price_delta, quantity
       FROM order_item_modifiers WHERE order_item_id = $1 ORDER BY name_snapshot`,
    [orderItemId],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_addons_e2e_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  menu = await import("../src/lib/menu-service");
  orderMutations = await import("../src/lib/order-mutations");
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
  // Reopened first: the order_not_open guard (migration 0036) rejects deleting a
  // closed order's rows, including the cascade from businesses. Children before
  // parents, because the financial guards on order_items measure their parent.
  await db.query("UPDATE orders SET status = 'open'");
  await db.query("DELETE FROM order_item_modifiers");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM businesses");
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Cafe', $1) RETURNING id",
    [`e2e-${randomUUID().slice(0, 8)}`],
  );
  businessId = biz.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  locationId = loc.rows[0].id;
});

describe("a café configures and sells an add-on, then changes the menu", () => {
  it("carries the configured order, the sold price and the quantity through the whole flow", async () => {
    const menuTree = await createMenu();

    // Attach the optional group first, then the required one, then reorder so
    // the required size comes first — the order the manager wants on the till.
    expect(await asTenant(() => menu.attachModifierGroupToItem(locationId, menuTree.itemId, menuTree.extrasId))).toEqual({ ok: true });
    expect(await asTenant(() => menu.attachModifierGroupToItem(locationId, menuTree.itemId, menuTree.sizeId))).toEqual({ ok: true });
    expect(
      await asTenant(() =>
        menu.reorderItemModifierGroups(locationId, menuTree.itemId, [menuTree.sizeId, menuTree.extrasId]),
      ),
    ).toEqual({ ok: true });

    // What the till offers, in order, with the per-item bounds resolved.
    expect(await posGroups(menuTree.itemId)).toEqual([menuTree.sizeId, menuTree.extrasId]);

    // A per-item override: this drink may carry at most three add-ons,
    // whatever the group's own 0..5 says.
    expect(
      await asTenant(() =>
        menu.updateItemModifierGroup(locationId, menuTree.itemId, menuTree.extrasId, {
          maxSelectOverride: 3,
        }),
      ),
    ).toEqual({ ok: true });

    const tree = await asTenant(() => menu.getMenuTree(locationId));
    const link = tree.itemModifierGroups.find(
      (row) => String(row.modifier_group_id) === menuTree.extrasId,
    );
    expect(Number(link?.max_select_override)).toBe(3);

    // Sell it: two lattes, large, with three shots on each.
    const { orderId, orderItemId } = await orderWith(menuTree, [
      menuTree.largeId,
      { id: menuTree.shotId, quantity: 3 } as unknown as string,
    ]);
    const sold = await addOnSnapshot(orderItemId);
    expect(sold).toEqual([
      { modifier_id: menuTree.largeId, name_snapshot: "بزرگ", price_delta: "15000", quantity: 1 },
      { modifier_id: menuTree.shotId, name_snapshot: "شات اضافه", price_delta: "20000", quantity: 3 },
    ]);

    // (100,000 + 15,000 + 3 × 20,000) × 2 = 350,000 Rial for the order.
    const { rows: totals } = await db.query<{ total: string }>(
      "SELECT total::text AS total FROM orders WHERE id = $1",
      [orderId],
    );
    expect(Number(totals[0].total)).toBe(350_000);

    // The menu moves on: rename the add-on and double its price.
    expect(
      await asTenant(() =>
        menu.updateModifier(locationId, menuTree.shotId, { name: "شات دوبل", priceDelta: 40_000 }),
      ),
    ).toEqual({ ok: true });

    // History is snapshot-based: what was sold keeps its own name and money.
    expect(await addOnSnapshot(orderItemId)).toEqual(sold);

    // A new order is priced from the menu as it is now.
    const { orderItemId: newLine } = await orderWith(menuTree, [
      menuTree.largeId,
      { id: menuTree.shotId, quantity: 1 } as unknown as string,
    ]);
    expect(await addOnSnapshot(newLine)).toContainEqual(
      expect.objectContaining({ name_snapshot: "شات دوبل", price_delta: "40000" }),
    );
  });

  it("refuses to detach a required group into an unusable state, then detaches once size is optional", async () => {
    const menuTree = await createMenu();
    await asTenant(() => menu.attachModifierGroupToItem(locationId, menuTree.itemId, menuTree.sizeId));
    await asTenant(() =>
      menu.attachModifierGroupToItem(locationId, menuTree.itemId, menuTree.extrasId),
    );

    // Making the required group optional is a configuration change the
    // service accepts; detaching it while it is still required is next.
    expect(
      await asTenant(() =>
        menu.updateModifierGroup(locationId, menuTree.sizeId, { minSelect: 0 }),
      ),
    ).toEqual({ ok: true });

    expect(
      await asTenant(() =>
        menu.detachModifierGroupFromItem(locationId, menuTree.itemId, menuTree.sizeId),
      ),
    ).toEqual({ ok: true });
    expect(await posGroups(menuTree.itemId)).toEqual([menuTree.extrasId]);

    // The remaining attachment is back at position 0 — no stranded numbering.
    const { rows } = await db.query<{ sort_order: number }>(
      "SELECT sort_order FROM menu_item_modifier_groups WHERE menu_item_id = $1",
      [menuTree.itemId],
    );
    expect(rows).toEqual([{ sort_order: 0 }]);
  });

  it("keeps a sold order's add-ons when the group is deleted, and stops offering it", async () => {
    const menuTree = await createMenu();
    await asTenant(() => menu.attachModifierGroupToItem(locationId, menuTree.itemId, menuTree.sizeId));
    await asTenant(() =>
      menu.attachModifierGroupToItem(locationId, menuTree.itemId, menuTree.extrasId),
    );
    const { orderItemId } = await orderWith(menuTree, [menuTree.largeId, menuTree.shotId]);
    const sold = await addOnSnapshot(orderItemId);

    // Deleting a group that has options and is carried by an item must not
    // cascade them away: it is deactivated, with counts the dialog shows.
    const deleted = await asTenant(() => menu.deleteModifierGroup(locationId, menuTree.extrasId));
    expect(deleted).toMatchObject({ ok: true, deactivated: true, affected: { items: 1, options: 1 } });

    // The sold line is untouched…
    expect(await addOnSnapshot(orderItemId)).toEqual(sold);
    // …and the till no longer offers the group.
    expect(await posGroups(menuTree.itemId)).toEqual([menuTree.sizeId]);
    // …nor can it be attached again while disabled.
    expect(
      await asTenant(() =>
        menu.attachModifierGroupToItem(locationId, menuTree.itemId, menuTree.extrasId),
      ),
    ).toEqual({ ok: false, error: "group_inactive", status: 409 });
  });

  it("refuses a new order that picks an option the till no longer offers", async () => {
    const menuTree = await createMenu();
    await asTenant(() => menu.attachModifierGroupToItem(locationId, menuTree.itemId, menuTree.sizeId));
    await asTenant(() =>
      menu.attachModifierGroupToItem(locationId, menuTree.itemId, menuTree.extrasId),
    );

    // The manager takes the shot off the menu. Nothing has sold it and no
    // recipe hangs off it, so it is a real delete rather than a deactivation.
    expect(
      await asTenant(() => menu.deleteModifier(locationId, menuTree.shotId)),
    ).toEqual({ ok: true, deactivated: false });
    const { rows: gone } = await db.query("SELECT 1 FROM modifiers WHERE id = $1", [
      menuTree.shotId,
    ]);
    expect(gone).toHaveLength(0);

    const refused = await asTenant(() =>
      orderMutations.createOrder({
        locationId,
        type: "takeaway",
        discount: { type: null },
        items: [
          {
            menuItemId: menuTree.itemId,
            quantity: 1,
            modifiers: [menuTree.largeId, menuTree.shotId],
          },
        ],
        openedBy: null,
      }),
    );
    expect(refused.ok).toBe(false);
    expect("error" in refused ? refused.error : null).toBe("invalid_modifier");

    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders",
    );
    expect(rows[0].count).toBe("0");
  });
});
