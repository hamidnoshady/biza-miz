/**
 * ESH-199 / #1384 — production-like migration rehearsal.
 *
 * The migration that introduced the global verified phone (0302) ships a
 * backfill. This test seeds the shapes real installs already hold *before*
 * that migration runs, then applies the migrations in the same order a deploy
 * would:
 *
 *   1. everything before 0302,
 *   2. through 0305 — the original, flawed backfill and credential rules,
 *   3. 0306/0307 — the forward repair and the corrected national-ID pair rule.
 *
 * It asserts the repaired end state, that a legacy password membership can
 * still sign in, and that one-sided national-ID rows written before the repair
 * are cleared while a valid pair survives.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  purchaseReadinessForAssurance,
  readIdentityAssurance,
  type IdentityAssuranceRow,
} from "../src/lib/identity-billing-contract";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const migrationsDirectory = join(process.cwd(), "migrations");
const IDENTITY_PHONE_MIGRATION = "0302_global_identity_phone.sql";
const PHONE_REPAIR_MIGRATION = "0306_identity_phone_backfill_repair.sql";

let databaseName: string;
let db: Client;
let migrationsDir: string;
let previousRootDomain: string | undefined;
let phoneSequence = 0;

type SeededPerson = {
  platformUserId: string;
  email: string;
  password: string;
  businessIds: string[];
};

const personA: SeededPerson = { platformUserId: "", email: "", password: "", businessIds: [] };
const personB: SeededPerson = { platformUserId: "", email: "", password: "", businessIds: [] };
const personG: SeededPerson = { platformUserId: "", email: "", password: "", businessIds: [] };
let personCPlatformUserId = "";
let personDPlatformUserId = "";
let personEPlatformUserId = "";

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

function allMigrations(): string[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

async function copyThrough(cutoffExclusive: string): Promise<void> {
  for (const name of allMigrations().filter((file) => file < cutoffExclusive)) {
    await copyFile(join(migrationsDirectory, name), join(migrationsDir, name));
  }
}

async function copyFromTo(fromInclusive: string, toExclusive: string): Promise<void> {
  for (const name of allMigrations().filter(
    (file) => file >= fromInclusive && file < toExclusive,
  )) {
    await copyFile(join(migrationsDirectory, name), join(migrationsDir, name));
  }
}

async function insertPlatformUser(email: string, password: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO platform_users (id, email, password_hash, full_name)
     VALUES ($1, $2, $3, 'آزمون')`,
    [id, email, await bcrypt.hash(password, 4)],
  );
  return id;
}

async function insertBusiness(name: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO businesses (id, name, slug) VALUES ($1, $2, $3)`,
    [id, name, `biz-${id.slice(0, 8)}`],
  );
  return id;
}

async function insertMembership(input: {
  businessId: string;
  platformUserId: string;
  email: string;
  phone: string;
  verifiedAt: Date | null;
  role?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users
       (id, business_id, role, full_name, email, platform_user_id, phone_e164, phone_verified_at)
     VALUES ($1, $2, $3, 'آزمون', $4, $5, $6, $7)`,
    [
      id,
      input.businessId,
      input.role ?? "manager",
      input.email,
      input.platformUserId,
      input.phone,
      input.verifiedAt,
    ],
  );
  return id;
}

async function seedPerson(input: {
  phoneCount: number;
  verified: boolean;
}): Promise<SeededPerson> {
  const email = `owner-${randomUUID()}@example.com`;
  const person: SeededPerson = {
    platformUserId: await insertPlatformUser(email, "correct-horse"),
    email,
    password: "correct-horse",
    businessIds: [],
  };

  for (let index = 0; index < input.phoneCount; index += 1) {
    const businessId = await insertBusiness(`کسب‌وکار ${randomUUID().slice(0, 8)}`);
    person.businessIds.push(businessId);
    // A distinct number per membership seed; the shared cases below overwrite
    // these deliberately.
    phoneSequence += 1;
    await insertMembership({
      businessId,
      platformUserId: person.platformUserId,
      email,
      phone: `+98912${String(1_000_000 + phoneSequence).padStart(7, "0")}`,
      verifiedAt: input.verified ? new Date("2026-01-01T00:00:00Z") : null,
    });
  }
  return person;
}

beforeAll(async () => {
  previousRootDomain = process.env.ROOT_DOMAIN;
  delete process.env.ROOT_DOMAIN;

  databaseName = `pos_identity_rehearsal_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  process.env.DATABASE_URL = urlFor(databaseName);

  migrationsDir = await mkdtemp(join(tmpdir(), "pos-identity-rehearsal-"));
  await copyThrough(IDENTITY_PHONE_MIGRATION);
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir, quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // A: one verified number — the ordinary, safely backfillable person.
  Object.assign(personA, await seedPerson({ phoneCount: 1, verified: true }));

  // B: two verified numbers on two memberships — the ambiguity 0302 misses.
  Object.assign(personB, await seedPerson({ phoneCount: 2, verified: true }));

  // C and D: the same verified number on two different identities. 0302
  // excludes it; the existing conflict view must report it.
  const shared = await seedPerson({ phoneCount: 1, verified: true });
  personCPlatformUserId = shared.platformUserId;
  const sharedNumber = "+989121119999";
  await db.query(
    `UPDATE users SET phone_e164 = $1 WHERE platform_user_id = $2`,
    [sharedNumber, personCPlatformUserId],
  );

  const dIdentity = await insertPlatformUser(`owner-${randomUUID()}@example.com`, "correct-horse");
  personDPlatformUserId = dIdentity;
  const dBusiness = await insertBusiness("کسب‌وکار د");
  await insertMembership({
    businessId: dBusiness,
    platformUserId: dIdentity,
    email: `owner-${randomUUID()}@example.com`,
    phone: sharedNumber,
    verifiedAt: new Date("2026-01-01T00:00:00Z"),
  });

  // E: a pending (unverified) membership phone. It must not be backfilled.
  const e = await seedPerson({ phoneCount: 1, verified: false });
  personEPlatformUserId = e.platformUserId;

  // G: the same number proved on two memberships of one person — still one
  // fact, so it remains safely backfillable.
  Object.assign(personG, await seedPerson({ phoneCount: 2, verified: true }));
  await db.query(
    `UPDATE users SET phone_e164 = $1 WHERE platform_user_id = $2`,
    ["+989121118888", personG.platformUserId],
  );

  // The flawed backfill plus the credential/national-ID schema.
  await copyFromTo(IDENTITY_PHONE_MIGRATION, PHONE_REPAIR_MIGRATION);
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir, quiet: true });
}, 240_000);

afterAll(async () => {
  if (previousRootDomain === undefined) delete process.env.ROOT_DOMAIN;
  else process.env.ROOT_DOMAIN = previousRootDomain;

  await db?.end().catch(() => {});
  const globalForPg = globalThis as unknown as { pgPool?: Pool };
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;

  if (migrationsDir) await rm(migrationsDir, { recursive: true, force: true });
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("verified-phone backfill before the repair", () => {
  it("shows the ambiguity 0302 leaves behind", async () => {
    const { rows } = await db.query<{
      phone_e164: string | null;
      phone_verified_at: Date | null;
    }>(
      `SELECT phone_e164, phone_verified_at FROM platform_users WHERE id = $1`,
      [personB.platformUserId],
    );
    // 0302 picked one of B's two numbers arbitrarily. The repair below must
    // not keep it.
    expect(rows[0].phone_e164).not.toBeNull();

    const conflicts = await db.query<{ phone_e164: string; identity_count: number }>(
      `SELECT phone_e164, identity_count FROM v_platform_verified_phone_conflicts`,
    );
    expect(conflicts.rows).toEqual([
      { phone_e164: "+989121119999", identity_count: 2 },
    ]);
  });
});

describe("forward repair and the commercial boundary", () => {
  beforeAll(async () => {
    // Rows that the old, NULL-tolerant national-ID CHECK accepted. They are
    // written before 0307 runs, exactly as they would exist in an install that
    // already applied 0303.
    await db.query(
      `UPDATE platform_users SET national_id_ciphertext = 'v1.aaaa.bbbb.cccc' WHERE id = $1`,
      [personA.platformUserId],
    );
    await db.query(
      `UPDATE platform_users SET national_id_bidx = repeat('a', 64) WHERE id = $1`,
      [personCPlatformUserId],
    );
    await db.query(
      `UPDATE platform_users
          SET national_id_ciphertext = 'v1.dddd.eeee.ffff', national_id_bidx = repeat('b', 64)
        WHERE id = $1`,
      [personDPlatformUserId],
    );

    await copyFromTo(PHONE_REPAIR_MIGRATION, "9999_never.sql");
    await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir, quiet: true });
  }, 120_000);

  it("keeps the unambiguous backfill and clears the arbitrary one", async () => {
    const { rows } = await db.query<{
      id: string;
      phone_e164: string | null;
      phone_verified_at: Date | null;
    }>(
      `SELECT id, phone_e164, phone_verified_at FROM platform_users
        WHERE id = ANY($1::uuid[])`,
      [[personA.platformUserId, personB.platformUserId, personG.platformUserId, personEPlatformUserId]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(personA.platformUserId)?.phone_e164).toBe("+989121000001");
    expect(byId.get(personA.platformUserId)?.phone_verified_at).not.toBeNull();

    // The ambiguity is not guessed: no global number is better than a wrong one.
    expect(byId.get(personB.platformUserId)?.phone_e164).toBeNull();
    expect(byId.get(personB.platformUserId)?.phone_verified_at).toBeNull();

    // Two memberships, one number, still one fact.
    expect(byId.get(personG.platformUserId)?.phone_e164).toBe("+989121118888");

    // A pending legacy number is not a verification.
    expect(byId.get(personEPlatformUserId)?.phone_e164).toBeNull();
  });

  it("reports both ambiguity shapes and audits the repair", async () => {
    const identityConflicts = await db.query<{
      platform_user_id: string;
      number_count: number;
    }>(
      `SELECT platform_user_id, number_count
         FROM v_platform_verified_phone_identity_conflicts`,
    );
    expect(identityConflicts.rows).toEqual([
      { platform_user_id: personB.platformUserId, number_count: 2 },
    ]);

    const numberConflicts = await db.query<{ phone_e164: string; identity_count: number }>(
      `SELECT phone_e164, identity_count FROM v_platform_verified_phone_conflicts`,
    );
    expect(numberConflicts.rows).toEqual([
      { phone_e164: "+989121119999", identity_count: 2 },
    ]);

    const { rows: events } = await db.query<{ action: string }>(
      `SELECT action FROM platform_identity_events
        WHERE platform_user_id = $1 ORDER BY id`,
      [personB.platformUserId],
    );
    expect(events.map((event) => event.action)).toEqual(["phone_backfill_cleared"]);
  });

  it("clears one-sided national-ID rows and keeps a complete pair", async () => {
    const { rows } = await db.query<{
      id: string;
      ciphertext: string | null;
      bidx: string | null;
    }>(
      `SELECT id, national_id_ciphertext AS ciphertext, national_id_bidx AS bidx
         FROM platform_users WHERE id = ANY($1::uuid[])`,
      [[personA.platformUserId, personCPlatformUserId, personDPlatformUserId]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(personA.platformUserId)).toEqual({
      id: personA.platformUserId,
      ciphertext: null,
      bidx: null,
    });
    expect(byId.get(personCPlatformUserId)).toEqual({
      id: personCPlatformUserId,
      ciphertext: null,
      bidx: null,
    });
    expect(byId.get(personDPlatformUserId)).toEqual({
      id: personDPlatformUserId,
      ciphertext: "v1.dddd.eeee.ffff",
      bidx: "b".repeat(64),
    });

    const { rows: repaired } = await db.query<{ platform_user_id: string; action: string }>(
      `SELECT platform_user_id, action FROM platform_identity_events
        WHERE action = 'national_id_pair_cleared' ORDER BY platform_user_id`,
    );
    expect(new Set(repaired.map((row) => row.platform_user_id))).toEqual(
      new Set([personA.platformUserId, personCPlatformUserId]),
    );
  });

  it("rejects either one-sided national ID from now on", async () => {
    const identityId = await insertPlatformUser(`pair-${randomUUID()}@example.com`, "hash");

    await expect(
      db.query(
        `UPDATE platform_users SET national_id_ciphertext = 'v1.aaaa.bbbb.cccc' WHERE id = $1`,
        [identityId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      db.query(
        `UPDATE platform_users SET national_id_bidx = repeat('c', 64) WHERE id = $1`,
        [identityId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      db.query(
        `UPDATE platform_users
            SET national_id_ciphertext = 'v1.aaaa.bbbb.cccc', national_id_bidx = repeat('c', 64)
          WHERE id = $1`,
        [identityId],
      ),
    ).resolves.toBeTruthy();
  });

  it("keeps the legacy password door and every membership intact", async () => {
    // The global number was cleared for B; that must not touch the membership
    // phones or the account's ability to sign in.
    const memberships = await db.query<{ phone_e164: string; phone_verified_at: Date | null }>(
      `SELECT phone_e164, phone_verified_at FROM users
        WHERE platform_user_id = $1 ORDER BY phone_e164`,
      [personA.platformUserId],
    );
    expect(memberships.rows).toEqual([
      { phone_e164: "+989121000001", phone_verified_at: new Date("2026-01-01T00:00:00Z") },
    ]);

    const loginRoute = await import("../src/app/api/auth/login/route");
    const response = await loginRoute.POST(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: personA.email, password: personA.password }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      business?: { id: string };
      user?: { id: string };
    };
    expect(body.business?.id).toBe(personA.businessIds[0]);
    expect(body.user?.id).toBeTruthy();
  }, 60_000);

  it("supports a pending phone-only identity during onboarding but not a purchase", async () => {
    const identityId = randomUUID();
    await db.query(
      `INSERT INTO platform_users (id, email, password_hash, phone_e164, phone_verified_at, full_name)
       VALUES ($1, NULL, NULL, $2, NULL, 'در حال ثبت‌نام')`,
      [identityId, "+989121117777"],
    );

    const { rows } = await db.query<IdentityAssuranceRow>(
      `SELECT phone_e164, phone_verified_at, email, email_verified_at
         FROM platform_users WHERE id = $1`,
      [identityId],
    );
    expect(readIdentityAssurance(rows[0]).phone).toEqual({
      e164: "+989121117777",
      verified: false,
    });
    expect(purchaseReadinessForAssurance(readIdentityAssurance(rows[0]))).toMatchObject({
      ok: false,
      blockedBy: ["phone_not_verified"],
    });
  });

  it("is a no-op when the migration runner runs again", async () => {
    await expect(
      runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir, quiet: true }),
    ).resolves.toEqual({
      applied: 0,
      adoptedChecksums: 0,
      repairedChecksums: [],
      deferredMigrations: [],
    });
  });
});
