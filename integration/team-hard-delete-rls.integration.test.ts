/**
 * Restricted-role RLS coverage for the hard membership removal (issue #1007).
 *
 * The team suite runs as the database owner, which BYPASSRLSes — so the one
 * statement in `deleteMembership` that is *about* cross-tenant state would
 * pass vacuously there. The login identity (`platform_users`) is shared
 * infrastructure: one person in two businesses has one identity and two
 * `users` rows pointing at it. Deciding whether this delete may purge the
 * identity therefore has to see *every* membership that links it, and the
 * identity row itself is no longer visible under tenant RLS once the local
 * membership is gone (`platform_users` is reachable only through a linking
 * `users` row of the current business — migration 0021).
 *
 * This suite connects as a purpose-created unprivileged role (the
 * accounting-dimensions-rls suite's arrangement) and pins both halves:
 * a shared identity survives one membership's delete, and an orphaned one is
 * actually purged instead of silently surviving as unreachable rows.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL required");

const APP_ROLE = "pos_team_rls_role";
const APP_PASSWORD = "team-rls-password";

let databaseName: string;
let owner: Client;

/** Modules under test are imported after DATABASE_URL points at the app-role connection. */
let team: typeof import("../src/lib/team-service");
let dbLib: typeof import("../src/lib/db");

const alpha = { businessId: "", ownerId: "" };
const beta = { businessId: "", ownerId: "" };

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

/** Seeded through the owner (superuser) connection — fixtures, not the code under test. */
async function seedBusiness(name: string): Promise<{ businessId: string; ownerId: string }> {
  const businessId = (
    await owner.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
      [name, `biz-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  await owner.query("INSERT INTO locations (business_id, name) VALUES ($1, 'Main')", [businessId]);
  const ownerId = (
    await owner.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email)
       VALUES ($1, 'owner', 'Owner', $2) RETURNING id`,
      [businessId, `owner-${randomUUID().slice(0, 8)}@example.com`],
    )
  ).rows[0].id;
  return { businessId, ownerId };
}

async function seedMember(
  businessId: string,
  fullName: string,
  email: string,
): Promise<{ userId: string; platformUserId: string }> {
  const platformUserId = (
    await owner.query<{ id: string }>(
      `INSERT INTO platform_users (email, password_hash, full_name)
       VALUES ($1, 'x', $2) RETURNING id`,
      [email, fullName],
    )
  ).rows[0].id;
  const userId = (
    await owner.query<{ id: string }>(
      `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
       VALUES ($1, $2, 'cashier', $3, $4) RETURNING id`,
      [businessId, platformUserId, fullName, email],
    )
  ).rows[0].id;
  return { userId, platformUserId };
}

beforeAll(async () => {
  databaseName = `pos_team_rls_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName) });

  owner = new Client({ connectionString: urlFor(databaseName) });
  await owner.connect();
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
  });

  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  team = await import("../src/lib/team-service");
  dbLib = await import("../src/lib/db");
}, 120_000);

afterAll(async () => {
  await owner?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await owner.query("DELETE FROM users");
  await owner.query("DELETE FROM platform_users");
  await owner.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha"));
  Object.assign(beta, await seedBusiness("Beta"));
});

describe("the identity purge under tenant RLS (issue #1007)", () => {
  it("keeps a shared login identity when another business's membership uses it", async () => {
    // One person, two businesses, one identity — the `users` row this delete
    // removes is only the Alpha half of it.
    const email = `shared.${randomUUID().slice(0, 8)}@example.com`;
    const alphaMember = await seedMember(alpha.businessId, "Shared Person", email);
    await owner.query(
      `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
       VALUES ($1, $2, 'cashier', 'Shared Person', $3)`,
      [beta.businessId, alphaMember.platformUserId, email],
    );

    await dbLib.withTenant(alpha.businessId, () =>
      team.deleteMembership(alpha.businessId, alphaMember.userId, alpha.ownerId),
    );

    const identity = await owner.query("SELECT 1 FROM platform_users WHERE id = $1", [
      alphaMember.platformUserId,
    ]);
    expect(identity.rows, "the identity the Beta membership uses must survive").toHaveLength(1);
  });

  it("purges the identity this membership orphaned, instead of leaving it unreachable", async () => {
    // Without the documented cross-tenant bypass, `platform_users` stops being
    // visible the moment the membership row is gone (migration 0021 links it
    // through `users`), so the purge would delete nothing and the email would
    // stay "already registered" forever — migration 0037's exact complaint.
    const email = `orphan.${randomUUID().slice(0, 8)}@example.com`;
    const member = await seedMember(alpha.businessId, "Orphan Person", email);

    await dbLib.withTenant(alpha.businessId, () =>
      team.deleteMembership(alpha.businessId, member.userId, alpha.ownerId),
    );

    const identity = await owner.query("SELECT 1 FROM platform_users WHERE id = $1", [
      member.platformUserId,
    ]);
    expect(identity.rows, "the orphaned identity must be purged").toHaveLength(0);
    const membership = await owner.query("SELECT 1 FROM users WHERE id = $1", [member.userId]);
    expect(membership.rows).toHaveLength(0);
  });
});
