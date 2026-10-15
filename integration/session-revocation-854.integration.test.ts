/**
 * Issue #854 follow-up (third pass) — every door that mints a tenant session
 * opens a revocable `employee_sessions` row, and a token that names none is
 * refused.
 *
 * Six doors used to sign a session cookie with no row behind it: the business
 * switch, first-run bootstrap, public signup, desktop pairing, the desktop
 * app's cloud hand-off and the company staff hand-off. «خروج» could only clear
 * the cookie (the second pass's `not_tracked`), and a copy of the token kept
 * anywhere else stayed valid. For each door this file drives the whole chain
 * through the real route handlers against a real schema:
 *
 *   issuance → the row that stores it → request authentication
 *   (`resolveSessionFromToken`, the check `getSession()` and the WebSocket
 *   upgrade both run) → «خروج» → the retained copy refused.
 *
 * Pairing is driven the same way in hybrid-credential-sync.integration.test.ts,
 * where the two-database cloud stub it needs already lives.
 *
 * Also here: legacy row-less tokens, support sessions (bound to their grant,
 * closed through the banner's own service), member and business isolation of
 * the row binding, and database/audit failures at every new write. Only
 * `next/headers` is replaced — outside a Next request there is no cookie store.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
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

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let authLib: typeof import("../src/lib/auth");
let employeeService: typeof import("../src/lib/employee-service");
let platformService: typeof import("../src/lib/platform-service");
let platformCompany: typeof import("../src/lib/platform-company");
let desktopLogin: typeof import("../src/lib/desktop-cloud-login");
let logoutRetry: typeof import("../src/lib/logout-retry");
let logoutRoute: typeof import("../src/app/api/auth/logout/route");
let logoutRetryRoute: typeof import("../src/app/api/auth/logout/retry/route");
let switchBusinessRoute: typeof import("../src/app/api/auth/switch-business/route");
let desktopSessionRoute: typeof import("../src/app/api/auth/desktop-session/route");
let companyHandoffRoute: typeof import("../src/app/api/auth/company-handoff/route");
let bootstrapRoute: typeof import("../src/app/api/setup/bootstrap/route");
let signupRoute: typeof import("../src/app/api/setup/signup/route");
let sessionsSelfRoute: typeof import("../src/app/api/sessions/self/route");
let stepUpRoute: typeof import("../src/app/api/auth/step-up/route");

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
  databaseName = `pos_session_revocation_${randomUUID().replaceAll("-", "")}`;
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

  // Fault injectors. Each raises for exactly one audit action (TG_ARGV[0]);
  // the session-scoped one only when the row names one session (TG_ARGV[1]),
  // so a test can fail one revocation while the next one succeeds.
  await db.query(`
    CREATE OR REPLACE FUNCTION fail_audit_854() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = TG_ARGV[0] AND (TG_NARGS < 2 OR NEW.payload->>'sessionId' = TG_ARGV[1]) THEN
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
  platformCompany = await import("../src/lib/platform-company");
  desktopLogin = await import("../src/lib/desktop-cloud-login");
  logoutRetry = await import("../src/lib/logout-retry");
  logoutRoute = await import("../src/app/api/auth/logout/route");
  logoutRetryRoute = await import("../src/app/api/auth/logout/retry/route");
  switchBusinessRoute = await import("../src/app/api/auth/switch-business/route");
  desktopSessionRoute = await import("../src/app/api/auth/desktop-session/route");
  companyHandoffRoute = await import("../src/app/api/auth/company-handoff/route");
  bootstrapRoute = await import("../src/app/api/setup/bootstrap/route");
  signupRoute = await import("../src/app/api/setup/signup/route");
  sessionsSelfRoute = await import("../src/app/api/sessions/self/route");
  stepUpRoute = await import("../src/app/api/auth/step-up/route");
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
  await db.query("DELETE FROM auth_login_attempts");
  await db.query("DELETE FROM platform_audit_log");
  await db.query("DELETE FROM impersonation_grants");
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_users");
  await db.query("DELETE FROM platform_admins");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.query("DROP TRIGGER IF EXISTS trg_fail_audit_854 ON audit_log");
  await db.query("DROP TRIGGER IF EXISTS trg_fail_platform_audit_854 ON platform_audit_log");
});

/** The routes log a failed write (without secrets); keep a run's output readable. */
const quietErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSWORD = "session-revocation-854";

