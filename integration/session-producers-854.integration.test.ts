/**
 * Issue #854 follow-up (third pass) — every session producer, end to end.
 *
 * `session-revocation-854` covers the six doors that used to mint a session
 * with no row behind it (business switch, bootstrap, signup, desktop hand-off,
 * company hand-off; pairing lives in `hybrid-credential-sync`). This file
 * covers every *other* route that hands out a tenant session cookie, each
 * through its real handler against a real, migrated schema:
 *
 * - **sign-in doors** open a new row: password, password + second factor,
 *   phone OTP, PIN, WebAuthn, invitation acceptance (directly and through a
 *   second factor);
 * - **re-mints** re-sign the caller's own row: step-up, branch switch, the
 *   member's own password change (Profile and Team), native device
 *   registration;
 * - **support doors** are bound to the support grant instead of a row: the
 *   console's start route, the host hand-off, and resume.
 *
 * For each one the cookie names a live row bound to exactly its member and
 * business (or names the grant), «خروج» ends it on the server, and every copy
 * anyone kept — including the copy from *before* a re-mint — is refused from
 * then on. The rows also record which door opened them (P2.27).
 *
 * The desktop's cloud-login callback is covered in `hybrid-credential-sync`,
 * where the cloud stub lives.
 *
 * WebAuthn: no stub. A software P-256 authenticator in this file signs a real
 * assertion over the server's own challenge, and the server's unmodified
 * `@simplewebauthn/server` verification checks it. It is not a physical
 * authenticator and not a browser's virtual one.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import bcrypt from "bcryptjs";
import { generate as generateTotp } from "otplib";
import { NextRequest, type NextResponse } from "next/server";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
  }),
  headers: async () => new Headers(),
}));

const sms = vi.hoisted(() => ({ sent: [] as { phone: string; code: string }[] }));
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

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let authLib: typeof import("../src/lib/auth");
let employeeService: typeof import("../src/lib/employee-service");
let platformService: typeof import("../src/lib/platform-service");
let platformAuthEdge: typeof import("../src/lib/platform-auth-edge");
let team: typeof import("../src/lib/team-service");
let settings: typeof import("../src/lib/settings");
let mfaPolicy: typeof import("../src/lib/mfa-policy");
let mfaEnrol: typeof import("../src/lib/mfa-enrol");
let mfaVerify: typeof import("../src/lib/mfa-verify");
let logoutRoute: typeof import("../src/app/api/auth/logout/route");
let sessionsSelfRoute: typeof import("../src/app/api/sessions/self/route");
let loginRoute: typeof import("../src/app/api/auth/login/route");
let mfaVerifyRoute: typeof import("../src/app/api/auth/mfa/verify/route");
let phoneOtpRequestRoute: typeof import("../src/app/api/auth/phone-otp/request/route");
let phoneOtpVerifyRoute: typeof import("../src/app/api/auth/phone-otp/verify/route");
let pinLoginRoute: typeof import("../src/app/api/auth/pin-login/route");
let webauthnOptionsRoute: typeof import("../src/app/api/auth/webauthn/login/options/route");
let webauthnVerifyRoute: typeof import("../src/app/api/auth/webauthn/login/verify/route");
let acceptInviteRoute: typeof import("../src/app/api/auth/accept-invite/route");
let stepUpRoute: typeof import("../src/app/api/auth/step-up/route");
let switchLocationRoute: typeof import("../src/app/api/auth/switch-location/route");
let passwordSelfRoute: typeof import("../src/app/api/auth/password/self/route");
let teamCredentialsRoute: typeof import("../src/app/api/team/[id]/credentials/route");
let nativeDevicesRoute: typeof import("../src/app/api/native-devices/route");
let impersonateRoute: typeof import("../src/app/api/platform/businesses/[id]/impersonate/route");
let impersonateHandoffRoute: typeof import("../src/app/api/auth/impersonate-handoff/route");
let resumeRoute: typeof import("../src/app/api/platform/impersonation/[id]/resume/route");

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
  databaseName = `pos_session_producers_${randomUUID().replaceAll("-", "")}`;
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

  // Fault injector: raises for exactly one audit action (TG_ARGV[0]).
  await db.query(`
    CREATE OR REPLACE FUNCTION fail_audit_854() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = TG_ARGV[0] THEN
        RAISE EXCEPTION 'injected audit failure for %', NEW.action USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql`);

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  authLib = await import("../src/lib/auth");
  employeeService = await import("../src/lib/employee-service");
  platformService = await import("../src/lib/platform-service");
  platformAuthEdge = await import("../src/lib/platform-auth-edge");
  team = await import("../src/lib/team-service");
  settings = await import("../src/lib/settings");
  mfaPolicy = await import("../src/lib/mfa-policy");
  mfaEnrol = await import("../src/lib/mfa-enrol");
  mfaVerify = await import("../src/lib/mfa-verify");
  logoutRoute = await import("../src/app/api/auth/logout/route");
  sessionsSelfRoute = await import("../src/app/api/sessions/self/route");
  loginRoute = await import("../src/app/api/auth/login/route");
  mfaVerifyRoute = await import("../src/app/api/auth/mfa/verify/route");
  phoneOtpRequestRoute = await import("../src/app/api/auth/phone-otp/request/route");
  phoneOtpVerifyRoute = await import("../src/app/api/auth/phone-otp/verify/route");
  pinLoginRoute = await import("../src/app/api/auth/pin-login/route");
  webauthnOptionsRoute = await import("../src/app/api/auth/webauthn/login/options/route");
  webauthnVerifyRoute = await import("../src/app/api/auth/webauthn/login/verify/route");
  acceptInviteRoute = await import("../src/app/api/auth/accept-invite/route");
  stepUpRoute = await import("../src/app/api/auth/step-up/route");
  switchLocationRoute = await import("../src/app/api/auth/switch-location/route");
  passwordSelfRoute = await import("../src/app/api/auth/password/self/route");
  teamCredentialsRoute = await import("../src/app/api/team/[id]/credentials/route");
  nativeDevicesRoute = await import("../src/app/api/native-devices/route");
  impersonateRoute = await import("../src/app/api/platform/businesses/[id]/impersonate/route");
  impersonateHandoffRoute = await import("../src/app/api/auth/impersonate-handoff/route");
  resumeRoute = await import("../src/app/api/platform/impersonation/[id]/resume/route");
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
  cookieJar.clear();
  sms.sent.length = 0;
  await db.query("DELETE FROM auth_login_attempts");
  await db.query("DELETE FROM impersonation_grants");
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_users");
  await db.query("DELETE FROM platform_admins");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.query("DROP TRIGGER IF EXISTS trg_fail_audit_854 ON audit_log");
});

/** Makes every `audit_log` insert of `action` fail, until the test ends. */
async function failAuditFor(action: string): Promise<void> {
  if (!/^[a-z_.]+$/.test(action)) throw new Error(`unexpected audit action ${action}`);
  await db.query("DROP TRIGGER IF EXISTS trg_fail_audit_854 ON audit_log");
  await db.query(
    `CREATE TRIGGER trg_fail_audit_854 BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION fail_audit_854('${action}')`,
  );
}

