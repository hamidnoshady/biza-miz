/**
 * #910 — the menu boundary measured *through the application*, not around it.
 *
 * `menu-tenant-isolation.integration.test.ts` proves the database policies
 * themselves: it speaks SQL to the tables as an unprivileged role. That is
 * necessary but not sufficient — it would keep passing if `withTenantScope`
 * stopped setting `app.business_id`, or if a service stopped scoping its
 * queries, because the test never goes through either of them.
 *
 * This file closes that gap. The whole application — `src/lib/db`, the services
 * and the route handlers — runs as the runtime role the deployment is meant to
 * use (`createAppRole`: NOSUPERUSER, NOBYPASSRLS, no table ownership). Every
 * call below therefore travels the production path:
 *
 *     route handler → withTenantScope → runInTenantScope → db.ts set_config
 *     → menu-service → SQL → RLS policy
 *
 * The discriminating cases call the **same service function with the same
 * arguments** under two scopes and get different answers. A branch-scoping bug
 * cannot explain the difference, because the arguments never change; only
 * `app.business_id` does. If any link in that chain regressed, the refusal
 * cases would start returning the other tenant's rows instead of nothing.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRole } from "../scripts/create-app-role";
import { runMigrations } from "../scripts/migrate";
import type { Role } from "../src/lib/auth-edge";

/**
 * The routes read the session through `next/headers`, which only exists inside
 * a request. This jar stands in for that request, so the cases below drive the
 * real handlers with a real signed session rather than calling services and
 * pretending the route is covered.
 */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
  headers: async () => new Headers(),
}));

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = `pos_menu_app_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const APP_PASSWORD = "menu-app-boundary-password";

let databaseName: string;
/** Superuser: seeds fixtures and reads back ground truth that RLS cannot colour. */
let owner: Client;

let dbLib: typeof import("../src/lib/db");
let menuService: typeof import("../src/lib/menu-service");
let auth: typeof import("../src/lib/auth");
let tenantContext: typeof import("../src/lib/tenant-context");
let employees: typeof import("../src/lib/employee-service");
let restaurantMenu: typeof import("../src/lib/restaurant-menu");

/** The route handlers under test, imported once the app points at the app role. */
let menuRoute: typeof import("../src/app/api/menu/route");
let groupRoute: typeof import("../src/app/api/menu/modifier-groups/[id]/route");
let itemGroupsRoute: typeof import("../src/app/api/menu/item-modifier-groups/route");
let itemReorderRoute: typeof import("../src/app/api/menu/item-modifier-groups/reorder/route");
let menuReorderRoute: typeof import("../src/app/api/menu/reorder/route");
let modifiersRoute: typeof import("../src/app/api/menu/modifiers/[id]/route");
let groupCollectionRoute: typeof import("../src/app/api/menu/modifier-groups/route");
let modifierCollectionRoute: typeof import("../src/app/api/menu/modifiers/route");

interface Seeded {
  businessId: string;
  locationId: string;
  ownerId: string;
  managerId: string;
  cashierId: string;
  waiterId: string;
  itemId: string;
  /** A second item whose attached groups are stored in an order that inverts their global one. */
  orderItemId: string;
  /** Globally ordered A, B, C — but attached to `orderItemId` as C, A, B. */
  orderGroupIds: [string, string, string];
  /** Attached to the item, so deleting it must deactivate rather than cascade. */
  groupId: string;
  /** No options, no attachments — the only shape a destructive DELETE may take. */
  emptyGroupId: string;
  /** A second one: the route control deletes a row of its own, so ordering between cases cannot decide the outcome. */
  spareGroupId: string;
  optionId: string;
}

let alpha: Seeded;
let bravo: Seeded;

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

/** Signs one member in by putting a real, signed session in the cookie jar. */
async function signInAs(business: Seeded, userId: string, role: Role): Promise<void> {
  // The canonical door: it creates the employee profile the session row's
  // foreign key needs, then opens the session the token names.
  const { session } = await inScope(business, () =>
    employees.createSession(userId, business.businessId, { loginMethod: "password" }),
  );
  const slug = await owner.query<{ slug: string }>("SELECT slug FROM businesses WHERE id = $1", [
    business.businessId,
  ]);
  jar.set(
    auth.SESSION_COOKIE,
    await auth.signSession({
      sub: userId,
      role,
      businessId: business.businessId,
      businessSlug: slug.rows[0].slug,
      locationId: null,
      fullName: "عضو",
      employeeSessionId: session.id,
    }),
  );
}

async function seedBusiness(name: string): Promise<Seeded> {
  const slug = `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 8)}`;
  const business = await owner.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, 'food_service') RETURNING id",
    [name, slug],
  );
  const businessId = business.rows[0].id;

  const location = await owner.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = location.rows[0].id;

  const member = async (role: Role, fullName: string): Promise<string> => {
    const row = await owner.query<{ id: string }>(
      "INSERT INTO users (business_id, location_id, role, full_name) VALUES ($1, $2, $3, $4) RETURNING id",
      [businessId, locationId, role, fullName],
    );
    return row.rows[0].id;
  };
  const ownerId = await member("owner", `${name} owner`);
  const managerId = await member("manager", `${name} manager`);
  const cashierId = await member("cashier", `${name} cashier`);
  const waiterId = await member("waiter", `${name} waiter`);

  const item = await owner.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, name, price) VALUES ($1, $2, 100000) RETURNING id",
    [locationId, `آمریکانو ${name}`],
  );
  const itemId = item.rows[0].id;

  const group = await owner.query<{ id: string }>(
    "INSERT INTO modifier_groups (location_id, name, min_select, max_select, sort_order) VALUES ($1, $2, 0, 2, 10) RETURNING id",
    [locationId, `افزودنی‌های ${name}`],
  );
  const groupId = group.rows[0].id;

  const emptyGroup = await owner.query<{ id: string }>(
    "INSERT INTO modifier_groups (location_id, name, min_select, max_select, sort_order) VALUES ($1, $2, 0, 1, 20) RETURNING id",
    [locationId, `گروه خالی ${name}`],
  );
  const spareGroup = await owner.query<{ id: string }>(
    "INSERT INTO modifier_groups (location_id, name, min_select, max_select, sort_order) VALUES ($1, $2, 0, 1, 30) RETURNING id",
    [locationId, `گروه یدکی ${name}`],
  );

  const option = await owner.query<{ id: string }>(
    `INSERT INTO modifiers (location_id, group_id, name, price_delta, sort_order)
     VALUES ($1, $2, $3, 20000, 0) RETURNING id`,
    [locationId, groupId, `شات اضافه ${name}`],
  );

  await owner.query(
    `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
     VALUES ($1, $2, 0)`,
    [itemId, groupId],
  );

  // Issue #910: the per-item link order must win over the group's global one.
  // These three are global A, B, C and attached C, A, B — so any consumer that
  // re-sorts by the global order renders them in the wrong sequence.
  const orderItem = await owner.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, name, price, sort_order) VALUES ($1, $2, 100000, 10) RETURNING id",
    [locationId, `ترتیبی ${name}`],
  );
  const orderGroupIds: string[] = [];
  for (const [index, label] of ["الف", "ب", "ج"].entries()) {
    const row = await owner.query<{ id: string }>(
      `INSERT INTO modifier_groups (location_id, name, min_select, max_select, sort_order)
       VALUES ($1, $2, 0, 1, $3) RETURNING id`,
      [locationId, `${label} ${name}`, 40 + index * 10],
    );
    orderGroupIds.push(row.rows[0].id);
  }
  // C, A, B by link sort_order.
  const linkOrder = [orderGroupIds[2], orderGroupIds[0], orderGroupIds[1]];
  for (const [index, id] of linkOrder.entries()) {
    await owner.query(
      `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
       VALUES ($1, $2, $3)`,
      [orderItem.rows[0].id, id, index],
    );
  }

  return {
    businessId,
    locationId,
    ownerId,
    managerId,
    cashierId,
    waiterId,
    itemId,
    orderItemId: orderItem.rows[0].id,
    orderGroupIds: orderGroupIds as [string, string, string],
    groupId,
    emptyGroupId: emptyGroup.rows[0].id,
    spareGroupId: spareGroup.rows[0].id,
    optionId: option.rows[0].id,
  };
}

/** Runs `fn` with the tenant scope a request for `business` would establish. */
function inScope<T>(business: Seeded, fn: () => Promise<T>): Promise<T> {
  return tenantContext.runInTenantScope(
    tenantContext.businessScope(business.businessId, business.locationId, business.ownerId),
    fn,
  ) as Promise<T>;
}

async function groupRow(id: string): Promise<{ is_active: boolean; name: string } | undefined> {
  const { rows } = await owner.query<{ is_active: boolean; name: string }>(
    "SELECT is_active, name FROM modifier_groups WHERE id = $1",
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  databaseName = `pos_menu_app_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  const ownerUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl: ownerUrl, quiet: true });
  await createAppRole({
    databaseUrl: ownerUrl,
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  // From here on the *application* connects as the unprivileged role. This is
  // the whole point of the file: `src/lib/db` must be imported only after the
  // URL has been pointed at it, or its pool would keep the superuser one.
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  menuService = await import("../src/lib/menu-service");
  auth = await import("../src/lib/auth");
  tenantContext = await import("../src/lib/tenant-context");
  employees = await import("../src/lib/employee-service");
  restaurantMenu = await import("../src/lib/restaurant-menu");
  menuRoute = await import("../src/app/api/menu/route");
  groupRoute = await import("../src/app/api/menu/modifier-groups/[id]/route");
  itemGroupsRoute = await import("../src/app/api/menu/item-modifier-groups/route");
  itemReorderRoute = await import("../src/app/api/menu/item-modifier-groups/reorder/route");
  menuReorderRoute = await import("../src/app/api/menu/reorder/route");
  modifiersRoute = await import("../src/app/api/menu/modifiers/[id]/route");
  groupCollectionRoute = await import("../src/app/api/menu/modifier-groups/route");
  modifierCollectionRoute = await import("../src/app/api/menu/modifiers/route");

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();

  alpha = await seedBusiness("Alpha");
  bravo = await seedBusiness("Bravo");
}, 180_000);

