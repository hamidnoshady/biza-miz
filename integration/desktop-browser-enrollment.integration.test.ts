/**
 * Issue #1115 §A.3 — browser-based Hybrid enrollment, end to end against a real
 * database.
 *
 * The protocol itself is unit-tested as a pure state machine; what this pins is
 * the half only a database can answer: that an approval really mints and seals
 * an ordinary pairing code, that the code only reaches the caller holding the
 * device secret, that redeeming it produces the same snapshot a typed code
 * does, and that denying, expiring or superseding a request revokes the sealed
 * code instead of leaving a redeemable credential behind.
 *
 * It runs as the database owner (as `pairing.integration.test.ts` does) because
 * the subject is the credential lifecycle, not row-level security — the tenant
 * boundary of these reads is exercised by
 * `desktop-enrollment-readiness.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { provisionBusiness } from "../src/lib/business-provisioning";
import { hashDeviceSecret, newDeviceSecret } from "../src/lib/desktop-enroll";
import {
  approveEnrollmentRequest,
  denyEnrollmentRequest,
  pollEnrollmentRequest,
  startEnrollmentRequest,
} from "../src/lib/desktop-enroll-service";
import { redeemPairingCode } from "../src/lib/pairing-service";
import { PAIRING_SNAPSHOT_VERSION } from "../src/lib/pairing-snapshot";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let ownerClient: Client;

let businessId: string;
let locationId: string;
let ownerUserId: string;

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

/** See pairing.integration.test.ts: db.ts caches its pool on globalThis. */
const globalForPg = globalThis as unknown as { pgPool?: Pool };

beforeAll(async () => {
  databaseName = `pos_enroll_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  ownerClient = new Client({ connectionString: process.env.DATABASE_URL });
  await ownerClient.connect();

  const created = await provisionBusiness({
    businessName: "کافه اتصال",
    ownerName: "حمید",
    email: `enroll-${randomUUID()}@example.com`,
    password: "correct-horse",
    seedChartOfAccounts: true,
  });
  businessId = created.businessId;
  locationId = created.locationId;
  ownerUserId = created.userId;

  // The readiness gate the approval runs reads persisted setup state, so the
  // business has to be genuinely finished — the same data the Cloud wizard
  // writes — before a browser approval may mint a code.
  await ownerClient.query(
    `INSERT INTO settings (business_id, location_id, key, value) VALUES
       ($1, NULL, 'business.prefs', '{"currencyDisplay":"toman","language":"fa","calendar":"jalali"}'),
       ($1, NULL, 'inventory.costing', '{"method":"fifo","system":"perpetual","lockedAt":null}'),
       ($1, NULL, 'tax.config', '{"defaultRate":9}')
     ON CONFLICT (business_id, location_id, key) DO NOTHING`,
    [businessId],
  );
  await ownerClient.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, 'setup.progress', $2)
     ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [businessId, JSON.stringify({ steps: {}, completedAt: "2026-10-01T08:00:00.000Z" })],
  );
  const { rows: categories } = await ownerClient.query<{ id: string }>(
    `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی گرم') RETURNING id`,
    [locationId],
  );
  await ownerClient.query(
    `INSERT INTO menu_items (location_id, category_id, name, price, is_active)
     VALUES ($1, $2, 'اسپرسو', 500000, true)`,
    [locationId, categories[0].id],
  );
}, 180_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  await ownerClient?.end();

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

/** The Windows app's half: a locally minted secret, only its hash registered. */
async function startEnrollment() {
  const deviceSecret = newDeviceSecret();
  const started = await startEnrollmentRequest({
    businessId,
    installationId: `desktop-${randomUUID()}`,
    deviceName: "Windows Bizamiz",
    deviceSecretHash: hashDeviceSecret(deviceSecret),
  });
  return { ...started, deviceSecret };
}

function approve(requestId: string) {
  return approveEnrollmentRequest({
    businessId,
    requestId,
    locationId,
    approvedBy: ownerUserId,
    issuedByPlatformUserId: null,
  });
}

function poll(requestId: string, deviceSecret: string) {
  return pollEnrollmentRequest({ requestId, deviceSecret });
}

function redeem(code: string) {
  return redeemPairingCode(code, "127.0.0.1", "Windows Bizamiz", `desktop-${randomUUID()}`, {
    maxSnapshotVersion: PAIRING_SNAPSHOT_VERSION,
  });
}

async function enrollmentRow(requestId: string): Promise<{
  state: string;
  location_id: string | null;
  pairing_code_ciphertext: string | null;
  pairing_code_id: string | null;
}> {
  const { rows } = await ownerClient.query<{
    state: string;
    location_id: string | null;
    pairing_code_ciphertext: string | null;
    pairing_code_id: string | null;
  }>(
    `SELECT state, location_id, pairing_code_ciphertext, pairing_code_id
       FROM desktop_enrollment_requests WHERE id = $1`,
    [requestId],
  );
  return rows[0];
}

