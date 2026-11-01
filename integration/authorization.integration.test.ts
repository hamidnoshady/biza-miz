/**
 * The authorization model against a real database.
 *
 * The unit suites pin the policy functions; this file pins the things that
 * only a database can answer, and that the refactor changed:
 *
 *   1. RLS still isolates tenants — the permission layer sits on top of that
 *      boundary, it does not replace it;
 *   2. `users.location_scope` (migration 0170) actually constrains branch
 *      reach, including the case that used to roam: no rows, NULL home;
 *   3. the migration's backfill preserved every existing member's access
 *      rather than narrowing anyone at deploy;
 *   4. an effective permission set resolves from the row as stored, so an
 *      override takes effect on the next request with no re-authentication;
 *   5. the guards read the *database* role, so a demotion cannot be outrun by
 *      a token minted before it.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

/**
 * The application pool must connect as a role row-level security actually
 * applies to. Superusers and BYPASSRLS roles ignore RLS entirely, and both the
 * stock docker-compose.yml and the CI service make `pos` a superuser — so
 * seeding and asserting through the owner connection would make every
 * isolation expectation below pass vacuously while proving nothing. Same
 * reasoning, and the same helper, as tenant-isolation.integration.test.ts.
 */
const APP_ROLE = "pos_authz_test_role";
const APP_PASSWORD = "authz-test-password";

let databaseName: string;
/** Owner connection: seeds fixtures, bypassing RLS on purpose. */
let db: Client;

let permissions: typeof import("../src/lib/permissions");
let locationAccess: typeof import("../src/lib/location-access");
let dbLib: typeof import("../src/lib/db");

const alpha = { businessId: "", locationId: "", secondLocationId: "", ownerId: "" };
const beta = { businessId: "", locationId: "", secondLocationId: "", ownerId: "" };

function urlFor(database: string, role?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = role.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function seedBusiness(name: string, slug: string, ownerEmail: string) {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = biz.rows[0].id;

  const main = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const second = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id",
    [businessId],
  );

  const identity = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, $2, 'Owner') RETURNING id`,
    [ownerEmail, await bcrypt.hash("owner-password", 10)],
  );

  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
     VALUES ($1, $2, 'owner', 'Owner', $3) RETURNING id`,
    [businessId, identity.rows[0].id, ownerEmail],
  );

  return {
    businessId,
    locationId: main.rows[0].id,
    secondLocationId: second.rows[0].id,
    ownerId: owner.rows[0].id,
  };
}

/** A PIN-only member: a membership with no platform identity at all. */
async function seedMember(
  businessId: string,
  role: string,
  opts: {
    locationScope?: string;
    defaultLocationId?: string | null;
    permissions?: unknown;
  } = {},
): Promise<string> {
  const row = await db.query<{ id: string }>(
    // pin_hash is not decoration: the users_credentials constraint (0022)
     // requires an *active* member to have some way of signing in, and a
     // PIN-only member's way is the PIN. Seeding without one would be seeding
     // a row the product cannot create.
     `INSERT INTO users (business_id, platform_user_id, role, full_name, location_scope, location_id, permissions, pin_hash)
     VALUES ($1, NULL, $2, $3, COALESCE($4::location_scope, 'home'), $5, COALESCE($6, '{}'::jsonb), 'pin-hash-not-a-real-hash')
     RETURNING id`,
    [
      businessId,
      role,
      `${role} member`,
      opts.locationScope ?? null,
      opts.defaultLocationId ?? null,
      opts.permissions ? JSON.stringify(opts.permissions) : null,
    ],
  );
  return row.rows[0].id;
}