afterAll(async () => {
  await owner?.end().catch(() => {});
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP OWNED BY "${APP_ROLE}"`).catch(() => {});
    await maintenance.query(`DROP ROLE IF EXISTS "${APP_ROLE}"`).catch(() => {});
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  jar.clear();
  // Every control below deliberately changes Bravo's rows; put them back so a
  // case can never pass (or fail) because of the one that ran before it.
  await owner.query("UPDATE modifier_groups SET is_active = true WHERE id = ANY($1::uuid[])", [
    [alpha.groupId, alpha.emptyGroupId, alpha.spareGroupId, bravo.groupId, bravo.emptyGroupId],
  ]);
  await owner.query("UPDATE modifiers SET is_active = true WHERE id = $1", [bravo.optionId]);
});

describe("the role this file runs the application as", () => {
  it("is neither a superuser nor BYPASSRLS, and owns none of the menu tables", async () => {
    const { rows } = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    // The pool really is connected as that role — otherwise every case below
    // would be measuring the superuser connection instead.
    const who = await dbLib.query<{ current_user: string }>("SELECT current_user");
    expect(who.rows[0].current_user).toBe(APP_ROLE);

    const tables = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_tables
        WHERE tablename = ANY($1::text[]) AND tableowner = $2`,
      [["menu_items", "modifier_groups", "modifiers", "menu_item_modifier_groups"], APP_ROLE],
    );
    expect(Number(tables.rows[0].count)).toBe(0);
  });
});