/** No session row of this member exists at all — nothing a failed door could have left listed as active. */
async function sessionRowsOf(memberId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM employee_sessions WHERE employee_id = $1`,
    [memberId],
  );
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSWORD = "session-producers-854";
const NEW_PASSWORD = "session-producers-854-rotated";
const USER_AGENT = "Vitest Browser";

interface Business {
  id: string;
  locationId: string;
}

interface Member {
  id: string;
  businessId: string;
  role: "owner" | "manager" | "accountant" | "cashier";
  platformUserId: string | null;
  email: string | null;
}

async function seedBusiness(name: string): Promise<Business> {
  const label = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, subdomain) VALUES ($1, $2, $2) RETURNING id`,
    [name, label],
  );
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`,
    [rows[0].id],
  );
  // A Local install: every door below is the business's own, and the
  // credential routes are writable here (on a Hybrid site the cloud owns them).
  await db.query(
    `INSERT INTO settings (business_id, location_id, key, value) VALUES ($1, NULL, $2, $3)`,
    [rows[0].id, settings.SETTING_KEYS.deploymentProfile, JSON.stringify({ profile: "local", pairedAt: new Date().toISOString() })],
  );
  await dbLib.withTenant(rows[0].id, () =>
    mfaPolicy.setMfaPolicy(rows[0].id, { requireForManagers: false, requireForAccountants: false }),
  );
  return { id: rows[0].id, locationId: location.rows[0].id };
}

async function createIdentity(): Promise<{ id: string; email: string }> {
  const email = `person-${randomUUID().slice(0, 8)}@example.com`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name) VALUES ($1, $2, 'Person') RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10)],
  );
  return { id: rows[0].id, email };
}

async function addMember(
  business: Business,
  role: Member["role"],
  options: { identity?: { id: string; email: string } | null; phone?: string } = {},
): Promise<Member> {
  const identity = options.identity ?? null;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email, phone_e164, phone_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [business.id, identity?.id ?? null, role, `${role}-${randomUUID().slice(0, 4)}`, identity?.email ?? null, options.phone ?? null],
  );
  return { id: rows[0].id, businessId: business.id, role, platformUserId: identity?.id ?? null, email: identity?.email ?? null };
}

/**
 * A session opened the way every sign-in door opens one, for the re-mint
 * routes to start from. `authenticatedSecondsAgo` backdates the last proof of
 * identity — a step-up exists precisely because that proof has gone stale.
 */
async function signIn(member: Member, authenticatedSecondsAgo = 0): Promise<string> {
  const { session } = await dbLib.withTenant(member.businessId, () =>
    employeeService.createSession(member.id, member.businessId, { loginMethod: "password" }),
  );
  return authLib.signSession({
    sub: member.id,
    role: member.role,
    businessId: member.businessId,
    locationId: null,
    fullName: "Member",
    ...(member.platformUserId ? { platformUserId: member.platformUserId } : {}),
    employeeSessionId: session.id,
    recentAuthAt: Math.floor(Date.now() / 1000) - authenticatedSecondsAgo,
  });
}

/** A TOTP factor confirmed on an identity, the way the enrolment ceremony confirms one. */
async function confirmTotp(identity: { id: string; email: string }): Promise<string> {
  const enrolled = await mfaEnrol.enrolMfaMethod({
    subjectRealm: "platform_user",
    subjectId: identity.id,
    email: identity.email,
    method: "totp",
  });
  if (!enrolled.ok || !enrolled.totpSecret) throw new Error("totp enrolment failed");
  const confirmed = await mfaVerify.verifyAndConfirmPendingMfaEnrolment({
    subjectRealm: "platform_user",
    subjectId: identity.id,
    method: "totp",
    code: await generateTotp({ secret: enrolled.totpSecret }),
  });
  expect(confirmed.outcome).toBe("totp");
  return enrolled.totpSecret;
}

interface Outcome {
  status: number;
  body: Record<string, unknown> | null;
  response: NextResponse | null;
}

/** Run a handler; a thrown error is the 500 Next would answer with. */
async function call(run: () => Promise<NextResponse | Response>): Promise<Outcome> {
  try {
    const response = (await run()) as NextResponse;
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body, response };
  } catch (error) {
    console.error(error);
    return { status: 500, body: null, response: null };
  }
}

const sessionCookieOf = (outcome: Outcome) => outcome.response?.cookies.get(authLib.SESSION_COOKIE)?.value;

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}, method = "POST"): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "user-agent": USER_AGENT, ...headers },
  });
}

/** Whether a token anyone kept would still be accepted on a request. */
async function works(token: string | undefined): Promise<boolean> {
  return (await authLib.resolveSessionFromToken(token)) !== null;
}

interface SessionRow {
  id: string;
  business_id: string;
  employee_id: string;
  login_method: string | null;
  revoked_at: Date | null;
}

async function rowOf(token: string | undefined): Promise<SessionRow | undefined> {
  const payload = token ? await authLib.verifySession(token) : null;
  if (!payload?.employeeSessionId) return undefined;
  const { rows } = await db.query<SessionRow>(
    `SELECT id, business_id, employee_id, login_method, revoked_at FROM employee_sessions WHERE id = $1`,
    [payload.employeeSessionId],
  );
  return rows[0];
}

/** The cookie a door handed out names a live row of exactly this member, in exactly this business. */
async function expectOwnRow(token: string | undefined, member: Member, loginMethod: string): Promise<SessionRow> {
  expect(token).toBeTruthy();
  const row = await rowOf(token);
  expect(row).toMatchObject({ employee_id: member.id, business_id: member.businessId, login_method: loginMethod, revoked_at: null });
  expect(await works(token)).toBe(true);
  return row!;
}

function signOutRequest(token: string | undefined): NextRequest {
  return new NextRequest("http://localhost/api/auth/logout", {
    method: "POST",
    headers: { "user-agent": USER_AGENT, ...(token ? { cookie: `${authLib.SESSION_COOKIE}=${token}` } : {}) },
  });
}

/**
 * «خروج» with `token` ends its session on the server, and then every token in
 * `retained` — the one signed out with, and any sibling a re-mint produced — is
 * refused, both by the authenticator and by a real route.
 */
async function expectSignOutEndsEvery(token: string, retained: string[]): Promise<Outcome> {
  const out = await call(() => logoutRoute.POST(signOutRequest(token)));
  expect(out.status).toBe(200);
  expect(out.body).toMatchObject({ ok: true, outcome: "revoked", sessionCookieCleared: true, pendingRevocations: 0 });
  for (const copy of retained) {
    expect(await works(copy)).toBe(false);
    cookieJar.set(authLib.SESSION_COOKIE, copy);
    expect((await call(() => sessionsSelfRoute.GET())).status).toBe(401);
  }
  cookieJar.delete(authLib.SESSION_COOKIE);
  return out;
}

/** A re-mint re-signs the caller's own row: same row id, nothing new opened. */
async function expectSameRow(before: string, after: string | undefined, member: Member): Promise<void> {
  expect(after).toBeTruthy();
  expect(after).not.toBe(before);
  const original = await rowOf(before);
  const reminted = await rowOf(after);
  expect(reminted?.id).toBe(original?.id);
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM employee_sessions WHERE employee_id = $1`,
    [member.id],
  );
  expect(rows[0].n).toBe(1);
}

