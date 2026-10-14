/**
 * Issue #854 follow-up audit (F01–F13) — the Profile security routes against a
 * real database.
 *
 * The component suites prove what the Profile screen *offers*; this file proves
 * what the routes behind it *do*, with real sessions, real rows and injected
 * database failures:
 *
 *  - **F01** ending one other session needs recent authentication, is scoped to
 *    this membership and this business, and commits with its audit row;
 *  - **F02 / F12** for all seven roles, the server page offers biometric
 *    management exactly when the WebAuthn routes accept it, a member can always
 *    list and remove their own authenticators, and enrolment stays PIN-roles-only;
 *  - **F03** step-up never accepts — or advertises — WebAuthn as a typed code,
 *    and no recent-auth window is granted without its audit row;
 *  - **F04** a self password change whose audit row cannot be written changes
 *    nothing: same hash, same token version, every session still alive;
 *  - **F05** a verified phone change and its audit row commit together;
 *  - **F06** resend, cancel, expiry and replay are bound to the server's live
 *    challenge, never to a number the browser sends;
 *  - **F07** a self-service PIN rotation refuses the member's own current PIN,
 *    while identical PINs across employees stay allowed (#953);
 *  - **F11** Cloud/Hybrid/Local: every surface the page marks read-only is
 *    refused by its route, including the pending-OTP and MFA confirm/resend
 *    actions;
 *  - **F13** the page's branch facts come from the membership, not the client.
 *
 * Failures are injected with a `BEFORE INSERT` trigger on `audit_log` that
 * raises for one named action only, created and dropped per test.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { generate as generateTotp } from "otplib";
import { NextRequest, type NextResponse } from "next/server";
import { Client } from "pg";
import type { ReactElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const sms = vi.hoisted(() => ({ sent: [] as { phone: string; code: string }[] }));
const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/sms-config", () => ({
  getPublicSmsConfig: async () => ({
    configured: true,
    hasStoredKey: true,
    keyHint: "••••1234",
    otpTemplate: "verify",
    fromEnvironment: false,
    updatedAt: null,
  }),
  getSmsProvider: async () => ({
    sendOtp: async (phone: string, code: string) => {
      sms.sent.push({ phone, code });
    },
  }),
}));

/**
 * The server page is rendered for its *props* only: the client card and the
 * page chrome are stubs, so the test reads exactly what the server decided to
 * hand the screen and compares it with what the routes accept.
 */
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

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let authLib: typeof import("../src/lib/auth");
let team: typeof import("../src/lib/team-service");
let settings: typeof import("../src/lib/settings");
let deployment: typeof import("../src/lib/deployment-mode");
let selfCredentials: typeof import("../src/lib/self-credentials");
let mfaEnrol: typeof import("../src/lib/mfa-enrol");
let sessionsSelfRoute: typeof import("../src/app/api/sessions/self/route");
let stepUpRoute: typeof import("../src/app/api/auth/step-up/route");
let passwordSelfRoute: typeof import("../src/app/api/auth/password/self/route");
let phoneSelfRoute: typeof import("../src/app/api/auth/phone/self/route");
let pinSelfRoute: typeof import("../src/app/api/auth/pin/self/route");
let mfaSelfRoute: typeof import("../src/app/api/auth/mfa/self/route");
let webauthnListRoute: typeof import("../src/app/api/auth/webauthn/credentials/route");
let webauthnItemRoute: typeof import("../src/app/api/auth/webauthn/credentials/[credentialId]/route");
let webauthnOptionsRoute: typeof import("../src/app/api/auth/webauthn/register/options/route");
let profilePage: typeof import("../src/app/(app)/settings/profile/page");
let profileSectionModule: typeof import("../src/app/(app)/settings/profile/profile-section");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_profile_854_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  authLib = await import("../src/lib/auth");
  team = await import("../src/lib/team-service");
  settings = await import("../src/lib/settings");
  deployment = await import("../src/lib/deployment-mode");
  selfCredentials = await import("../src/lib/self-credentials");
  mfaEnrol = await import("../src/lib/mfa-enrol");
  sessionsSelfRoute = await import("../src/app/api/sessions/self/route");
  stepUpRoute = await import("../src/app/api/auth/step-up/route");
  passwordSelfRoute = await import("../src/app/api/auth/password/self/route");
  phoneSelfRoute = await import("../src/app/api/auth/phone/self/route");
  pinSelfRoute = await import("../src/app/api/auth/pin/self/route");
  mfaSelfRoute = await import("../src/app/api/auth/mfa/self/route");
  webauthnListRoute = await import("../src/app/api/auth/webauthn/credentials/route");
  webauthnItemRoute = await import("../src/app/api/auth/webauthn/credentials/[credentialId]/route");
  webauthnOptionsRoute = await import("../src/app/api/auth/webauthn/register/options/route");
  profilePage = await import("../src/app/(app)/settings/profile/page");
  profileSectionModule = await import("../src/app/(app)/settings/profile/profile-section");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // The fault injector: raise for exactly one audit action (TG_ARGV[0]).
  await db.query(`
    CREATE OR REPLACE FUNCTION fail_audit_854() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = TG_ARGV[0] THEN
        RAISE EXCEPTION 'injected audit failure for %', NEW.action USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql`);
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
  sms.sent.length = 0;
  cookieJar.clear();
  await db.query("DELETE FROM auth_login_attempts");
  await db.query("DELETE FROM mfa_challenges");
  await db.query("DELETE FROM mfa_enrolments");
  await db.query("DELETE FROM employee_credentials");
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_users");
});