describe("the menu service reads only the scoped tenant's branch", () => {
  it("returns nothing for a branch belonging to the other tenant", async () => {
    // Same function, same argument (Bravo's location) as the control below.
    const tree = await inScope(alpha, () => menuService.getMenuTree(bravo.locationId));

    expect(tree.items).toEqual([]);
    expect(tree.modifierGroups).toEqual([]);
    expect(tree.modifiers).toEqual([]);
    expect(tree.itemModifierGroups).toEqual([]);
  });

  it("control: the identical call returns the menu under its own scope", async () => {
    const tree = await inScope(bravo, () => menuService.getMenuTree(bravo.locationId));

    expect(tree.items.map((row) => row.id)).toEqual([bravo.itemId, bravo.orderItemId]);
    expect(tree.modifierGroups.map((row) => row.id)).toEqual([
      bravo.groupId,
      bravo.emptyGroupId,
      bravo.spareGroupId,
      ...bravo.orderGroupIds,
    ]);
    // Only `app.business_id` differs from the case above.
  });

  it("still returns the tenant's own menu when asked for its own branch", async () => {
    const tree = await inScope(alpha, () => menuService.getMenuTree(alpha.locationId));
    expect(tree.items.map((row) => row.id)).toEqual([alpha.itemId, alpha.orderItemId]);
  });
});

