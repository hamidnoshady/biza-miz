/**
 * Hybrid login credential convergence (issue #843), end to end against two
 * real databases.
 *
 * The cloud holds an owner, a manager and three PIN staff; the desktop starts
 * empty and is paired from a real redemption snapshot. Reconciliation then
 * runs through the real `runIamSync()`/`syncHybridLoginCredentials()` path.
 * Only the HTTP hop is stubbed: every request the desktop makes is answered by
 * the *cloud database's own* payload builders (snapshot, events, credentials,
 * PINs), so the data crossing the boundary is the production shape.
 *
 * This is the regression the issue is about: a site could be perfectly
 * converged on memberships (`iam_sync_state` healthy) while every cloud PIN
 * was missing locally, and the roster silently showed only the setup owner.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { query, withTenant, withoutTenantScope } from "../src/lib/db";
import { provisionBusiness } from "../src/lib/business-provisioning";
import { issuePairingCode, redeemPairingCode } from "../src/lib/pairing-service";
import { applyPairingSnapshot } from "../src/lib/pairing-apply";
import { validateSnapshot } from "../src/lib/pairing-snapshot";
import { buildIamSnapshot, listIamEvents } from "../src/lib/iam/service";
import {
  applyReplicatedPins,
  buildLoginCredentials,
  buildReplicatedPins,
  recordSpentRecoveryCodes,
} from "../src/lib/iam/login-credentials-service";
import { runIamSync } from "../src/lib/iam/sync";
import {
  pinCredentialGap,
  readCredentialSyncState,
  readHybridIdentityStatus,
  syncHybridLoginCredentials,
} from "../src/lib/iam/login-credential-sync";
import { loginRoster } from "../src/lib/employee-service";
import { setPin, updateMembership } from "../src/lib/team-service";
import { SESSION_COOKIE, resolveSessionFromToken } from "../src/lib/auth";
import { GET as cloudLoginCallback } from "../src/app/api/auth/cloud-login/callback/route";
import { POST as pairRoute } from "../src/app/api/setup/pair/route";
import { NextRequest } from "next/server";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

// The apply step is wrapped, not replaced: every call still runs the
// production implementation, and one test below forces it to fail once (the
// "apply failure" case the issue asks for) to prove the failure is persisted
// rather than printed.
vi.mock("../src/lib/iam/login-credentials-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/iam/login-credentials-service")>();
  return { ...actual, applyReplicatedPins: vi.fn(actual.applyReplicatedPins) };
});

const globalForPg = globalThis as unknown as { pgPool?: Pool };
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

const cloudDb = `pos_cred_cloud_${randomUUID().replaceAll("-", "")}`;
const siteDb = `pos_cred_site_${randomUUID().replaceAll("-", "")}`;

let currentDb: string | null = null;
async function switchDatabase(name: string): Promise<void> {
  if (currentDb === name) return;
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(name);
  currentDb = name;
}
async function maintenance(sql: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

beforeAll(async () => {
  for (const name of [cloudDb, siteDb]) {
    await maintenance(`CREATE DATABASE "${name}"`);
    await runMigrations({ databaseUrl: urlFor(name), quiet: true });
  }
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  for (const name of [cloudDb, siteDb]) await maintenance(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});

// ---------------------------------------------------------------------------
// The desktop's view of the cloud: real payloads, stubbed transport
// ---------------------------------------------------------------------------

type CloudMode = "ok" | "http500" | "invalid" | "legacy" | "offline";
const cloud = { mode: "ok" as CloudMode, businessId: "", siteDeviceId: "" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Run a builder against the cloud database, then put back whichever database
 * was current — normally the site, but the pairing-route test pairs a
 * *fresh* desktop database and must stay on it across the redeem call.
 */