interface Business {
  id: string;
  subdomain: string;
}

interface Member {
  id: string;
  businessId: string;
  role: "owner" | "manager" | "cashier";
  platformUserId: string | null;
}

async function seedBusiness(name: string): Promise<Business> {
  const label = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, subdomain) VALUES ($1, $2, $2) RETURNING id`,
    [name, label],
  );
  await db.query(`INSERT INTO locations (business_id, name) VALUES ($1, 'Main')`, [rows[0].id]);
  return { id: rows[0].id, subdomain: label };
}

async function createIdentity(): Promise<{ id: string; email: string; tokenVersion: number }> {
  const email = `person-${randomUUID().slice(0, 8)}@example.com`;
  const { rows } = await db.query<{ id: string; token_version: number }>(
    `INSERT INTO platform_users (email, password_hash, full_name) VALUES ($1, $2, 'Person')
     RETURNING id, token_version`,
    [email, await bcrypt.hash(PASSWORD, 10)],
  );
  return { id: rows[0].id, email, tokenVersion: rows[0].token_version };
}

async function addMember(
  business: Business,
  role: Member["role"],
  identity: { id: string; email: string } | null = null,
): Promise<Member> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [business.id, identity?.id ?? null, role, `${role}-${randomUUID().slice(0, 4)}`, identity?.email ?? null],
  );
  return { id: rows[0].id, businessId: business.id, role, platformUserId: identity?.id ?? null };
}

/** A sign-in the way every sign-in door does it: a row, then a token naming it. */
async function signIn(member: Member, tokenVersion?: number): Promise<string> {
  const { session } = await dbLib.withTenant(member.businessId, () =>
    employeeService.createSession(member.id, member.businessId, { loginMethod: "password" }),
  );
  return authLib.signSession({
    sub: member.id,
    role: member.role,
    businessId: member.businessId,
    locationId: null,
    fullName: "Member",
    ...(member.platformUserId ? { platformUserId: member.platformUserId, tokenVersion } : {}),
    employeeSessionId: session.id,
    recentAuthAt: Math.floor(Date.now() / 1000),
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

/** The row a token names, read straight from the table. */
async function rowOf(token: string | undefined): Promise<SessionRow | undefined> {
  const payload = token ? await authLib.verifySession(token) : null;
  if (!payload?.employeeSessionId) return undefined;
  const { rows } = await db.query<SessionRow>(
    `SELECT id, business_id, employee_id, login_method, revoked_at FROM employee_sessions WHERE id = $1`,
    [payload.employeeSessionId],
  );
  return rows[0];
}

async function sessionRevoked(sessionId: string): Promise<boolean> {
  const { rows } = await db.query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM employee_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.revoked_at != null;
}

async function auditRows(businessId: string, action: string) {
  const { rows } = await db.query<{ payload: Record<string, unknown>; user_id: string | null }>(
    `SELECT payload, user_id FROM audit_log WHERE business_id = $1 AND action = $2 ORDER BY id`,
    [businessId, action],
  );
  return rows;
}

async function failAuditFor(action: string, sessionId?: string): Promise<void> {
  if (!/^[a-z_.]+$/.test(action)) throw new Error(`unexpected audit action ${action}`);
  if (sessionId !== undefined && !/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error("unexpected session id");
  await db.query("DROP TRIGGER IF EXISTS trg_fail_audit_854 ON audit_log");
  await db.query(
    `CREATE TRIGGER trg_fail_audit_854 BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION fail_audit_854('${action}'${sessionId ? `, '${sessionId}'` : ""})`,
  );
}

async function failPlatformAuditFor(action: string): Promise<void> {
  if (!/^[a-z_.]+$/.test(action)) throw new Error(`unexpected audit action ${action}`);
  await db.query("DROP TRIGGER IF EXISTS trg_fail_platform_audit_854 ON platform_audit_log");
  await db.query(
    `CREATE TRIGGER trg_fail_platform_audit_854 BEFORE INSERT ON platform_audit_log
       FOR EACH ROW EXECUTE FUNCTION fail_audit_854('${action}')`,
  );
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
  } catch {
    return { status: 500, body: null, response: null };
  }
}

const sessionCookieOf = (outcome: Outcome) => outcome.response?.cookies.get(authLib.SESSION_COOKIE)?.value;

function postWithCookies(url: string, cookies: Record<string, string | undefined>): NextRequest {
  const header = Object.entries(cookies)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "user-agent": "Vitest Browser", ...(header ? { cookie: header } : {}) },
  });
}

const signOut = (token: string | undefined, extra: Record<string, string | undefined> = {}) =>
  call(() => logoutRoute.POST(postWithCookies("/api/auth/logout", { [authLib.SESSION_COOKIE]: token, ...extra })));

const retrySignOut = (ticket: string | undefined) =>
  call(() => logoutRetryRoute.POST(postWithCookies("/api/auth/logout/retry", { [logoutRetry.LOGOUT_RETRY_COOKIE]: ticket })));

/** «خروج» ends the row on the server, and the copy of the token kept anywhere else is refused from then on. */
async function expectSignOutEnds(token: string, businessId: string): Promise<void> {
  const row = await rowOf(token);
  expect(row?.revoked_at).toBeNull();
  const out = await signOut(token);
  expect(out.status).toBe(200);
  expect(out.body).toEqual({ ok: true, outcome: "revoked", sessionCookieCleared: true, pendingRevocations: 0 });
  expect(await sessionRevoked(row!.id)).toBe(true);
  const audit = await auditRows(businessId, "employee.session_revoked");
  expect(audit.at(-1)?.payload).toMatchObject({ sessionId: row!.id, via: "sign_out" });
  // The retained-token regression: every copy is dead, on every path.
  expect(await works(token)).toBe(false);
  cookieJar.set(authLib.SESSION_COOKIE, token);
  expect((await call(() => sessionsSelfRoute.GET())).status).toBe(401);
}

function switchTo(token: string, businessId: string) {
  cookieJar.set(authLib.SESSION_COOKIE, token);
  return call(() =>
    switchBusinessRoute.POST(
      new NextRequest("http://localhost/api/auth/switch-business", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Vitest Browser" },
        body: JSON.stringify({ businessId }),
      }),
    ),
  );
}

/** A person who belongs to two businesses — the only kind with something to switch to. */
async function twoMemberships() {
  const identity = await createIdentity();
  const alpha = await seedBusiness("Alpha");
  const beta = await seedBusiness("Beta");
  const inAlpha = await addMember(alpha, "owner", identity);
  const inBeta = await addMember(beta, "manager", identity);
  const token = await signIn(inAlpha, identity.tokenVersion);
  return { identity, alpha, beta, inAlpha, inBeta, token };
}

// ---------------------------------------------------------------------------
// The business switch
// ---------------------------------------------------------------------------

describe("business switch — the session moves; it is not copied", () => {
  it("opens a row in the target business, ends the one it leaves, and «خروج» ends the new one", async () => {
    const { alpha, beta, inBeta, token } = await twoMemberships();
    const leaving = (await rowOf(token))!;

    const switched = await switchTo(token, beta.id);
    expect(switched.status).toBe(200);
    const next = sessionCookieOf(switched);
    expect(next).toBeTruthy();

    // Stored: a row in the target business, for the target membership, saying how it was opened.
    const opened = (await rowOf(next))!;
    expect(opened).toMatchObject({
      business_id: beta.id,
      employee_id: inBeta.id,
      login_method: "business_switch",
      revoked_at: null,
    });
    expect((await authLib.resolveSessionFromToken(next))?.businessId).toBe(beta.id);
    const created = await auditRows(beta.id, "employee.session_created");
    expect(created.at(-1)?.payload).toMatchObject({ sessionId: opened.id });

    // The session left behind is over: a copy of the old cookie is refused.
    expect(await sessionRevoked(leaving.id)).toBe(true);
    const ended = await auditRows(alpha.id, "employee.session_revoked");
    expect(ended).toHaveLength(1);
    expect(ended[0].payload).toMatchObject({ sessionId: leaving.id, via: "business_switch" });
    expect(await works(token)).toBe(false);

    await expectSignOutEnds(next!, beta.id);
  });

  it("refuses a business the person does not belong to — nothing opened there, nothing ended here", async () => {
    const identity = await createIdentity();
    const alpha = await seedBusiness("Mine");
    const foreign = await seedBusiness("Foreign");
    await addMember(foreign, "owner", await createIdentity());
    const member = await addMember(alpha, "owner", identity);
    const token = await signIn(member, identity.tokenVersion);

    const refused = await switchTo(token, foreign.id);
    expect(refused.status).toBe(403);
    expect(sessionCookieOf(refused)).toBeUndefined();
    const { rows } = await db.query(`SELECT 1 FROM employee_sessions WHERE business_id = $1`, [foreign.id]);
    expect(rows).toHaveLength(0);
    expect(await works(token)).toBe(true);
  });

  it("changes nothing when the target row cannot be opened (its audit row fails)", async () => {
    const { beta, token } = await twoMemberships();
    await failAuditFor("employee.session_created");

    const failed = await switchTo(token, beta.id);
    expect(failed.status).toBe(500);
    expect(sessionCookieOf(failed)).toBeUndefined();
    // The old session is untouched and still works: nothing was half-switched.
    expect((await rowOf(token))?.revoked_at).toBeNull();
    expect(await works(token)).toBe(true);
  });

  it("is all-or-nothing when the session it leaves cannot be ended: 503, the old cookie kept, the new row ended again", async () => {
    const { beta, token } = await twoMemberships();
    const leaving = (await rowOf(token))!;
    await failAuditFor("employee.session_revoked", leaving.id);
    quietErrors();

    const failed = await switchTo(token, beta.id);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: "switch_unconfirmed" });
    expect(sessionCookieOf(failed)).toBeUndefined();
    expect(await sessionRevoked(leaving.id)).toBe(false);
    expect(await works(token)).toBe(true);

    // Never two live sessions for one browser: the row opened for the switch is ended again.
    const { rows } = await db.query<{ id: string; revoked_at: Date | null }>(
      `SELECT id, revoked_at FROM employee_sessions WHERE business_id = $1`,
      [beta.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();

    // Once the fault clears, the same request switches.
    await db.query("DROP TRIGGER trg_fail_audit_854 ON audit_log");
    const retried = await switchTo(token, beta.id);
    expect(retried.status).toBe(200);
    expect(await sessionRevoked(leaving.id)).toBe(true);
    expect(await works(sessionCookieOf(retried))).toBe(true);
  });

  it("a legacy row-less cookie cannot switch at all — it is refused before the switch runs", async () => {
    const { identity, inAlpha, beta } = await twoMemberships();
    const legacy = await authLib.signSession({
      sub: inAlpha.id,
      role: "owner",
      businessId: inAlpha.businessId,
      locationId: null,
      fullName: "Member",
      platformUserId: identity.id,
      tokenVersion: identity.tokenVersion,
    });
    const refused = await switchTo(legacy, beta.id);
    expect(refused.status).toBe(401);
    const { rows } = await db.query(`SELECT 1 FROM employee_sessions WHERE business_id = $1`, [beta.id]);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The desktop and company hand-offs
// ---------------------------------------------------------------------------

/** A session code the desktop would hand its embedded cloud pane. */
async function desktopSessionCode(business: Business, member: Member): Promise<string> {
  const code = desktopLogin.newLoginToken();
  await db.query(
    `INSERT INTO desktop_login_codes (business_id, kind, code_hash, user_id, expires_at)
     VALUES ($1, 'session', $2, $3, now() + interval '2 minutes')`,
    [business.id, desktopLogin.hashLoginCode(code), member.id],
  );
  return code;
}

function openDesktopPane(host: string, code: string, next = "/dashboard") {
  return call(() =>
    desktopSessionRoute.GET(
      new NextRequest(
        `http://${host}/api/auth/desktop-session?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`,
        { headers: { host, "user-agent": "BizaMiz Desktop" } },
      ),
    ),
  );
}