describe("the menu service cannot destroy the other tenant's configuration", () => {
  it("refuses to delete another tenant's group, and leaves it untouched", async () => {
    const result = await inScope(alpha, () =>
      menuService.deleteModifierGroup(bravo.locationId, bravo.emptyGroupId),
    );

    expect(result).toMatchObject({ ok: false, error: "group_not_found", status: 404 });
    expect(await groupRow(bravo.emptyGroupId)).toEqual({
      is_active: true,
      name: "گروه خالی Bravo",
    });
  });

  it("controls: the owning scope deletes the very same empty group", async () => {
    const result = await inScope(bravo, () =>
      menuService.deleteModifierGroup(bravo.locationId, bravo.emptyGroupId),
    );

    expect(result).toMatchObject({ ok: true, deactivated: false });
    expect(await groupRow(bravo.emptyGroupId)).toBeUndefined();
  });

  it("deactivates rather than cascading when the group is still attached", async () => {
    const result = await inScope(bravo, () =>
      menuService.deleteModifierGroup(bravo.locationId, bravo.groupId),
    );

    // The safe semantics from the issue: a group an item still uses, or one
    // that has options, is archived — never silently cascaded away.
    expect(result).toMatchObject({
      ok: true,
      deactivated: true,
      affected: { items: 1, options: 1 },
    });
    expect(await groupRow(bravo.groupId)).toEqual({
      is_active: false,
      name: "افزودنی‌های Bravo",
    });

    // And its option and attachment survived the call.
    const option = await owner.query("SELECT 1 FROM modifiers WHERE id = $1", [bravo.optionId]);
    expect(option.rowCount).toBe(1);
    const link = await owner.query(
      "SELECT 1 FROM menu_item_modifier_groups WHERE menu_item_id = $1 AND modifier_group_id = $2",
      [bravo.itemId, bravo.groupId],
    );
    expect(link.rowCount).toBe(1);
  });
});

describe("the menu service cannot renumber the other tenant's rows", () => {
  it("refuses a collection reorder aimed at another tenant's branch", async () => {
    const result = await inScope(alpha, () =>
      menuService.reorderMenuCollection(bravo.locationId, "modifierGroups", [bravo.groupId]),
    );

    // The ownership count finds nothing under this scope, so the request is a
    // mismatch rather than a silent renumbering of a row it cannot see.
    expect(result).toMatchObject({ ok: false, error: "reorder_mismatch", status: 400 });
    const order = await owner.query<{ sort_order: number }>(
      "SELECT sort_order FROM modifier_groups WHERE id = $1",
      [bravo.groupId],
    );
    expect(order.rows[0].sort_order).toBe(10);
  });

  it("refuses an attachment reorder aimed at another tenant's item", async () => {
    const result = await inScope(alpha, () =>
      menuService.reorderItemModifierGroups(bravo.locationId, bravo.itemId, [bravo.groupId]),
    );

    expect(result).toMatchObject({ ok: false, error: "item_not_found", status: 404 });
  });
});