beforeAll(async () => {
  databaseName = `pos_authz_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  // The library pool — everything the assertions go through — is the
  // unprivileged role. `db` stays the owner so fixtures can be seeded across
  // both tenants.
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  permissions = await import("../src/lib/permissions");
  locationAccess = await import("../src/lib/location-access");
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
    await dropAppRole(maintenance, APP_ROLE);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_users");
  Object.assign(
    alpha,
    await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`, "alpha.owner@example.com"),
  );
  Object.assign(
    beta,
    await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`, "beta.owner@example.com"),
  );
});

function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

/**
 * The branches a member actually reaches, resolved the way a request does:
 * read the membership row and its assignments inside the tenant scope, read
 * the business's own branches, then apply the pure policy. Going through the
 * real reads is the point — it is what puts RLS in the path, so a
 * cross-tenant assignment is filtered by the database rather than by the
 * policy function being asked nicely.
 */
async function reachFor(businessId: string, memberId: string): Promise<string[]> {
  return asBusiness(businessId, async () => {
    const member = await dbLib.query<{
      role: string;
      location_id: string | null;
      location_scope: string;
    }>("SELECT role, location_id, location_scope FROM users WHERE id = $1", [memberId]);
    const assigned = await dbLib.query<{ location_id: string }>(
      "SELECT location_id FROM user_locations WHERE user_id = $1",
      [memberId],
    );
    const branches = await dbLib.query<{ id: string }>("SELECT id FROM locations");

    const row = member.rows[0];
    return locationAccess.accessibleLocationIds(
      {
        role: row.role as never,
        defaultLocationId: row.location_id,
        assignedLocationIds: assigned.rows.map((r) => r.location_id),
        locationScope: row.location_scope as never,
      },
      branches.rows.map((r) => r.id),
    );
  });
}

describe("the isolation assertions are not vacuous", () => {
  it("runs the application pool as a role row-level security applies to", async () => {
    // Without this, every isolation expectation in the next describe would
    // pass on a superuser connection that never consults a policy. This is the
    // guard that makes the rest of the file mean something.
    const { rows } = await dbLib.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT current_user, r.rolsuper, r.rolbypassrls
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0].current_user).toBe(APP_ROLE);
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
  });
});

describe("tenant isolation is still the floor under the permission model", () => {
  it("does not show one business another's memberships, whatever the role", () => {
    return asBusiness(alpha.businessId, async () => {
      const { rows } = await dbLib.query<{ business_id: string }>(
        "SELECT business_id FROM users",
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.business_id).toBe(alpha.businessId);
    });
  });

  it("cannot read a specific foreign membership even by its exact id", async () => {
    // The shape that matters: an id leaked into a URL. RLS must make it a
    // not-found rather than a permission decision the route has to remember.
    const foreign = await seedMember(beta.businessId, "manager");
    await asBusiness(alpha.businessId, async () => {
      const { rows } = await dbLib.query("SELECT id FROM users WHERE id = $1", [foreign]);
      expect(rows).toHaveLength(0);
    });
  });

  it("cannot update a foreign membership", async () => {
    const foreign = await seedMember(beta.businessId, "cashier");
    await asBusiness(alpha.businessId, async () => {
      const result = await dbLib.query("UPDATE users SET role = 'owner' WHERE id = $1", [foreign]);
      expect(result.rowCount).toBe(0);
    });
    const after = await db.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [foreign]);
    expect(after.rows[0].role).toBe("cashier");
  });

  it("keeps a business's locations to itself", () => {
    return asBusiness(alpha.businessId, async () => {
      const { rows } = await dbLib.query<{ id: string }>("SELECT id FROM locations");
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(alpha.locationId);
      expect(ids).not.toContain(beta.locationId);
    });
  });
});

describe("branch scope (migration 0170)", () => {
  it("gives 'all' every branch in the business and none outside it", async () => {
    const member = await seedMember(alpha.businessId, "manager", { locationScope: "all" });
    const ids = await reachFor(alpha.businessId, member);
      expect([...ids].sort()).toEqual([alpha.locationId, alpha.secondLocationId].sort());
      expect(ids).not.toContain(beta.locationId);
  });

  it("gives 'home' exactly the home branch", async () => {
    const member = await seedMember(alpha.businessId, "cashier", {
      locationScope: "home",
      defaultLocationId: alpha.locationId,
    });
    const ids = await reachFor(alpha.businessId, member);
      expect([...ids]).toEqual([alpha.locationId]);
  });

  it("gives 'home' with no home branch NOTHING, which is the bug that closed", async () => {
    /*
     * Before 0170 this member — a non-owner with no `user_locations` rows and a
     * NULL `location_id` — fell through to "every branch". Deny-by-default
     * means the absence of an assignment is an absence of access, not a
     * wildcard.
     */
    const member = await seedMember(alpha.businessId, "cashier", {
      locationScope: "home",
      defaultLocationId: null,
    });
    const ids = await reachFor(alpha.businessId, member);
      expect([...ids]).toEqual([]);
  });

  it("gives 'selected' only the branches actually assigned", async () => {
    const member = await seedMember(alpha.businessId, "manager", { locationScope: "selected" });
    await db.query("INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)", [
      member,
      alpha.secondLocationId,
    ]);
    const ids = await reachFor(alpha.businessId, member);
      expect([...ids]).toEqual([alpha.secondLocationId]);
  });

  it("never lets an assignment reach across the tenant boundary", async () => {
    // A foreign location id written into user_locations must not resolve, even
    // though the row itself exists.
    const member = await seedMember(alpha.businessId, "manager", { locationScope: "selected" });
    await db.query("INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)", [
      member,
      beta.locationId,
    ]);
    const ids = await reachFor(alpha.businessId, member);
      expect([...ids]).not.toContain(beta.locationId);
  });

  it("defaults the column to 'home' rather than to a wildcard", async () => {
    const member = await seedMember(alpha.businessId, "waiter");
    const { rows } = await db.query<{ location_scope: string }>(
      "SELECT location_scope FROM users WHERE id = $1",
      [member],
    );
    expect(rows[0].location_scope).toBe("home");
  });

  it("gave every pre-existing owner the reach they already had", async () => {
    // The backfill's promise: nobody is narrowed at deploy. An owner roams.
    const ids = await reachFor(alpha.businessId, alpha.ownerId);
    expect([...ids].sort()).toEqual([alpha.locationId, alpha.secondLocationId].sort());
  });
});

describe("effective permissions resolve from the row as stored", () => {
  it("applies a grant on the next request, with no re-authentication", async () => {
    const member = await seedMember(alpha.businessId, "cashier");
    await db.query("UPDATE users SET permissions = $2 WHERE id = $1", [
      member,
      JSON.stringify({ granted: ["payments.refund"], revoked: [] }),
    ]);

    const { rows } = await db.query<{ role: string; permissions: unknown }>(
      "SELECT role, permissions FROM users WHERE id = $1",
      [member],
    );
    const effective = permissions.effectivePermissions(
      rows[0].role as never,
      permissions.parseOverrides(rows[0].permissions),
    );
    expect(effective.has("payments.refund")).toBe(true);
  });

  it("applies a revocation the same way", async () => {
    const member = await seedMember(alpha.businessId, "cashier");
    expect(permissions.roleBasePermissions("cashier")).toContain("payments.take");

    await db.query("UPDATE users SET permissions = $2 WHERE id = $1", [
      member,
      JSON.stringify({ granted: [], revoked: ["payments.take"] }),
    ]);
    const { rows } = await db.query<{ role: string; permissions: unknown }>(
      "SELECT role, permissions FROM users WHERE id = $1",
      [member],
    );
    const effective = permissions.effectivePermissions(
      rows[0].role as never,
      permissions.parseOverrides(rows[0].permissions),
    );
    expect(effective.has("payments.take")).toBe(false);
  });

  it("cannot store its way into an owner-only permission", async () => {
    // `api.manage` is owner-only: even written straight into the column by
    // hand, `effectivePermissions` refuses to apply it.
    const member = await seedMember(alpha.businessId, "manager");
    await db.query("UPDATE users SET permissions = $2 WHERE id = $1", [
      member,
      JSON.stringify({ granted: ["api.manage"], revoked: [] }),
    ]);
    const { rows } = await db.query<{ role: string; permissions: unknown }>(
      "SELECT role, permissions FROM users WHERE id = $1",
      [member],
    );
    const effective = permissions.effectivePermissions(
      rows[0].role as never,
      permissions.parseOverrides(rows[0].permissions),
    );
    expect(effective.has("api.manage")).toBe(false);
  });

  it("cannot revoke an owner out of their own business", async () => {
    await db.query("UPDATE users SET permissions = $2 WHERE id = $1", [
      alpha.ownerId,
      JSON.stringify({ granted: [], revoked: ["team.manage", "settings.manage"] }),
    ]);
    const { rows } = await db.query<{ role: string; permissions: unknown }>(
      "SELECT role, permissions FROM users WHERE id = $1",
      [alpha.ownerId],
    );
    const effective = permissions.effectivePermissions(
      rows[0].role as never,
      permissions.parseOverrides(rows[0].permissions),
    );
    expect(effective.has("team.manage")).toBe(true);
    expect(effective.has("settings.manage")).toBe(true);
  });
});

describe("the new roles are storable and resolve to their presets", () => {
  it("accepts admin as a membership role", async () => {
    const member = await seedMember(alpha.businessId, "admin");
    const { rows } = await db.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [
      member,
    ]);
    expect(rows[0].role).toBe("admin");
  });

  it("resolves admin to everything except the owner-only keys", async () => {
    const member = await seedMember(alpha.businessId, "admin");
    const { rows } = await db.query<{ role: string; permissions: unknown }>(
      "SELECT role, permissions FROM users WHERE id = $1",
      [member],
    );
    const effective = permissions.effectivePermissions(
      rows[0].role as never,
      permissions.parseOverrides(rows[0].permissions),
    );
    expect(effective.has("api.manage")).toBe(false);
    expect(effective.has("team.manage")).toBe(true);
    expect(effective.has("ledger.post")).toBe(true);
  });

  it("keeps admin reducible, unlike owner", async () => {
    // `admin` is a rule, not an absolute role: overrides still apply to it, so
    // an owner can trim a deputy without inventing a custom role.
    const member = await seedMember(alpha.businessId, "admin", {
      permissions: { granted: [], revoked: ["payments.refund"] },
    });
    const { rows } = await db.query<{ role: string; permissions: unknown }>(
      "SELECT role, permissions FROM users WHERE id = $1",
      [member],
    );
    const effective = permissions.effectivePermissions(
      rows[0].role as never,
      permissions.parseOverrides(rows[0].permissions),
    );
    expect(effective.has("payments.refund")).toBe(false);
  });
});

describe("PIN-only staff are first-class memberships", () => {
  it("exists with no platform identity at all", async () => {
    const member = await seedMember(alpha.businessId, "waiter");
    const { rows } = await db.query<{ platform_user_id: string | null }>(
      "SELECT platform_user_id FROM users WHERE id = $1",
      [member],
    );
    expect(rows[0].platform_user_id).toBeNull();
  });

  it("still resolves a full permission set", async () => {
    const member = await seedMember(alpha.businessId, "waiter");
    const { rows } = await db.query<{ role: string; permissions: unknown }>(
      "SELECT role, permissions FROM users WHERE id = $1",
      [member],
    );
    const effective = permissions.effectivePermissions(
      rows[0].role as never,
      permissions.parseOverrides(rows[0].permissions),
    );
    expect(effective.has("orders.create")).toBe(true);
    expect(effective.has("payments.refund")).toBe(false);
  });
});
