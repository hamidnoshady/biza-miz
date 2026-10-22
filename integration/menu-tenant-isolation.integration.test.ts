/**
 * The tenant boundary itself, against real PostgreSQL RLS.
 *
 * ## Why this file exists
 *
 * Two things made the menu suites unable to speak about tenant isolation:
 *
 *   1. `menu-service` scopes by `location_id`. A call that passes business A's
 *      branch with a row id belonging to business B is refused by the location
 *      predicate — that is *branch* scoping, and a passing test of that shape
 *      would keep passing if the tenant machinery regressed entirely.
 *   2. Those suites run as `pos`, a superuser with BYPASSRLS, so RLS never
 *      engages at all.
 *
 * This file removes both confounds. It provisions the real runtime role the
 * application is meant to use (`createAppRole` → NOSUPERUSER, NOBYPASSRLS, with
 * CRUD grants) and connects as that role. Business A and business B each own
 * their own branch, group and option.
 *
 * Between every refusal case and its control the **only** thing that changes is
 * `app.business_id` — same role, same connection, same SQL, same row ids. If
 * `app_current_business()` or the tenant policies in migration 0021 regressed,
 * the refusal cases below would start returning business B's rows.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../src/lib/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const OPTION_B = "گزینهٔ بیگانه";
const PROBE_PASSWORD = "probe-password";

let databaseName: string;
let probeRole: string;
/** Superuser: seeds fixtures and reads back ground truth, bypassing RLS. */
let db: Client;
/** The unprivileged role — the tenant boundary is measured here. */
let app: Client;

let businessA = "";
let locationA = "";
let groupA = "";
let businessB = "";
let locationB = "";
let groupB = "";
let modifierB = "";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

/** A connection URL that logs in as the unprivileged runtime role. */
function appUrlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  url.username = probeRole;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

/**
 * Point the unprivileged connection at one business. This is the single
 * variable every test in this file turns.
 */
async function scopeTo(businessId: string): Promise<void> {
  await app.query("SELECT set_config('app.business_id', $1, false)", [businessId]);
}

async function seedBusiness(name: string): Promise<{
  businessId: string;
  locationId: string;
  groupId: string;
  modifierId: string;
}> {
  const { rows: business } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`],
  );
  const businessId = business[0].id;

  const { rows: location } = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = location[0].id;

  const { rows: group } = await db.query<{ id: string }>(
    "INSERT INTO modifier_groups (location_id, name) VALUES ($1, $2) RETURNING id",
    [locationId, `گروه ${name}`],
  );
  const groupId = group[0].id;

  const { rows: modifier } = await db.query<{ id: string }>(
    `INSERT INTO modifiers (location_id, group_id, name, price_delta)
     VALUES ($1, $2, $3, 9000) RETURNING id`,
    [locationId, groupId, OPTION_B],
  );

  return { businessId, locationId, groupId, modifierId: modifier[0].id };
}

/** Ground truth, read as the superuser so RLS cannot colour the answer. */
async function groupName(groupId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ name: string }>(
    "SELECT name FROM modifier_groups WHERE id = $1",
    [groupId],
  );
  return rows[0]?.name;
}

async function modifierName(modifierId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ name: string }>(
    "SELECT name FROM modifiers WHERE id = $1",
    [modifierId],
  );
  return rows[0]?.name;
}

beforeAll(async () => {
  databaseName = `pos_menu_tenant_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // The fixtures must be real rows before the tenant boundary is measured, so
  // they are seeded while the only connection is still the superuser one.
  const a = await seedBusiness("Alpha");
  const b = await seedBusiness("Bravo");
  businessA = a.businessId;
  locationA = a.locationId;
  groupA = a.groupId;
  businessB = b.businessId;
  locationB = b.locationId;
  groupB = b.groupId;
  modifierB = b.modifierId;

  probeRole = `pos_menu_tenant_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: probeRole,
    password: PROBE_PASSWORD,
    quiet: true,
  });

  app = new Client({ connectionString: appUrlFor(databaseName) });
  await app.connect();
}, 180_000);

afterAll(async () => {
  await app?.end().catch(() => {});
  await db?.end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP OWNED BY "${probeRole}"`).catch(() => {});
    await maintenance.query(`DROP ROLE IF EXISTS "${probeRole}"`).catch(() => {});
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  // The control case writes to business B's rows on purpose; put them back so
  // every test starts from the same ground truth.
  await db.query("UPDATE modifiers SET name = $2 WHERE id = $1", [modifierB, OPTION_B]);
});