describe("the menu routes as a signed-in member", () => {
  it("answers 401 without a session", async () => {
    const response = await menuRoute.GET();
    expect(response.status).toBe(401);
  });

  it("serve the tenant's own menu and none of the other tenant's", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const response = await menuRoute.GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { id: string }[];
      modifierGroups: { id: string }[];
      modifiers: { id: string }[];
    };

    expect(body.items.map((row) => row.id)).toEqual([alpha.itemId, alpha.orderItemId]);
    expect(body.modifierGroups.map((row) => row.id)).toEqual([
      alpha.groupId,
      alpha.emptyGroupId,
      alpha.spareGroupId,
      ...alpha.orderGroupIds,
    ]);
    expect(body.modifiers.map((row) => row.id)).toEqual([alpha.optionId]);
  });

  it("answer 404 for another tenant's group, and leave it alone", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const response = await groupRoute.DELETE(
      new NextRequest(`http://localhost/api/menu/modifier-groups/${bravo.groupId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: bravo.groupId }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "group_not_found" });
    expect((await groupRow(bravo.groupId))?.is_active).toBe(true);
  });

  it("control: the owning tenant's session deletes that same group", async () => {
    await signInAs(bravo, bravo.ownerId, "owner");

    const response = await groupRoute.DELETE(
      new NextRequest(`http://localhost/api/menu/modifier-groups/${bravo.spareGroupId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: bravo.spareGroupId }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, deactivated: false });
  });

  it("refuse an attachment on another tenant's item", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const response = await itemGroupsRoute.POST(
      new NextRequest("http://localhost/api/menu/item-modifier-groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ menuItemId: bravo.itemId, modifierGroupId: alpha.groupId }),
      }),
    );

    expect(response.status).toBe(404);
    const link = await owner.query(
      "SELECT 1 FROM menu_item_modifier_groups WHERE menu_item_id = $1 AND modifier_group_id = $2",
      [bravo.itemId, alpha.groupId],
    );
    // No cross-tenant reference was written.
    expect(link.rowCount).toBe(0);
  });

  it("refuse a reorder that names another tenant's rows", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const response = await menuReorderRoute.POST(
      new NextRequest("http://localhost/api/menu/reorder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entity: "modifierGroups", ids: [bravo.groupId] }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "reorder_mismatch" });
  });

  it("refuse an attachment reorder aimed at another tenant's item", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const response = await itemReorderRoute.POST(
      new NextRequest("http://localhost/api/menu/item-modifier-groups/reorder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ menuItemId: bravo.itemId, groupIds: [bravo.groupId] }),
      }),
    );

    expect(response.status).toBe(404);
  });
});

describe("the order every surface renders", () => {
  /**
   * POS, the waiter screen and the order editor share one payload and one
   * index: `GET /api/menu` → `toRestaurantMenu` → `buildRestaurantMenuIndex`.
   * So this case starts at the route and ends at the index those screens read,
   * which is as close to "all three surfaces" as a server test can get without
   * mounting the screens themselves.
   */
  it("renders an item's own attachment order, not the groups' global order", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const payload = (await (await menuRoute.GET()).json()) as Parameters<
      typeof restaurantMenu.toRestaurantMenu
    >[0];
    const index = restaurantMenu.buildRestaurantMenuIndex(
      restaurantMenu.toRestaurantMenu(payload),
    );

    // Globally A, B, C; attached to this item as C, A, B.
    expect(index.groupsByItem.get(alpha.orderItemId)?.map((group) => group.id)).toEqual([
      alpha.orderGroupIds[2],
      alpha.orderGroupIds[0],
      alpha.orderGroupIds[1],
    ]);
  });

  it("follows the reorder route, so the stored order is the rendered order", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const rendered = async () => {
      const payload = (await (await menuRoute.GET()).json()) as Parameters<
        typeof restaurantMenu.toRestaurantMenu
      >[0];
      const index = restaurantMenu.buildRestaurantMenuIndex(
        restaurantMenu.toRestaurantMenu(payload),
      );
      return index.groupsByItem.get(alpha.orderItemId)?.map((group) => group.id) ?? [];
    };

    expect(await rendered()).toEqual([
      alpha.orderGroupIds[2],
      alpha.orderGroupIds[0],
      alpha.orderGroupIds[1],
    ]);

    // One atomic request, every link of the item, in the new order.
    const response = await itemReorderRoute.POST(
      new NextRequest("http://localhost/api/menu/item-modifier-groups/reorder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          menuItemId: alpha.orderItemId,
          groupIds: [alpha.orderGroupIds[1], alpha.orderGroupIds[2], alpha.orderGroupIds[0]],
        }),
      }),
    );
    expect(response.status).toBe(200);

    expect(await rendered()).toEqual([
      alpha.orderGroupIds[1],
      alpha.orderGroupIds[2],
      alpha.orderGroupIds[0],
    ]);
  });
});