/** The TTL passing, without waiting ten minutes. */
async function expire(requestId: string) {
  await ownerClient.query(
    `UPDATE desktop_enrollment_requests SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [requestId],
  );
}

describe("browser enrollment", () => {
  it("starts, approves in the browser, polls with the device secret, and redeems the sealed code", async () => {
    const started = await startEnrollment();
    expect(started.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.userCode).toMatch(/^[A-Z2-9]{8}$/);

    expect(await poll(started.requestId, started.deviceSecret)).toMatchObject({
      status: "pending",
      expiresAt: expect.any(String),
    });

    // The request id is not a credential: without the matching secret — and
    // for an id that never existed — the answer is the same non-answer.
    expect(await poll(started.requestId, newDeviceSecret())).toEqual({ status: "not_found" });
    expect(await poll(randomUUID(), started.deviceSecret)).toEqual({ status: "not_found" });
    // A wrong secret must not disturb the real request.
    expect(await poll(started.requestId, started.deviceSecret)).toMatchObject({ status: "pending" });

    expect(await approve(started.requestId)).toEqual({ ok: true });
    const approved = await poll(started.requestId, started.deviceSecret);
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") return;

    // Approval sealed an ordinary pairing code for the branch the owner chose.
    const sealed = await enrollmentRow(started.requestId);
    expect(sealed.state).toBe("approved");
    expect(sealed.location_id).toBe(locationId);
    expect(sealed.pairing_code_ciphertext).toEqual(expect.any(String));
    expect(sealed.pairing_code_ciphertext).not.toContain(approved.pairingCode);

    // The row names the one code it sealed, so revocation needs no decryption.
    const { rows: sealedCodes } = await ownerClient.query<{
      business_id: string;
      location_id: string;
      redeemed_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT business_id, location_id, redeemed_at, revoked_at
         FROM install_pairing_codes WHERE id = $1`,
      [sealed.pairing_code_id],
    );
    expect(sealedCodes[0]).toMatchObject({
      business_id: businessId,
      location_id: locationId,
      redeemed_at: null,
      revoked_at: null,
    });

    const redeemed = await redeem(approved.pairingCode);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    expect(redeemed.snapshot.business.id).toBe(businessId);
    expect(redeemed.snapshot.location.id).toBe(locationId);
    expect(redeemed.snapshot.users.some((user) => user.id === ownerUserId)).toBe(true);

    // Enrollment is not a second identity system: the code is one-time exactly
    // like a typed one.
    expect(await redeem(approved.pairingCode)).toEqual({
      ok: false,
      error: "code_already_redeemed",
    });
  });

  it("denies an approved request and revokes the code the approval sealed", async () => {
    const started = await startEnrollment();
    expect(await approve(started.requestId)).toEqual({ ok: true });
    const approved = await poll(started.requestId, started.deviceSecret);
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") return;

    expect(
      await denyEnrollmentRequest({
        businessId,
        requestId: started.requestId,
        deniedBy: ownerUserId,
      }),
    ).toBe(true);

    expect(await poll(started.requestId, started.deviceSecret)).toEqual({ status: "denied" });
    expect(await redeem(approved.pairingCode)).toEqual({ ok: false, error: "code_revoked" });
    const row = await enrollmentRow(started.requestId);
    expect(row.state).toBe("denied");
    expect(row.pairing_code_ciphertext).toBeNull();
    expect(row.pairing_code_id).toBeNull();
  });

  it("still denies a request nobody approved, and has no code to revoke", async () => {
    const started = await startEnrollment();
    expect(
      await denyEnrollmentRequest({
        businessId,
        requestId: started.requestId,
        deniedBy: ownerUserId,
      }),
    ).toBe(true);
    expect(await poll(started.requestId, started.deviceSecret)).toEqual({ status: "denied" });
    expect(await enrollmentRow(started.requestId)).toMatchObject({
      state: "denied",
      pairing_code_ciphertext: null,
    });
  });

  it("expires an unanswered request and refuses to approve it afterwards", async () => {
    const started = await startEnrollment();
    await expire(started.requestId);

    expect(await poll(started.requestId, started.deviceSecret)).toEqual({ status: "expired" });
    expect(await approve(started.requestId)).toEqual({ ok: false, error: "not_found" });
    expect(await enrollmentRow(started.requestId)).toMatchObject({ state: "expired" });
  });

  it("expires an approved request and revokes its sealed code with it", async () => {
    const started = await startEnrollment();
    expect(await approve(started.requestId)).toEqual({ ok: true });
    const approved = await poll(started.requestId, started.deviceSecret);
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") return;

    await expire(started.requestId);
    expect(await poll(started.requestId, started.deviceSecret)).toEqual({ status: "expired" });
    expect(await redeem(approved.pairingCode)).toEqual({ ok: false, error: "code_revoked" });
    expect(await enrollmentRow(started.requestId)).toMatchObject({
      state: "expired",
      pairing_code_ciphertext: null,
      pairing_code_id: null,
    });
  });

  it("superseding an approved request revokes the code it sealed", async () => {
    const deviceSecret = newDeviceSecret();
    const installationId = `desktop-${randomUUID()}`;
    const first = await startEnrollmentRequest({
      businessId,
      installationId,
      deviceName: "Windows Bizamiz",
      deviceSecretHash: hashDeviceSecret(deviceSecret),
    });
    expect(await approve(first.requestId)).toEqual({ ok: true });
    const approved = await poll(first.requestId, deviceSecret);
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") return;

    // The app retries from scratch (its window was closed, say). The abandoned
    // approval must not leave a redeemable code behind.
    const second = await startEnrollmentRequest({
      businessId,
      installationId,
      deviceName: "Windows Bizamiz",
      deviceSecretHash: hashDeviceSecret(deviceSecret),
    });
    expect(second.requestId).not.toBe(first.requestId);
    expect(await enrollmentRow(first.requestId)).toMatchObject({
      state: "expired",
      pairing_code_ciphertext: null,
      pairing_code_id: null,
    });
    expect(await redeem(approved.pairingCode)).toEqual({ ok: false, error: "code_revoked" });
    expect(await poll(second.requestId, deviceSecret)).toMatchObject({ status: "pending" });
  });
});
