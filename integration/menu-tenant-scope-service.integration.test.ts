/**
 * The tenant boundary measured **through the menu service**, not around it.
 *
 * `menu-tenant-isolation.integration.test.ts` proves the Postgres policies with
 * raw SQL under the real runtime role. That answers "does RLS work?" but not
 * "does the application still ask Postgres through a scoped connection?" — and
 * the second question is the one a regression in `withTenant`, the pool's
 * scope hook or `menu-service`'s own SQL would break. A raw-SQL suite would
 * stay green through all three.
 *
 * So this file calls the **real service functions** the routes call
 * (`getMenuTree`, `updateModifier`, `updateModifierGroup`, `deleteModifier`,
 * `deleteModifierGroup`, `attachModifierGroupToItem`, `reorderItemModifierGroups`)
 * as the **unprivileged application role**, with the tenant scope that
 * `withTenantScope` installs for a request. Every refusal is paired with a
 * positive control that differs in exactly one thing — `app.business_id` — so a
 * suite that passed by refusing everything would fail.
 *
 * Failure mode this catches: a service that opened its own connection without
 * the scope (an unscoped pool, a raw `new Client`, a missing
 * `runInTenantScope`) would read business B's rows under business A's scope and
 * the refusals below would return `ok: true`.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../src/lib/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const PROBE_PASSWORD = "probe-password";

let databaseName: string;
let probeRole: string;
/** Superuser: seeds fixtures and reads ground truth around RLS. */
let db: Client;

let dbLib: typeof import("../src/lib/db");
let menu: typeof import("../src/lib/menu-service");
let tenant: typeof import("../src/lib/tenant-context");

/** Business A — the caller's own tenant. */
const a = { businessId: "", locationId: "", itemId: "", groupId: "", optionId: "", extraGroupId: "" };
/** Business B — the other tenant, same shapes, never reachable from A. */
const b = { businessId: "", locationId: "", itemId: "", groupId: "", optionId: "", extraGroupId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function appUrlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  url.username = probeRole;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

/** The scope `withTenantScope` installs for an authenticated request. */
function asTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return tenant.runInTenantScope(tenant.businessScope(businessId, null, null), fn);
}

async function seedBusiness(label: string): Promise<{
  businessId: string;
  locationId: string;
  itemId: string;
  groupId: string;
  optionId: string;
  extraGroupId: string;
}> {
  const { rows: business } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [`Scope ${label}`, `scope-${label}-${randomUUID().slice(0, 8)}`],
  );
  const businessId = business[0].id;
  const { rows: location } = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id",
    [businessId, `Branch ${label}`],
  );
  const locationId = location[0].id;
  const { rows: item } = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, name, price) VALUES ($1, $2, 100000) RETURNING id",
    [locationId, `Latte ${label}`],
  );
  const { rows: group } = await db.query<{ id: string }>(
    "INSERT INTO modifier_groups (location_id, name, min_select, max_select) VALUES ($1, $2, 0, 3) RETURNING id",
    [locationId, `Group ${label}`],
  );
  const { rows: extraGroup } = await db.query<{ id: string }>(
    "INSERT INTO modifier_groups (location_id, name, min_select, max_select) VALUES ($1, $2, 0, 2) RETURNING id",
    [locationId, `Second group ${label}`],
  );
  const { rows: option } = await db.query<{ id: string }>(
    "INSERT INTO modifiers (location_id, group_id, name, price_delta) VALUES ($1, $2, $3, 20000) RETURNING id",
    [locationId, group[0].id, `Shot ${label}`],
  );
  await db.query(
    "INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order) VALUES ($1, $2, 0)",
    [item[0].id, group[0].id],
  );
  return {
    businessId,
    locationId,
    itemId: item[0].id,
    groupId: group[0].id,
    optionId: option[0].id,
    extraGroupId: extraGroup[0].id,
  };
}

async function optionName(id: string): Promise<string | undefined> {
  const { rows } = await db.query<{ name: string }>("SELECT name FROM modifiers WHERE id = $1", [id]);
  return rows[0]?.name;
}

async function groupState(id: string): Promise<{ name: string; is_active: boolean } | undefined> {
  const { rows } = await db.query<{ name: string; is_active: boolean }>(
    "SELECT name, is_active FROM modifier_groups WHERE id = $1",
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  databaseName = `pos_menu_scope_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  Object.assign(a, await seedBusiness("A"));
  Object.assign(b, await seedBusiness("B"));

  probeRole = `pos_menu_scope_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: probeRole,
    password: PROBE_PASSWORD,
    quiet: true,
  });

  // From here on the application pool logs in as the unprivileged role — the
  // same posture a deployed request has, with RLS actually in force.
  process.env.DATABASE_URL = appUrlFor(databaseName);
  dbLib = await import("../src/lib/db");
  menu = await import("../src/lib/menu-service");
  tenant = await import("../src/lib/tenant-context");
}, 180_000);

