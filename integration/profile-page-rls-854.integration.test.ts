/**
 * Issue #854 F11 under the production runtime role.
 *
 * profile-security-854 proves the Profile page and its routes agree, but its
 * library pool is the superuser `pos`, which row-level security ignores. In
 * production the pool is the unprivileged app role, and a read issued outside
 * a tenant scope comes back empty — RLS fails closed. A server page cannot
 * borrow `getSession()`'s scope (see `withTenantScope` in src/lib/auth.ts), so
 * an unwrapped read on the page silently falls back to defaults: the runtime
 * role's guessed deployment profile instead of the business's own (the page
 * then offers forms the routes refuse) and no credential state at all.
 *
 * Here the page is rendered — and the route it must agree with is called —
 * through a purpose-created unprivileged role (the helper and reasoning of
 * authorization.integration.test.ts), so a page read that escapes the tenant
 * scope fails.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import type { ReactElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
  }),
  headers: async () => new Headers(),
}));

/** Rendered for its props only, as in profile-security-854. */
vi.mock("../src/app/(app)/settings/profile/profile-section", () => ({
  ProfileSection: function ProfileSectionStub() {
    return null;
  },
}));
vi.mock("../src/app/dashboard/page-chrome", () => ({
  PageShell: function PageShellStub() {
    return null;
  },
  PageHeader: function PageHeaderStub() {
    return null;
  },
}));

const APP_ROLE = "pos_profile_rls_854_role";
const APP_PASSWORD = "profile-rls-854-password";

let databaseName: string;
/** Owner connection: seeds fixtures, bypassing RLS on purpose. */
let db: Client;
const previousDeploymentRole = process.env.DEPLOYMENT_ROLE;

let dbLib: typeof import("../src/lib/db");
let authLib: typeof import("../src/lib/auth");
let profilePage: typeof import("../src/app/(app)/settings/profile/page");
let profileSectionModule: typeof import("../src/app/(app)/settings/profile/profile-section");
let phoneSelfRoute: typeof import("../src/app/api/auth/phone/self/route");

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

