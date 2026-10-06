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
  buildStaffPinMemberships,
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
import { removeMembership, setPin, updateMembership } from "../src/lib/team-service";
import { SESSION_COOKIE, resolveSessionFromToken } from "../src/lib/auth";
import { GET as cloudLoginCallback } from "../src/app/api/auth/cloud-login/callback/route";
import { GET as rosterRoute } from "../src/app/api/auth/pin-login/roster/route";
import { POST as rosterSyncRoute } from "../src/app/api/auth/pin-login/roster/sync/route";
import { POST as pairRoute } from "../src/app/api/setup/pair/route";
import { POST as iamStatusRoute } from "../src/app/api/team/iam-status/route";
import { createSession } from "../src/lib/employee-service";
import { signSession } from "../src/lib/auth";
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

// The repair action and the login-screen retry are driven through the real
// route handlers, so the session cookie has to be readable outside a Next
// request: only the cookie store is replaced, exactly as the other route-level
// integration tests do it.
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
  headers: async () => new Headers(),
}));

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

type CloudMode = "ok" | "http500" | "invalid" | "legacy" | "legacy_payload" | "invalid_staff_pins" | "offline";
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
      staffPins: { authoritative: true, memberships: await buildStaffPinMemberships(cloud.businessId) },
    }));
    if (cloud.mode === "invalid") return json({ credentials: "not-an-array" });
    if (cloud.mode === "invalid_staff_pins") {
      // A block that claims nothing: neither authoritative nor a roster. The
      // site must refuse the payload rather than read it as "remove".
      return json({ ...payload, staffPins: { authoritative: false } });
    }
    if (cloud.mode === "legacy_payload") {
      // A cloud from before #850: it has no staff-PIN block, so absence from
      // `pins` must keep meaning "leave the site's PIN alone".
      const { staffPins: _omitted, ...legacy } = payload;
      void _omitted;
      return json(legacy);
    }
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

