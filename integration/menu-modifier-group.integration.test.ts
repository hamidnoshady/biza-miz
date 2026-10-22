/**
 * Moving a menu addon (a `modifiers` row) between modifier groups, against a
 * real database — `updateModifier` in menu-service.ts calls query() and so isn't
 * unit tested directly, per repo convention.
 *
 * What a move promises, and what this pins down:
 *   1. the addon re-parents and lands at the end of the target group's order,
 *      rather than keeping a sort_order that means nothing among new siblings;
 *   2. an explicit sortOrder in the same patch still wins;
 *   3. a group belonging to another branch is not a valid destination — the
 *      addon stays where it was;
 *   4. an addon from another branch can't be patched at all;
 *   5. name and price travel with the move in a single patch;
 *   6. naming the group the addon is already in is a no-op, not an error;
 *   7. closed orders that used the addon keep their own name/price snapshot, so
 *      no history moves with it.
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
let menuValidation: typeof import("../src/lib/menu-validation");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let mainId = "";
let otherId = "";
let orderNumber = 0;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

async function insertGroup(locationId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO modifier_groups (location_id, name) VALUES ($1, $2) RETURNING id",
    [locationId, name],
  );
  return rows[0].id;
}

async function insertModifier(
  locationId: string,
  groupId: string,
  name: string,
  opts: { priceDelta?: number; sortOrder?: number } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO modifiers (location_id, group_id, name, price_delta, sort_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [locationId, groupId, name, opts.priceDelta ?? 0, opts.sortOrder ?? 0],
  );
  return rows[0].id;
}

async function readModifier(id: string) {
  const { rows } = await db.query<{
    group_id: string;
    name: string;
    price_delta: string;
    sort_order: number;
    is_active: boolean;
  }>("SELECT group_id, name, price_delta, sort_order, is_active FROM modifiers WHERE id = $1", [id]);
  return rows[0];
}

/**
 * The route's call, inside the tenant scope every request runs in: the body is
 * validated exactly as PATCH /api/menu/modifiers/[id] validates it, then the
 * service runs. Calling the service with an unvalidated body would skip the
 * layer that trims names and rejects non-string ids.
 */
function patch(locationId: string, id: string, body: Record<string, unknown>) {
  return dbLib.withTenant(businessId, async () => {
    const parsed = menuValidation.validateModifierPatch(body);
    if (!parsed.ok) return { ok: false as const, error: parsed.error, status: 400 };
    return menuService.updateModifier(locationId, id, parsed.value);
  });
}