describe("the runtime role really is subject to RLS", () => {
  it("is neither a superuser nor BYPASSRLS", async () => {
    const { rows } = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [probeRole],
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("business A cannot see business B's menu", () => {
  it("hides B's rows and still shows A's own — the same query, one scope", async () => {
    await scopeTo(businessA);

    const { rows } = await app.query<{ id: string }>(
      "SELECT id FROM modifier_groups WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[groupA, groupB]],
    );

    // Both directions in one assertion: B is invisible *and* A is visible, so
    // this cannot pass by the role simply being unable to read anything.
    expect(rows.map((row) => row.id)).toEqual([groupA]);
  });

  it("control: under B's scope the identical query returns B's group", async () => {
    await scopeTo(businessB);

    const { rows } = await app.query<{ id: string }>(
      "SELECT id FROM modifier_groups WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[groupA, groupB]],
    );

    // Only `app.business_id` changed since the test above.
    expect(rows.map((row) => row.id)).toEqual([groupB]);
  });

  it("cannot update business B's option", async () => {
    await scopeTo(businessA);

    const result = await app.query("UPDATE modifiers SET name = 'hacked' WHERE id = $1", [
      modifierB,
    ]);

    expect(result.rowCount).toBe(0);
    expect(await modifierName(modifierB)).toBe(OPTION_B);
  });

  it("cannot delete business B's group", async () => {
    await scopeTo(businessA);

    const result = await app.query("DELETE FROM modifier_groups WHERE id = $1", [groupB]);

    expect(result.rowCount).toBe(0);
    expect(await groupName(groupB)).toBe(`گروه Bravo`);
  });

  it("cannot insert an option into business B's branch", async () => {
    await scopeTo(businessA);

    // WITH CHECK — not USING — rejects this: the new row claims a location
    // that belongs to another tenant.
    await expect(
      app.query(
        `INSERT INTO modifiers (location_id, group_id, name, price_delta)
         VALUES ($1, $2, 'قاچاقی', 1000)`,
        [locationB, groupB],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("control: the owning scope can update the very same option", async () => {
    await scopeTo(businessB);

    const result = await app.query("UPDATE modifiers SET name = $2 WHERE id = $1", [
      modifierB,
      "گزینهٔ به‌روزشده",
    ]);

    // Same role, same connection, same statement as the refusal above.
    expect(result.rowCount).toBe(1);
    expect(await modifierName(modifierB)).toBe("گزینهٔ به‌روزشده");
  });
});

describe("the tenant scope does not leak between scopes", () => {
  it("follows app.business_id back and forth", async () => {
    const visibleGroups = async () => {
      const { rows } = await app.query<{ id: string }>(
        "SELECT id FROM modifier_groups WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[groupA, groupB]],
      );
      return rows.map((row) => row.id);
    };

    await scopeTo(businessA);
    expect(await visibleGroups()).toEqual([groupA]);

    await scopeTo(businessB);
    expect(await visibleGroups()).toEqual([groupB]);

    // Switching back must not leave the previous scope cached.
    await scopeTo(businessA);
    expect(await visibleGroups()).toEqual([groupA]);
  });

  it("shows nothing when no scope is set", async () => {
    await app.query("SELECT set_config('app.business_id', '', false)");

    const { rows } = await app.query<{ id: string }>(
      "SELECT id FROM modifier_groups WHERE id = ANY($1::uuid[])",
      [[groupA, groupB]],
    );
    expect(rows).toEqual([]);
  });
});