/** Signs the owner into the jar the way the app's own routes see a session. */
async function signInOwner(paired: PairedBusiness): Promise<void> {
  const { session } = await withTenant(paired.siteBusinessId, () =>
    createSession(paired.ownerUserId, paired.siteBusinessId, { deviceLabel: "test" }),
  );
  jar.set(SESSION_COOKIE, await signSession({
    sub: paired.ownerUserId,
    role: "owner",
    businessId: paired.siteBusinessId,
    businessSlug: "site",
    locationId: null,
    fullName: "مالک",
    employeeSessionId: session.id,
  }));
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

    // Offboarding travels the same branch and must clear the member's local
    // login material, not just hide them from the roster.
    await switchDatabase(cloudDb);
    await withoutTenantScope("platform", () => removeMembership(paired.cloudBusinessId, paired.staff.kitchen.id, paired.cloudOwnerId));
    await switchDatabase(siteDb);
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    const offboarded = await withTenant(paired.siteBusinessId, () => query<{ is_active: boolean; membership_status: string; location_scope: string }>(
      `SELECT is_active, membership_status, location_scope FROM users WHERE id = $1`,
      [paired.staff.kitchen.id],
    ));
    expect(offboarded.rows[0]).toMatchObject({ is_active: false, membership_status: "offboarded", location_scope: "none" });
    expect(await activePinHash(paired.siteBusinessId, paired.staff.kitchen.id)).toBeNull();
    expect((await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId))).map((entry) => entry.id))
      .not.toContain(paired.staff.kitchen.id);
    // The remaining PIN staff are untouched by the offboarding.
    expect((await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId))).map((entry) => entry.id))
      .toContain(paired.staff.cashier.id);
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

  it("repairs both planes from the repair action, and refuses to call it done while PIN staff are unready", async () => {
    const paired = await pairBusiness();
    // The route resolves the business from the session; sibling businesses
    // paired by earlier tests would otherwise make host resolution ambiguous.
    await withoutTenantScope("platform", () => query(`DELETE FROM businesses WHERE id <> $1`, [paired.siteBusinessId]));
    await signInOwner(paired);

    // Repair with the credential endpoint broken: the membership plane can be
    // reconciled, but the action must not report success while active PIN
    // members cannot sign in locally.
    cloud.mode = "http500";
    const refused = await iamStatusRoute(new NextRequest("http://localhost/api/team/iam-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "repair" }),
    }));
    expect(refused.status).toBe(503);
    const refusedBody = (await refused.json()) as {
      ok: boolean;
      identitySyncOk: boolean;
      credentialsConverged: boolean;
      overall: string;
      degradedBy: string | null;
      credentialSync: { status: string; pinMembersMissing: number };
    };
    expect(refusedBody.ok).toBe(false);
    expect(refusedBody.credentialsConverged).toBe(false);
    expect(refusedBody.degradedBy).toBe("credentials");
    expect(refusedBody.credentialSync.pinMembersMissing).toBe(3);
    // The repair did not simply force a snapshot and leave the roster empty —
    // the memberships are local, they just cannot sign in yet.
    expect((await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId))).length).toBe(0);

    // The cloud answers again: the same action converges both planes and only
    // then reports success.
    cloud.mode = "ok";
    const repaired = await iamStatusRoute(new NextRequest("http://localhost/api/team/iam-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "repair" }),
    }));
    expect(repaired.status).toBe(200);
    const body = (await repaired.json()) as {
      ok: boolean;
      overall: string;
      credentialSync: { status: string; pinMembersMissing: number; pinsApplied: number };
    };
    expect(body.ok).toBe(true);
    expect(body.overall).toBe("healthy");
    expect(body.credentialSync).toMatchObject({ status: "healthy", pinMembersMissing: 0 });
    const roster = await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId));
    for (const role of PIN_ROLES) expect(roster.map((entry) => entry.id)).toContain(paired.staff[role].id);

    jar.delete(SESSION_COOKIE);
  }, 240_000);

  it("surfaces the missing-credential gap on the staff roster and repairs it from the login screen", async () => {
    const paired = await pairBusiness();
    await withoutTenantScope("platform", () => query(`DELETE FROM businesses WHERE id <> $1`, [paired.siteBusinessId]));
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    expect((await withTenant(paired.siteBusinessId, () => readHybridIdentityStatus(paired.siteBusinessId))).overall).toBe("healthy");

    // The owner-only symptom, reproduced: the cashier's membership is here,
    // the replicated PIN is not. The roster silently omits the member, so the
    // route has to say the list is incomplete.
    await withTenant(paired.siteBusinessId, () => query(
      `DELETE FROM employee_credentials
        WHERE business_id = $1 AND employee_id = $2 AND credential_type = 'pin'`,
      [paired.siteBusinessId, paired.staff.cashier.id],
    ));
    const notice = await rosterRoute(new NextRequest(
      `http://localhost/api/auth/pin-login/roster?businessId=${paired.siteBusinessId}`,
    ));
    expect(notice.status).toBe(200);
    const noticeBody = (await notice.json()) as {
      employees: Array<{ id: string }>;
      credentialSync: {
        state: string;
        overall: string;
        expected: number;
        usable: number;
        missing: number;
        missingMembers: Array<{ id: string; fullName: string; role: string }>;
      } | null;
    };
    expect(noticeBody.employees.map((entry) => entry.id)).not.toContain(paired.staff.cashier.id);
    expect(noticeBody.credentialSync).not.toBeNull();
    expect(noticeBody.credentialSync).toMatchObject({ expected: 3, usable: 2, missing: 1, overall: "degraded" });
    expect(noticeBody.credentialSync?.missingMembers.map((member) => member.id)).toEqual([paired.staff.cashier.id]);
    // Names and roles only — the notice never carries credential material.
    expect(JSON.stringify(noticeBody.credentialSync)).not.toContain("secret_hash");

    // «همگام‌سازی دوباره» on the login screen: no session, so this is the only
    // door for the person at the till while nobody can sign in.
    const retried = await rosterSyncRoute(new NextRequest(
      `http://localhost/api/auth/pin-login/roster/sync?businessId=${paired.siteBusinessId}`,
      { method: "POST" },
    ));
    expect(retried.status).toBe(200);
    const retriedBody = (await retried.json()) as { overall: string; missing: number; lastError: string | null };
    expect(retriedBody).toMatchObject({ overall: "healthy", missing: 0, lastError: null });

    const after = await rosterRoute(new NextRequest(
      `http://localhost/api/auth/pin-login/roster?businessId=${paired.siteBusinessId}`,
    ));
    const afterBody = (await after.json()) as { employees: Array<{ id: string }>; credentialSync: { missing: number } | null };
    expect(afterBody.employees.map((entry) => entry.id)).toContain(paired.staff.cashier.id);
    expect(afterBody.credentialSync?.missing).toBe(0);
    expect(await bcrypt.compare(paired.staff.cashier.pin, (await activePinHash(paired.siteBusinessId, paired.staff.cashier.id))!)).toBe(true);
  }, 240_000);

  it("leaves a Local install alone: no cloud identity is required and no warning is shown", async () => {
    // The non-regression the issue asks for at the end of its test list: the
    // fixes above are Hybrid-only. A Local business has no cloud to converge
    // with, so nothing may be reported missing and the staff door must behave
    // exactly as before.
    await switchDatabase(siteDb);
    const local = await provisionBusiness({
      businessName: `کافه محلی ${randomUUID().slice(0, 6)}`,
      ownerName: "مالک محلی",
      email: `local-${randomUUID()}@example.com`,
      password: "local-password",
      seedChartOfAccounts: false,
    });
    const waiterId = await createMember(local.businessId, "waiter", "گارسون محلی", local.locationId);
    await withTenant(local.businessId, () => setPin(local.businessId, waiterId, "1122", local.userId));

    // Not configured is not degraded: a business that never joined a cloud is
    // never asked for credential convergence.
    const status = await withTenant(local.businessId, () => readHybridIdentityStatus(local.businessId));
    expect(status).toMatchObject({ configured: false, overall: "not_configured", degradedBy: null });
    expect(status.credentials).toBeNull();

    // And the login screen is not told about a problem it does not have.
    const response = await rosterRoute(new NextRequest(
      `http://localhost/api/auth/pin-login/roster?businessId=${local.businessId}`,
    ));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      employees: Array<{ id: string }>;
      credentialSync: unknown;
    };
    expect(body.credentialSync).toBeNull();
    expect(body.employees.map((entry) => entry.id)).toContain(waiterId);

    // The PIN the local owner set works offline, on its own hash.
    const hash = await activePinHash(local.businessId, waiterId);
    expect(await bcrypt.compare("1122", hash!)).toBe(true);
  }, 240_000);

  it("pairs successfully while the credential endpoint is down, without claiming identity sync finished", async () => {
    // The other half of the pairing contract: the snapshot and its
    // acknowledgement succeeded, so the install must be usable and the owner
    // must be able to reach the till — but the credential plane did not
    // converge, so the wizard says so, the state is durable, and the retry
    // finishes the job once the cloud answers.
    const remote = await createCloudBusiness();
    const routeSiteDb = `pos_cred_partial_${randomUUID().replaceAll("-", "")}`;
    await maintenance(`CREATE DATABASE "${routeSiteDb}"`);
    try {
      await runMigrations({ databaseUrl: urlFor(routeSiteDb), quiet: true });
      await switchDatabase(routeSiteDb);
      cloud.businessId = remote.cloudBusinessId;
      cloud.mode = "http500";

      const response = await pairRoute(new NextRequest("http://localhost/api/setup/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteUrl: "https://cloud.example.test", code: remote.code }),
      }));
      // Pairing itself succeeded — the owner is signed in and the wizard moves on.
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        ownerUserId: string;
        identitySyncPending: boolean;
        credentialSync: { status: string; error: string | null; pinMembersMissing: number };
      };
      expect(body.ok).toBe(true);
      expect(response.cookies.get(SESSION_COOKIE)?.value).toBeTruthy();
      expect(body.identitySyncPending).toBe(true);
      expect(body.credentialSync.status).toBe("degraded");
      expect(body.credentialSync.error).toContain("login_credentials_http_500");

      const businessId = (await withoutTenantScope("platform", () => query<{ business_id: string }>(
        `SELECT business_id FROM users WHERE id = $1`,
        [body.ownerUserId],
      ))).rows[0].business_id;
      const siteDeviceId = (await withTenant(businessId, () => query<{ value: { siteDeviceId: string } }>(
        `SELECT value FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = 'server_sync.config'`,
        [businessId],
      ))).rows[0].value.siteDeviceId;
      cloud.siteDeviceId = siteDeviceId;

      // Durable and honest: the failure is recorded, and the gap is measured
      // against the memberships the snapshot did bring.
      const state = await withTenant(businessId, () => readCredentialSyncState(businessId, siteDeviceId));
      expect(state).toMatchObject({ status: "degraded", pinMembersExpected: 3, pinMembersUsable: 0, pinMembersMissing: 3 });
      expect(state?.lastError).toContain("login_credentials_http_500");

      // The owner can still work: the device-local offline PIN the wizard asks
      // for next is the guaranteed door, and the roster route says the list is
      // incomplete rather than pretending the business has no staff.
      await withTenant(businessId, () => setPin(businessId, body.ownerUserId, "4321", body.ownerUserId));
      const rosterWhileDown = await rosterRoute(new NextRequest(
        `http://localhost/api/auth/pin-login/roster?businessId=${businessId}`,
      ));
      const rosterBody = (await rosterWhileDown.json()) as {
        employees: Array<{ id: string }>;
        credentialSync: { missing: number; missingMembers: Array<{ id: string }> } | null;
      };
      expect(rosterBody.employees.map((entry) => entry.id)).toContain(body.ownerUserId);
      for (const role of PIN_ROLES) expect(rosterBody.employees.map((entry) => entry.id)).not.toContain(remote.staff[role].id);
      expect(rosterBody.credentialSync?.missing).toBe(3);
      expect(rosterBody.credentialSync?.missingMembers.map((member) => member.id).sort())
        .toEqual(PIN_ROLES.map((role) => remote.staff[role].id).sort());

      // The login screen's retry — the only door while nobody can sign in —
      // converges once the cloud is healthy again.
      cloud.mode = "ok";
      const retried = await rosterSyncRoute(new NextRequest(
        `http://localhost/api/auth/pin-login/roster/sync?businessId=${businessId}`,
        { method: "POST" },
      ));
      expect(retried.status).toBe(200);
      const retriedBody = (await retried.json()) as { overall: string; usable: number; missing: number };
      expect(retriedBody).toMatchObject({ overall: "healthy", usable: 3, missing: 0 });
      const converged = await withTenant(businessId, () => readCredentialSyncState(businessId, siteDeviceId));
      expect(converged?.status).toBe("healthy");
      for (const role of PIN_ROLES) {
        const hash = await activePinHash(businessId, remote.staff[role].id);
        expect(await bcrypt.compare(remote.staff[role].pin, hash!)).toBe(true);
      }
    } finally {
      await switchDatabase(siteDb);
      await maintenance(`DROP DATABASE IF EXISTS "${routeSiteDb}" WITH (FORCE)`);
    }
  }, 240_000);

  it("removes a staff PIN the cloud deleted, and leaves the owner's offline PIN alone", async () => {
    const paired = await pairBusiness();
    // The owner's device-local door, and a converged site to start from.
    await withTenant(paired.siteBusinessId, () => setPin(paired.siteBusinessId, paired.ownerUserId, "4321", paired.ownerUserId));
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    const before = await withTenant(paired.siteBusinessId, () => readHybridIdentityStatus(paired.siteBusinessId));
    expect(before.overall).toBe("healthy");

    // The cloud deletes the cashier's PIN — the membership stays active. The
    // roster lists only members a PIN can sign in, so before #850 the desktop
    // kept the deleted PIN working indefinitely.
    await switchDatabase(cloudDb);
    await withTenant(paired.cloudBusinessId, () => query(
      `UPDATE employee_credentials SET status = 'revoked', revoked_at = now()
        WHERE employee_id = $1 AND credential_type = 'pin' AND status = 'active'`,
      [paired.staff.cashier.id],
    ));
    await switchDatabase(siteDb);

    const synced = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(synced.pinsRevoked).toBe(1);
    // Recorded where the connection panel reads it.
    const state = await withTenant(paired.siteBusinessId, () => readCredentialSyncState(paired.siteBusinessId, paired.siteDeviceId));
    expect(state?.pinsRevoked).toBe(1);

    // The member is still a member; their PIN simply no longer works.
    expect(await activePinHash(paired.siteBusinessId, paired.staff.cashier.id)).toBeNull();
    const member = await withTenant(paired.siteBusinessId, () => query<{ is_active: boolean; membership_status: string }>(
      `SELECT is_active, membership_status FROM users WHERE id = $1`,
      [paired.staff.cashier.id],
    ));
    expect(member.rows[0]).toMatchObject({ is_active: true, membership_status: "active" });
    const roster = await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId));
    expect(roster.map((entry) => entry.id)).not.toContain(paired.staff.cashier.id);
    // ...and the other two staff are untouched.
    for (const role of ["waiter", "kitchen"] as const) {
      expect(roster.map((entry) => entry.id)).toContain(paired.staff[role].id);
    }

    // The owner's device-local PIN is not a cloud staff PIN: it survives, and
    // the removal counter never counted it.
    const ownerHash = await activePinHash(paired.siteBusinessId, paired.ownerUserId);
    expect(ownerHash).not.toBeNull();
    expect(await bcrypt.compare("4321", ownerHash!)).toBe(true);

    // Idempotent: nothing left to remove on the next pass.
    const again = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(again.pinsRevoked).toBe(0);
  }, 240_000);

  it("keeps a local PIN when the cloud does not claim authority over staff PINs", async () => {
    // The pre-#850 contract, preserved for a cloud that does not send the
    // staff-PIN block: absence from `pins` still means "this is not yours to
    // remove", so a site's own PIN survives an older cloud.
    const paired = await pairBusiness();
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    cloud.mode = "legacy_payload";
    const result = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(result.pinsRevoked).toBe(0);
    for (const role of PIN_ROLES) {
      expect(await activePinHash(paired.siteBusinessId, paired.staff[role].id)).not.toBeNull();
    }
    const roster = await withTenant(paired.siteBusinessId, () => loginRoster(paired.siteBusinessId));
    for (const role of PIN_ROLES) expect(roster.map((entry) => entry.id)).toContain(paired.staff[role].id);
    cloud.mode = "ok";
  }, 240_000);

  it("refuses a half-sent staff-PIN block instead of deleting PINs on it", async () => {
    // The dangerous failure mode: a malformed block must be an invalid payload
    // (visible, retryable) and never a licence to remove.
    const paired = await pairBusiness();
    await withTenant(paired.siteBusinessId, () => runIamSync(paired.siteBusinessId));
    cloud.mode = "invalid_staff_pins";
    const result = await withTenant(paired.siteBusinessId, () => syncHybridLoginCredentials(paired.siteBusinessId));
    expect(result.status).toBe("degraded");
    expect(result.error).toContain("staff_pins_not_authoritative");
    expect(result.pinsRevoked).toBe(0);
    for (const role of PIN_ROLES) {
      expect(await activePinHash(paired.siteBusinessId, paired.staff[role].id)).not.toBeNull();
    }
    cloud.mode = "ok";
  }, 240_000);
});