afterAll(async () => {
  await dbLib?.getPool().end().catch(() => {});
  await db?.end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP OWNED BY "${probeRole}"`).catch(() => {});
    await maintenance.query(`DROP ROLE IF EXISTS "${probeRole}"`).catch(() => {});
  } finally {
    await maintenance.end();
  }
}, 120_000);

describe("the service really is running under the unprivileged role", () => {
  it("connects as the app role, not a superuser", async () => {
    const posture = await asTenant(a.businessId, async () => {
      const { rows } = await dbLib.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
      );
      return rows[0];
    });
    expect(posture.current_user).toBe(probeRole);
    expect(posture.rolsuper).toBe(false);
    expect(posture.rolbypassrls).toBe(false);
  });
});

describe("menu reads — a tenant sees only its own tree", () => {
  it("returns A's tree under A's scope", async () => {
    const tree = await asTenant(a.businessId, () => menu.getMenuTree(a.locationId));
    expect(tree.items.map((item: { id: string }) => item.id)).toEqual([a.itemId]);
    expect(tree.modifierGroups.map((group: { id: string }) => group.id).sort()).toEqual(
      [a.groupId, a.extraGroupId].sort(),
    );
    expect(tree.modifiers.map((option: { id: string }) => option.id)).toEqual([a.optionId]);
  });

  it("cannot read B's tree even when it names B's branch", async () => {
    // The only difference from the case above is the branch id: B's, under A's
    // tenant scope. The tenant policy, not the location predicate, is what
    // has to answer — which is why this is not merely `location_not_found`.
    const tree = await asTenant(a.businessId, () => menu.getMenuTree(b.locationId));
    expect(tree.items).toEqual([]);
    expect(tree.modifierGroups).toEqual([]);
    expect(tree.modifiers).toEqual([]);
    expect(tree.itemModifierGroups).toEqual([]);
  });

  it("control: the identical call under B's scope returns B's tree", async () => {
    const tree = await asTenant(b.businessId, () => menu.getMenuTree(b.locationId));
    expect(tree.items.map((item: { id: string }) => item.id)).toEqual([b.itemId]);
    expect(tree.modifiers.map((option: { id: string }) => option.id)).toEqual([b.optionId]);
  });

  it("fails closed with no scope at all", async () => {
    const tree = await menu.getMenuTree(a.locationId);
    expect(tree.items).toEqual([]);
  });
});

describe("menu writes — cross-tenant ids are refused before anything changes", () => {
  it("cannot rename B's option, and the row is untouched", async () => {
    const before = await optionName(b.optionId);
    const refused = await asTenant(a.businessId, () =>
      menu.updateModifier(b.locationId, b.optionId, { name: "hijacked" }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toBe("modifier_not_found");
      expect(refused.status).toBe(404);
    }
    expect(await optionName(b.optionId)).toBe(before);
  });

  it("control: the same call under B's scope succeeds", async () => {
    const accepted = await asTenant(b.businessId, () =>
      menu.updateModifier(b.locationId, b.optionId, { name: "renamed by B" }),
    );
    expect(accepted.ok).toBe(true);
    expect(await optionName(b.optionId)).toBe("renamed by B");
    await db.query("UPDATE modifiers SET name = $2 WHERE id = $1", [b.optionId, "Shot B"]);
  });

  it("cannot change B's group bounds", async () => {
    const refused = await asTenant(a.businessId, () =>
      menu.updateModifierGroup(b.locationId, b.groupId, { minSelect: 2 }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(404);
    const { rows } = await db.query<{ min_select: number }>(
      "SELECT min_select FROM modifier_groups WHERE id = $1",
      [b.groupId],
    );
    expect(rows[0].min_select).toBe(0);
  });

  it("control: the same bounds change under B's scope applies", async () => {
    const accepted = await asTenant(b.businessId, () =>
      menu.updateModifierGroup(b.locationId, b.groupId, { maxSelect: 2 }),
    );
    expect(accepted.ok).toBe(true);
    const { rows } = await db.query<{ max_select: number }>(
      "SELECT max_select FROM modifier_groups WHERE id = $1",
      [b.groupId],
    );
    expect(rows[0].max_select).toBe(2);
  });

  it("cannot delete B's group — it is refused, not silently deactivated", async () => {
    const refused = await asTenant(a.businessId, () =>
      menu.deleteModifierGroup(b.locationId, b.groupId),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("group_not_found");
    const state = await groupState(b.groupId);
    expect(state?.is_active).toBe(true);
  });

  it("control: deleting B's group under B's scope deactivates it (it still has options)", async () => {
    const accepted = await asTenant(b.businessId, () =>
      menu.deleteModifierGroup(b.locationId, b.groupId),
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.deactivated).toBe(true);
    expect((await groupState(b.groupId))?.is_active).toBe(false);
    await db.query("UPDATE modifier_groups SET is_active = true WHERE id = $1", [b.groupId]);
  });

  it("cannot delete B's option", async () => {
    const refused = await asTenant(a.businessId, () =>
      menu.deleteModifier(b.locationId, b.optionId),
    );
    expect(refused.ok).toBe(false);
    const { rows } = await db.query("SELECT 1 FROM modifiers WHERE id = $1", [b.optionId]);
    expect(rows).toHaveLength(1);
  });

  it("control: deleting B's option under B's scope removes it", async () => {
    const { rows: spare } = await db.query<{ id: string }>(
      `INSERT INTO modifiers (location_id, group_id, name, price_delta)
       VALUES ($1, $2, 'Spare B', 1000) RETURNING id`,
      [b.locationId, b.groupId],
    );
    const accepted = await asTenant(b.businessId, () =>
      menu.deleteModifier(b.locationId, spare[0].id),
    );
    expect(accepted.ok).toBe(true);
    const { rows } = await db.query("SELECT 1 FROM modifiers WHERE id = $1", [spare[0].id]);
    expect(rows).toHaveLength(0);
  });

  it("cannot attach B's group to B's item from A's scope", async () => {
    const refused = await asTenant(a.businessId, () =>
      menu.attachModifierGroupToItem(b.locationId, b.itemId, b.extraGroupId),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(404);

    const { rows } = await db.query(
      "SELECT 1 FROM menu_item_modifier_groups WHERE menu_item_id = $1 AND modifier_group_id = $2",
      [b.itemId, b.extraGroupId],
    );
    expect(rows).toHaveLength(0);
  });

  it("control: the same attach under B's scope lands the link", async () => {
    const accepted = await asTenant(b.businessId, () =>
      menu.attachModifierGroupToItem(b.locationId, b.itemId, b.extraGroupId),
    );
    expect(accepted.ok).toBe(true);
    const { rows } = await db.query(
      "SELECT 1 FROM menu_item_modifier_groups WHERE menu_item_id = $1 AND modifier_group_id = $2",
      [b.itemId, b.extraGroupId],
    );
    expect(rows).toHaveLength(1);
  });

  it("cannot reorder B's item from A's scope", async () => {
    const refused = await asTenant(a.businessId, () =>
      menu.reorderItemModifierGroups(b.locationId, b.itemId, [b.extraGroupId, b.groupId]),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("item_not_found");

    const { rows } = await db.query<{ modifier_group_id: string; sort_order: number }>(
      "SELECT modifier_group_id, sort_order FROM menu_item_modifier_groups WHERE menu_item_id = $1 ORDER BY sort_order",
      [b.itemId],
    );
    expect(rows[0].modifier_group_id).toBe(b.groupId);
  });

  it("control: the same reorder under B's scope is applied", async () => {
    const accepted = await asTenant(b.businessId, () =>
      menu.reorderItemModifierGroups(b.locationId, b.itemId, [b.extraGroupId, b.groupId]),
    );
    expect(accepted.ok).toBe(true);
    const { rows } = await db.query<{ modifier_group_id: string }>(
      "SELECT modifier_group_id FROM menu_item_modifier_groups WHERE menu_item_id = $1 ORDER BY sort_order",
      [b.itemId],
    );
    expect(rows.map((row) => row.modifier_group_id)).toEqual([b.extraGroupId, b.groupId]);
  });

  it("cannot create a group inside B's branch", async () => {
    const before = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM modifier_groups WHERE location_id = $1",
      [b.locationId],
    );
    // The FK would refuse this too; what matters is that the *service* is
    // refused under A's scope, before the row is even attempted.
    const outcome = await asTenant(a.businessId, () =>
      menu.createModifierGroup(b.locationId, { name: "Smuggled group", minSelect: 0, maxSelect: 1 }),
    ).catch((error: unknown) => ({ ok: false, error: String(error) }) as { ok: boolean; error: string });
    expect(outcome.ok).toBe(false);

    const after = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM modifier_groups WHERE location_id = $1",
      [b.locationId],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