async function onCloud<T>(fn: () => Promise<T>): Promise<T> {
  const previous = currentDb;
  await switchDatabase(cloudDb);
  try { return await fn(); } finally { if (previous) await switchDatabase(previous); }
}

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (cloud.mode === "offline") throw new TypeError("fetch failed");
  if (url.pathname === "/api/iam/snapshot") {
    return onCloud(async () => json({ snapshot: await buildIamSnapshot(cloud.businessId, cloud.siteDeviceId) }));
  }
  if (url.pathname === "/api/iam/events") {
    const after = Number(url.searchParams.get("after") ?? "0");
    return onCloud(async () => json({ events: await listIamEvents(cloud.businessId, after, 200) }));
  }
  if (url.pathname === "/api/iam/login-credentials") {
    if (cloud.mode === "legacy") return json({ error: "not_found" }, 404);
    if (cloud.mode === "http500") return json({ error: "boom" }, 500);
    if (init?.method === "POST") {
      const spent = (JSON.parse(String(init.body)) as { spent: unknown[] }).spent;
      await onCloud(() => recordSpentRecoveryCodes(cloud.businessId, spent as never));
      return json({ ok: true });
    }
    const payload = await onCloud(async () => ({
      credentials: await buildLoginCredentials(cloud.businessId),
      pins: await buildReplicatedPins(cloud.businessId),
    }));
    if (cloud.mode === "invalid") return json({ credentials: "not-an-array" });
    return json(payload);
  }
  if (url.pathname === "/api/pairing/redeem" || url.pathname === "/api/platform/pairing/redeem") {
    const body = JSON.parse(String(init?.body)) as { code: string; deviceName: string; installationId: string };
    const redeemed = await onCloud(() =>
      redeemPairingCode(body.code, "127.0.0.1", body.deviceName, body.installationId),
    );
    if (!redeemed.ok) return json({ error: redeemed.error }, 400);
    return json({ snapshot: redeemed.snapshot, pairingSessionId: redeemed.pairingSessionId });
  }
  if (url.pathname === "/api/pairing/acknowledge") return json({ ok: true });
  if (url.pathname === "/api/server-sync/desktop-login") {
    return json(cloudLoginHandoff);
  }
  throw new Error(`unexpected fetch ${url.pathname}`);
});

