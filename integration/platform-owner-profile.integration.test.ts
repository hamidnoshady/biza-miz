/**
 * The super-admin owner/admin profile, against a real database (issue #755 §1).
 *
 * The security-shaped properties are the point of this file, so all of them run
 * against the real schema:
 *
 *   - the read never returns credential material (no password hash, no TOTP
 *     secret, no recovery-code hash or plaintext);
 *   - a membership edit is business-scoped, while an email edit moves the global
 *     identity and invalidates that person's sessions everywhere;
 *   - changing an email that reaches beyond this business needs explicit
 *     confirmation;
 *   - a changed MFA phone is stored *unconfirmed*, because the second factor
 *     must be re-proven;
 *   - every edit leaves one audit row with before/after values.
 *
 * Platform authentication is the only thing stubbed — there is no HTTP session
 * in an integration test — but `platformAudit` stays the real implementation, so
 * the audit assertions read rows the production code actually wrote.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { CAPABILITIES_FOR, type PlatformAdminRole } from "../src/lib/platform-admin";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const adminId = randomUUID();
const state = { role: "owner" as PlatformAdminRole };

vi.mock("@/lib/platform-auth", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/platform-auth")>(
    "../src/lib/platform-auth",
  );
  const { CAPABILITIES_FOR: caps } = await vi.importActual<
    typeof import("../src/lib/platform-admin")
  >("../src/lib/platform-admin");

  return {
    // `platformAudit` deliberately stays real: the audit rows asserted below are
    // written by the production implementation.
    platformAudit: actual.platformAudit,
    requirePlatformAdmin: vi.fn(async () => ({
      session: { padmin: adminId, role: state.role },
      error: null,
    })),
    requirePlatformCapability: vi.fn(async (capability: string) =>
      (caps(state.role) as string[]).includes(capability)
        ? { session: { padmin: adminId, role: state.role }, error: null }
        : {
            session: null,
            error: Response.json({ error: "forbidden", capability }, { status: 403 }),
          },
    ),
    withPlatformScope: (fn: (request: Request, ctx: unknown) => Promise<Response>) => fn,
  };
});

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");

const businessA = { id: "" };
const businessB = { id: "" };
const identity = { id: "", email: "" };
const otherIdentity = { id: "" };
const membershipA = { id: "" };
const membershipB = { id: "" };

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
  databaseName = `pos_owner_profile_${randomUUID().replaceAll("-", "")}`;
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

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  await db.query(
    `INSERT INTO platform_admins (id, email, password_hash, full_name)
     VALUES ($1, 'ops@example.com', 'x', 'اپراتور')`,
    [adminId],
  );

  const suffix = randomUUID().slice(0, 8);
  const a = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ('کافه مالک', $1) RETURNING id`,
    [`owner-a-${suffix}`],
  );
  const b = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ('فروشگاه دوم', $1) RETURNING id`,
    [`owner-b-${suffix}`],
  );
  businessA.id = a.rows[0].id;
  businessB.id = b.rows[0].id;

  identity.email = `owner-${suffix}@example.com`;
  const identityRow = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, 'hashed-secret-value', 'مالک اصلی') RETURNING id`,
    [identity.email],
  );
  identity.id = identityRow.rows[0].id;

  const otherRow = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, 'x', 'شخص دیگر') RETURNING id`,
    [`taken-${suffix}@example.com`],
  );
  otherIdentity.id = otherRow.rows[0].id;

  const memberA = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, platform_user_id)
     VALUES ($1, 'owner', 'مالک اصلی', $2) RETURNING id`,
    [businessA.id, identity.id],
  );
  membershipA.id = memberA.rows[0].id;
  const memberB = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, platform_user_id)
     VALUES ($1, 'owner', 'مالک اصلی', $2) RETURNING id`,
    [businessB.id, identity.id],
  );
  membershipB.id = memberB.rows[0].id;

  // An SMS enrolment with a confirmed phone, plus one unused recovery code, so
  // the "security state" half of the read has something to report.
  await db.query(
    `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, phone_e164, is_primary, confirmed_at)
     VALUES ('platform_user', $1, 'sms_otp', '+989121234567', true, now())`,
    [identity.id],
  );
  await db.query(
    `INSERT INTO mfa_recovery_codes (subject_realm, subject_id, code_hash)
     VALUES ('platform_user', $1, 'hashed-recovery-code')`,
    [identity.id],
  );
  await db.query(
    `INSERT INTO mfa_enrolments (subject_realm, subject_id, method, totp_secret, confirmed_at)
     VALUES ('platform_user', $1, 'totp', $2, now())`,
    [otherIdentity.id, Buffer.from("super-secret-totp")],
  );
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

async function get(): Promise<Response> {
  const { GET } = await import("../src/app/api/platform/businesses/[id]/owner/route");
  return GET(
    new Request(`http://localhost:3000/api/platform/businesses/${businessA.id}/owner`) as never,
    { params: Promise.resolve({ id: businessA.id }) },
  ) as Promise<Response>;
}

async function patch(body: Record<string, unknown>): Promise<Response> {
  const { PATCH } = await import("../src/app/api/platform/businesses/[id]/owner/route");
  return PATCH(
    new Request(`http://localhost:3000/api/platform/businesses/${businessA.id}/owner`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: businessA.id }) },
  ) as Promise<Response>;
}

async function auditRows(): Promise<{ action: string; payload: Record<string, unknown> }[]> {
  const { rows } = await db.query<{ action: string; payload: Record<string, unknown> }>(
    `SELECT action, payload FROM platform_audit_log
      WHERE business_id = $1 ORDER BY id`,
    [businessA.id],
  );
  return rows;
}

beforeEach(async () => {
  state.role = "owner";
  await db.query(`DELETE FROM platform_audit_log WHERE business_id = $1`, [businessA.id]);
  // Reset the mutable fields each test touches.
  await db.query(
    `UPDATE users SET full_name = 'مالک اصلی', is_active = true WHERE id = $1`,
    [membershipA.id],
  );
  await db.query(`UPDATE platform_users SET full_name = 'مالک اصلی' WHERE id = $1`, [identity.id]);
  await db.query(`UPDATE platform_users SET email = $2 WHERE id = $1`, [identity.id, identity.email]);
  await db.query(`UPDATE platform_users SET token_version = 1 WHERE id = $1`, [identity.id]);
  await db.query(
    `UPDATE mfa_enrolments SET phone_e164 = '+989121234567', confirmed_at = now()
      WHERE subject_realm = 'platform_user' AND subject_id = $1 AND method = 'sms_otp'`,
    [identity.id],
  );
});

describe("GET owner profiles", () => {
  it("reports identity, membership, security state and cross-business reach", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.profiles).toHaveLength(1);
    const profile = json.profiles[0];

    expect(profile).toMatchObject({
      role: "owner",
      fullName: "مالک اصلی",
      email: identity.email,
      membershipActive: true,
      platformUserId: identity.id,
      membershipCount: 2,
      branchAccess: { locationId: null, locationName: null },
    });
    expect(profile.mfa).toMatchObject({
      method: "sms_otp",
      phoneE164: "+989121234567",
      recoveryCodesRemaining: 1,
    });
    expect(profile.mfa.confirmedAt).toBeTruthy();
    expect(profile.otherBusinesses.map((b: { id: string }) => b.id)).toEqual([businessB.id]);
    expect(profile.lastLoginAt).toBeNull();
  });

  it("never returns credential material", async () => {
    const json = JSON.stringify(await (await get()).json());
    expect(json).not.toContain("hashed-secret-value");
    expect(json).not.toContain("hashed-recovery-code");
    expect(json).not.toContain("super-secret-totp");
    expect(json).not.toContain("password_hash");
    expect(json).not.toContain("totp_secret");
  });

  it("is readable by support, who cannot edit it", async () => {
    state.role = "support";
    expect((await get()).status).toBe(200);
    const res = await patch({ membershipId: membershipA.id, fullName: "نام تازه" });
    expect(res.status).toBe(403);
  });
});

describe("PATCH owner profile — business-scoped edits", () => {
  it("updates the name on the membership and the identity together, with an audit row", async () => {
    const res = await patch({ membershipId: membershipA.id, fullName: "نام تازه", reason: "درخواست مالک" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.profiles[0].fullName).toBe("نام تازه");

    const { rows: member } = await db.query<{ full_name: string }>(
      `SELECT full_name FROM users WHERE id = $1`,
      [membershipA.id],
    );
    expect(member[0].full_name).toBe("نام تازه");
    const { rows: globalIdentity } = await db.query<{ full_name: string }>(
      `SELECT full_name FROM platform_users WHERE id = $1`,
      [identity.id],
    );
    expect(globalIdentity[0].full_name).toBe("نام تازه");

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("business.owner_profile.updated");
    expect(audits[0].payload).toMatchObject({
      reason: "درخواست مالک",
      before: { fullName: "مالک اصلی" },
      after: { fullName: "نام تازه" },
    });
  });

  it("disables this membership without touching the person's other business", async () => {
    const res = await patch({ membershipId: membershipA.id, isActive: false });
    expect(res.status).toBe(200);

    const { rows: a } = await db.query<{ is_active: boolean }>(
      `SELECT is_active FROM users WHERE id = $1`,
      [membershipA.id],
    );
    const { rows: b } = await db.query<{ is_active: boolean }>(
      `SELECT is_active FROM users WHERE id = $1`,
      [membershipB.id],
    );
    const { rows: globalIdentity } = await db.query<{ is_active: boolean }>(
      `SELECT is_active FROM platform_users WHERE id = $1`,
      [identity.id],
    );
    expect(a[0].is_active).toBe(false);
    expect(b[0].is_active).toBe(true);
    expect(globalIdentity[0].is_active).toBe(true);
  });

  it("stores a changed MFA phone unconfirmed, so the factor must be re-proven", async () => {
    const res = await patch({ membershipId: membershipA.id, phone: "09121234568" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.notices.join(" ")).toContain("تأیید");

    const { rows } = await db.query<{ phone_e164: string | null; confirmed_at: Date | null }>(
      `SELECT phone_e164, confirmed_at FROM mfa_enrolments
        WHERE subject_realm = 'platform_user' AND subject_id = $1 AND method = 'sms_otp'`,
      [identity.id],
    );
    expect(rows[0].phone_e164).toBe("+989121234568");
    expect(rows[0].confirmed_at).toBeNull();
  });

  it("rejects a malformed phone without writing anything", async () => {
    const res = await patch({ membershipId: membershipA.id, phone: "123" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_phone" });
    const { rows } = await db.query<{ phone_e164: string | null }>(
      `SELECT phone_e164 FROM mfa_enrolments WHERE subject_id = $1 AND method = 'sms_otp'`,
      [identity.id],
    );
    expect(rows[0].phone_e164).toBe("+989121234567");
  });

  it("refuses an edit that changes nothing", async () => {
    const res = await patch({ membershipId: membershipA.id, fullName: "مالک اصلی" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_changes" });
    expect(await auditRows()).toHaveLength(0);
  });

  it("does not treat a membership of another business as editable here", async () => {
    const res = await patch({ membershipId: membershipB.id, fullName: "دستکاری" });
    expect(res.status).toBe(404);
    const { rows } = await db.query<{ full_name: string }>(
      `SELECT full_name FROM users WHERE id = $1`,
      [membershipB.id],
    );
    expect(rows[0].full_name).toBe("مالک اصلی");
  });
});

describe("PATCH owner profile — the email is a global login", () => {
  it("needs explicit confirmation when the identity reaches another business", async () => {
    const res = await patch({ membershipId: membershipA.id, email: "new-owner@example.com" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "cross_business_confirmation_required" });

    const { rows } = await db.query<{ email: string }>(
      `SELECT email::text AS email FROM platform_users WHERE id = $1`,
      [identity.id],
    );
    expect(rows[0].email).toBe(identity.email);
  });

  it("changes the identity's email and invalidates its sessions everywhere", async () => {
    const res = await patch({
      membershipId: membershipA.id,
      email: "new-owner@example.com",
      confirmCrossBusiness: true,
    });
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ email: string; token_version: number }>(
      `SELECT email::text AS email, token_version FROM platform_users WHERE id = $1`,
      [identity.id],
    );
    expect(rows[0].email).toBe("new-owner@example.com");
    // Sessions of that identity are invalidated on *every* business it belongs
    // to — it is one identity, so one email change has to mean one logout.
    expect(rows[0].token_version).toBe(2);

    // The membership in the other business still points at the same identity.
    const { rows: still } = await db.query<{ platform_user_id: string }>(
      `SELECT platform_user_id FROM users WHERE id = $1`,
      [membershipB.id],
    );
    expect(still[0].platform_user_id).toBe(identity.id);

    const audits = await auditRows();
    expect(audits[0].payload).toMatchObject({
      before: { email: identity.email },
      after: { email: "new-owner@example.com" },
    });
  });

  it("refuses an email another identity already owns", async () => {
    const res = await patch({
      membershipId: membershipA.id,
      email: `taken-${identity.email.split("-")[1]}`,
      confirmCrossBusiness: true,
    });
    expect(res.status).toBe(409);
    // The real conflict is the citext unique index, so whatever it rejects must
    // come back as `email_taken` rather than a 500.
    expect(await res.json()).toMatchObject({ error: "email_taken" });
  });

  it("refuses a malformed email", async () => {
    const res = await patch({
      membershipId: membershipA.id,
      email: "not-an-email",
      confirmCrossBusiness: true,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_email" });
  });
});
