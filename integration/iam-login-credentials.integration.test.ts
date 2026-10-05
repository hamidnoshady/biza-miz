/**
 * Global login: an owner's cloud password, TOTP and recovery codes are
 * replicated to a paired desktop, re-encrypted under the desktop's own key,
 * and applied idempotently. Two databases, as in pairing.integration.test.ts.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client, type Pool } from "pg";
import { generateSecret, NobleCryptoPlugin, ScureBase32Plugin, TOTP } from "otplib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { query, withTenant, withoutTenantScope } from "../src/lib/db";
import { provisionBusiness } from "../src/lib/business-provisioning";
import { provisionMfaEnrolment } from "../src/lib/mfa-service";
import { issueRecoveryCodes } from "../src/lib/mfa-recovery";
import { verifyMfaCode } from "../src/lib/mfa-verify";
import {
  applyLoginCredentials,
  applyReplicatedPins,
  buildLoginCredentials,
  buildReplicatedPins,
  recordSpentRecoveryCodes,
  spentRecoveryCodes,
} from "../src/lib/iam/login-credentials-service";
import { setPin } from "../src/lib/team-service";
import { loginRoster } from "../src/lib/employee-service";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const globalForPg = globalThis as unknown as { pgPool?: Pool };
function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}
async function useDatabase(name: string): Promise<void> {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(name);
}
async function maintenance(sql: string): Promise<void> {
  const client = new Client({ connectionString: urlFor("postgres") });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

const cloudDb = `pos_login_cloud_${randomUUID().replaceAll("-", "")}`;
const siteDb = `pos_login_site_${randomUUID().replaceAll("-", "")}`;

beforeAll(async () => {
  for (const name of [cloudDb, siteDb]) {
    await maintenance(`CREATE DATABASE "${name}"`);
    await runMigrations({ databaseUrl: urlFor(name), quiet: true });
  }
}, 180_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  for (const name of [cloudDb, siteDb]) await maintenance(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});

describe("global login replication", () => {
  it("replicates the cloud password, TOTP and recovery codes onto the site's membership", async () => {
    await useDatabase(cloudDb);
    const email = `owner-${randomUUID()}@example.com`;
    const cloud = await provisionBusiness({
      businessName: "کافه ابر", ownerName: "حمید", email, password: "cloud-password", seedChartOfAccounts: false,
    });
    const secret = generateSecret();
    let recovery: string[] = [];
    await withoutTenantScope("platform", async () => {
      await provisionMfaEnrolment({ query: (t, p) => query(t, p as unknown[]) }, "platform_user", cloud.platformUserId!, "totp", true, null, Buffer.from(secret));
      recovery = await issueRecoveryCodes("platform_user", cloud.platformUserId!);
    });
    const credentials = await buildLoginCredentials(cloud.businessId);
    const owner = credentials.find((c) => c.membershipId === cloud.userId)!;
    expect(owner.mfa).toContainEqual({ method: "totp", isPrimary: true, phoneE164: null, totpSecret: secret });
    expect(owner.recoveryCodes).toHaveLength(recovery.length);

    // Site: a paired membership with the cloud's id and no identity yet —
    // exactly what pairing leaves behind — plus the wizard's local owner.
    await useDatabase(siteDb);
    const site = await provisionBusiness({
      businessName: "کافه محلی", ownerName: "حمید", email: `local-${randomUUID()}@example.com`, password: "local-password", seedChartOfAccounts: false,
    });
    await withTenant(site.businessId, () => query(
      `INSERT INTO users (id, business_id, role, full_name, email, location_id) VALUES ($1, $2, 'owner', 'حمید', $3, $4)`,
      [cloud.userId, site.businessId, email, site.locationId],
    ));

    await expect(withTenant(site.businessId, () => applyLoginCredentials(site.businessId, credentials))).resolves.toBe(true);
    // Unchanged cloud → no rewrite.
    await expect(withTenant(site.businessId, () => applyLoginCredentials(site.businessId, credentials))).resolves.toBe(false);

    const identity = await withoutTenantScope("identity", () => query<{ id: string; password_hash: string }>(
      `SELECT p.id, p.password_hash FROM platform_users p JOIN users u ON u.platform_user_id = p.id WHERE u.id = $1`,
      [cloud.userId],
    ));
    const localId = identity.rows[0].id;
    expect(await bcrypt.compare("cloud-password", identity.rows[0].password_hash)).toBe(true);

    const code = await new TOTP({ crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() }).generate({ secret });
    await expect(verifyMfaCode({ subjectRealm: "platform_user", subjectId: localId, method: "totp", code })).resolves.toBe("totp");
    await expect(verifyMfaCode({ subjectRealm: "platform_user", subjectId: localId, method: "totp", code: recovery[0], useRecoveryCode: true }))
      .resolves.toBe("recovery_code");

    // A code spent on the site stays spent when the cloud re-sends it unspent.
    const changed = credentials.map((c) => (c.membershipId === cloud.userId ? { ...c, fullName: "حمید نوشادی" } : c));
    await withTenant(site.businessId, () => applyLoginCredentials(site.businessId, changed));
    await expect(verifyMfaCode({ subjectRealm: "platform_user", subjectId: localId, method: "totp", code: recovery[0], useRecoveryCode: true }))
      .resolves.toBe("rejected");

    // A password changed on the site alone is noticed and put back to the cloud's.
    await withoutTenantScope("identity", () =>
      query(`UPDATE platform_users SET password_hash = $2 WHERE id = $1`, [localId, bcrypt.hashSync("site-only", 4)]));
    await expect(withTenant(site.businessId, () => applyLoginCredentials(site.businessId, changed))).resolves.toBe(true);
    const restored = await withoutTenantScope("identity", () =>
      query<{ password_hash: string }>(`SELECT password_hash FROM platform_users WHERE id = $1`, [localId]));
    expect(await bcrypt.compare("cloud-password", restored.rows[0].password_hash)).toBe(true);

    // The code spent on the site is reported and becomes single-use on the cloud too.
    const spent = await withTenant(site.businessId, () => spentRecoveryCodes(site.businessId));
    expect(spent).toHaveLength(1);
    await useDatabase(cloudDb);
    await recordSpentRecoveryCodes(cloud.businessId, spent);
    await expect(verifyMfaCode({ subjectRealm: "platform_user", subjectId: cloud.platformUserId!, method: "totp", code: recovery[0], useRecoveryCode: true }))
      .resolves.toBe("rejected");
    await expect(verifyMfaCode({ subjectRealm: "platform_user", subjectId: cloud.platformUserId!, method: "totp", code: recovery[1], useRecoveryCode: true }))
      .resolves.toBe("recovery_code");
  }, 180_000);

  it("brings a cashier's cloud PIN to the desktop so they appear on its quick login", async () => {
    await useDatabase(cloudDb);
    const cloud = await provisionBusiness({
      businessName: "کافه ابر ۲", ownerName: "حمید", email: `owner-${randomUUID()}@example.com`, password: "cloud-password", seedChartOfAccounts: false,
    });
    const cashierId = randomUUID();
    await withTenant(cloud.businessId, () => query(
      `INSERT INTO users (id, business_id, role, full_name, location_id) VALUES ($1, $2, 'cashier', 'صندوق', $3)`,
      [cashierId, cloud.businessId, cloud.locationId],
    ));
    await withTenant(cloud.businessId, () => setPin(cloud.businessId, cashierId, "4826", cloud.userId));
    const pins = await buildReplicatedPins(cloud.businessId);
    expect(pins.map((pin) => pin.membershipId)).toEqual([cashierId]);

    // Site: the IAM snapshot has replicated the membership, but no PIN.
    await useDatabase(siteDb);
    const site = await provisionBusiness({
      businessName: "کافه محلی ۲", ownerName: "حمید", email: `local-${randomUUID()}@example.com`, password: "local-password", seedChartOfAccounts: false,
    });
    await withTenant(site.businessId, () => query(
      `INSERT INTO users (id, business_id, role, full_name, location_id) VALUES ($1, $2, 'cashier', 'صندوق', $3)`,
      [cashierId, site.businessId, site.locationId],
    ));
    const before = await withTenant(site.businessId, () => loginRoster(site.businessId));
    expect(before.map((entry) => entry.id)).not.toContain(cashierId);

    await expect(withTenant(site.businessId, () => applyReplicatedPins(site.businessId, pins))).resolves.toBe(1);
    // Unchanged cloud → no rewrite.
    await expect(withTenant(site.businessId, () => applyReplicatedPins(site.businessId, pins))).resolves.toBe(0);

    const after = await withTenant(site.businessId, () => loginRoster(site.businessId));
    expect(after.map((entry) => entry.id)).toContain(cashierId);
    const stored = await withTenant(site.businessId, () => query<{ secret_hash: string }>(
      `SELECT secret_hash FROM employee_credentials WHERE employee_id = $1 AND credential_type = 'pin' AND status = 'active'`,
      [cashierId],
    ));
    expect(await bcrypt.compare("4826", stored.rows[0].secret_hash)).toBe(true);
  }, 180_000);
});