describe("deleting an option — the safeguards the confirmation dialog explains", () => {
  /** A group on the alpha branch, with a required minimum when asked for one. */
  async function newGroup(minSelect: number, maxSelect: number): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO modifier_groups (location_id, name, min_select, max_select, sort_order)
       VALUES ($1, $2, $3, $4, 90) RETURNING id`,
      [alpha.locationId, `گروه حذف ${randomUUID().slice(0, 6)}`, minSelect, maxSelect],
    );
    return rows[0].id;
  }

  async function newOption(groupId: string, priceDelta = 5000): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO modifiers (location_id, group_id, name, price_delta)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [alpha.locationId, groupId, `گزینه ${randomUUID().slice(0, 6)}`, priceDelta],
    );
    return rows[0].id;
  }

  const del = (id: string) =>
    modifiersRoute.DELETE(
      new NextRequest(`http://localhost/api/menu/modifiers/${id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id }) },
    );

  it("refuses the last option a required attachment still needs", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const group = await newGroup(1, 1);
    const option = await newOption(group);
    // Required: the item cannot be ordered without one of this group's options.
    const item = await owner.query<{ id: string }>(
      "INSERT INTO menu_items (location_id, name, price) VALUES ($1, $2, 100000) RETURNING id",
      [alpha.locationId, `آیتم ${randomUUID().slice(0, 6)}`],
    );
    await owner.query(
      `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
       VALUES ($1, $2, 0)`,
      [item.rows[0].id, group],
    );

    const response = await del(option);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "modifier_group_unsatisfiable" });

    // Nothing was removed, so the item stays orderable.
    const still = await owner.query("SELECT 1 FROM modifiers WHERE id = $1 AND is_active", [option]);
    expect(still.rowCount).toBe(1);
  });

  it("archives an option that was sold, so the historic snapshot keeps its meaning", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const group = await newGroup(0, 1);
    const option = await newOption(group);
    const order = await owner.query<{ id: string }>(
      "INSERT INTO orders (location_id, order_number) VALUES ($1, $2) RETURNING id",
      [alpha.locationId, Date.now() % 1_000_000_000],
    );
    const line = await owner.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price)
       VALUES ($1, $2, 'لاته', 100000) RETURNING id`,
      [alpha.locationId, order.rows[0].id],
    );
    await owner.query(
      `INSERT INTO order_item_modifiers (order_item_id, modifier_id, name_snapshot, price_delta, quantity)
       VALUES ($1, $2, 'شات اضافه', 20000, 3)`,
      [line.rows[0].id, option],
    );

    const response = await del(option);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, deactivated: true });

    const row = await owner.query<{ is_active: boolean }>(
      "SELECT is_active FROM modifiers WHERE id = $1",
      [option],
    );
    expect(row.rows[0]).toEqual({ is_active: false });

    // The sold line is untouched: quantity and price are snapshots.
    const sold = await owner.query<{ quantity: number; price_delta: string }>(
      "SELECT quantity, price_delta FROM order_item_modifiers WHERE modifier_id = $1",
      [option],
    );
    expect(sold.rows[0]).toEqual({ quantity: 3, price_delta: "20000" });
  });

  it("actually deletes an option nothing references", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const group = await newGroup(0, 1);
    const option = await newOption(group);

    const response = await del(option);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, deactivated: false });

    const gone = await owner.query("SELECT 1 FROM modifiers WHERE id = $1", [option]);
    expect(gone.rowCount).toBe(0);
  });

  it("refuses another tenant's option", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");

    const response = await del(bravo.optionId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "modifier_not_found" });
    expect((await groupRow(bravo.groupId))?.is_active).toBe(true);
  });
});

describe("two reorders of one item at the same time", () => {
  it("leaves one complete order, never a mix of both", async () => {
    const [a, b, c] = alpha.orderGroupIds;

    // Both requests name every link of the item, in opposite orders. Whatever
    // the interleaving, the row lock makes them serialise, so the stored
    // result must be one of the two — not A,B,A with two links on one slot.
    const results = await Promise.all([
      inScope(alpha, () =>
        menuService.reorderItemModifierGroups(alpha.locationId, alpha.orderItemId, [a, b, c]),
      ),
      inScope(alpha, () =>
        menuService.reorderItemModifierGroups(alpha.locationId, alpha.orderItemId, [c, b, a]),
      ),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);

    const { rows } = await owner.query<{ modifier_group_id: string; sort_order: number }>(
      `SELECT modifier_group_id, sort_order FROM menu_item_modifier_groups
        WHERE menu_item_id = $1 ORDER BY sort_order`,
      [alpha.orderItemId],
    );

    // Distinct slots 0,1,2 — no two links left sharing one, which is exactly
    // the corruption the old two-PATCH swap produced.
    expect(rows.map((row) => row.sort_order)).toEqual([0, 1, 2]);

    const stored = rows.map((row) => row.modifier_group_id).join(",");
    expect([[a, b, c].join(","), [c, b, a].join(",")]).toContain(stored);
  });
});

describe("every menu write route is wired and guarded", () => {
  // The audit found no dead add-on endpoints, and this is the guard against
  // one appearing: each handler must exist, answer rather than 404, and refuse
  // a caller with no session before it touches anything. Without the session
  // check, a route that lost its `withTenantScope` wrapper would be caught here
  // as a 500 instead of a 401.
  const post = (path: string, body: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const cases: [string, () => Promise<{ status: number }>][] = [
    ["GET  /api/menu", () => menuRoute.GET()],
    ["POST /api/menu/modifier-groups", () => groupCollectionRoute.POST(post("/api/menu/modifier-groups", { name: "x" }))],
    ["POST /api/menu/modifiers", () => modifierCollectionRoute.POST(post("/api/menu/modifiers", { groupId: randomUUID(), name: "x" }))],
    ["POST /api/menu/item-modifier-groups", () => itemGroupsRoute.POST(post("/api/menu/item-modifier-groups", { menuItemId: randomUUID(), modifierGroupId: randomUUID() }))],
    ["POST /api/menu/item-modifier-groups/reorder", () => itemReorderRoute.POST(post("/api/menu/item-modifier-groups/reorder", { menuItemId: randomUUID(), groupIds: [] }))],
    ["POST /api/menu/reorder", () => menuReorderRoute.POST(post("/api/menu/reorder", { entity: "items", ids: [] }))],
    [
      "DELETE /api/menu/modifier-groups/[id]",
      () =>
        groupRoute.DELETE(
          new NextRequest(`http://localhost/api/menu/modifier-groups/${randomUUID()}`, {
            method: "DELETE",
          }),
          { params: Promise.resolve({ id: randomUUID() }) },
        ),
    ],
    [
      "DELETE /api/menu/modifiers/[id]",
      () =>
        modifiersRoute.DELETE(
          new NextRequest(`http://localhost/api/menu/modifiers/${randomUUID()}`, {
            method: "DELETE",
          }),
          { params: Promise.resolve({ id: randomUUID() }) },
        ),
    ],
  ];

  it.each(cases)("%s refuses an unauthenticated caller with 401", async (_name, call) => {
    jar.clear();
    expect((await call()).status).toBe(401);
  });
});

