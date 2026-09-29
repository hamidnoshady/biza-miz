/**
 * Owner activation, against a real database (issue #755 §14).
 *
 * The claim this file exists to prove is negative and easy to break silently:
 * **provisioning must not leave the platform operator holding a permanent
 * credential to a tenant.** So the assertions are about what does *not* exist —
 * no operator-chosen password, no MFA enrolment minted at provisioning time, no
 * recovery codes in the console's response.
 *
 *   - the owner identity is created with a password nobody knows, which fails
 *     closed against any guess;
 *   - the activation link is single-use, expiring and stored only as a hash;
 *   - redeeming it is where the password, the second factor and the recovery
 *     codes come into being — in the *owner's* response, never the operator's;
 *   - an email that already has a platform login keeps that password and gets no
 *     activation link, so a group owner's second business is added without
 *     anybody needing to know their credentials;
 *   - and that cross-business attach is refused unless the operator confirms it,
 *     because it is an action on somebody else's account.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let activation: typeof import("../src/lib/owner-activation");

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
  databaseName = `pos_owner_activation_${randomUUID().replaceAll("-", "")}`;
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
  provisioning = await import("../src/lib/business-provisioning");
  activation = await import("../src/lib/owner-activation");

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
  } finally {
    await maintenance.end();
  }
});

async function provisionActivated(suffix: string, ownerPhone: string | null = "09121234567") {
  const email = `owner-${suffix}@example.com`;
  const businessName = `کافه ${suffix}`;
  const result = await provisioning.provisionBusiness({
    businessName,
    ownerName: "مالک تازه",
    ownerPhone,
    email,
    industry: "food_service",
    subdomain: `act-${suffix}`,
    seedChartOfAccounts: false,
    ownerActivation: true,
    createdBy: null,
  });
  return { ...result, email, businessName };
}

async function getPreview(token: string): Promise<Response> {
  const { GET } = await import("../src/app/api/auth/owner-activation/route");
  return GET(
    new Request(`http://localhost:3000/api/auth/owner-activation?token=${encodeURIComponent(token)}`) as never,
  ) as Promise<Response>;
}

async function postAccept(token: string, password: string): Promise<Response> {
  const { POST } = await import("../src/app/api/auth/owner-activation/route");
  return POST(
    new Request("http://localhost:3000/api/auth/owner-activation", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }) as never,
  ) as Promise<Response>;
}

describe("provisioning with owner activation", () => {
  it("creates no credential the operator could know, and no MFA material at all", async () => {
    const biz = await provisionActivated(`new-${randomUUID().slice(0, 6)}`);
    expect(biz.ownerIdentityCreated).toBe(true);
    expect(biz.ownerActivation?.token).toBeTruthy();

    const { rows } = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM platform_users WHERE id = $1`,
      [biz.platformUserId],
    );
    // The stored hash is of 32 random bytes this process generated and threw
    // away. Every plausible guess — including the empty string — fails closed.
    for (const guess of ["", "password", "Password1", biz.email]) {
      expect(await bcrypt.compare(guess, rows[0].password_hash)).toBe(false);
    }

    const { rows: enrolments } = await db.query(
      `SELECT 1 FROM mfa_enrolments WHERE subject_realm = 'platform_user' AND subject_id = $1`,
      [biz.platformUserId],
    );
    expect(enrolments).toHaveLength(0);

    const { rows: codes } = await db.query(
      `SELECT 1 FROM mfa_recovery_codes WHERE subject_realm = 'platform_user' AND subject_id = $1`,
      [biz.platformUserId],
    );
    expect(codes).toHaveLength(0);

    // Only the hash is on disk: the plaintext exists solely in the response.
    const { rows: stored } = await db.query<{ token_hash: string }>(
      `SELECT token_hash FROM owner_activations WHERE business_id = $1`,
      [biz.businessId],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).toBe(activation.hashActivationToken(biz.ownerActivation!.token));
    expect(stored[0].token_hash).not.toBe(biz.ownerActivation!.token);
  }, 60_000);

  it("previews the business and a masked phone, and nothing else", async () => {
    const biz = await provisionActivated(`prev-${randomUUID().slice(0, 6)}`);
    const res = await getPreview(biz.ownerActivation!.token);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json).toMatchObject({
      businessName: biz.businessName,
      email: biz.email,
      ownerName: "مالک تازه",
      phoneHint: "••••4567",
    });

    // The full mobile never leaves the server on a page reachable by whoever
    // holds the link.
    expect(JSON.stringify(json)).not.toContain("09121234567");
    expect(JSON.stringify(json)).not.toContain("+989121234567");
  }, 60_000);

  it("refuses an unknown token", async () => {
    const res = await getPreview("act_deadbeef");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "invalid_activation" });
  }, 60_000);
});

describe("redeeming an activation link", () => {
  it("sets the owner's own password and mints their own second factor and codes", async () => {
    const biz = await provisionActivated(`redeem-${randomUUID().slice(0, 6)}`);

    const before = await postAccept(biz.ownerActivation!.token, "short");
    expect(before.status).toBe(400);
    expect(await before.json()).toMatchObject({ error: "weak_password" });

    const res = await postAccept(biz.ownerActivation!.token, "owner-chosen-password");
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.mfa.method).toBe("sms_otp");
    expect(json.mfa.phoneE164).toBe("+989121234567");
    // Ten codes, and they exist only here — the console never receives them.
    expect(json.mfa.recoveryCodes).toHaveLength(10);

    const { rows: user } = await db.query<{ password_hash: string; token_version: number }>(
      `SELECT password_hash, token_version FROM platform_users WHERE id = $1`,
      [biz.platformUserId],
    );
    expect(await bcrypt.compare("owner-chosen-password", user[0].password_hash)).toBe(true);
    // Sessions minted against the throwaway hash are invalidated.
    expect(user[0].token_version).toBe(2);

    const { rows: enrolments } = await db.query<{ method: string; phone_e164: string | null; confirmed_at: Date | null }>(
      `SELECT method, phone_e164, confirmed_at FROM mfa_enrolments
        WHERE subject_realm = 'platform_user' AND subject_id = $1`,
      [biz.platformUserId],
    );
    expect(enrolments).toHaveLength(1);
    expect(enrolments[0].method).toBe("sms_otp");
    // The operator typed the number, so the owner still has to prove it.
    expect(enrolments[0].confirmed_at).toBeNull();

    const { rows: codes } = await db.query(`SELECT 1 FROM mfa_recovery_codes WHERE subject_id = $1`, [
      biz.platformUserId,
    ]);
    expect(codes).toHaveLength(10);

    const { rows: audit } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE business_id = $1`,
      [biz.businessId],
    );
    expect(audit.map((a) => a.action)).toContain("owner.activated");
  }, 60_000);

  it("is single use", async () => {
    const biz = await provisionActivated(`once-${randomUUID().slice(0, 6)}`);
    expect((await postAccept(biz.ownerActivation!.token, "first-password")).status).toBe(200);

    const second = await postAccept(biz.ownerActivation!.token, "second-password");
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "activation_accepted" });

    // The second attempt changed nothing.
    const { rows } = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM platform_users WHERE id = $1`,
      [biz.platformUserId],
    );
    expect(await bcrypt.compare("first-password", rows[0].password_hash)).toBe(true);
  }, 60_000);

  it("falls back to an authenticator when there is no phone to text", async () => {
    const biz = await provisionActivated(`totp-${randomUUID().slice(0, 6)}`, null);
    expect(biz.ownerActivation?.token).toBeTruthy();

    const res = await postAccept(biz.ownerActivation!.token, "offline-password");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mfa.method).toBe("totp");
    expect(json.mfa.totpSecret).toBeTruthy();
    expect(json.mfa.totpQr).toMatch(/^data:image\//);
    expect(json.mfa.recoveryCodes).toHaveLength(10);
  }, 60_000);
});

describe("an owner who already has a platform login", () => {
  it("is refused until the operator confirms, then linked without an activation link", async () => {
    const suffix = randomUUID().slice(0, 6);
    const email = `group-${suffix}@example.com`;
    const first = await provisioning.provisionBusiness({
      businessName: "کافه نخست",
      ownerName: "مالک گروه",
      ownerPhone: "09121234567",
      email,
      subdomain: `group-a-${suffix}`,
      seedChartOfAccounts: false,
      ownerActivation: true,
      createdBy: null,
    });
    const token = first.ownerActivation!.token;
    expect((await postAccept(token, "their-own-password")).status).toBe(200);

    const { rows: before } = await db.query<{ password_hash: string; token_version: number }>(
      `SELECT password_hash, token_version FROM platform_users WHERE id = $1`,
      [first.platformUserId],
    );

    // Unconfirmed: refused, and nothing was created.
    await expect(
      provisioning.provisionBusiness({
        businessName: "کافه دوم",
        ownerName: "مالک گروه",
        ownerPhone: "09121234567",
        email,
        subdomain: `group-b-${suffix}`,
        seedChartOfAccounts: false,
        ownerActivation: true,
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(provisioning.ExistingOwnerConfirmationRequiredError);

    const { rows: nothing } = await db.query(
      `SELECT 1 FROM businesses WHERE subdomain = $1`,
      [`group-b-${suffix}`],
    );
    expect(nothing).toHaveLength(0);

    // Confirmed: the business is added to the *same* identity.
    const second = await provisioning.provisionBusiness({
      businessName: "کافه دوم",
      ownerName: "مالک گروه",
      ownerPhone: "09121234567",
      email,
      subdomain: `group-b-${suffix}`,
      seedChartOfAccounts: false,
      ownerActivation: true,
      confirmExistingOwner: true,
      createdBy: null,
    });
    expect(second.platformUserId).toBe(first.platformUserId);
    expect(second.ownerIdentityCreated).toBe(false);
    // No link: this person's credentials are theirs, and nobody — including the
    // operator who just added a business — needs to know or reset them.
    expect(second.ownerActivation).toBeUndefined();

    const { rows: after } = await db.query<{ password_hash: string; token_version: number }>(
      `SELECT password_hash, token_version FROM platform_users WHERE id = $1`,
      [first.platformUserId],
    );
    expect(after[0].password_hash).toBe(before[0].password_hash);
    expect(after[0].token_version).toBe(before[0].token_version);
  }, 120_000);
});