// ---------------------------------------------------------------------------
// Sign-in doors: each opens its own row
// ---------------------------------------------------------------------------

describe("sign-in doors — each opens its own row, and «خروج» ends it", () => {
  it("password: opens a `password` row; the retained cookie is refused after «خروج»", async () => {
    const business = await seedBusiness("PasswordDoor");
    const identity = await createIdentity();
    const manager = await addMember(business, "manager", { identity });

    const login = await call(() =>
      loginRoute.POST(jsonRequest("/api/auth/login", { email: identity.email, password: PASSWORD })),
    );
    expect(login.status).toBe(200);
    const token = sessionCookieOf(login)!;
    await expectOwnRow(token, manager, "password");

    await expectSignOutEndsEvery(token, [token]);
  });

  it("password + second factor: the row is opened only by the factor, and records the password door", async () => {
    const business = await seedBusiness("MfaDoor");
    const identity = await createIdentity();
    const owner = await addMember(business, "owner", { identity });
    const secret = await confirmTotp(identity);

    const login = await call(() =>
      loginRoute.POST(jsonRequest("/api/auth/login", { email: identity.email, password: PASSWORD })),
    );
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ mfaRequired: true });
    expect(sessionCookieOf(login)).toBeUndefined();
    const before = await db.query(`SELECT 1 FROM employee_sessions WHERE employee_id = $1`, [owner.id]);
    expect(before.rows).toHaveLength(0);

    const code = await generateTotp({ secret });
    const verified = await call(() =>
      mfaVerifyRoute.POST(
        jsonRequest("/api/auth/mfa/verify", { code, method: "totp" }, { authorization: `Bearer ${login.body!.mfaToken as string}` }),
      ),
    );
    expect(verified.status).toBe(200);
    const token = sessionCookieOf(verified)!;
    await expectOwnRow(token, owner, "password");

    await expectSignOutEndsEvery(token, [token]);
  });

  it("phone OTP: opens a `phone_otp` row; the retained cookie is refused after «خروج»", async () => {
    const business = await seedBusiness("PhoneDoor");
    const phone = "+989125550101";
    const cashier = await addMember(business, "cashier", { phone });

    const requested = await call(() =>
      phoneOtpRequestRoute.POST(jsonRequest("/api/auth/phone-otp/request", { phone, businessId: business.id })),
    );
    expect(requested.status).toBe(200);
    const pending = (requested.body!.pendingToken ?? requested.body!.token) as string;
    expect(pending).toBeTruthy();
    const code = sms.sent.at(-1)!.code;

    const verified = await call(() =>
      phoneOtpVerifyRoute.POST(jsonRequest("/api/auth/phone-otp/verify", { code }, { authorization: `Bearer ${pending}` })),
    );
    expect(verified.status).toBe(200);
    const token = sessionCookieOf(verified)!;
    await expectOwnRow(token, cashier, "phone_otp");

    await expectSignOutEndsEvery(token, [token]);
  });

  it("PIN: opens a `pin` row; the retained cookie is refused after «خروج»", async () => {
    const business = await seedBusiness("PinDoor");
    const owner = await addMember(business, "owner");
    const cashier = await addMember(business, "cashier");
    await dbLib.withTenant(business.id, () => team.setPin(business.id, cashier.id, "7734", owner.id));

    const login = await call(() =>
      pinLoginRoute.POST(jsonRequest("/api/auth/pin-login", { pin: "7734", employeeId: cashier.id, businessId: business.id })),
    );
    expect(login.status).toBe(200);
    const token = sessionCookieOf(login)!;
    await expectOwnRow(token, cashier, "pin");

    await expectSignOutEndsEvery(token, [token]);
  });

  it("WebAuthn: a real assertion opens a `webauthn` row; the retained cookie is refused after «خروج»", async () => {
    const business = await seedBusiness("WebauthnDoor");
    const cashier = await addMember(business, "cashier");
    const authenticator = softwareAuthenticator();
    await db.query(`INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [cashier.id, business.id]);
    await db.query(
      `INSERT INTO employee_credentials (employee_id, business_id, credential_type, status, webauthn_credential_id, webauthn_public_key)
       VALUES ($1, $2, 'webauthn', 'active', $3, $4)`,
      [cashier.id, business.id, authenticator.credentialId, authenticator.publicKeyBase64],
    );

    const options = await call(() =>
      webauthnOptionsRoute.POST(jsonRequest("/api/auth/webauthn/login/options", { employeeId: cashier.id, businessId: business.id })),
    );
    expect(options.status).toBe(200);
    const challenge = (options.body!.options as { challenge: string }).challenge;
    const challengeToken = options.body!.challengeToken as string;

    // A response signed for some other challenge is refused and opens nothing.
    const forged = await call(() =>
      webauthnVerifyRoute.POST(
        jsonRequest("/api/auth/webauthn/login/verify", {
          employeeId: cashier.id,
          businessId: business.id,
          challengeToken,
          response: authenticator.assert(isoBase64URL.fromBuffer(randomBytes(32))),
        }),
      ),
    );
    expect(forged.status).toBe(401);
    expect(sessionCookieOf(forged)).toBeUndefined();

    const verified = await call(() =>
      webauthnVerifyRoute.POST(
        jsonRequest("/api/auth/webauthn/login/verify", {
          employeeId: cashier.id,
          businessId: business.id,
          challengeToken,
          response: authenticator.assert(challenge),
        }),
      ),
    );
    expect(verified.status).toBe(200);
    const token = sessionCookieOf(verified)!;
    await expectOwnRow(token, cashier, "webauthn");

    await expectSignOutEndsEvery(token, [token]);
  });

  it("invitation: accepting opens an `invitation` row; the retained cookie is refused after «خروج»", async () => {
    const business = await seedBusiness("InviteDoor");
    const owner = await addMember(business, "owner");
    const email = `invitee-${randomUUID().slice(0, 8)}@example.com`;
    const { token: invitation } = await dbLib.withTenant(business.id, () =>
      team.createInvitation({
        businessId: business.id,
        email,
        role: "manager",
        fullName: "Invitee",
        locationIds: [business.locationId],
        actorId: owner.id,
        reason: "تست: دعوت عضو جدید",
      }),
    );

    const accepted = await call(() =>
      acceptInviteRoute.POST(jsonRequest("/api/auth/accept-invite", { token: invitation, password: PASSWORD })),
    );
    expect(accepted.status).toBe(200);
    const token = sessionCookieOf(accepted)!;
    const member = await db.query<{ id: string }>(`SELECT id FROM users WHERE business_id = $1 AND email = $2`, [business.id, email]);
    await expectOwnRow(token, { id: member.rows[0].id, businessId: business.id, role: "manager", platformUserId: null, email }, "invitation");

    await expectSignOutEndsEvery(token, [token]);
  });

  it("invitation through a second factor: the row records the invitation, not the password", async () => {
    const home = await seedBusiness("InviteHome");
    const identity = await createIdentity();
    await addMember(home, "owner", { identity });
    const secret = await confirmTotp(identity);

    const business = await seedBusiness("InviteMfa");
    const owner = await addMember(business, "owner");
    const { token: invitation } = await dbLib.withTenant(business.id, () =>
      team.createInvitation({
        businessId: business.id,
        email: identity.email,
        role: "accountant",
        fullName: "Existing Login",
        locationIds: [business.locationId],
        actorId: owner.id,
        reason: "تست: دعوت حساب موجود",
      }),
    );

    const accepted = await call(() =>
      acceptInviteRoute.POST(jsonRequest("/api/auth/accept-invite", { token: invitation, password: PASSWORD })),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ mfaRequired: true });
    expect(sessionCookieOf(accepted)).toBeUndefined();

    const code = await generateTotp({ secret });
    const verified = await call(() =>
      mfaVerifyRoute.POST(
        jsonRequest("/api/auth/mfa/verify", { code, method: "totp" }, { authorization: `Bearer ${accepted.body!.mfaToken as string}` }),
      ),
    );
    expect(verified.status).toBe(200);
    const token = sessionCookieOf(verified)!;
    const member = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE business_id = $1 AND platform_user_id = $2`,
      [business.id, identity.id],
    );
    await expectOwnRow(
      token,
      { id: member.rows[0].id, businessId: business.id, role: "accountant", platformUserId: identity.id, email: identity.email },
      "invitation",
    );

    await expectSignOutEndsEvery(token, [token]);
  });
});

