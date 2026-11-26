/**
 * ESH-199 / #1384 — the launch identity shapes, against a real database.
 *
 * Covers what migration 0303 introduced and nothing that was already tested:
 * a passwordless/email-less identity row, the one-live-token email proof
 * (including the address-changed refusal), and the encrypted national ID with
 * its blind-index uniqueness and audit trail.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: typeof import("../src/lib/db");
let credentials: typeof import("../src/lib/iam/identity-credentials");
let profile: typeof import("../src/lib/iam/identity-profile");

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

async function insertIdentity(overrides: {
  email?: string | null;
  passwordHash?: string | null;
  phone?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db.withoutTenantScope("platform", () =>
    db.query(
      `INSERT INTO platform_users (id, email, password_hash, phone_e164, phone_verified_at, full_name)
       VALUES ($1, $2, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, 'آزمون')`,
      [id, overrides.email ?? null, overrides.passwordHash ?? null, overrides.phone ?? null],
    ),
  );
  return id;
}

beforeAll(async () => {
  databaseName = `pos_identity_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  // The national-ID service refuses to write without a key; give this test a
  // throwaway 32-byte key rather than borrowing a deployment's.
  process.env.POS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  delete (globalThis as { pgPool?: unknown }).pgPool;

  db = await import("../src/lib/db");
  credentials = await import("../src/lib/iam/identity-credentials");
  profile = await import("../src/lib/iam/identity-profile");
}, 180_000);

afterAll(async () => {
  await db?.getPool().end().catch(() => {});
  delete (globalThis as { pgPool?: unknown }).pgPool;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
  delete process.env.POS_MASTER_KEY;
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("identity shapes", () => {
  it("accepts a phone-only, passwordless identity and refuses a channel-less one", async () => {
    const phoneOnly = await insertIdentity({ phone: "+989121112233" });
    const { rows } = await db.withoutTenantScope("platform", () =>
      db.query<{ email: string | null; password_hash: string | null }>(
        "SELECT email::text AS email, password_hash FROM platform_users WHERE id = $1",
        [phoneOnly],
      ),
    );
    expect(rows[0]).toEqual({ email: null, password_hash: null });

    await expect(
      db.withoutTenantScope("platform", () =>
        db.query(
          `INSERT INTO platform_users (full_name) VALUES ('بدون کانال')`,
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("email verification", () => {
  it("issues one live token, spends it once and audits both ends", async () => {
    const identityId = await insertIdentity({ email: `a-${randomUUID()}@example.com`, passwordHash: "hash" });

    const issued = await credentials.issueEmailVerification({ platformUserId: identityId });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const consumed = await credentials.consumeEmailVerification(issued.token);
    expect(consumed).toEqual({ ok: true, platformUserId: identityId, email: issued.email });

    const again = await credentials.consumeEmailVerification(issued.token);
    expect(again).toEqual({ ok: false, error: "invalid_token" });

    expect(await credentials.hasVerifiedEmail(identityId)).toBe(true);

    const { rows: events } = await db.withoutTenantScope("platform", () =>
      db.query<{ action: string }>(
        "SELECT action FROM platform_identity_events WHERE platform_user_id = $1 ORDER BY id",
        [identityId],
      ),
    );
    expect(events.map((event) => event.action)).toEqual([
      "email_verification_issued",
      "email_verified",
    ]);
  });

  it("invalidates an older link when a new one is issued", async () => {
    const identityId = await insertIdentity({ email: `b-${randomUUID()}@example.com`, passwordHash: "hash" });
    const first = await credentials.issueEmailVerification({ platformUserId: identityId });
    const second = await credentials.issueEmailVerification({ platformUserId: identityId });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(await credentials.consumeEmailVerification(first.token)).toEqual({
      ok: false,
      error: "invalid_token",
    });
    expect((await credentials.consumeEmailVerification(second.token)).ok).toBe(true);
  });

  it("clears an existing verification when the address changes", async () => {
    const identityId = await insertIdentity({ email: `d-${randomUUID()}@example.com`, passwordHash: "hash" });
    const first = await credentials.issueEmailVerification({ platformUserId: identityId });
    if (!first.ok) throw new Error("issue failed");
    expect((await credentials.consumeEmailVerification(first.token)).ok).toBe(true);
    expect(await credentials.hasVerifiedEmail(identityId)).toBe(true);

    // A fresh live link, then the address changes. The writer below stands in
    // for both real writers (owner profile, cloud replication); the invariant
    // is enforced in the database so neither has to remember it.
    const live = await credentials.issueEmailVerification({ platformUserId: identityId });
    if (!live.ok) throw new Error("issue failed");

    await db.withoutTenantScope("platform", () =>
      db.query("UPDATE platform_users SET email = $2 WHERE id = $1", [
        identityId,
        `moved-${randomUUID()}@example.com`,
      ]),
    );

    expect(await credentials.hasVerifiedEmail(identityId)).toBe(false);

    const { rows } = await db.withoutTenantScope("platform", () =>
      db.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM platform_email_verifications WHERE platform_user_id = $1",
        [identityId],
      ),
    );
    expect(rows.every((row) => row.consumed_at !== null)).toBe(true);
  });

  it("does not verify a link whose address changed after issue", async () => {
    const identityId = await insertIdentity({ email: `c-${randomUUID()}@example.com`, passwordHash: "hash" });
    const issued = await credentials.issueEmailVerification({ platformUserId: identityId });
    if (!issued.ok) throw new Error("issue failed");

    await db.withoutTenantScope("platform", () =>
      db.query("UPDATE platform_users SET email = $2 WHERE id = $1", [
        identityId,
        `moved-${randomUUID()}@example.com`,
      ]),
    );

    expect(await credentials.consumeEmailVerification(issued.token)).toEqual({
      ok: false,
      error: "email_changed",
    });
    expect(await credentials.hasVerifiedEmail(identityId)).toBe(false);
  });
});

describe("national ID", () => {
  it("stores ciphertext, reads it back for the person and audits the read", async () => {
    const identityId = await insertIdentity({ email: `n-${randomUUID()}@example.com`, passwordHash: "hash" });

    expect(
      await profile.setNationalId({
        platformUserId: identityId,
        nationalId: "0012345679",
        actorPlatformUserId: identityId,
      }),
    ).toEqual({ ok: true });

    const stored = await db.withoutTenantScope("platform", () =>
      db.query<{ ciphertext: string | null }>(
        "SELECT national_id_ciphertext AS ciphertext FROM platform_users WHERE id = $1",
        [identityId],
      ),
    );
    expect(stored.rows[0].ciphertext).toMatch(/^v1\./);
    expect(stored.rows[0].ciphertext).not.toContain("0012345679");

    expect(await profile.hasNationalId(identityId)).toBe(true);
    expect(
      await profile.readNationalId({ platformUserId: identityId, actorPlatformUserId: identityId }),
    ).toEqual({ ok: true, nationalId: "0012345679" });

    const { rows: events } = await db.withoutTenantScope("platform", () =>
      db.query<{ action: string }>(
        "SELECT action FROM platform_identity_events WHERE platform_user_id = $1 ORDER BY id",
        [identityId],
      ),
    );
    expect(events.map((event) => event.action)).toEqual(["national_id_set", "national_id_read"]);
  });

  it("refuses another person, a duplicate number and an invalid number", async () => {
    const owner = await insertIdentity({ email: `o-${randomUUID()}@example.com`, passwordHash: "hash" });
    const other = await insertIdentity({ email: `p-${randomUUID()}@example.com`, passwordHash: "hash" });

    expect(
      await profile.setNationalId({
        platformUserId: owner,
        nationalId: "1234567891",
        actorPlatformUserId: other,
      }),
    ).toEqual({ ok: false, error: "forbidden" });

    expect(
      await profile.readNationalId({ platformUserId: owner, actorPlatformUserId: other }),
    ).toEqual({ ok: false, error: "forbidden" });

    expect(
      await profile.setNationalId({
        platformUserId: owner,
        nationalId: "1234567891",
        actorPlatformUserId: owner,
      }),
    ).toEqual({ ok: true });

    expect(
      await profile.setNationalId({
        platformUserId: other,
        nationalId: "1234567891",
        actorPlatformUserId: other,
      }),
    ).toEqual({ ok: false, error: "national_id_taken" });

    expect(
      await profile.setNationalId({
        platformUserId: other,
        nationalId: "12345",
        actorPlatformUserId: other,
      }),
    ).toEqual({ ok: false, error: "invalid_national_id" });
  });

  it("lets an active platform admin read it and records which admin read it", async () => {
    const identityId = await insertIdentity({ email: `r-${randomUUID()}@example.com`, passwordHash: "hash" });
    await profile.setNationalId({
      platformUserId: identityId,
      nationalId: "0084575948",
      actorPlatformUserId: identityId,
    });

    const { rows: admins } = await db.withoutTenantScope("platform", () =>
      db.query<{ id: string }>(
        `INSERT INTO platform_admins (email, password_hash, full_name, role)
         VALUES ($1, 'x', 'پشتیبانی', 'support') RETURNING id`,
        [`admin-${randomUUID()}@example.com`],
      ),
    );
    const adminId = admins[0].id;

    expect(
      await profile.readNationalId({
        platformUserId: identityId,
        actorPlatformAdminId: adminId,
        actorBusinessId: null,
      }),
    ).toEqual({ ok: true, nationalId: "0084575948" });

    const { rows: events } = await db.withoutTenantScope("platform", () =>
      db.query<{
        action: string;
        actor_platform_user_id: string | null;
        actor_platform_admin_id: string | null;
      }>(
        `SELECT action, actor_platform_user_id, actor_platform_admin_id
           FROM platform_identity_events
          WHERE platform_user_id = $1 AND action = 'national_id_read'
          ORDER BY id DESC LIMIT 1`,
        [identityId],
      ),
    );
    // The subject is the identity; the actor is the admin — never conflated.
    expect(events[0]).toEqual({
      action: "national_id_read",
      actor_platform_user_id: null,
      actor_platform_admin_id: adminId,
    });
  });

  it("clears both the ciphertext and the blind index", async () => {
    const identityId = await insertIdentity({ email: `q-${randomUUID()}@example.com`, passwordHash: "hash" });
    await profile.setNationalId({
      platformUserId: identityId,
      nationalId: "0084575948",
      actorPlatformUserId: identityId,
    });
    expect(
      await profile.clearNationalId({ platformUserId: identityId, actorPlatformUserId: identityId }),
    ).toEqual({ ok: true });
    expect(await profile.hasNationalId(identityId)).toBe(false);
    expect(
      await profile.readNationalId({ platformUserId: identityId, actorPlatformUserId: identityId }),
    ).toEqual({ ok: true, nationalId: null });
  });

  it("enforces FORCE RLS and append-only audit on 0303 identity tables, while allowing tenant-scoped readNationalId and FK cascades", async () => {
    const identityId = await insertIdentity({
      email: `rls-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const { rows: bizRows } = await db.withoutTenantScope("platform", () =>
      db.query<{ id: string }>(
        `INSERT INTO businesses (name, slug) VALUES ('کافه امنیت', $1) RETURNING id`,
        [`sec-${randomUUID().slice(0, 8)}`],
      ),
    );
    const businessId = bizRows[0].id;

    expect(
      await profile.setNationalId({
        platformUserId: identityId,
        nationalId: "0499370899",
        actorPlatformUserId: identityId,
        actorBusinessId: businessId,
      }),
    ).toEqual({ ok: true });

    // Called from inside a tenant-scoped request, readNationalId still succeeds
    // and writes its audit row inside withoutTenantScopeTransaction("identity").
    await expect(
      db.withTenant(businessId, () =>
        profile.readNationalId({
          platformUserId: identityId,
          actorPlatformUserId: identityId,
          actorBusinessId: businessId,
        }),
      ),
    ).resolves.toEqual({ ok: true, nationalId: "0499370899" });

    // Verify RLS flags on both 0303 tables in pg_class.
    const { rows: rlsFlags } = await db.withoutTenantScope("platform", () =>
      db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relname IN ('platform_email_verifications', 'platform_identity_events')
          ORDER BY relname`,
      ),
    );
    expect(rlsFlags).toEqual([
      {
        relname: "platform_email_verifications",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "platform_identity_events",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);

    // Append-only trigger blocks UPDATE and direct DELETE even with bypass on.
    await expect(
      db.withoutTenantScope("platform", () =>
        db.query(
          `UPDATE platform_identity_events SET action = 'national_id_cleared' WHERE platform_user_id = $1`,
          [identityId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      db.withoutTenantScope("platform", () =>
        db.query(
          `DELETE FROM platform_identity_events WHERE platform_user_id = $1`,
          [identityId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // Deleting the referenced business permits FK ON DELETE SET NULL on actor_business_id.
    await expect(
      db.withoutTenantScope("platform", () =>
        db.query(`DELETE FROM businesses WHERE id = $1`, [businessId]),
      ),
    ).resolves.toBeTruthy();

    // Deleting the parent identity permits FK ON DELETE CASCADE.
    await expect(
      db.withoutTenantScope("platform", () =>
        db.query(`DELETE FROM platform_users WHERE id = $1`, [identityId]),
      ),
    ).resolves.toBeTruthy();
  });

  it("refuses clearing email on an email-only identity instead of throwing 23514", async () => {
    const emailOnlyId = await insertIdentity({
      email: `only-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    expect(
      await credentials.setIdentityEmail({
        platformUserId: emailOnlyId,
        actorPlatformUserId: emailOnlyId,
        email: null,
      }),
    ).toEqual({ ok: false, error: "credential_channel_required" });
  });
});
