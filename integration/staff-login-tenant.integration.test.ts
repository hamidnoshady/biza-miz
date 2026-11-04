/**
 * Which business a staff PIN login belongs to, on a deployment where the host
 * is NOT the tenancy boundary.
 *
 * The bug this pins: after the login split (`/` is the staff quick login, its
 * `/admin` subdirectory the owner's password form), the staff picker became
 * the entire front door of a business's origin — and on a platform serving
 * several businesses with `ROOT_DOMAIN` unset, `resolveLoginBusinessId` had
 * nothing left to name a tenant with but "the only active business". With two
 * it answered `business_required`, the roster read 400'd, and every till in
 * the building showed «دریافت فهرست کارکنان ممکن نشد» over a business that
 * plainly had staff. The owner's email login kept working throughout, because
 * it resolves a tenant from that person's memberships instead — the exact
 * "admin signs in, staff cannot" shape reported.
 *
 * Runs as an unprivileged role for the same reason first-run-guard does: the
 * resolution happens inside `withoutTenantScope`, and under a superuser every
 * policy is a no-op, so a passing test would prove nothing.
 */
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";
import { loginRoster, resolveLoginBusinessId } from "../src/lib/employee-service";
import { withTenant } from "../src/lib/db";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_staff_login_test_role";
const APP_PASSWORD = "staff-login-test-password";

let databaseName: string;
let ownerClient: Client;
let previousRootDomain: string | undefined;
let titeaId: string;
let otherId: string;

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

/** See pairing.integration.test.ts: db.ts caches its pool on globalThis. */
const globalForPg = globalThis as unknown as { pgPool?: Pool };

async function seedBusiness(
  name: string,
  slug: string,
  subdomain: string,
  staff: string[],
): Promise<string> {
  const biz = await ownerClient.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, subdomain, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
    [name, slug, subdomain],
  );
  const businessId = biz.rows[0].id;
  const loc = await ownerClient.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  for (const fullName of staff) {
    await ownerClient.query(
      `INSERT INTO users (business_id, location_id, full_name, role, pin_hash)
       VALUES ($1, $2, $3, 'cashier', 'pin-hash')`,
      [businessId, loc.rows[0].id, fullName],
    );
  }
  return businessId;
}

beforeAll(async () => {
  databaseName = `pos_staff_login_${randomUUID().replaceAll("-", "")}`;

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

  ownerClient = new Client({ connectionString: ownerUrl });
  await ownerClient.connect();

  titeaId = await seedBusiness("تی‌تی‌ای", "titea", "titea", ["علی رضایی", "مریم احمدی"]);
  otherId = await seedBusiness("کافه دیگر", "other-cafe", "othercafe", ["حسن کریمی"]);

  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  // Host tenancy off — the deployment this whole file is about.
  previousRootDomain = process.env.ROOT_DOMAIN;
  delete process.env.ROOT_DOMAIN;
}, 120_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  if (previousRootDomain === undefined) delete process.env.ROOT_DOMAIN;
  else process.env.ROOT_DOMAIN = previousRootDomain;
  await ownerClient?.end();

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await dropAppRole(maintenance, APP_ROLE);
  } finally {
    await maintenance.end();
  }
});

describe("the staff login's tenant, with ROOT_DOMAIN unset", () => {
  it("runs as a role that row-level security applies to", async () => {
    const { rows } = await ownerClient.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    expect(rows[0].privileged).toBe(false);
  });

  it("names the business from the origin's first label", async () => {
    expect(await resolveLoginBusinessId({ host: "titea.app.eshobe.com" })).toEqual({
      businessId: titeaId,
      error: null,
    });
    expect(await resolveLoginBusinessId({ host: "othercafe.app.eshobe.com:3000" })).toEqual({
      businessId: otherId,
      error: null,
    });
  });

  it("hands that business a roster with its own staff on it", async () => {
    const { businessId } = await resolveLoginBusinessId({ host: "titea.app.eshobe.com" });
    expect(businessId).toBe(titeaId);
    const roster = await withTenant(businessId!, () => loginRoster(businessId!));
    expect(roster.map((entry) => entry.fullName).sort()).toEqual(["علی رضایی", "مریم احمدی"].sort());
  });

  it("follows a rename alias, since no host-scoped cookie depends on the origin here", async () => {
    await ownerClient.query(
      "INSERT INTO business_subdomain_aliases (business_id, alias) VALUES ($1, 'titeaold')",
      [titeaId],
    );
    expect(await resolveLoginBusinessId({ host: "titeaold.app.eshobe.com" })).toEqual({
      businessId: titeaId,
      error: null,
    });
  });

  it("still refuses a host that names no business, rather than guessing one", async () => {
    // The refusal is the point: with two businesses active there is no
    // defensible default, and picking either would sign a cashier into the
    // wrong shop. `business_required` is what the login screen turns into
    // «این نشانی به کسب‌وکاری وصل نیست».
    expect(await resolveLoginBusinessId({ host: "nosuchshop.app.eshobe.com" })).toEqual({
      businessId: null,
      error: "business_required",
    });
    expect(await resolveLoginBusinessId({ host: "localhost:3000" })).toEqual({
      businessId: null,
      error: "business_required",
    });
  });

  it("never reaches past an explicit businessId in the request", async () => {
    // A kiosk URL that names its business outranks the hostname it happens to
    // be typed into; the host label is the fallback, not an override.
    expect(
      await resolveLoginBusinessId({ businessId: otherId, host: "titea.app.eshobe.com" }),
    ).toEqual({ businessId: otherId, error: null });
  });

  it("ignores a suspended business's subdomain", async () => {
    await ownerClient.query("UPDATE businesses SET status = 'suspended' WHERE id = $1", [otherId]);
    try {
      // Only titea is active now, so the last-resort single-business rule
      // answers with it — the point is that the suspended row never does.
      expect(await resolveLoginBusinessId({ host: "othercafe.app.eshobe.com" })).toEqual({
        businessId: titeaId,
        error: null,
      });
    } finally {
      await ownerClient.query("UPDATE businesses SET status = 'active' WHERE id = $1", [otherId]);
    }
  });
});