afterEach(async () => {
  await db.query("DROP TRIGGER IF EXISTS trg_fail_audit_854 ON audit_log");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROLES = ["owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen"] as const;
type TestRole = (typeof ROLES)[number];
const PIN_ROLE_SET = new Set<TestRole>(["cashier", "waiter", "kitchen"]);
type Profile = "cloud" | "hybrid" | "local";

interface Business {
  id: string;
  mainLocationId: string;
}

interface Member {
  id: string;
  businessId: string;
  role: TestRole;
  fullName: string;
  platformUserId: string | null;
  email: string | null;
  password: string | null;
  locationId: string | null;
}

const PASSWORD = "profile-password-854";

async function seedBusiness(name: string, profile?: Profile): Promise<Business> {
  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`],
  );
  const id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`,
    [id],
  );
  if (profile) await setProfile(id, profile);
  return { id, mainLocationId: location.rows[0].id };
}

async function addLocation(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id`,
    [businessId, name],
  );
  return rows[0].id;
}

async function setProfile(businessId: string, profile: Profile): Promise<void> {
  await dbLib.withTenant(businessId, () =>
    dbLib.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       VALUES ($1, NULL, $2, $3)
       ON CONFLICT (business_id, location_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [
        businessId,
        settings.SETTING_KEYS.deploymentProfile,
        JSON.stringify({ profile, pairedAt: new Date().toISOString() }),
      ],
    ),
  );
  expect((await deployment.readDeploymentProfile(businessId)).profile).toBe(profile);
}

async function createIdentity(): Promise<{ id: string; email: string }> {
  const email = `member-${randomUUID().slice(0, 8)}@example.com`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name) VALUES ($1, $2, 'Member') RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10)],
  );
  return { id: rows[0].id, email };
}

/**
 * A membership. Password roles get a global identity (with a password) unless
 * one is passed in — passing one is how a single person is made a member of
 * several businesses. PIN roles get none, as the product creates them.
 */
async function addMember(
  business: Business,
  role: TestRole,
  options: {
    identity?: { id: string; email: string } | null;
    phone?: string | null;
    phoneVerified?: boolean;
    locationId?: string | null;
    locationScope?: "all" | "selected" | "home";
  } = {},
): Promise<Member> {
  const identity =
    options.identity !== undefined
      ? options.identity
      : PIN_ROLE_SET.has(role)
        ? null
        : await createIdentity();
  const locationId = options.locationId === undefined ? business.mainLocationId : options.locationId;
  const fullName = `${role}-${randomUUID().slice(0, 4)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email, phone_e164,
                        phone_verified_at, location_id, location_scope)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() ELSE NULL END, $8, $9)
     RETURNING id`,
    [
      business.id,
      identity?.id ?? null,
      role,
      fullName,
      identity?.email ?? null,
      options.phone ?? null,
      Boolean(options.phone) && options.phoneVerified !== false,
      locationId,
      options.locationScope ?? (role === "owner" ? "all" : "home"),
    ],
  );
  await db.query(`INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [
    rows[0].id,
    business.id,
  ]);
  return {
    id: rows[0].id,
    businessId: business.id,
    role,
    fullName,
    platformUserId: identity?.id ?? null,
    email: identity?.email ?? null,
    password: identity ? PASSWORD : null,
    locationId,
  };
}

async function addSession(member: Member, label = "تبلت سالن"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO employee_sessions (employee_id, business_id, token_hash, device_label, expires_at, login_method)
     VALUES ($1, $2, $3, $4, now() + interval '1 day', 'password')
     RETURNING id`,
    [member.id, member.businessId, createHash("sha256").update(randomBytes(16)).digest("hex"), label],
  );
  return rows[0].id;
}

/** Sign in as `member`; `recent: false` makes the recent-auth stamp an hour old. */
async function signIn(
  member: Member,
  options: { sessionId?: string | null; recent?: boolean; activeLocationId?: string | null } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await authLib.signSession({
    sub: member.id,
    role: member.role,
    businessId: member.businessId,
    locationId: member.locationId,
    fullName: member.fullName,
    ...(member.platformUserId ? { platformUserId: member.platformUserId } : {}),
    ...(options.sessionId ? { employeeSessionId: options.sessionId } : {}),
    ...(options.activeLocationId !== undefined ? { activeLocationId: options.activeLocationId } : {}),
    recentAuthAt: options.recent === false ? now - 3600 : now,
  });
  cookieJar.set(authLib.SESSION_COOKIE, token);
  return token;
}

function request(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });
}

interface Outcome {
  status: number;
  body: Record<string, unknown> | null;
  response: NextResponse | null;
}

/** Run a handler; a thrown error is the 500 Next would answer with. */
async function call(run: () => Promise<NextResponse>): Promise<Outcome> {
  try {
    const response = await run();
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body, response };
  } catch {
    return { status: 500, body: null, response: null };
  }
}

function sessionCookieOf(outcome: Outcome): string | undefined {
  return outcome.response?.cookies.get(authLib.SESSION_COOKIE)?.value;
}

async function failAuditFor(action: string): Promise<void> {
  if (!/^[a-z_.]+$/.test(action)) throw new Error(`unexpected audit action ${action}`);
  await db.query("DROP TRIGGER IF EXISTS trg_fail_audit_854 ON audit_log");
  await db.query(
    `CREATE TRIGGER trg_fail_audit_854 BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION fail_audit_854('${action}')`,
  );
}

async function auditRows(businessId: string, action: string) {
  const { rows } = await db.query<{ payload: Record<string, unknown>; user_id: string | null }>(
    `SELECT payload, user_id FROM audit_log WHERE business_id = $1 AND action = $2 ORDER BY created_at`,
    [businessId, action],
  );
  return rows;
}

async function sessionRevoked(sessionId: string): Promise<boolean> {
  const { rows } = await db.query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM employee_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.revoked_at != null;
}

async function setMemberPin(member: Member, pin: string): Promise<void> {
  await dbLib.withTenant(member.businessId, () => team.setPin(member.businessId, member.id, pin, null));
}

async function pinWorks(member: Member, pin: string): Promise<boolean> {
  return dbLib.withTenant(member.businessId, () =>
    selfCredentials.verifySelfPin(member.businessId, member.id, pin),
  );
}

async function addWebauthnCredential(member: Member): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO employee_credentials
       (employee_id, business_id, credential_type, webauthn_credential_id, webauthn_public_key, display_hint)
     VALUES ($1, $2, 'webauthn', $3, 'test-public-key', 'Phone')
     RETURNING id`,
    [member.id, member.businessId, `cred-${randomUUID()}`],
  );
  return rows[0].id;
}