beforeAll(async () => {
  databaseName = `pos_modifier_group_${randomUUID().replaceAll("-", "")}`;

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
  // Reopened first: the order_not_open guard (migration 0036) rejects deleting a
  // closed order's rows, including the cascade from businesses.
  await db.query("UPDATE orders SET status = 'open'");
  // Child rows before parents: the financial guards on order_items measure
  // their parent's status, and an ON DELETE CASCADE removes the parent first.
  await db.query("DELETE FROM order_item_modifiers");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM businesses");
  orderNumber = 0;

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

describe("moving an addon to another group", () => {
  it("re-parents it and puts it last in the target group", async () => {
    const syrups = await insertGroup(mainId, "شربت‌ها");
    const milks = await insertGroup(mainId, "شیرها");
    await insertModifier(mainId, milks, "شیر بادام", { sortOrder: 0 });
    await insertModifier(mainId, milks, "شیر جو", { sortOrder: 4 });
    const vanilla = await insertModifier(mainId, syrups, "وانیل", { sortOrder: 2 });

    expect(await patch(mainId, vanilla, { groupId: milks })).toEqual({ ok: true });

    const moved = await readModifier(vanilla);
    expect(moved.group_id).toBe(milks);
    expect(moved.sort_order).toBe(5);
  });

  it("starts the order at zero when the target group is empty", async () => {
    const syrups = await insertGroup(mainId, "شربت‌ها");
    const milks = await insertGroup(mainId, "شیرها");
    const vanilla = await insertModifier(mainId, syrups, "وانیل", { sortOrder: 7 });

    expect(await patch(mainId, vanilla, { groupId: milks })).toEqual({ ok: true });
    expect((await readModifier(vanilla)).sort_order).toBe(0);
  });

  it("keeps an explicitly patched sortOrder instead of appending", async () => {
    const syrups = await insertGroup(mainId, "شربت‌ها");
    const milks = await insertGroup(mainId, "شیرها");
    await insertModifier(mainId, milks, "شیر جو", { sortOrder: 4 });
    const vanilla = await insertModifier(mainId, syrups, "وانیل");

    expect(await patch(mainId, vanilla, { groupId: milks, sortOrder: 1 })).toEqual({ ok: true });

    const moved = await readModifier(vanilla);
    expect(moved.group_id).toBe(milks);
    expect(moved.sort_order).toBe(1);
  });

  it("applies a rename and a new price in the same patch", async () => {
    const syrups = await insertGroup(mainId, "شربت‌ها");
    const milks = await insertGroup(mainId, "شیرها");
    const vanilla = await insertModifier(mainId, syrups, "وانیل", { priceDelta: 50_000 });

    expect(
      await patch(mainId, vanilla, { groupId: milks, name: " وانیل فرانسوی ", priceDelta: 80_000 }),
    ).toEqual({ ok: true });

    const moved = await readModifier(vanilla);
    expect(moved.group_id).toBe(milks);
    expect(moved.name).toBe("وانیل فرانسوی");
    expect(Number(moved.price_delta)).toBe(80_000);
  });

  it("treats the group it is already in as a no-op rather than a bad request", async () => {
    const syrups = await insertGroup(mainId, "شربت‌ها");
    const vanilla = await insertModifier(mainId, syrups, "وانیل", { sortOrder: 3 });

    expect(await patch(mainId, vanilla, { groupId: syrups })).toEqual({ ok: true });

    const unchanged = await readModifier(vanilla);
    expect(unchanged.group_id).toBe(syrups);
    expect(unchanged.sort_order).toBe(3);
  });

  it("refuses a group from another branch and leaves the addon where it was", async () => {
    const syrups = await insertGroup(mainId, "شربت‌ها");
    const otherGroup = await insertGroup(otherId, "شربت‌های شعبهٔ دیگر");
    const vanilla = await insertModifier(mainId, syrups, "وانیل");

    expect(await patch(mainId, vanilla, { groupId: otherGroup })).toEqual({
      ok: false,
      error: "group_not_found",
      status: 404,
    });
    expect((await readModifier(vanilla)).group_id).toBe(syrups);
  });

  it("refuses a made-up group id", async () => {
    const syrups = await insertGroup(mainId, "شربت‌ها");
    const vanilla = await insertModifier(mainId, syrups, "وانیل");

    expect(await patch(mainId, vanilla, { groupId: randomUUID() })).toEqual({
      ok: false,
      error: "group_not_found",
      status: 404,
    });
  });

  it("refuses a groupId that isn't a string", async () => {
    const syrups = await insertGroup(mainId, "شربت‌ها");
    const vanilla = await insertModifier(mainId, syrups, "وانیل");

    expect(await patch(mainId, vanilla, { groupId: 7 })).toEqual({
      ok: false,
      error: "bad_request",
      status: 400,
    });
  });

  it("does not reach an addon belonging to another branch", async () => {
    const otherGroup = await insertGroup(otherId, "شربت‌ها");
    const mainGroup = await insertGroup(mainId, "شیرها");
    const theirs = await insertModifier(otherId, otherGroup, "وانیل");

    expect(await patch(mainId, theirs, { groupId: mainGroup })).toEqual({
      ok: false,
      error: "modifier_not_found",
      status: 404,
    });
    expect((await readModifier(theirs)).group_id).toBe(otherGroup);
  });
});

describe("orders already placed with the addon", () => {
  it("keep their own name and price snapshot after the move", async () => {
    const syrups = await insertGroup(mainId, "شربت‌ها");
    const milks = await insertGroup(mainId, "شیرها");
    const vanilla = await insertModifier(mainId, syrups, "وانیل", { priceDelta: 50_000 });

    orderNumber += 1;
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, total, opened_at)
       VALUES ($1, $2, 'dine_in', 'open', 500000, now()) RETURNING id`,
      [mainId, orderNumber],
    );
    const item = await db.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price)
       VALUES ($1, $2, 'لاته', 450000) RETURNING id`,
      [mainId, order.rows[0].id],
    );
    // The financial guard (migration 0014) only lets modifier rows be written
    // while the order is open, so the sale is closed afterwards.
    await db.query(
      `INSERT INTO order_item_modifiers (order_item_id, modifier_id, name_snapshot, price_delta)
       VALUES ($1, $2, 'وانیل', 50000)`,
      [item.rows[0].id, vanilla],
    );
    await db.query("UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1", [
      order.rows[0].id,
    ]);

    expect(
      await patch(mainId, vanilla, { groupId: milks, name: "وانیل فرانسوی", priceDelta: 90_000 }),
    ).toEqual({ ok: true });

    const { rows } = await db.query<{
      modifier_id: string;
      name_snapshot: string;
      price_delta: string;
    }>("SELECT modifier_id, name_snapshot, price_delta FROM order_item_modifiers");
    expect(rows).toHaveLength(1);
    expect(rows[0].modifier_id).toBe(vanilla);
    expect(rows[0].name_snapshot).toBe("وانیل");
    expect(Number(rows[0].price_delta)).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// Issue #910 — the last active option must not leave a required group, and
// destructive group deletion must not erase configuration.
// ---------------------------------------------------------------------------

async function insertGroupWithBounds(
  locationId: string,
  name: string,
  minSelect: number,
  maxSelect: number,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO modifier_groups (location_id, name, min_select, max_select)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [locationId, name, minSelect, maxSelect],
  );
  return rows[0].id;
}

async function insertItem(locationId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, name, price) VALUES ($1, $2, 100000) RETURNING id",
    [locationId, name],
  );
  return rows[0].id;
}

async function attach(itemId: string, groupId: string): Promise<void> {
  await db.query(
    "INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id) VALUES ($1, $2)",
    [itemId, groupId],
  );
}

describe("moving the last active option out of a required group", () => {
  it("is refused without a partial move", async () => {
    const required = await insertGroupWithBounds(mainId, "اندازه", 1, 1);
    const optional = await insertGroup(mainId, "افزودنی‌ها");
    const size = await insertModifier(mainId, required, "بزرگ");
    const item = await insertItem(mainId, "لاته");
    await attach(item, required);

    // The only active option cannot leave: the item would become unorderable.
    expect(await patch(mainId, size, { groupId: optional })).toEqual({
      ok: false,
      error: "modifier_group_unsatisfiable",
      status: 409,
    });

    const unchanged = await readModifier(size);
    expect(unchanged.group_id).toBe(required);
    expect(unchanged.is_active).toBe(true);
  });

  it("allows the move once another active option remains", async () => {
    const required = await insertGroupWithBounds(mainId, "اندازه", 1, 1);
    const optional = await insertGroup(mainId, "افزودنی‌ها");
    const small = await insertModifier(mainId, required, "کوچک");
    const large = await insertModifier(mainId, required, "بزرگ");
    const item = await insertItem(mainId, "لاته");
    await attach(item, required);

    expect(await patch(mainId, large, { groupId: optional })).toEqual({ ok: true });
    expect((await readModifier(large)).group_id).toBe(optional);
    expect((await readModifier(small)).group_id).toBe(required);
  });

  it("still refuses deactivating the last active option", async () => {
    const required = await insertGroupWithBounds(mainId, "اندازه", 1, 1);
    const size = await insertModifier(mainId, required, "بزرگ");
    const item = await insertItem(mainId, "لاته");
    await attach(item, required);

    expect(await patch(mainId, size, { isActive: false })).toEqual({
      ok: false,
      error: "modifier_group_unsatisfiable",
      status: 409,
    });
    expect((await readModifier(size)).is_active).toBe(true);
  });
});

describe("concurrent option moves", () => {
  it("serialises two moves so a required group never ends up empty", async () => {
    const required = await insertGroupWithBounds(mainId, "اندازه", 1, 1);
    const firstTarget = await insertGroup(mainId, "هدف اول");
    const secondTarget = await insertGroup(mainId, "هدف دوم");
    const first = await insertModifier(mainId, required, "کوچک");
    const second = await insertModifier(mainId, required, "بزرگ");
    const item = await insertItem(mainId, "لاته");
    await attach(item, required);

    // Both requests read the same pre-write state if the group row is not
    // locked: each sees the other option still active and both moves pass,
    // leaving a required group with zero options. The row lock makes the
    // second guard read the first request's committed result, so exactly one
    // move is allowed and the other is refused.
    const results = await Promise.all([
      dbLib.withTenant(businessId, () =>
        menuService.updateModifier(mainId, first, { groupId: firstTarget }),
      ),
      dbLib.withTenant(businessId, () =>
        menuService.updateModifier(mainId, second, { groupId: secondTarget }),
      ),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter(
        (result) => !result.ok && result.error === "modifier_group_unsatisfiable",
      ),
    ).toHaveLength(1);

    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM modifiers WHERE group_id = $1 AND is_active",
      [required],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });
});

describe("deleteModifierGroup — configuration is preserved", () => {
  it("deactivates a group that still has options instead of cascading them away", async () => {
    const group = await insertGroup(mainId, "شربت‌ها");
    await insertModifier(mainId, group, "وانیل");

    expect(
      await dbLib.withTenant(businessId, () =>
        menuService.deleteModifierGroup(mainId, group),
      ),
    ).toEqual({
      ok: true,
      deactivated: true,
      affected: { items: 0, options: 1 },
    });

    const { rows } = await db.query<{ is_active: boolean }>(
      "SELECT is_active FROM modifier_groups WHERE id = $1",
      [group],
    );
    expect(rows[0].is_active).toBe(false);
    const options = await db.query("SELECT id FROM modifiers WHERE group_id = $1", [group]);
    expect(options.rows).toHaveLength(1);
  });

  it("deactivates a group an item still carries, keeping the attachment", async () => {
    const group = await insertGroupWithBounds(mainId, "شیرها", 0, 2);
    const item = await insertItem(mainId, "لاته");
    await attach(item, group);

    const result = await dbLib.withTenant(businessId, () =>
      menuService.deleteModifierGroup(mainId, group),
    );
    expect(result.ok).toBe(true);
    expect(result.deactivated).toBe(true);
    expect(result.affected).toEqual({ items: 1, options: 0 });

    const links = await db.query(
      "SELECT 1 FROM menu_item_modifier_groups WHERE modifier_group_id = $1",
      [group],
    );
    expect(links.rows).toHaveLength(1);
  });

  it("hard-deletes only a truly empty, unreferenced group", async () => {
    const group = await insertGroup(mainId, "خالی");

    expect(
      await dbLib.withTenant(businessId, () =>
        menuService.deleteModifierGroup(mainId, group),
      ),
    ).toEqual({
      ok: true,
      deactivated: false,
      affected: { items: 0, options: 0 },
    });

    const { rows } = await db.query("SELECT id FROM modifier_groups WHERE id = $1", [group]);
    expect(rows).toHaveLength(0);
  });

  it("never reaches a group from another branch", async () => {
    const otherGroup = await insertGroup(otherId, "شربت‌های شعبهٔ دیگر");

    expect(
      await dbLib.withTenant(businessId, () =>
        menuService.deleteModifierGroup(mainId, otherGroup),
      ),
    ).toEqual({ ok: false, error: "group_not_found", status: 404 });
    const { rows } = await db.query("SELECT id FROM modifier_groups WHERE id = $1", [otherGroup]);
    expect(rows).toHaveLength(1);
  });
});

describe("reorderItemModifierGroups — one atomic order per item", () => {
  it("stores the item's own group order in a single call", async () => {
    const first = await insertGroup(mainId, "اندازه");
    const second = await insertGroup(mainId, "شیر");
    const third = await insertGroup(mainId, "افزودنی‌ها");
    const item = await insertItem(mainId, "لاته");
    await attach(item, first);
    await attach(item, second);
    await attach(item, third);

    expect(
      await dbLib.withTenant(businessId, () =>
        menuService.reorderItemModifierGroups(mainId, item, [third, first, second]),
      ),
    ).toEqual({ ok: true });

    const { rows } = await db.query<{ modifier_group_id: string; sort_order: number }>(
      "SELECT modifier_group_id, sort_order FROM menu_item_modifier_groups WHERE menu_item_id = $1 ORDER BY sort_order",
      [item],
    );
    expect(rows.map((row) => row.modifier_group_id)).toEqual([third, first, second]);
  });

  it("refuses a partial list rather than leaving stale positions", async () => {
    const first = await insertGroup(mainId, "اندازه");
    const second = await insertGroup(mainId, "شیر");
    const item = await insertItem(mainId, "لاته");
    await attach(item, first);
    await attach(item, second);

    expect(
      await dbLib.withTenant(businessId, () =>
        menuService.reorderItemModifierGroups(mainId, item, [first]),
      ),
    ).toEqual({ ok: false, error: "reorder_mismatch", status: 400 });
  });

  it("refuses an item from another branch", async () => {
    const item = await insertItem(otherId, "لاتهٔ شعبهٔ دیگر");
    const group = await insertGroup(otherId, "اندازه");
    await attach(item, group);

    expect(
      await dbLib.withTenant(businessId, () =>
        menuService.reorderItemModifierGroups(mainId, item, [group]),
      ),
    ).toEqual({ ok: false, error: "item_not_found", status: 404 });
  });
});