describe("the role matrix on the menu API", () => {
  const reorder = () =>
    menuReorderRoute.POST(
      new NextRequest("http://localhost/api/menu/reorder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entity: "modifierGroups",
          ids: [alpha.groupId, alpha.spareGroupId, alpha.emptyGroupId],
        }),
      }),
    );

  it("lets the owner change the menu", async () => {
    await signInAs(alpha, alpha.ownerId, "owner");
    expect((await reorder()).status).toBe(200);
  });

  it("lets a manager change the menu too — the preset carries menu.edit", async () => {
    await signInAs(alpha, alpha.managerId, "manager");
    expect((await reorder()).status).toBe(200);
  });

  it("refuses a cashier — menu.view is not menu.edit", async () => {
    await signInAs(alpha, alpha.cashierId, "cashier");

    const response = await reorder();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "forbidden",
      code: "MISSING_PERMISSION",
      permission: "menu.edit",
    });
  });

  it("refuses a waiter, but still lets them read the menu they sell from", async () => {
    await signInAs(alpha, alpha.waiterId, "waiter");

    expect((await reorder()).status).toBe(403);
    expect((await menuRoute.GET()).status).toBe(200);
  });

  it("refuses a view-only member the group delete too", async () => {
    await signInAs(alpha, alpha.cashierId, "cashier");

    const response = await groupRoute.DELETE(
      new NextRequest(`http://localhost/api/menu/modifier-groups/${alpha.emptyGroupId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: alpha.emptyGroupId }) },
    );

    expect(response.status).toBe(403);
    expect(await groupRow(alpha.emptyGroupId)).toBeDefined();
  });
});