beforeAll(async () => {
  databaseName = `pos_profile_rls_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({ databaseUrl: urlFor(databaseName), roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });

  // Everything the page and the route read goes through the unprivileged role.
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  authLib = await import("../src/lib/auth");
  profilePage = await import("../src/app/(app)/settings/profile/page");
  profileSectionModule = await import("../src/app/(app)/settings/profile/profile-section");
  phoneSelfRoute = await import("../src/app/api/auth/phone/self/route");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  if (previousDeploymentRole === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = previousDeploymentRole;
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
  cookieJar.clear();
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_users");
});

// ---------------------------------------------------------------------------
// Fixtures (seeded through the owner connection)
// ---------------------------------------------------------------------------

type Profile = "cloud" | "hybrid" | "local";

interface Member {
  id: string;
  businessId: string;
  locationId: string;
  role: "owner" | "cashier";
  platformUserId: string | null;
}

async function seedBusiness(profile: Profile): Promise<{ id: string; locationId: string }> {
  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Profile ${profile}`, `profile-rls-${randomUUID().slice(0, 8)}`],
  );
  const id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`,
    [id],
  );
  await db.query(
    `INSERT INTO settings (business_id, location_id, key, value) VALUES ($1, NULL, 'deployment.profile', $2)`,
    [id, JSON.stringify({ profile, pairedAt: new Date().toISOString() })],
  );
  return { id, locationId: location.rows[0].id };
}

async function addMember(
  business: { id: string; locationId: string },
  role: Member["role"],
  withIdentity: boolean,
): Promise<Member> {
  let platformUserId: string | null = null;
  if (withIdentity) {
    const identity = await db.query<{ id: string }>(
      `INSERT INTO platform_users (email, password_hash, full_name) VALUES ($1, 'not-a-real-hash', 'Member') RETURNING id`,
      [`member-${randomUUID().slice(0, 8)}@example.com`],
    );
    platformUserId = identity.rows[0].id;
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, location_id, location_scope)
     VALUES ($1, $2, $3, $4, $5, 'home') RETURNING id`,
    [business.id, platformUserId, role, `${role}-${randomUUID().slice(0, 4)}`, business.locationId],
  );
  await db.query(`INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [
    rows[0].id,
    business.id,
  ]);
  return { id: rows[0].id, businessId: business.id, locationId: business.locationId, role, platformUserId };
}

/** A real door's session: an `employee_sessions` row, named by the token. */
async function signIn(member: Member): Promise<void> {
  const session = await db.query<{ id: string }>(
    `INSERT INTO employee_sessions (employee_id, business_id, token_hash, device_label, expires_at, login_method)
     VALUES ($1, $2, $3, 'Test', now() + interval '1 day', 'password') RETURNING id`,
    [member.id, member.businessId, createHash("sha256").update(randomBytes(16)).digest("hex")],
  );
  const token = await authLib.signSession({
    sub: member.id,
    role: member.role,
    businessId: member.businessId,
    locationId: member.locationId,
    fullName: "Member",
    ...(member.platformUserId ? { platformUserId: member.platformUserId } : {}),
    employeeSessionId: session.rows[0].id,
    recentAuthAt: Math.floor(Date.now() / 1000),
  });
  cookieJar.set(authLib.SESSION_COOKIE, token);
}

async function profileProps(): Promise<Record<string, unknown>> {
  const page = (await profilePage.default()) as ReactElement<{ children: unknown }>;
  const children = ([] as unknown[]).concat(page.props.children);
  const section = children.find(
    (child): child is ReactElement<Record<string, unknown>> =>
      Boolean(child) &&
      typeof child === "object" &&
      (child as ReactElement).type === profileSectionModule.ProfileSection,
  );
  if (!section) throw new Error("the page rendered no ProfileSection");
  return section.props;
}

// ---------------------------------------------------------------------------

describe("#854 F11 under the unprivileged runtime role — the Profile page reads inside the tenant scope", () => {
  it("runs as a role row-level security applies to", async () => {
    expect(await dbLib.rlsEffective()).toBe(true);
  });

  describe.each(["central", "site"] as const)("on a %s server", (role) => {
    it.each(["cloud", "hybrid", "local"] as const)(
      "renders the stored %s profile's authority, exactly as the route reports it",
      async (profile) => {
        process.env.DEPLOYMENT_ROLE = role;
        const business = await seedBusiness(profile);
        const owner = await addMember(business, "owner", true);
        await signIn(owner);

        const props = await profileProps();
        const surfaces = props.credentialSurfaces as Record<string, { editable: boolean; readOnly: boolean }>;
        const cloudOwned = profile === "hybrid";
        for (const field of ["global_password", "login_phone", "totp_secret"]) {
          expect(surfaces[field].readOnly).toBe(cloudOwned);
        }
        expect(surfaces.staff_pin.editable).toBe(true);

        const phone = await phoneSelfRoute.GET();
        expect(phone.status).toBe(200);
        const body = (await phone.json()) as { credential: { readOnly: boolean }; deploymentProfile: string };
        expect(body.deploymentProfile).toBe(profile);
        expect(body.credential.readOnly).toBe(surfaces.login_phone.readOnly);
      },
    );
  });

  it("offers two-step sign-in from the member's own identity, not from a guess by role", async () => {
    process.env.DEPLOYMENT_ROLE = "central";
    const business = await seedBusiness("cloud");
    // A PIN role that holds a global identity: the role alone would say no.
    const cashier = await addMember(business, "cashier", true);
    await signIn(cashier);
    expect((await profileProps()).canUseMfa).toBe(true);

    const pinOnly = await addMember(business, "cashier", false);
    await signIn(pinOnly);
    expect((await profileProps()).canUseMfa).toBe(false);
  });

  it("still states the member's branch facts", async () => {
    process.env.DEPLOYMENT_ROLE = "central";
    const business = await seedBusiness("cloud");
    const owner = await addMember(business, "owner", true);
    await signIn(owner);
    expect((await profileProps()).branch).toMatchObject({
      active: { id: business.locationId, name: "Main" },
      home: { id: business.locationId, name: "Main" },
      homeStatus: "same",
    });
  });
});