describe("sign-in doors — a session whose audit cannot be written is never opened", () => {
  it("password: an audit failure leaves no row and sets no cookie", async () => {
    const business = await seedBusiness("PasswordFault");
    const identity = await createIdentity();
    const manager = await addMember(business, "manager", { identity });
    await failAuditFor("employee.session_created");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const login = await call(() =>
      loginRoute.POST(jsonRequest("/api/auth/login", { email: identity.email, password: PASSWORD })),
    );
    expect(login.status).toBe(500);
    expect(sessionCookieOf(login)).toBeUndefined();
    expect(await sessionRowsOf(manager.id)).toBe(0);

    // With the audit writable again the same credentials open exactly one row.
    await db.query("DROP TRIGGER trg_fail_audit_854 ON audit_log");
    const retried = await call(() =>
      loginRoute.POST(jsonRequest("/api/auth/login", { email: identity.email, password: PASSWORD })),
    );
    expect(retried.status).toBe(200);
    await expectOwnRow(sessionCookieOf(retried), manager, "password");
    expect(await sessionRowsOf(manager.id)).toBe(1);
  });

  it("password + second factor: an audit failure at MFA completion leaves no row and sets no cookie", async () => {
    const business = await seedBusiness("MfaFault");
    const identity = await createIdentity();
    const owner = await addMember(business, "owner", { identity });
    const secret = await confirmTotp(identity);

    const login = await call(() =>
      loginRoute.POST(jsonRequest("/api/auth/login", { email: identity.email, password: PASSWORD })),
    );
    expect(login.body).toMatchObject({ mfaRequired: true });
    await failAuditFor("employee.session_created");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await generateTotp({ secret });
    const verified = await call(() =>
      mfaVerifyRoute.POST(
        jsonRequest("/api/auth/mfa/verify", { code, method: "totp" }, { authorization: `Bearer ${login.body!.mfaToken as string}` }),
      ),
    );
    expect(verified.status).toBe(500);
    expect(sessionCookieOf(verified)).toBeUndefined();
    expect(await sessionRowsOf(owner.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Re-mints: the caller's own row, re-signed
// ---------------------------------------------------------------------------

describe("re-mints — the caller's own row is re-signed, so «خروج» ends every copy", () => {
  it("step-up: same row; «خروج» with the new cookie refuses the one from before the step-up too", async () => {
    const business = await seedBusiness("StepUpRemint");
    const identity = await createIdentity();
    const manager = await addMember(business, "manager", { identity });
    const before = await signIn(manager, 20 * 60);

    cookieJar.set(authLib.SESSION_COOKIE, before);
    const stepped = await call(() =>
      stepUpRoute.POST(jsonRequest("/api/auth/step-up", { method: "password", credential: PASSWORD })),
    );
    expect(stepped.status).toBe(200);
    const after = sessionCookieOf(stepped);
    await expectSameRow(before, after, manager);
    // What the step-up is for: the same session, with a fresh proof of identity.
    const stale = (await authLib.verifySession(before))!.recentAuthAt!;
    expect((await authLib.verifySession(after!))!.recentAuthAt!).toBeGreaterThan(stale);

    await expectSignOutEndsEvery(after!, [before, after!]);
  });

  it("branch switch: same row; «خروج» refuses both copies", async () => {
    const business = await seedBusiness("BranchRemint");
    const second = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id`,
      [business.id],
    );
    const owner = await addMember(business, "owner");
    const before = await signIn(owner);

    cookieJar.set(authLib.SESSION_COOKIE, before);
    const switched = await call(() =>
      switchLocationRoute.POST(jsonRequest("/api/auth/switch-location", { locationId: second.rows[0].id })),
    );
    expect(switched.status).toBe(200);
    const after = sessionCookieOf(switched);
    await expectSameRow(before, after, owner);
    expect((await authLib.verifySession(after!))?.activeLocationId).toBe(second.rows[0].id);

    await expectSignOutEndsEvery(after!, [before, after!]);
  });

  it("own password change (Profile): the old cookie dies with the change; the new one is the same row, and «خروج» ends it", async () => {
    const business = await seedBusiness("PasswordRemint");
    const identity = await createIdentity();
    const manager = await addMember(business, "manager", { identity });
    const before = await signIn(manager);

    cookieJar.set(authLib.SESSION_COOKIE, before);
    const changed = await call(() =>
      passwordSelfRoute.POST(
        jsonRequest("/api/auth/password/self", {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        }),
      ),
    );
    expect(changed.status).toBe(200);
    const after = sessionCookieOf(changed);
    await expectSameRow(before, after, manager);
    // The identity's token version moved, so the copy from before is refused at once.
    expect(await works(before)).toBe(false);
    expect(await works(after)).toBe(true);

    await expectSignOutEndsEvery(after!, [before, after!]);
  });

  it("own password change (Team): the same — one row, and «خروج» ends it", async () => {
    const business = await seedBusiness("TeamRemint");
    const identity = await createIdentity();
    const manager = await addMember(business, "manager", { identity });
    const before = await signIn(manager);

    cookieJar.set(authLib.SESSION_COOKIE, before);
    const changed = await call(() =>
      teamCredentialsRoute.PUT(
        jsonRequest(
          `/api/team/${manager.id}/credentials`,
          { password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD, currentPassword: PASSWORD },
          {},
          "PUT",
        ),
        { params: Promise.resolve({ id: manager.id }) },
      ),
    );
    expect(changed.status).toBe(200);
    const after = sessionCookieOf(changed);
    await expectSameRow(before, after, manager);
    expect(await works(before)).toBe(false);

    await expectSignOutEndsEvery(after!, [before, after!]);
  });

  it("native device registration: same row; «خروج» refuses both copies", async () => {
    const business = await seedBusiness("NativeRemint");
    const owner = await addMember(business, "owner");
    const before = await signIn(owner);

    cookieJar.set(authLib.SESSION_COOKIE, before);
    const registered = await call(() =>
      nativeDevicesRoute.POST(
        jsonRequest("/api/native-devices", {
          installationId: `install-${randomUUID()}`,
          environment: "production",
          appVersionName: "1.0.0",
          appVersionCode: 1,
          bridgeVersion: 1,
        }),
      ),
    );
    expect(registered.status).toBe(201);
    const after = sessionCookieOf(registered);
    await expectSameRow(before, after, owner);
    expect((await authLib.verifySession(after!))?.nativeDeviceId).toBeTruthy();

    await expectSignOutEndsEvery(after!, [before, after!]);
  });
});

// ---------------------------------------------------------------------------
// Support doors: bound to the grant
// ---------------------------------------------------------------------------

describe("support doors — bound to the grant, so «خروج» closes it and every copy dies", () => {
  async function operator(): Promise<{ adminId: string; platformToken: string }> {
    const email = `op-${randomUUID().slice(0, 8)}@example.com`;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO platform_admins (email, password_hash, full_name, role) VALUES ($1, 'x', 'Operator', 'support') RETURNING id`,
      [email],
    );
    const platformToken = await platformAuthEdge.signPlatformSession({
      padmin: rows[0].id,
      fullName: "Operator",
      email,
      role: "support",
    });
    return { adminId: rows[0].id, platformToken };
  }

  async function supportedBusiness(): Promise<Business> {
    const business = await seedBusiness("Supported");
    await addMember(business, "owner", { identity: await createIdentity() });
    return business;
  }

  async function grantEnded(grantId: string): Promise<boolean> {
    const { rows } = await db.query<{ ended_at: Date | null }>(`SELECT ended_at FROM impersonation_grants WHERE id = $1`, [grantId]);
    return rows[0]?.ended_at != null;
  }

  const REASON = "بررسی مشکل گزارش‌شده توسط مشتری";

  it("the console's start route: the cookie names the grant, and «خروج» closes it", async () => {
    const business = await supportedBusiness();
    const { platformToken } = await operator();
    cookieJar.set(platformAuthEdge.PLATFORM_SESSION_COOKIE, platformToken);

    const started = await call(() =>
      impersonateRoute.POST(jsonRequest(`/api/platform/businesses/${business.id}/impersonate`, { mode: "read_only", reason: REASON }), {
        params: Promise.resolve({ id: business.id }),
      }),
    );
    expect(started.status).toBe(200);
    const token = sessionCookieOf(started)!;
    const grantId = (started.body!.grant as { id: string }).id;
    expect((await authLib.verifySession(token))?.imp?.grantId).toBe(grantId);
    expect(await rowOf(token)).toBeUndefined();
    expect(await works(token)).toBe(true);

    await expectSignOutEndsEvery(token, [token]);
    expect(await grantEnded(grantId)).toBe(true);
  });

  it("the host hand-off: the cookie names the grant, and «خروج» closes it", async () => {
    const business = await supportedBusiness();
    const { adminId } = await operator();
    const { grant, handoff } = await platformService.startImpersonation({
      adminId,
      businessId: business.id,
      mode: "read_only",
      reason: REASON,
      allowedCapabilities: [],
    });

    const redeemed = await call(() =>
      impersonateHandoffRoute.GET(
        new NextRequest(`http://localhost/api/auth/impersonate-handoff?token=${encodeURIComponent(handoff.token)}`),
      ),
    );
    expect(redeemed.status).toBeGreaterThanOrEqual(300);
    expect(redeemed.status).toBeLessThan(400);
    const token = sessionCookieOf(redeemed)!;
    expect((await authLib.verifySession(token))?.imp?.grantId).toBe(grant.id);
    expect(await works(token)).toBe(true);

    await expectSignOutEndsEvery(token, [token]);
    expect(await grantEnded(grant.id)).toBe(true);
  });

  it("resume: a second cookie for the same grant; «خروج» with either refuses both", async () => {
    const business = await supportedBusiness();
    const { platformToken } = await operator();
    cookieJar.set(platformAuthEdge.PLATFORM_SESSION_COOKIE, platformToken);

    const started = await call(() =>
      impersonateRoute.POST(jsonRequest(`/api/platform/businesses/${business.id}/impersonate`, { mode: "read_only", reason: REASON }), {
        params: Promise.resolve({ id: business.id }),
      }),
    );
    expect(started.status).toBe(200);
    const first = sessionCookieOf(started)!;
    const grantId = (started.body!.grant as { id: string }).id;

    const resumed = await call(() =>
      resumeRoute.POST(jsonRequest(`/api/platform/impersonation/${grantId}/resume`, { businessId: business.id }), {
        params: Promise.resolve({ id: grantId }),
      }),
    );
    expect(resumed.status).toBe(200);
    const second = sessionCookieOf(resumed)!;
    expect(second).toBeTruthy();
    expect((await authLib.verifySession(second))?.imp?.grantId).toBe(grantId);
    expect(await works(first)).toBe(true);
    expect(await works(second)).toBe(true);

    await expectSignOutEndsEvery(second, [first, second]);
    expect(await grantEnded(grantId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A software authenticator: a real P-256 key, a real ES256 assertion
// ---------------------------------------------------------------------------

/**
 * Signs WebAuthn assertions with a fresh P-256 key, the way a platform
 * authenticator does: authenticator data (RP id hash, user-present and
 * user-verified flags, counter) followed by an ES256 signature over it and the
 * client data hash. The server verifies it with its own unmodified code, so a
 * wrong challenge, origin, RP id, key or counter is refused exactly as it would
 * be for a phone or a security key.
 */
function softwareAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const coseKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))],
    ]),
  );
  const credentialId = isoBase64URL.fromBuffer(new Uint8Array(randomBytes(16)));
  let counter = 0;
  return {
    credentialId,
    publicKeyBase64: Buffer.from(coseKey).toString("base64"),
    /** The server's defaults with no WEBAUTHN_* configured: RP id `localhost`, origin `http://localhost:3000`. */
    assert(challenge: string, origin = "http://localhost:3000", rpId = "localhost"): AuthenticationResponseJSON {
      counter += 1;
      const signCount = Buffer.alloc(4);
      signCount.writeUInt32BE(counter);
      const authenticatorData = Buffer.concat([
        createHash("sha256").update(rpId).digest(),
        Buffer.from([0x05]), // user present + user verified
        signCount,
      ]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      const signature = createSign("SHA256")
        .update(Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]))
        .sign(privateKey);
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          authenticatorData: isoBase64URL.fromBuffer(new Uint8Array(authenticatorData)),
          clientDataJSON: isoBase64URL.fromBuffer(new Uint8Array(clientDataJSON)),
          signature: isoBase64URL.fromBuffer(new Uint8Array(signature)),
        },
        clientExtensionResults: {},
      };
    },
  };
}