describe("desktop hand-off — the cloud pane's session is an ordinary revocable one", () => {
  it("opens a row, signs it into the cookie, and «خروج» ends it", async () => {
    const business = await seedBusiness("Desk");
    const owner = await addMember(business, "owner", await createIdentity());
    const code = await desktopSessionCode(business, owner);

    const opened = await openDesktopPane(`${business.subdomain}.example.test`, code);
    expect(opened.status).toBe(303);
    expect(opened.response?.headers.get("location")).toBe("/dashboard");
    const token = sessionCookieOf(opened);
    expect(await rowOf(token)).toMatchObject({
      business_id: business.id,
      employee_id: owner.id,
      login_method: "desktop_handoff",
      revoked_at: null,
    });
    expect(await works(token)).toBe(true);

    await expectSignOutEnds(token!, business.id);
  });

  it("a code minted for one business opens nothing on another business's origin", async () => {
    const mine = await seedBusiness("DeskMine");
    const other = await seedBusiness("DeskOther");
    const owner = await addMember(mine, "owner", await createIdentity());
    const code = await desktopSessionCode(mine, owner);

    const refused = await openDesktopPane(`${other.subdomain}.example.test`, code);
    expect(refused.status).toBe(303);
    expect(refused.response?.headers.get("location")).toBe("/login?next=%2Fdashboard");
    expect(sessionCookieOf(refused)).toBeUndefined();
    const { rows } = await db.query(`SELECT 1 FROM employee_sessions`);
    expect(rows).toHaveLength(0);
  });

  it("issues no cookie at all when the row cannot be opened — the pane lands on the sign-in page", async () => {
    const business = await seedBusiness("DeskFault");
    const owner = await addMember(business, "owner", await createIdentity());
    const code = await desktopSessionCode(business, owner);
    await failAuditFor("employee.session_created");
    quietErrors();

    const failed = await openDesktopPane(`${business.subdomain}.example.test`, code, "/orders");
    expect(failed.status).toBe(303);
    expect(failed.response?.headers.get("location")).toBe("/login?next=%2Forders");
    expect(sessionCookieOf(failed)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// First-run bootstrap and public signup
// ---------------------------------------------------------------------------

function provisionRequest(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Vitest Browser" },
    body: JSON.stringify(body),
  });
}

const owner = () => ({
  businessName: "کافه آغاز",
  ownerName: "مالک",
  email: `owner-${randomUUID().slice(0, 8)}@example.com`,
  password: "a-long-enough-owner-password",
});

describe("first-run bootstrap — the Owner's first session is revocable", () => {
  it("opens a row, signs it into the cookie, and «خروج» ends it", async () => {
    const created = await call(() =>
      bootstrapRoute.POST(provisionRequest("/api/setup/bootstrap", { ...owner(), deploymentMode: "local" })),
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, signedIn: true });
    const token = sessionCookieOf(created);
    const row = (await rowOf(token))!;
    expect(row).toMatchObject({ login_method: "setup", revoked_at: null });
    expect(await works(token)).toBe(true);

    await expectSignOutEnds(token!, row.business_id);
  });

  it("keeps the once-only second factor and sends the Owner to sign in when the row cannot be opened", async () => {
    await failAuditFor("employee.session_created");
    quietErrors();
    const created = await call(() =>
      bootstrapRoute.POST(provisionRequest("/api/setup/bootstrap", { ...owner(), deploymentMode: "local" })),
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, signedIn: false });
    // Shown exactly once — a 500 here would have lost it for good.
    const mfa = created.body?.mfa as { totpSecret?: string; recoveryCodes?: string[] } | undefined;
    expect(mfa?.totpSecret).toBeTruthy();
    expect(mfa?.recoveryCodes?.length).toBeGreaterThan(0);
    expect(sessionCookieOf(created)).toBeUndefined();
    const { rows } = await db.query(`SELECT 1 FROM businesses`);
    expect(rows).toHaveLength(1);
  });
});

describe("public signup — the new Owner's session is revocable", () => {
  const signupEnv = process.env.ALLOW_PUBLIC_SIGNUP;
  beforeEach(() => {
    process.env.ALLOW_PUBLIC_SIGNUP = "true";
  });
  afterEach(() => {
    if (signupEnv === undefined) delete process.env.ALLOW_PUBLIC_SIGNUP;
    else process.env.ALLOW_PUBLIC_SIGNUP = signupEnv;
  });

  it("opens a row, signs it into the cookie, and «خروج» ends it", async () => {
    const created = await call(() =>
      signupRoute.POST(provisionRequest("/api/setup/signup", { ...owner(), ownerPhone: "09121234567" })),
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, signedIn: true });
    const token = sessionCookieOf(created);
    const row = (await rowOf(token))!;
    expect(row).toMatchObject({ login_method: "setup", revoked_at: null });

    await expectSignOutEnds(token!, row.business_id);
  });

  it("answers ok without a cookie when the row cannot be opened, so the visitor signs in instead of signing up twice", async () => {
    await failAuditFor("employee.session_created");
    quietErrors();
    const created = await call(() =>
      signupRoute.POST(provisionRequest("/api/setup/signup", { ...owner(), ownerPhone: "09121234567" })),
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, signedIn: false });
    expect(sessionCookieOf(created)).toBeUndefined();
    const { rows } = await db.query(`SELECT 1 FROM businesses`);
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Legacy tokens and the row binding
// ---------------------------------------------------------------------------

describe("legacy tokens and the row binding", () => {
  it("a row-less token from before the third pass is refused on every request, and a re-mint cannot revive it", async () => {
    const business = await seedBusiness("Legacy");
    const cashier = await addMember(business, "cashier");
    const legacy = await authLib.signSession({
      sub: cashier.id,
      role: "cashier",
      businessId: business.id,
      locationId: null,
      fullName: "Member",
      recentAuthAt: Math.floor(Date.now() / 1000),
    });

    expect(await works(legacy)).toBe(false);
    cookieJar.set(authLib.SESSION_COOKIE, legacy);
    expect((await call(() => sessionsSelfRoute.GET())).status).toBe(401);
    // The step-up route used to re-sign such a token with a fresh 12 hours.
    const remint = await call(() =>
      stepUpRoute.POST(
        new NextRequest("http://localhost/api/auth/step-up", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: "pin", credential: "1234" }),
        }),
      ),
    );
    expect(remint.status).toBe(401);
    expect(sessionCookieOf(remint)).toBeUndefined();

    const out = await signOut(legacy);
    expect(out.body).toEqual({ ok: true, outcome: "already_ended", sessionCookieCleared: true, pendingRevocations: 0 });
  });

  it("a token naming another member's row — in the same business or another — names no session", async () => {
    const alpha = await seedBusiness("BindAlpha");
    const beta = await seedBusiness("BindBeta");
    const mallory = await addMember(alpha, "cashier");
    const victim = await addMember(alpha, "cashier");
    const foreigner = await addMember(beta, "cashier");
    const victimToken = await signIn(victim);
    const foreignToken = await signIn(foreigner);
    const victimRow = (await rowOf(victimToken))!.id;
    const foreignRow = (await rowOf(foreignToken))!.id;

    const forge = (employeeSessionId: string, businessId = alpha.id) =>
      authLib.signSession({
        sub: mallory.id,
        role: "cashier",
        businessId,
        locationId: null,
        fullName: "Mallory",
        employeeSessionId,
      });
    // Same business, someone else's row.
    expect(await works(await forge(victimRow))).toBe(false);
    // Another business's row, claimed for this business or for that one.
    expect(await works(await forge(foreignRow))).toBe(false);
    expect(await works(await forge(foreignRow, beta.id))).toBe(false);
    // And their owners' own tokens are untouched.
    expect(await works(victimToken)).toBe(true);
    expect(await works(foreignToken)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Support sessions
// ---------------------------------------------------------------------------

async function supportSession(mode: "read_only" | "controlled" = "read_only") {
  const business = await seedBusiness("Supported");
  await addMember(business, "owner", await createIdentity());
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name, role)
     VALUES ($1, 'x', 'Operator', 'engineer') RETURNING id`,
    [`op-${randomUUID().slice(0, 8)}@example.com`],
  );
  const adminId = rows[0].id;
  const { grant, userId, fullName } = await platformService.startImpersonation({
    adminId,
    businessId: business.id,
    mode,
    reason: "بررسی مشکل گزارش‌شده توسط مشتری",
    allowedCapabilities: [],
  });
  const token = await authLib.signSession({
    sub: userId,
    role: "owner",
    businessId: business.id,
    locationId: null,
    fullName,
    imp: { grantId: grant.id, adminId, mode, allowedCapabilities: grant.allowedCapabilities },
  });
  return { business, adminId, grantId: grant.id, token };
}

async function grantRow(id: string) {
  const { rows } = await db.query<{ ended_at: Date | null; revoked_at: Date | null; ended_by_type: string | null }>(
    `SELECT ended_at, revoked_at, ended_by_type FROM impersonation_grants WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function supportAudit(grantId: string) {
  const { rows } = await db.query<{ action: string; payload: Record<string, unknown> }>(
    `SELECT action, payload FROM platform_audit_log WHERE entity = 'impersonation_grant' AND entity_id = $1 ORDER BY id`,
    [grantId],
  );
  return rows;
}

describe("support sessions — «خروج» closes the grant, through the banner's own service", () => {
  it("ends the grant as the operator, says so, returns to the console, and the token is dead", async () => {
    const support = await supportSession("read_only");
    expect(await works(support.token)).toBe(true);

    const out = await signOut(support.token);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      ok: true,
      outcome: "revoked",
      sessionCookieCleared: true,
      pendingRevocations: 0,
      redirectTo: `/platform/businesses/${support.business.id}/support`,
    });
    expect((await grantRow(support.grantId)).ended_by_type).toBe("operator");
    const audit = await supportAudit(support.grantId);
    expect(audit.map((row) => row.action)).toContain("support_session.ended");
    expect(audit.find((row) => row.action === "support_session.ended")?.payload).toMatchObject({
      channel: "tenant_sign_out",
      endedByType: "operator",
    });
    expect(await works(support.token)).toBe(false);
    // No employee row was ever involved.
    expect(await auditRows(support.business.id, "employee.session_revoked")).toHaveLength(0);

    // Signing the same token out again finds nothing left to end.
    const again = await signOut(support.token);
    expect(again.body).toMatchObject({ ok: true, outcome: "already_ended" });
    expect((await supportAudit(support.grantId)).filter((row) => row.action === "support_session.ended")).toHaveLength(1);
  });

  it("an unauditable close is unconfirmed, keeps the grant live, and the retry ticket finishes it", async () => {
    const support = await supportSession("controlled");
    await failPlatformAuditFor("support_session.ended");
    quietErrors();

    const out = await signOut(support.token);
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({
      ok: false,
      outcome: "unconfirmed",
      sessionCookieCleared: true,
      pendingRevocations: 1,
      redirectTo: `/platform/businesses/${support.business.id}/support`,
    });
    // Truthfully unconfirmed: the grant (and so a retained token) is still live.
    expect((await grantRow(support.grantId)).ended_at).toBeNull();
    expect(await works(support.token)).toBe(true);
    const ticket = out.response?.cookies.get(logoutRetry.LOGOUT_RETRY_COOKIE)?.value;
    expect(ticket).toBeTruthy();

    await db.query("DROP TRIGGER trg_fail_platform_audit_854 ON platform_audit_log");
    const finished = await retrySignOut(ticket);
    expect(finished.body).toEqual({ ok: true, outcome: "revoked", sessionCookieCleared: false, pendingRevocations: 0 });
    expect((await grantRow(support.grantId)).ended_by_type).toBe("operator");
    expect(
      (await supportAudit(support.grantId)).find((row) => row.action === "support_session.ended")?.payload,
    ).toMatchObject({ channel: "tenant_sign_out_retry" });
    expect(await works(support.token)).toBe(false);
  });

  it("a ticket naming someone else's grant, or the grant under another business, closes nothing", async () => {
    const support = await supportSession();
    const other = await seedBusiness("OtherBusiness");
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    // Correctly signed (that needs the server key), but pairing the grant with
    // the wrong operator or the wrong business matches no grant.
    const forged = await logoutRetry.signLogoutRetryTicket([
      { kind: "support_grant", grantId: support.grantId, businessId: support.business.id, adminId: randomUUID(), expiresAt },
      { kind: "support_grant", grantId: support.grantId, businessId: other.id, adminId: support.adminId, expiresAt },
    ]);
    const out = await retrySignOut(forged!.token);
    expect(out.body).toMatchObject({ ok: true, outcome: "already_ended" });
    expect((await grantRow(support.grantId)).ended_at).toBeNull();
    expect(await works(support.token)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retry with a newly established session
// ---------------------------------------------------------------------------

describe("an unconfirmed sign-out is finished by the next one, whichever door the new session came through", () => {
  it("ends a switched session left unconfirmed, from a session the desktop hand-off opened", async () => {
    const { beta, inBeta, token } = await twoMemberships();
    const switched = sessionCookieOf(await switchTo(token, beta.id));
    const switchedRow = (await rowOf(switched))!.id;

    await failAuditFor("employee.session_revoked", switchedRow);
    quietErrors();
    const failed = await signOut(switched);
    expect(failed.status).toBe(503);
    const ticket = failed.response?.cookies.get(logoutRetry.LOGOUT_RETRY_COOKIE)?.value;
    expect(ticket).toBeTruthy();
    expect(await works(switched)).toBe(true);
    await db.query("DROP TRIGGER trg_fail_audit_854 ON audit_log");

    // Signed in again on the same browser through another door, then signed out normally.
    const code = await desktopSessionCode(beta, inBeta);
    const pane = sessionCookieOf(await openDesktopPane(`${beta.subdomain}.example.test`, code));
    expect(await works(pane)).toBe(true);
    const out = await signOut(pane, { [logoutRetry.LOGOUT_RETRY_COOKIE]: ticket });
    expect(out.body).toMatchObject({ ok: true, outcome: "revoked", pendingRevocations: 0 });
    expect(out.response?.cookies.get(logoutRetry.LOGOUT_RETRY_COOKIE)?.value).toBe("");
    expect(await works(switched)).toBe(false);
    expect(await works(pane)).toBe(false);
    const audit = await auditRows(beta.id, "employee.session_revoked");
    expect(audit.map((row) => row.payload.via)).toEqual(["sign_out", "sign_out_retry"]);
  });
});

// ---------------------------------------------------------------------------
// The company hand-off (last: it provisions the internal company)
// ---------------------------------------------------------------------------

describe("company hand-off — a staff member's own revocable session in the company", () => {
  async function companyHandoff() {
    const previousRole = process.env.DEPLOYMENT_ROLE;
    process.env.DEPLOYMENT_ROLE = "central";
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO platform_admins (email, full_name, password_hash, role, is_active)
         VALUES ($1, 'مدیر پلتفرم', 'x', 'owner', true) RETURNING id`,
        [`owner+${randomUUID()}@example.test`],
      );
      const adminId = rows[0].id;
      const company = await dbLib.withoutTenantScope("platform", () =>
        platformCompany.ensurePlatformCompany({ padmin: adminId, role: "owner" } as never),
      );
      const businessId = company!.business_id;
      const member = await db.query<{ user_id: string }>(
        `SELECT user_id FROM platform_company_members WHERE platform_admin_id = $1`,
        [adminId],
      );
      const userId = member.rows[0].user_id;
      const created = await dbLib.withoutTenantScope("platform", () =>
        platformCompany.createCompanyHandoff(
          {
            platformAdminId: adminId,
            businessId,
            userId,
            fullName: "مدیر",
            preset: "company_owner",
            permissions: new Set<string>() as never,
            revision: 1,
          },
          "/accounting",
        ),
      );
      return { businessId, userId, token: created.token, host: `${created.subdomain}.example.test` };
    } finally {
      if (previousRole === undefined) delete process.env.DEPLOYMENT_ROLE;
      else process.env.DEPLOYMENT_ROLE = previousRole;
    }
  }

  function redeem(host: string, token: string) {
    return call(() =>
      companyHandoffRoute.GET(
        new NextRequest(`http://${host}/api/auth/company-handoff?token=${encodeURIComponent(token)}`, {
          headers: { host, "user-agent": "Vitest Browser" },
        }),
      ),
    );
  }

  it("opens a row, signs it into the cookie, and «خروج» ends it", async () => {
    const handoff = await companyHandoff();
    const redeemed = await redeem(handoff.host, handoff.token);
    expect(redeemed.status).toBe(307);
    expect(redeemed.response?.headers.get("location")).toMatch(/\/accounting$/);
    const token = sessionCookieOf(redeemed);
    expect(await rowOf(token)).toMatchObject({
      business_id: handoff.businessId,
      employee_id: handoff.userId,
      login_method: "company_handoff",
      revoked_at: null,
    });
    expect(await works(token)).toBe(true);

    await expectSignOutEnds(token!, handoff.businessId);
  });

  it("answers 503 with no cookie when the row cannot be opened, and the spent token stays spent", async () => {
    const handoff = await companyHandoff();
    await failAuditFor("employee.session_created");
    quietErrors();

    const failed = await redeem(handoff.host, handoff.token);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: "session_unavailable" });
    expect(sessionCookieOf(failed)).toBeUndefined();

    await db.query("DROP TRIGGER trg_fail_audit_854 ON audit_log");
    expect((await redeem(handoff.host, handoff.token)).status).toBe(400);
  });
});