/** What the stubbed cloud hand-back answers for «ورود با حساب ابری». */
let cloudLoginHandoff: { userId: string; sessionCode: string; platformUserId: string | null; tokenVersion: number | null } = {
  userId: "", sessionCode: "session-code-value-000000000000", platformUserId: null, tokenVersion: null,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PIN_ROLES = ["cashier", "waiter", "kitchen"] as const;

interface PairedBusiness {
  cloudBusinessId: string;
  cloudOwnerId: string;
  siteBusinessId: string;
  siteDeviceId: string;
  ownerUserId: string;
  staff: Record<string, { id: string; pin: string }>;
  managerId: string;
}

async function createPlatformAdmin(): Promise<string> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO platform_users (email, password_hash, full_name) VALUES ($1, 'x', 'operator') RETURNING id`,
      [`admin-${randomUUID()}@example.com`],
    );
    return rows[0].id;
  });
}

async function createMember(businessId: string, role: string, fullName: string, locationId: string): Promise<string> {
  const id = randomUUID();
  await withTenant(businessId, () => query(
    `INSERT INTO users (id, business_id, role, full_name, location_id) VALUES ($1, $2, $3::user_role, $4, $5)`,
    [id, businessId, role, fullName, locationId],
  ));
  return id;
}

/** The cloud side of the fixture: owner, manager, three PIN staff, a pairing code. */
interface CloudBusiness {
  cloudBusinessId: string;
  cloudOwnerId: string;
  cloudLocationId: string;
  managerId: string;
  staff: Record<string, { id: string; pin: string }>;
  code: string;
}

async function createCloudBusiness(): Promise<CloudBusiness> {
  await switchDatabase(cloudDb);
  const cloudBusiness = await provisionBusiness({
    businessName: `کافه ${randomUUID().slice(0, 6)}`,
    ownerName: "مالک",
    email: `owner-${randomUUID()}@example.com`,
    password: "cloud-password",
    seedChartOfAccounts: false,
  });
  const cloudBusinessId = cloudBusiness.businessId;
  const ownerId = cloudBusiness.userId;
  const managerId = await createMember(cloudBusinessId, "manager", "مدیر", cloudBusiness.locationId);
  const staff: Record<string, { id: string; pin: string }> = {};
  const pins: Record<string, string> = { cashier: "1357", waiter: "2468", kitchen: "9753" };
  for (const role of PIN_ROLES) {
    const id = await createMember(cloudBusinessId, role, `کارمند ${role}`, cloudBusiness.locationId);
    await withTenant(cloudBusinessId, () => setPin(cloudBusinessId, id, pins[role], ownerId));
    staff[role] = { id, pin: pins[role] };
  }

  const platformAdminId = await createPlatformAdmin();
  const issued = await withoutTenantScope("platform", () =>
    issuePairingCode(cloudBusinessId, platformAdminId, cloudBusiness.locationId),
  );
  if (!("code" in issued)) throw new Error("pairing code was not issued");
  return {
    cloudBusinessId,
    cloudOwnerId: ownerId,
    cloudLocationId: cloudBusiness.locationId,
    managerId,
    staff,
    code: issued.code,
  };
}

/**
 * A cloud business with an owner, a manager and three PIN staff, paired onto an
 * empty desktop through the library path (the `/api/setup/pair` route itself is
 * exercised separately below).
 */
async function pairBusiness(): Promise<PairedBusiness> {
  const remote = await createCloudBusiness();
  const installationId = `desktop-${randomUUID()}`;
  const redeemed = await redeemPairingCode(remote.code, "127.0.0.1", "Windows Business Suite", installationId);
  if (!redeemed.ok) throw new Error(`redeem failed: ${redeemed.error}`);
  const validation = validateSnapshot(JSON.parse(JSON.stringify(redeemed.snapshot)));
  if (!validation.ok) throw new Error(`snapshot invalid: ${validation.error}`);

  await switchDatabase(siteDb);
  const applied = await applyPairingSnapshot(validation.snapshot, "https://cloud.example.test", {
    pairingSessionId: redeemed.pairingSessionId,
    installationId,
  });
  const config = await withTenant(applied.businessId, () => query<{ value: { siteDeviceId: string } }>(
    `SELECT value FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = 'server_sync.config'`,
    [applied.businessId],
  ));
  cloud.businessId = remote.cloudBusinessId;
  cloud.siteDeviceId = config.rows[0].value.siteDeviceId;
  cloud.mode = "ok";
  return {
    cloudBusinessId: remote.cloudBusinessId,
    cloudOwnerId: remote.cloudOwnerId,
    siteBusinessId: applied.businessId,
    siteDeviceId: cloud.siteDeviceId,
    ownerUserId: applied.ownerUserId,
    staff: remote.staff,
    managerId: remote.managerId,
  };
}

async function activePinHash(businessId: string, memberId: string): Promise<string | null> {
  const { rows } = await withTenant(businessId, () => query<{ secret_hash: string }>(
    `SELECT secret_hash FROM employee_credentials
      WHERE employee_id = $1 AND business_id = $2 AND credential_type = 'pin' AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`,
    [memberId, businessId],
  ));
  return rows[0]?.secret_hash ?? null;
}

describe("hybrid login credential convergence", () => {
  it("makes cloud PIN staff usable right after pairing, without forcing password roles into the roster", async () => {
    const paired = await pairBusiness();

    // The wizard's own offline door for the owner, created after pairing.
    await withTenant(paired.siteBusinessId, () => setPin(paired.siteBusinessId, paired.ownerUserId, "4321", paired.ownerUserId));

    // Pairing itself already ran the credential reconciliation; a sync tick
    // must leave the converged state alone.
    const synced = await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    expect(synced).toBe(true);

    const state = await withTenant(paired.siteBusinessId, () => readCredentialSyncState(paired.siteBusinessId, paired.siteDeviceId));
    expect(state?.status).toBe("healthy");
    expect(state?.pinMembersExpected).toBe(3);
    expect(state?.pinMembersUsable).toBe(3);
    expect(state?.pinMembersMissing).toBe(0);

    // Memberships exist locally, with the cloud's PINs under the same ids.
    for (const role of PIN_ROLES) {
      const hash = await activePinHash(paired.siteBusinessId, paired.staff[role].id);
      expect(hash, `${role} has no active PIN`).not.toBeNull();
      expect(await bcrypt.compare(paired.staff[role].pin, hash!)).toBe(true);
    }

    // The quick-login roster shows all three PIN staff...
    const roster = await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId));
    const rosterIds = roster.map((entry) => entry.id);
    for (const role of PIN_ROLES) expect(rosterIds).toContain(paired.staff[role].id);
    // ...and the manager (password role, no PIN) is not forced into it.
    expect(rosterIds).not.toContain(paired.managerId);
    // The owner's device-local offline PIN is intact — the cloud did not
    // overwrite the PIN the wizard created.
    const ownerHash = await activePinHash(paired.siteBusinessId, paired.ownerUserId);
    expect(ownerHash).not.toBeNull();
    expect(await bcrypt.compare("4321", ownerHash!)).toBe(true);

    // PIN-only staff carry no replicated global identity; the owner does.
    const identities = await withTenant(paired.siteBusinessId, () => query<{ id: string; platform_user_id: string | null }>(
      `SELECT id, platform_user_id FROM users WHERE business_id = $1 AND id = ANY($2::uuid[])`,
      [paired.siteBusinessId, [paired.staff.cashier.id, paired.ownerUserId]],
    ));
    const byId = new Map(identities.rows.map((row) => [row.id, row.platform_user_id]));
    expect(byId.get(paired.staff.cashier.id)).toBeNull();
    expect(byId.get(paired.ownerUserId)).not.toBeNull();

    const health = await withTenant(paired.siteBusinessId, () => readHybridIdentityStatus(paired.siteBusinessId));
    expect(health.overall).toBe("healthy");
  }, 240_000);

  it("propagates a cloud PIN change, retires the old PIN, and keeps staff usable offline", async () => {
    const paired = await pairBusiness();
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));

    // Change the cashier's PIN on the cloud.
    await switchDatabase(cloudDb);
    await withTenant(paired.cloudBusinessId, () => setPin(paired.cloudBusinessId, paired.staff.cashier.id, "8642", paired.cloudOwnerId));

    await switchDatabase(siteDb);
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    const hash = await activePinHash(paired.siteBusinessId, paired.staff.cashier.id);
    expect(await bcrypt.compare("8642", hash!)).toBe(true);
    expect(await bcrypt.compare("1357", hash!)).toBe(false);
    const active = await withTenant(paired.siteBusinessId, () => query<{ count: string }>(
      `SELECT count(*)::text AS count FROM employee_credentials
        WHERE employee_id = $1 AND credential_type = 'pin' AND status = 'active'`,
      [paired.staff.cashier.id],
    ));
    expect(Number(active.rows[0].count)).toBe(1);

    // Offline restart: the whole cloud is unreachable, so the credential
    // reconciliation records a degraded state (while the membership plane, as
    // designed, simply stops this tick), and every synchronized PIN still
    // works because the roster and the hashes are local.
    cloud.mode = "offline";
    const offline = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(offline.status).toBe("degraded");
    expect(offline.error).toContain("unreachable");
    const offlineState = await withTenant(paired.siteBusinessId, () => readCredentialSyncState(paired.siteBusinessId, paired.siteDeviceId));
    expect(offlineState?.status).toBe("degraded");
    const roster = await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId));
    for (const role of PIN_ROLES) expect(roster.map((entry) => entry.id)).toContain(paired.staff[role].id);
    expect(await bcrypt.compare("8642", (await activePinHash(paired.siteBusinessId, paired.staff.cashier.id))!)).toBe(true);
    cloud.mode = "ok";
  }, 240_000);

  it("persists credential failures as degraded (not console-only) and accepts a repair", async () => {
    const paired = await pairBusiness();
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));

    // A 500 from the credential endpoint must leave memberships healthy but
    // credentials degraded, and the overall verdict must not be green.
    cloud.mode = "http500";
    const failed = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(failed.status).toBe("degraded");
    expect(failed.error).toContain("login_credentials_http_500");

    const degradedState = await withTenant(paired.siteBusinessId, () => readCredentialSyncState(paired.siteBusinessId, paired.siteDeviceId));
    expect(degradedState?.status).toBe("degraded");
    expect(degradedState?.lastError).toContain("login_credentials_http_500");

    const identityPlane = await withTenant(paired.siteBusinessId, () => query<{ status: string }>(
      `SELECT status FROM iam_sync_state WHERE business_id = $1 AND site_device_id = $2`,
      [paired.siteBusinessId, paired.siteDeviceId],
    ));
    expect(identityPlane.rows[0].status).toBe("healthy");

    const health = await withTenant(paired.siteBusinessId, () => readHybridIdentityStatus(paired.siteBusinessId));
    expect(health.overall).toBe("degraded");
    expect(health.degradedBy).toBe("credentials");

    // An invalid payload is refused whole before anything is applied.
    cloud.mode = "invalid";
    const invalid = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(invalid.status).toBe("degraded");
    expect(invalid.error).toContain("login_credentials_invalid");

    // Repair: the same call the repair route makes converges and goes green.
    cloud.mode = "ok";
    const repaired = await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    expect(repaired).toBe(true);
    const repairedState = await withTenant(paired.siteBusinessId, () => readCredentialSyncState(paired.siteBusinessId, paired.siteDeviceId));
    expect(repairedState?.status).toBe("healthy");
    expect(repairedState?.convergedAt).not.toBeNull();
  }, 240_000);

  it("reports a cloud without the credential endpoint as limited, never healthy", async () => {
    const paired = await pairBusiness();
    cloud.mode = "legacy";
    const result = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(result.status).toBe("unsupported_legacy_cloud");
    const health = await withTenant(paired.siteBusinessId, () => readHybridIdentityStatus(paired.siteBusinessId));
    expect(health.overall).toBe("limited");
    // The PIN gap is measurable even so: the memberships are here, the
    // credentials are not.
    const gap = await withTenant(paired.siteBusinessId, () => pinCredentialGap(paired.siteBusinessId));
    expect(gap.missing).toBe(3);
    expect(gap.missingMembers.map((member) => member.role).sort()).toEqual(["cashier", "kitchen", "waiter"]);
    cloud.mode = "ok";
  }, 240_000);

  it("removes local login access when a member is suspended on the cloud", async () => {
    const paired = await pairBusiness();
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    expect((await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId))).map((entry) => entry.id))
      .toContain(paired.staff.waiter.id);

    await switchDatabase(cloudDb);
    await withoutTenantScope("platform", () => updateMembership({
      businessId: paired.cloudBusinessId,
      userId: paired.staff.waiter.id,
      isActive: false,
      actorId: paired.cloudOwnerId,
    }));

    await switchDatabase(siteDb);
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    const member = await withTenant(paired.siteBusinessId, () => query<{ is_active: boolean; membership_status: string }>(
      `SELECT is_active, membership_status FROM users WHERE id = $1`,
      [paired.staff.waiter.id],
    ));
    expect(member.rows[0]).toMatchObject({ is_active: false, membership_status: "suspended" });
    expect((await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId))).map((entry) => entry.id))
      .not.toContain(paired.staff.waiter.id);
  }, 240_000);

  it("refuses «ورود با حساب ابری» until the replicated identity has converged, then binds the session", async () => {
    const paired = await pairBusiness();
    // Earlier tests paired their own businesses into this same desktop
    // database; with more than one business and host routing off, the login
    // resolver refuses to guess which business this origin means.
    await withoutTenantScope("platform", () => query(`DELETE FROM businesses WHERE id <> $1`, [paired.siteBusinessId]));
    const state = "s".repeat(43);
    cloudLoginHandoff = {
      userId: paired.ownerUserId,
      sessionCode: "session-code-value-000000000000",
      // The cloud says this member signs in through a platform identity. The
      // desktop's replica does not have it yet (membership-only convergence).
      platformUserId: "11111111-1111-1111-1111-111111111111",
      tokenVersion: 5,
    };
    // Credential sync is broken, so reconciliation cannot bridge the gap.
    cloud.mode = "http500";
    const request = () => new NextRequest(
      `http://localhost/api/auth/cloud-login/callback?code=${"c".repeat(43)}&state=${state}`,
      { headers: { cookie: `cloud_login_state=${state}` } },
    );
    const refused = await cloudLoginCallback(request());
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe("/login?cloudLogin=identity_not_synced");
    expect(refused.cookies.get(SESSION_COOKIE)).toBeUndefined();

    // Converged: the local replica now carries the cloud's platform identity,
    // and the same hand-back mints a session bound to it.
    cloud.mode = "ok";
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    const bound = await withTenant(paired.siteBusinessId, () => query<{ platform_user_id: string | null }>(
      `SELECT platform_user_id FROM users WHERE id = $1`,
      [paired.ownerUserId],
    ));
    expect(bound.rows[0].platform_user_id).not.toBeNull();
    cloudLoginHandoff = {
      ...cloudLoginHandoff,
      platformUserId: bound.rows[0].platform_user_id,
      tokenVersion: (await withTenant(paired.siteBusinessId, () => query<{ token_version: number }>(
        `SELECT token_version FROM platform_users WHERE id = $1`,
        [bound.rows[0].platform_user_id],
      ))).rows[0].token_version,
    };
    const accepted = await cloudLoginCallback(request());
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/dashboard");
    const cookie = accepted.cookies.get(SESSION_COOKIE)?.value;
    expect(cookie).toBeTruthy();
    const session = await resolveSessionFromToken(cookie);
    expect(session?.platformUserId).toBe(cloudLoginHandoff.platformUserId);
    expect(session?.tokenVersion).toBe(cloudLoginHandoff.tokenVersion);
  }, 240_000);

  it("persists a failed PIN apply as degraded and repairs it on the next pass", async () => {
    const paired = await pairBusiness();
    cloud.mode = "ok";

    // The cloud answers correctly; applying its PINs is what fails. This is
    // exactly the path that used to end in a bare `console.error` while the
    // membership plane stayed healthy and the site was reported as fine.
    vi.mocked(applyReplicatedPins).mockRejectedValueOnce(new Error("forced_pin_apply_failure"));
    const failed = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(failed.status).toBe("degraded");
    expect(failed.error).toContain("pin_apply_failed");
    expect(failed.error).toContain("forced_pin_apply_failure");

    // Persisted, observable, and not green: the gap in the roster is measured
    // even though the apply itself threw.
    const state = await withTenant(paired.siteBusinessId, () => readCredentialSyncState(paired.siteBusinessId, paired.siteDeviceId));
    expect(state?.status).toBe("degraded");
    expect(state?.lastError).toContain("forced_pin_apply_failure");
    expect(state?.pinMembersMissing).toBe(3);
    const health = await withTenant(paired.siteBusinessId, () => readHybridIdentityStatus(paired.siteBusinessId));
    expect(health.overall).toBe("degraded");
    expect(health.degradedBy).toBe("credentials");

    // Retry: the same call the repair action and the login-screen retry make.
    const repaired = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(repaired.status).toBe("healthy");
    expect(repaired.pinsApplied).toBe(3);
    expect(repaired.pinMembersMissing).toBe(0);
    const roster = await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId));
    for (const role of PIN_ROLES) expect(roster.map((entry) => entry.id)).toContain(paired.staff[role].id);
  }, 240_000);

  it("ends a desktop session when the cloud password changes, and rebinds on the next hand-back", async () => {
    const paired = await pairBusiness();
    // Earlier tests paired their own businesses into this same desktop
    // database; with more than one business and host routing off, the login
    // resolver refuses to guess which business this origin means.
    await withoutTenantScope("platform", () => query(`DELETE FROM businesses WHERE id <> $1`, [paired.siteBusinessId]));
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));

    const identity = await withTenant(paired.siteBusinessId, () => query<{ platform_user_id: string; token_version: number }>(
      `SELECT u.platform_user_id, pu.token_version
         FROM users u JOIN platform_users pu ON pu.id = u.platform_user_id
        WHERE u.id = $1`,
      [paired.ownerUserId],
    ));
    const platformUserId = identity.rows[0].platform_user_id;
    const before = identity.rows[0].token_version;

    const state = "s".repeat(43);
    const request = () => new NextRequest(
      `http://localhost/api/auth/cloud-login/callback?code=${"c".repeat(43)}&state=${state}`,
      { headers: { cookie: `cloud_login_state=${state}` } },
    );
    cloudLoginHandoff = {
      userId: paired.ownerUserId,
      sessionCode: "session-code-value-000000000000",
      platformUserId,
      tokenVersion: before,
    };
    const accepted = await cloudLoginCallback(request());
    expect(accepted.headers.get("location")).toBe("/dashboard");
    const cookie = accepted.cookies.get(SESSION_COOKIE)?.value;
    expect(cookie).toBeTruthy();
    expect((await resolveSessionFromToken(cookie))?.tokenVersion).toBe(before);

    // The cloud password is changed (or reset). The replicated hash differs,
    // so the desktop's replica must move its token_version forward — the
    // chain that lets a cloud-side change end a session opened on the site.
    // The row is reached through the cloud's own membership linkage: the
    // desktop's replica may hold a platform user id of its own, so the test
    // must change the identity the cloud actually publishes, not a guessed id.
    const changedHash = bcrypt.hashSync("changed-cloud-password", 4);
    await switchDatabase(cloudDb);
    const cloudIdentity = await withTenant(paired.cloudBusinessId, () => query<{ platform_user_id: string }>(
      `SELECT platform_user_id FROM users WHERE business_id = $1 AND id = $2`,
      [paired.cloudBusinessId, paired.ownerUserId],
    ));
    const cloudPlatformUserId = cloudIdentity.rows[0].platform_user_id;
    await withTenant(paired.cloudBusinessId, () => query(
      `UPDATE platform_users SET password_hash = $2 WHERE id = $1`,
      [cloudPlatformUserId, changedHash],
    ));
    const published = await withTenant(paired.cloudBusinessId, () => buildLoginCredentials(paired.cloudBusinessId));
    expect(published.find((entry) => entry.membershipId === paired.ownerUserId)?.passwordHash).toBe(changedHash);
    await switchDatabase(siteDb);
    const synced = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(synced.status).toBe("healthy");

    const after = await withTenant(paired.siteBusinessId, () => query<{ token_version: number; password_hash: string }>(
      `SELECT token_version, password_hash FROM platform_users WHERE id = $1`,
      [platformUserId],
    ));
    expect(after.rows[0].password_hash).toBe(changedHash);
    expect(after.rows[0].token_version).toBeGreaterThan(before);

    // The session opened with the old version no longer resolves at all.
    expect(await resolveSessionFromToken(cookie)).toBeNull();

    // A fresh hand-back carries the new version and signs the member in again.
    cloudLoginHandoff = { ...cloudLoginHandoff, tokenVersion: after.rows[0].token_version };
    const fresh = await cloudLoginCallback(request());
    expect(fresh.headers.get("location")).toBe("/dashboard");
    expect((await resolveSessionFromToken(fresh.cookies.get(SESSION_COOKIE)?.value))?.tokenVersion)
      .toBe(after.rows[0].token_version);
  }, 240_000);

  it("finishes pairing only once the roster is complete — asserted against the route", async () => {
    // The library path is covered by every test above; this one drives the
    // real `/api/setup/pair` handler, because that wiring — "reconcile
    // credentials before pairing is considered complete" — is the regression.
    const remote = await createCloudBusiness();
    const routeSiteDb = `pos_cred_route_${randomUUID().replaceAll("-", "")}`;
    await maintenance(`CREATE DATABASE "${routeSiteDb}"`);
    try {
      await runMigrations({ databaseUrl: urlFor(routeSiteDb), quiet: true });
      await switchDatabase(routeSiteDb);
      cloud.businessId = remote.cloudBusinessId;
      cloud.mode = "ok";

      const response = await pairRoute(new NextRequest("http://localhost/api/setup/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteUrl: "https://cloud.example.test", code: remote.code }),
      }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        ownerUserId: string;
        requiresOfflineCredential: boolean;
        identitySyncPending: boolean;
        credentialSync: { status: string; pinMembersExpected: number; pinMembersUsable: number; pinMembersMissing: number };
      };
      expect(body.ok).toBe(true);
      expect(body.requiresOfflineCredential).toBe(true);
      // Pairing does not finish while PIN staff remain credentialless: it ran
      // the credential plane itself and reports the outcome.
      expect(body.credentialSync).toMatchObject({
        status: "healthy",
        pinMembersExpected: 3,
        pinMembersUsable: 3,
        pinMembersMissing: 0,
      });
      expect(body.identitySyncPending).toBe(false);

      // The fresh install's own database agrees: the three PIN staff are
      // usable immediately, without waiting for a single background tick.
      expect(cloud.mode).toBe("ok");
      const device = await withoutTenantScope("platform", () => query<{ business_id: string }>(
        `SELECT business_id FROM users WHERE id = $1`,
        [body.ownerUserId],
      ));
      const businessId = device.rows[0].business_id;
      const config = await withTenant(businessId, () => query<{ value: { siteDeviceId: string } }>(
        `SELECT value FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = 'server_sync.config'`,
        [businessId],
      ));
      const state = await withTenant(businessId, () => readCredentialSyncState(businessId, config.rows[0].value.siteDeviceId));
      expect(state?.status).toBe("healthy");
      const roster = await withTenant(businessId, () => loginRoster(businessId));
      for (const role of PIN_ROLES) expect(roster.map((entry) => entry.id)).toContain(remote.staff[role].id);
      expect(roster.map((entry) => entry.id)).not.toContain(remote.managerId);
      for (const role of PIN_ROLES) {
        const hash = await activePinHash(businessId, remote.staff[role].id);
        expect(await bcrypt.compare(remote.staff[role].pin, hash!)).toBe(true);
      }
    } finally {
      // Never leave the pool pointing at a database that is about to be dropped.
      await switchDatabase(siteDb);
      await maintenance(`DROP DATABASE IF EXISTS "${routeSiteDb}" WITH (FORCE)`);
    }
  }, 240_000);
});
