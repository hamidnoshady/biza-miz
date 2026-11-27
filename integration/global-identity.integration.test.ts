/**
 * ESH-199 / #1384 — the global verified phone against a real database.
 *
 * The acceptance criterion this file exists for is "verified phone uniqueness
 * holds under concurrent signup attempts". A read-then-write check passes a
 * single-threaded test and fails in production, so this test fires both claims
 * at once and requires the partial unique index (not the service's control
 * flow) to pick exactly one winner.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: typeof import("../src/lib/db");
let identity: typeof import("../src/lib/iam/global-identity-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const personA = { platformUserId: "", businessId: "" };
const personB = { platformUserId: "", businessId: "" };

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
  db = await import("../src/lib/db");
  identity = await import("../src/lib/iam/global-identity-service");
  provisioning = await import("../src/lib/business-provisioning");

  // Two distinct people, so nothing here depends on one being a member of the
  // other's business — the phone is global, the businesses are not shared.
  const first = await provisioning.provisionBusiness({
    businessName: "کافهٔ الف",
    ownerName: "الف",
    email: `a-${randomUUID()}@example.com`,
    password: "password-a",
    seedChartOfAccounts: false,
  });
  const second = await provisioning.provisionBusiness({
    businessName: "کافهٔ ب",
    ownerName: "ب",
    email: `b-${randomUUID()}@example.com`,
    password: "password-b",
    seedChartOfAccounts: false,
  });
  personA.platformUserId = first.platformUserId!;
  personA.businessId = first.businessId;
  personB.platformUserId = second.platformUserId!;
  personB.businessId = second.businessId;

  expect(personA.platformUserId).not.toBe(personB.platformUserId);
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
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("global verified phone", () => {
  it("lets exactly one of two simultaneous claims of one number win", async () => {
    const phone = "+989121110001";
    const [a, b] = await Promise.all([
      identity.claimVerifiedPhone({ platformUserId: personA.platformUserId, phone }),
      identity.claimVerifiedPhone({ platformUserId: personB.platformUserId, phone }),
    ]);

    const results = [a, b];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const loser = results.find((result) => !result.ok);
    expect(loser).toEqual({ ok: false, error: "phone_taken" });

    // The index — not the losing caller's luck — is the authority: the winner
    // owns the number and the other identity has no phone at all.
    const availability = await Promise.all(
      [personA.platformUserId, personB.platformUserId].map((id) =>
        identity.readPlatformIdentityAssurance(id),
      ),
    );
    const owners = availability.filter((assurance) => assurance?.phone.e164 === phone);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.phone.verified).toBe(true);
  });

  it("keeps refusing the number after the race, on a later attempt too", async () => {
    const phone = "+989121110001";
    const owner =
      (await identity.readPlatformIdentityAssurance(personA.platformUserId))?.phone.e164 === phone
        ? personA
        : personB;
    const other = owner === personA ? personB : personA;

    expect(
      await identity.claimVerifiedPhone({ platformUserId: owner.platformUserId, phone }),
    ).toEqual({ ok: true, phoneE164: phone });
    expect(
      await identity.claimVerifiedPhone({ platformUserId: other.platformUserId, phone }),
    ).toEqual({ ok: false, error: "phone_taken" });
  });

  it("clears the stamp with the number, so a change never inherits proof", async () => {
    const before = await identity.readPlatformIdentityAssurance(personA.platformUserId);
    expect(before?.phone.verified).toBe(true);

    await identity.clearVerifiedPhone(personA.platformUserId);
    const cleared = await identity.readPlatformIdentityAssurance(personA.platformUserId);
    expect(cleared).toEqual({
      phone: { e164: null, verified: false },
      email: { address: expect.any(String), verified: false },
    });

    // Freed by the clear, and claimable by the other identity now.
    const reclaimed = await identity.claimVerifiedPhone({
      platformUserId: personB.platformUserId,
      phone: "+989121110001",
    });
    expect(reclaimed).toEqual({ ok: true, phoneE164: "+989121110001" });

    // Put A back on its own (different) number so later assertions are stable.
    expect(
      await identity.claimVerifiedPhone({
        platformUserId: personA.platformUserId,
        phone: "+989121110002",
      }),
    ).toEqual({ ok: true, phoneE164: "+989121110002" });
  });

  it("stores the canonical form whatever the door typed", async () => {
    await identity.clearVerifiedPhone(personA.platformUserId);
    const claimed = await identity.claimVerifiedPhone({
      platformUserId: personA.platformUserId,
      phone: "۰۹۱۲ ۱۱۱ ۰۰۰۳",
    });
    expect(claimed).toEqual({ ok: true, phoneE164: "+989121110003" });
    const assurance = await identity.readPlatformIdentityAssurance(personA.platformUserId);
    expect(assurance?.phone).toEqual({ e164: "+989121110003", verified: true });
  });

  it("refuses a landline and junk without touching the row", async () => {
    const before = await identity.readPlatformIdentityAssurance(personA.platformUserId);
    expect(
      await identity.claimVerifiedPhone({
        platformUserId: personA.platformUserId,
        phone: "02112345678",
      }),
    ).toEqual({ ok: false, error: "not_mobile" });
    expect(
      await identity.claimVerifiedPhone({
        platformUserId: personA.platformUserId,
        phone: "not a number",
      }),
    ).toEqual({ ok: false, error: "invalid_phone" });
    expect(await identity.readPlatformIdentityAssurance(personA.platformUserId)).toEqual(before);
  });

  it("mirrors a door-verified membership phone onto the global identity", async () => {
    // The wiring, not just the service: every OTP door stamps the membership
    // first, and that proof has to reach the person the purchase rule reads.
    const { stampPhoneVerified } = await import("../src/lib/phone-otp");
    const { rows } = await db.withTenant(personA.businessId, () =>
      db.query<{ id: string }>(
        `SELECT id FROM users WHERE platform_user_id = $1 AND business_id = $2`,
        [personA.platformUserId, personA.businessId],
      ),
    );
    const membershipId = rows[0]?.id;
    expect(membershipId).toBeTruthy();

    // The person has no global number yet: this is the *first* proof.
    await identity.clearVerifiedPhone(personA.platformUserId);
    await stampPhoneVerified({
      businessId: personA.businessId,
      userId: membershipId!,
      phone: "+989121110005",
    });

    const assurance = await identity.readPlatformIdentityAssurance(personA.platformUserId);
    expect(assurance?.phone).toEqual({ e164: "+989121110005", verified: true });
  });

  it("refuses to let a second business rotate the person's verified number", async () => {
    // A membership in a *different* business, belonging to the same global
    // person. An admin there can set and prove a phone of their choosing; if
    // that overwrote the identity, the employer would own the person's
    // password-reset channel.
    const membershipId = randomUUID();
    await db.withTenant(personB.businessId, () =>
      db.query(
        `INSERT INTO users (id, business_id, role, full_name, email, platform_user_id)
         VALUES ($1, $2, 'manager', 'الف', $3, $4)`,
        [
          membershipId,
          personB.businessId,
          `a-at-b-${randomUUID()}@example.com`,
          personA.platformUserId,
        ],
      ),
    );

    const before = await identity.readPlatformIdentityAssurance(personA.platformUserId);
    expect(before?.phone).toEqual({ e164: "+989121110005", verified: true });

    // Direct service call: the write-once rule, not the door's choice.
    expect(
      await identity.claimVerifiedPhone({
        platformUserId: personA.platformUserId,
        phone: "+989121110006",
      }),
    ).toEqual({ ok: false, error: "identity_phone_locked" });

    // Through the door, the refusal must be visible in the log and must not
    // change the identity — but the membership keeps its own proven phone.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warnCalls: unknown[][] = [];
    try {
      const { stampPhoneVerified } = await import("../src/lib/phone-otp");
      await stampPhoneVerified({
        businessId: personB.businessId,
        userId: membershipId,
        phone: "+989121110006",
      });
    } finally {
      // mockRestore() also clears the recorded calls, so capture first.
      warnCalls = [...warn.mock.calls];
      warn.mockRestore();
    }
    expect(
      warnCalls.some(
        (call) =>
          (call[1] as { reason?: string } | undefined)?.reason === "identity_phone_locked",
      ),
    ).toBe(true);
    expect(await identity.readPlatformIdentityAssurance(personA.platformUserId)).toEqual(before);

    const membershipPhone = await db.withTenant(personB.businessId, () =>
      db.query<{ phone_e164: string | null; phone_verified_at: Date | null }>(
        `SELECT phone_e164, phone_verified_at FROM users WHERE id = $1`,
        [membershipId],
      ),
    );
    expect(membershipPhone.rows[0]).toEqual({
      phone_e164: "+989121110006",
      phone_verified_at: expect.any(Date),
    });
  });

  it("renews the same number from a second business instead of refusing it", async () => {
    const { rows } = await db.withTenant(personB.businessId, () =>
      db.query<{ id: string }>(
        `SELECT id FROM users WHERE platform_user_id = $1 AND business_id = $2`,
        [personA.platformUserId, personB.businessId],
      ),
    );
    const membershipId = rows[0]?.id;
    expect(membershipId).toBeTruthy();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warnCalls: unknown[][] = [];
    try {
      const { stampPhoneVerified } = await import("../src/lib/phone-otp");
      await stampPhoneVerified({
        businessId: personB.businessId,
        userId: membershipId!,
        phone: "+989121110005",
      });
    } finally {
      warnCalls = [...warn.mock.calls];
      warn.mockRestore();
    }

    expect(
      warnCalls.some(
        (call) =>
          (call[1] as { reason?: string } | undefined)?.reason === "identity_phone_locked",
      ),
    ).toBe(false);
    expect((await identity.readPlatformIdentityAssurance(personA.platformUserId))?.phone).toEqual({
      e164: "+989121110005",
      verified: true,
    });
  });

  it("returns null for an identity that does not exist", async () => {
    expect(
      await identity.readPlatformIdentityAssurance("00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
    expect(
      await identity.claimVerifiedPhone({
        platformUserId: "00000000-0000-0000-0000-000000000000",
        phone: "+989121110009",
      }),
    ).toEqual({ ok: false, error: "identity_missing" });
  });

  it("reports no cross-identity conflicts for numbers this test created", async () => {
    const { rows } = await db.query<{ phone_e164: string }>(
      `SELECT phone_e164 FROM v_platform_verified_phone_conflicts`,
    );
    expect(rows).toEqual([]);
  });

  it("propagates verified phone status when creating a new business for a verified global identity (ESH-199)", async () => {
    const phoneIdentityId = randomUUID();
    const verifiedPhone = "+989129998877";
    await db.query(
      `INSERT INTO platform_users (id, email, password_hash, phone_e164, phone_verified_at, full_name, is_active)
       VALUES ($1, NULL, NULL, $2, now(), 'کارآفرین', true)`,
      [phoneIdentityId, verifiedPhone],
    );

    const provisioning = await import("../src/lib/business-provisioning");
    const selfCreds = await import("../src/lib/self-credentials");
    const dbLib = await import("../src/lib/db");

    const created = await provisioning.provisionBusiness({
      businessName: "فروشگاه دوم",
      ownerName: "کارآفرین",
      platformUserId: phoneIdentityId,
      seedChartOfAccounts: false,
    });

    const { rows: memberRows } = await db.query<{
      phone_e164: string | null;
      phone_verified_at: Date | null;
    }>(`SELECT phone_e164, phone_verified_at FROM users WHERE id = $1`, [created.userId]);
    expect(memberRows[0].phone_e164).toBe(verifiedPhone);
    expect(memberRows[0].phone_verified_at).not.toBeNull();

    const state = await dbLib.withTenant(created.businessId, () =>
      selfCreds.readSelfCredentialState(created.businessId, created.userId),
    );
    expect(state?.hasVerifiedPhone).toBe(true);
    expect(state?.hasPassword).toBe(false);
  });
});