/** The props the server page hands the Profile card, for the signed-in member. */
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

const sessionsSelf = (body: unknown) =>
  call(() => sessionsSelfRoute.DELETE(request("/api/sessions/self", "DELETE", body)));
const phoneSelf = (body: unknown) => call(() => phoneSelfRoute.POST(request("/api/auth/phone/self", "POST", body)));
const pinSelf = (body: unknown) => call(() => pinSelfRoute.POST(request("/api/auth/pin/self", "POST", body)));
const passwordSelf = (body: unknown) =>
  call(() => passwordSelfRoute.POST(request("/api/auth/password/self", "POST", body)));
const stepUp = (body: unknown) => call(() => stepUpRoute.POST(request("/api/auth/step-up", "POST", body)));

/** The send limiter allows one code a minute; tests that resend skip the wait. */
async function skipResendCooldown(): Promise<void> {
  await db.query(`DELETE FROM auth_login_attempts WHERE realm = 'phone_otp'`);
}

// ---------------------------------------------------------------------------
// F01
// ---------------------------------------------------------------------------

describe("#854 F01 — ending one session needs recent authentication and stays in scope", () => {
  it("refuses a stale session before looking the target up, and changes nothing", async () => {
    const business = await seedBusiness("RevokeStale");
    const owner = await addMember(business, "owner");
    const current = await addSession(owner, "این مرورگر");
    const other = await addSession(owner);
    await signIn(owner, { sessionId: current, recent: false });

    const refused = await sessionsSelf({ action: "revoke_one", sessionId: other });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: "recent_auth_required" });

    // A guessed id gets the same answer: a stale session cannot probe for ids.
    const probe = await sessionsSelf({ action: "revoke_one", sessionId: randomUUID() });
    expect(probe.status).toBe(403);
    expect(probe.body).toMatchObject({ error: "recent_auth_required" });

    expect(await sessionRevoked(other)).toBe(false);
    expect(await auditRows(business.id, "self.session_revoked")).toHaveLength(0);
  });

  it("lets a stale session end itself — a sign-out — and clears the cookie", async () => {
    const business = await seedBusiness("RevokeSelf");
    const cashier = await addMember(business, "cashier");
    const current = await addSession(cashier);
    await signIn(cashier, { sessionId: current, recent: false });

    const ended = await sessionsSelf({ action: "revoke_one", sessionId: current });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ ok: true, signedOut: true, revokedCount: 1 });
    expect(sessionCookieOf(ended)).toBe("");
    expect(await sessionRevoked(current)).toBe(true);
  });

  it("with recent authentication ends exactly the named session and audits it", async () => {
    const business = await seedBusiness("RevokeRecent");
    const manager = await addMember(business, "manager");
    const current = await addSession(manager, "این مرورگر");
    const other = await addSession(manager);
    const untouched = await addSession(manager, "گوشی");
    await signIn(manager, { sessionId: current });

    const ended = await sessionsSelf({ action: "revoke_one", sessionId: other });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ ok: true, signedOut: false, revokedCount: 1, scope: "business" });
    expect(sessionCookieOf(ended)).toBeUndefined();
    expect(await sessionRevoked(other)).toBe(true);
    expect(await sessionRevoked(untouched)).toBe(false);
    expect(await sessionRevoked(current)).toBe(false);

    const audit = await auditRows(business.id, "self.session_revoked");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ sessionId: other, currentSession: false });
  });

  it("answers session_not_found for another member's, another tenant's, or a malformed id", async () => {
    const alpha = await seedBusiness("RevokeAlpha");
    const beta = await seedBusiness("RevokeBeta");
    const identity = await createIdentity();
    const owner = await addMember(alpha, "owner", { identity });
    // The same person, also a member of another business (shared global identity).
    const ownerInBeta = await addMember(beta, "accountant", { identity });
    const colleague = await addMember(alpha, "waiter");

    const current = await addSession(owner);
    const colleagueSession = await addSession(colleague);
    const betaSession = await addSession(ownerInBeta);
    await signIn(owner, { sessionId: current });

    for (const sessionId of [colleagueSession, betaSession, "not-a-uuid"]) {
      const refused = await sessionsSelf({ action: "revoke_one", sessionId });
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ error: "session_not_found" });
    }
    expect(await sessionRevoked(colleagueSession)).toBe(false);
    expect(await sessionRevoked(betaSession)).toBe(false);
  });

  it("rolls the revocation back when its audit row cannot be written", async () => {
    const business = await seedBusiness("RevokeAudit");
    const owner = await addMember(business, "owner");
    const current = await addSession(owner);
    const other = await addSession(owner);
    await signIn(owner, { sessionId: current });
    await failAuditFor("self.session_revoked");

    const failed = await sessionsSelf({ action: "revoke_one", sessionId: other });
    expect(failed.status).toBe(500);
    expect(await sessionRevoked(other)).toBe(false);
  });

  it("keeps the bulk revocations' scopes: others is this business, all is every business", async () => {
    const alpha = await seedBusiness("BulkAlpha");
    const beta = await seedBusiness("BulkBeta");
    const identity = await createIdentity();
    const owner = await addMember(alpha, "owner", { identity });
    const ownerInBeta = await addMember(beta, "manager", { identity });
    const current = await addSession(owner);
    const otherAlpha = await addSession(owner);
    const betaSession = await addSession(ownerInBeta);

    await signIn(owner, { sessionId: current, recent: false });
    expect((await sessionsSelf({ action: "revoke_others" })).status).toBe(403);

    await signIn(owner, { sessionId: current });
    const others = await sessionsSelf({ action: "revoke_others" });
    expect(others.body).toMatchObject({ ok: true, scope: "business", revokedCount: 1 });
    expect(await sessionRevoked(otherAlpha)).toBe(true);
    expect(await sessionRevoked(betaSession)).toBe(false);
    expect(await sessionRevoked(current)).toBe(false);

    const all = await sessionsSelf({ action: "revoke_all" });
    expect(all.body).toMatchObject({ ok: true, scope: "global", signedOut: true });
    expect(await sessionRevoked(betaSession)).toBe(true);
    expect(await sessionRevoked(current)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F02 / F12
// ---------------------------------------------------------------------------

describe("#854 F02 / F12 — the page and the WebAuthn routes agree for all seven roles", () => {
  it.each(ROLES)("%s: enrolment matches the role policy, on every deployment profile", async (role) => {
    for (const profile of ["cloud", "hybrid", "local"] as const) {
      const business = await seedBusiness(`Webauthn${profile}`, profile);
      const member = await addMember(business, role);
      await signIn(member);

      const listed = await call(() => webauthnListRoute.GET());
      expect(listed.status).toBe(200);
      const mayEnrol = PIN_ROLE_SET.has(role);
      expect(listed.body).toMatchObject({
        credentials: [],
        canRegister: mayEnrol,
        canRemove: true,
        registerBlockedBy: mayEnrol ? null : "role",
      });

      const options = await call(() => webauthnOptionsRoute.POST());
      if (mayEnrol) {
        expect(options.status).toBe(200);
        expect(options.body).toHaveProperty("challengeToken");
      } else {
        expect(options.status).toBe(403);
        expect(options.body).toMatchObject({ error: "forbidden" });
      }

      // The server page offers the card exactly when the route would accept.
      const props = await profileProps();
      expect(props.showBiometric).toBe(mayEnrol);
    }
  });

  it.each(ROLES)("%s: an authenticator already registered stays listed and removable", async (role) => {
    const business = await seedBusiness("WebauthnHeld");
    const member = await addMember(business, role);
    const credentialId = await addWebauthnCredential(member);
    await signIn(member, { recent: false });

    const listed = await call(() => webauthnListRoute.GET());
    expect(listed.status).toBe(200);
    expect((listed.body?.credentials as { id: string }[]).map((c) => c.id)).toEqual([credentialId]);
    expect((await profileProps()).showBiometric).toBe(true);

    // Removal is still a sensitive mutation (#854 P1.8)...
    const stale = await call(() =>
      webauthnItemRoute.DELETE(request(`/api/auth/webauthn/credentials/${credentialId}`, "DELETE"), {
        params: Promise.resolve({ credentialId }),
      }),
    );
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ error: "recent_auth_required" });

    // ...but open to every role for their own authenticator.
    await signIn(member);
    const removed = await call(() =>
      webauthnItemRoute.DELETE(request(`/api/auth/webauthn/credentials/${credentialId}`, "DELETE"), {
        params: Promise.resolve({ credentialId }),
      }),
    );
    expect(removed.status).toBe(200);
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM employee_credentials WHERE id = $1`, [
      credentialId,
    ]);
    expect(rows[0].status).toBe("revoked");
  });

  it("never removes another member's authenticator, in this business or another", async () => {
    const alpha = await seedBusiness("WebauthnAlpha");
    const beta = await seedBusiness("WebauthnBeta");
    const cashier = await addMember(alpha, "cashier");
    const colleague = await addMember(alpha, "waiter");
    const foreign = await addMember(beta, "kitchen");
    const colleagueCredential = await addWebauthnCredential(colleague);
    const foreignCredential = await addWebauthnCredential(foreign);
    await signIn(cashier);

    for (const credentialId of [colleagueCredential, foreignCredential]) {
      const refused = await call(() =>
        webauthnItemRoute.DELETE(request(`/api/auth/webauthn/credentials/${credentialId}`, "DELETE"), {
          params: Promise.resolve({ credentialId }),
        }),
      );
      expect(refused.status).toBe(404);
    }
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM employee_credentials WHERE id = ANY($1::uuid[])`,
      [[colleagueCredential, foreignCredential]],
    );
    expect(rows.map((r) => r.status)).toEqual(["active", "active"]);

    // And the list is the caller's own only.
    const listed = await call(() => webauthnListRoute.GET());
    expect(listed.body?.credentials).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F03
// ---------------------------------------------------------------------------

describe("#854 F03 — step-up never treats WebAuthn as a typed code", () => {
  it("does not advertise WebAuthn to a member who holds a passkey, and refuses it if sent", async () => {
    const business = await seedBusiness("StepUpWebauthn");
    const cashier = await addMember(business, "cashier");
    await setMemberPin(cashier, "4821");
    await addWebauthnCredential(cashier);
    await signIn(cashier, { recent: false });

    const methods = await call(() => stepUpRoute.GET());
    expect(methods.status).toBe(200);
    expect(methods.body?.availableMethods).toEqual(["pin"]);
    expect(methods.body?.methodLabels).not.toHaveProperty("webauthn");
    expect(methods.body).not.toHaveProperty("hasWebauthn");

    const refused = await stepUp({ method: "webauthn", credential: "123456" });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "unsupported_method" });
    expect(sessionCookieOf(refused)).toBeUndefined();
    expect(await auditRows(business.id, "auth.step_up")).toHaveLength(0);
  });

  it("still verifies a PIN (Persian digits included), a password and a confirmed TOTP", async () => {
    const business = await seedBusiness("StepUpDoors");
    const cashier = await addMember(business, "cashier");
    await setMemberPin(cashier, "4821");
    await signIn(cashier, { recent: false });
    const wrongPin = await stepUp({ method: "pin", credential: "0000" });
    expect(wrongPin.status).toBe(401);
    expect(sessionCookieOf(wrongPin)).toBeUndefined();
    const pin = await stepUp({ method: "pin", credential: "۴۸۲۱" });
    expect(pin.status).toBe(200);
    expect(sessionCookieOf(pin)).toBeTruthy();

    const owner = await addMember(business, "owner");
    await signIn(owner, { recent: false });
    const wrong = await stepUp({ method: "password", credential: "not-the-password" });
    expect(wrong.status).toBe(401);
    expect(sessionCookieOf(wrong)).toBeUndefined();
    const password = await stepUp({ method: "password", credential: PASSWORD });
    expect(password.status).toBe(200);
    expect(sessionCookieOf(password)).toBeTruthy();

    const enrolled = await mfaEnrol.enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: owner.platformUserId!,
      email: owner.email!,
      method: "totp",
    });
    if (!enrolled.ok || !enrolled.totpSecret) throw new Error("enrolment failed");
    // Confirmed directly, so the step-up below spends the first code there is.
    await db.query(`UPDATE mfa_enrolments SET confirmed_at = now() WHERE subject_id = $1`, [owner.platformUserId]);
    const totp = await stepUp({ method: "totp", credential: await generateTotp({ secret: enrolled.totpSecret }) });
    expect(totp.status).toBe(200);

    const audit = await auditRows(business.id, "auth.step_up");
    expect(audit.map((row) => row.payload.method)).toEqual(["pin", "password", "totp"]);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    expect(await auditRows(business.id, "auth.step_up_failed")).toHaveLength(1);
  });

  it("grants no recent-auth window when the success audit cannot be written", async () => {
    const business = await seedBusiness("StepUpAudit");
    const owner = await addMember(business, "owner");
    await signIn(owner, { recent: false });
    await failAuditFor("auth.step_up");

    const failed = await stepUp({ method: "password", credential: PASSWORD });
    expect(failed.status).toBe(500);
    expect(sessionCookieOf(failed)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F04
// ---------------------------------------------------------------------------

describe("#854 F04 — a self password change is one unit with its audit and its cookie", () => {
  async function passwordFixture() {
    const alpha = await seedBusiness("PasswordAlpha");
    const beta = await seedBusiness("PasswordBeta");
    const identity = await createIdentity();
    const owner = await addMember(alpha, "owner", { identity });
    const ownerInBeta = await addMember(beta, "accountant", { identity });
    const current = await addSession(owner, "این مرورگر");
    const otherAlpha = await addSession(owner);
    const betaSession = await addSession(ownerInBeta);
    const token = await signIn(owner, { sessionId: current });
    return { alpha, identity, owner, current, otherAlpha, betaSession, token };
  }

  async function identityRow(id: string) {
    const { rows } = await db.query<{ password_hash: string; token_version: number }>(
      `SELECT password_hash, token_version FROM platform_users WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  const change = { currentPassword: PASSWORD, newPassword: "a-brand-new-password-854", confirmPassword: "a-brand-new-password-854" };

  it("changes nothing — hash, token version, sessions, cookie — when the audit write fails", async () => {
    const f = await passwordFixture();
    const before = await identityRow(f.identity.id);
    await failAuditFor("user.password_changed_self");

    const failed = await passwordSelf(change);
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ error: "credential_change_failed" });
    expect(sessionCookieOf(failed)).toBeUndefined();

    const after = await identityRow(f.identity.id);
    expect(after.token_version).toBe(before.token_version);
    expect(await bcrypt.compare(PASSWORD, after.password_hash)).toBe(true);
    expect(await sessionRevoked(f.otherAlpha)).toBe(false);
    expect(await sessionRevoked(f.betaSession)).toBe(false);
    expect(await auditRows(f.alpha.id, "user.password_changed_self")).toHaveLength(0);

    // The member's existing cookie is still a working session.
    cookieJar.set(authLib.SESSION_COOKIE, f.token);
    expect((await call(() => sessionsSelfRoute.GET())).status).toBe(200);
  });

  it("commits everything together once the audit can be written", async () => {
    const f = await passwordFixture();
    const before = await identityRow(f.identity.id);

    const changed = await passwordSelf(change);
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ ok: true, tokenVersion: before.token_version + 1 });
    const refreshed = sessionCookieOf(changed);
    expect(refreshed).toBeTruthy();

    const after = await identityRow(f.identity.id);
    expect(after.token_version).toBe(before.token_version + 1);
    expect(await bcrypt.compare(change.newPassword, after.password_hash)).toBe(true);
    // Global identity: the other sessions go in every business; the caller's stays.
    expect(await sessionRevoked(f.otherAlpha)).toBe(true);
    expect(await sessionRevoked(f.betaSession)).toBe(true);
    expect(await sessionRevoked(f.current)).toBe(false);

    const audit = await auditRows(f.alpha.id, "user.password_changed_self");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ tokenVersion: before.token_version + 1, revokedSessions: 2 });
    expect(JSON.stringify(audit[0].payload)).not.toContain(change.newPassword);

    // The old cookie is dead; the refreshed one works.
    cookieJar.set(authLib.SESSION_COOKIE, f.token);
    expect((await call(() => sessionsSelfRoute.GET())).status).toBe(401);
    cookieJar.set(authLib.SESSION_COOKIE, refreshed!);
    expect((await call(() => sessionsSelfRoute.GET())).status).toBe(200);
  });

  it("refuses a wrong current password without touching anything", async () => {
    const f = await passwordFixture();
    const before = await identityRow(f.identity.id);
    const refused = await passwordSelf({ ...change, currentPassword: "wrong-password-854" });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: "invalid_current_password" });
    expect((await identityRow(f.identity.id)).token_version).toBe(before.token_version);
    expect(await sessionRevoked(f.otherAlpha)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F05 / F06
// ---------------------------------------------------------------------------

describe("#854 F05 — a verified phone change commits with its audit row", () => {
  it("leaves the number untouched when the audit write fails, and commits both once it can", async () => {
    const business = await seedBusiness("PhoneAudit");
    const owner = await addMember(business, "owner", { phone: "+989121110001" });
    await signIn(owner);
    await failAuditFor("auth.self_phone_changed");

    expect((await phoneSelf({ action: "send", phone: "09121110002" })).status).toBe(200);
    const failed = await phoneSelf({ action: "verify", code: sms.sent[0].code });
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ error: "credential_change_failed" });

    const unchanged = await db.query<{ phone_e164: string; phone_verified_at: Date | null }>(
      `SELECT phone_e164, phone_verified_at FROM users WHERE id = $1`,
      [owner.id],
    );
    expect(unchanged.rows[0].phone_e164).toBe("+989121110001");
    expect(await auditRows(business.id, "auth.self_phone_changed")).toHaveLength(0);

    await db.query("DROP TRIGGER trg_fail_audit_854 ON audit_log");
    await skipResendCooldown();
    expect((await phoneSelf({ action: "send", phone: "09121110002" })).status).toBe(200);
    const verified = await phoneSelf({ action: "verify", code: sms.sent[1].code });
    expect(verified.status).toBe(200);

    const changed = await db.query<{ phone_e164: string; phone_verified_at: Date | null }>(
      `SELECT phone_e164, phone_verified_at FROM users WHERE id = $1`,
      [owner.id],
    );
    expect(changed.rows[0].phone_e164).toBe("+989121110002");
    expect(changed.rows[0].phone_verified_at).not.toBeNull();
    const audit = await auditRows(business.id, "auth.self_phone_changed");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ deliveredTo: "+989***0002", channel: "sms" });
    // The masked destination only — never the full number or the code.
    expect(JSON.stringify(audit[0].payload)).not.toContain("+989121110002");
    expect(JSON.stringify(audit[0].payload)).not.toContain(sms.sent[1].code);
  });
});

describe("#854 F06 — resend, cancel, expiry and replay follow the server's challenge", () => {
  async function phoneFixture() {
    const alpha = await seedBusiness("PhoneAlpha");
    const beta = await seedBusiness("PhoneBeta");
    const identity = await createIdentity();
    const owner = await addMember(alpha, "owner", { identity, phone: "+989121110001" });
    const ownerInBeta = await addMember(beta, "manager", { identity, phone: "+989121110001" });
    await signIn(owner);
    return { alpha, owner, ownerInBeta };
  }

  async function phoneOf(userId: string) {
    const { rows } = await db.query<{ phone_e164: string | null; phone_verified_at: Date | null }>(
      `SELECT phone_e164, phone_verified_at FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0];
  }

  it("after a reload, resend goes to the candidate under its own purpose — whatever the body says", async () => {
    const f = await phoneFixture();
    expect((await phoneSelf({ action: "send", phone: "09121110002" })).status).toBe(200);

    // The reloaded card knows only what GET tells it.
    const reloaded = await call(() => phoneSelfRoute.GET());
    expect(reloaded.body?.pendingChallenge).toMatchObject({
      maskedPhone: "+989***0002",
      purpose: "change_login_phone",
    });

    await skipResendCooldown();
    const resent = await phoneSelf({ action: "resend", phone: "+989121119999" });
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ maskedPhone: "+989***0002", purpose: "change_login_phone" });
    expect(sms.sent.map((s) => s.phone)).toEqual(["+989121110002", "+989121110002"]);

    // The first code was replaced by the resend; the newest one verifies.
    expect((await phoneSelf({ action: "verify", code: sms.sent[0].code })).status).not.toBe(200);
    const verified = await phoneSelf({ action: "verify", code: sms.sent[1].code, phone: "+989121119999" });
    expect(verified.status).toBe(200);
    expect((await phoneOf(f.owner.id)).phone_e164).toBe("+989121110002");
    // A per-membership number: the same person's other membership is untouched.
    expect((await phoneOf(f.ownerInBeta.id)).phone_e164).toBe("+989121110001");
  });

  it("a code is single-use: replaying it after a verify changes nothing", async () => {
    const f = await phoneFixture();
    await phoneSelf({ action: "send", phone: "09121110002" });
    const code = sms.sent[0].code;
    expect((await phoneSelf({ action: "verify", code })).status).toBe(200);

    await db.query(`UPDATE users SET phone_e164 = '+989121110005' WHERE id = $1`, [f.owner.id]);
    const replay = await phoneSelf({ action: "verify", code });
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ error: "challenge_expired" });
    expect((await phoneOf(f.owner.id)).phone_e164).toBe("+989121110005");
  });

  it("cancel burns the code on the server, so neither verify nor resend can use it", async () => {
    const f = await phoneFixture();
    await phoneSelf({ action: "send", phone: "09121110002" });

    // Cancel needs no fresh step-up: it only removes capability.
    await signIn(f.owner, { recent: false });
    const cancelled = await phoneSelf({ action: "cancel" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", cancelled: 1 });

    await signIn(f.owner);
    expect((await call(() => phoneSelfRoute.GET())).body?.pendingChallenge).toBeNull();
    const verify = await phoneSelf({ action: "verify", code: sms.sent[0].code });
    expect(verify.status).toBe(400);
    expect(verify.body).toMatchObject({ error: "challenge_expired" });
    await skipResendCooldown();
    expect((await phoneSelf({ action: "resend" })).body).toMatchObject({ error: "challenge_expired" });
    expect(sms.sent).toHaveLength(1);
    expect((await phoneOf(f.owner.id)).phone_e164).toBe("+989121110001");
  });

  it("an expired challenge can be neither resent nor verified", async () => {
    const f = await phoneFixture();
    await phoneSelf({ action: "send", phone: "09121110002" });
    await db.query(`UPDATE mfa_challenges SET expires_at = now() - interval '1 minute'`);

    await skipResendCooldown();
    const resend = await phoneSelf({ action: "resend" });
    expect(resend.status).toBe(400);
    expect(resend.body).toMatchObject({ error: "challenge_expired" });
    const verify = await phoneSelf({ action: "verify", code: sms.sent[0].code });
    expect(verify.status).toBe(400);
    expect(sms.sent).toHaveLength(1);
    expect((await phoneOf(f.owner.id)).phone_e164).toBe("+989121110001");
  });

  it("one ceremony at a time: a fresh re-verification burns a pending change", async () => {
    const f = await phoneFixture();
    await phoneSelf({ action: "send", phone: "09121110002" });
    await skipResendCooldown();
    await phoneSelf({ action: "send" });
    expect(sms.sent.map((s) => s.phone)).toEqual(["+989121110002", "+989121110001"]);

    const pending = (await call(() => phoneSelfRoute.GET())).body?.pendingChallenge;
    expect(pending).toMatchObject({ purpose: "verify_login_phone", maskedPhone: "+989***0001" });
    // The abandoned change code no longer writes its number.
    expect((await phoneSelf({ action: "verify", code: sms.sent[0].code })).status).not.toBe(200);
    expect((await phoneOf(f.owner.id)).phone_e164).toBe("+989121110001");
  });

  it("a re-verification does not vouch for a number an administrator changed meanwhile", async () => {
    const f = await phoneFixture();
    await db.query(`UPDATE users SET phone_verified_at = NULL WHERE id = $1`, [f.owner.id]);
    await phoneSelf({ action: "send" });
    await db.query(`UPDATE users SET phone_e164 = '+989121110007' WHERE id = $1`, [f.owner.id]);

    const verify = await phoneSelf({ action: "verify", code: sms.sent[0].code });
    expect(verify.status).toBe(409);
    expect(verify.body).toMatchObject({ error: "code_wrong_phone" });
    const row = await phoneOf(f.owner.id);
    expect(row.phone_e164).toBe("+989121110007");
    expect(row.phone_verified_at).toBeNull();

    await skipResendCooldown();
    expect((await phoneSelf({ action: "resend" })).body).toMatchObject({ error: "challenge_expired" });
  });
});

// ---------------------------------------------------------------------------
// F07
// ---------------------------------------------------------------------------

describe("#854 F07 — a self-service PIN rotation must change the member's own PIN", () => {
  async function activePinIds(member: Member): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM employee_credentials
        WHERE employee_id = $1 AND credential_type = 'pin' AND status = 'active'`,
      [member.id],
    );
    return rows.map((r) => r.id);
  }

  it("refuses the current PIN as the new one (Persian digits included) and writes nothing", async () => {
    const business = await seedBusiness("PinSame");
    const cashier = await addMember(business, "cashier");
    await setMemberPin(cashier, "4821");
    const before = await activePinIds(cashier);
    await signIn(cashier);

    for (const body of [
      { currentPin: "4821", newPin: "4821", confirmPin: "4821" },
      { currentPin: "۴۸۲۱", newPin: "۴۸۲۱", confirmPin: "۴۸۲۱" },
    ]) {
      const refused = await pinSelf(body);
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ error: "pin_unchanged" });
    }
    expect(await activePinIds(cashier)).toEqual(before);
    expect(await auditRows(business.id, "auth.self_pin_changed")).toHaveLength(0);
    expect(await auditRows(business.id, "team.self_pin_changed")).toHaveLength(0);
  });

  it("the shared service re-checks under the membership lock; an admin reset is not a rotation", async () => {
    const business = await seedBusiness("PinService");
    const waiter = await addMember(business, "waiter");
    await setMemberPin(waiter, "4821");

    await expect(
      dbLib.withTenant(business.id, () =>
        team.setPin(business.id, waiter.id, "4821", waiter.id, { selfService: true, currentPinVerified: true }),
      ),
    ).rejects.toMatchObject({ message: "pin_unchanged", status: 400 });

    // An administrator resetting a forgotten PIN may set any value.
    await expect(setMemberPin(waiter, "4821")).resolves.toBeUndefined();
    expect(await pinWorks(waiter, "4821")).toBe(true);
  });

  it("allows a PIN another employee already uses (#953) and leaves both working", async () => {
    const business = await seedBusiness("PinShared");
    const cashier = await addMember(business, "cashier");
    const kitchen = await addMember(business, "kitchen");
    await setMemberPin(cashier, "4821");
    await setMemberPin(kitchen, "1357");
    await signIn(cashier);

    const changed = await pinSelf({ currentPin: "4821", newPin: "1357", confirmPin: "1357" });
    expect(changed.status).toBe(200);
    expect(await pinWorks(cashier, "1357")).toBe(true);
    expect(await pinWorks(cashier, "4821")).toBe(false);
    expect(await pinWorks(kitchen, "1357")).toBe(true);
    expect(await auditRows(business.id, "auth.self_pin_changed")).toHaveLength(1);
    expect(await auditRows(business.id, "team.self_pin_changed")).toHaveLength(1);
  });

  it("rolls the rotation and both audit rows back when the surface audit fails", async () => {
    const business = await seedBusiness("PinAudit");
    const cashier = await addMember(business, "cashier");
    await setMemberPin(cashier, "4821");
    await signIn(cashier);
    await failAuditFor("auth.self_pin_changed");

    const failed = await pinSelf({ currentPin: "4821", newPin: "2468", confirmPin: "2468" });
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ error: "credential_change_failed" });
    expect(await pinWorks(cashier, "4821")).toBe(true);
    expect(await pinWorks(cashier, "2468")).toBe(false);
    expect(await auditRows(business.id, "team.self_pin_changed")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F11
// ---------------------------------------------------------------------------

describe("#854 F11 — every surface the page marks read-only is refused by its route", () => {
  it.each(["cloud", "hybrid", "local"] as const)("%s", async (profile) => {
    const business = await seedBusiness(`Authority${profile}`);
    const owner = await addMember(business, "owner", { phone: "+989121110001" });
    await setMemberPin(owner, "4821");
    await signIn(owner);

    // A code requested while the site was still writable (before pairing).
    expect((await phoneSelf({ action: "send", phone: "09121110002" })).status).toBe(200);
    await setProfile(business.id, profile);

    const props = await profileProps();
    const surfaces = props.credentialSurfaces as Record<string, { editable: boolean; readOnly: boolean }>;
    const cloudOwned = profile === "hybrid";
    for (const field of ["global_password", "login_phone", "totp_secret"]) {
      expect(surfaces[field].readOnly).toBe(cloudOwned);
    }
    expect(surfaces.staff_pin.editable).toBe(true);
    expect(surfaces.webauthn_credential.editable).toBe(true);

    const phoneStatus = await call(() => phoneSelfRoute.GET());
    expect((phoneStatus.body?.credential as { readOnly: boolean }).readOnly).toBe(cloudOwned);

    const verify = await phoneSelf({ action: "verify", code: sms.sent[0].code });
    const resend = await phoneSelf({ action: "resend" });
    const mfaConfirm = await call(() =>
      mfaSelfRoute.POST(request("/api/auth/mfa/self", "POST", { action: "confirm", method: "totp", code: "123456" })),
    );
    const mfaResend = await call(() =>
      mfaSelfRoute.POST(request("/api/auth/mfa/self", "POST", { action: "resend_challenge", method: "sms" })),
    );
    // Last: a successful change bumps the token version behind this cookie.
    const password = await passwordSelf({
      currentPassword: PASSWORD,
      newPassword: "another-password-854",
      confirmPassword: "another-password-854",
    });

    if (cloudOwned) {
      for (const refused of [verify, resend, password, mfaConfirm, mfaResend]) {
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ error: "login_managed_by_cloud" });
      }
      const { rows } = await db.query<{ phone_e164: string }>(`SELECT phone_e164 FROM users WHERE id = $1`, [owner.id]);
      expect(rows[0].phone_e164).toBe("+989121110001");
      // Discarding the stale code is still allowed: it only removes capability.
      expect((await phoneSelf({ action: "cancel" })).body).toMatchObject({ status: "cancelled", cancelled: 1 });
    } else {
      expect(verify.status).toBe(200);
      expect(password.status).toBe(200);
      // Processed on their merits (no live code, a wrong TOTP code, …) —
      // neither refused by authority nor by a stale session.
      for (const answered of [resend, mfaConfirm, mfaResend]) {
        expect(["login_managed_by_cloud", "unauthorized"]).not.toContain(answered.body?.error);
      }
    }

    // The staff PIN is a till credential every profile may rotate locally.
    await signIn(owner);
    expect((await pinSelf({ currentPin: "4821", newPin: "1357", confirmPin: "1357" })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// F13
// ---------------------------------------------------------------------------

describe("#854 F13 — the branch facts come from the membership", () => {
  it("shows the active branch and, separately, a different home branch", async () => {
    const business = await seedBusiness("Branches");
    const north = await addLocation(business.id, "North");
    const manager = await addMember(business, "manager", { locationScope: "all" });
    await signIn(manager, { activeLocationId: north });

    const props = await profileProps();
    expect(props.branch).toEqual({
      active: { id: north, name: "North" },
      home: { id: business.mainLocationId, name: "Main" },
      canSwitch: true,
    });
  });

  it("falls back to the member's own branch when the session names one they cannot reach", async () => {
    const alpha = await seedBusiness("BranchAlpha");
    const beta = await seedBusiness("BranchBeta");
    await addLocation(alpha.id, "North");
    const cashier = await addMember(alpha, "cashier");
    // A branch of another tenant: never shown, never honoured.
    await signIn(cashier, { activeLocationId: beta.mainLocationId });

    const props = await profileProps();
    expect(props.branch).toEqual({
      active: { id: alpha.mainLocationId, name: "Main" },
      home: null,
      canSwitch: false,
    });
  });
});
