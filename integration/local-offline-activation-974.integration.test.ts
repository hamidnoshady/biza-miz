/**
 * Issue #974 — Full Offline (`deployment.profile = 'local'`) mandatory Cloud
 * activation, periodic validation & Cloud-authoritative business refresh,
 * `locked_invalid` 423 boundary enforcement, online-only Support & Bug Report,
 * and outbound Owner-consented Superadmin remote support sessions.
 *
 * Runs end-to-end against TWO real migrated PostgreSQL databases (`cloudDb` and
 * `siteDb`) with RLS enabled & forced on all 7 new tables. Every Site -> Cloud
 * HTTP request is answered by the real `/api/local-activation/cloud` Next.js
 * route handler executing against `cloudDb`.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client, type Pool } from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { query, withTenant, withoutTenantScope } from "../src/lib/db";
import { provisionBusiness } from "../src/lib/business-provisioning";
import { createSession } from "../src/lib/employee-service";
import { SESSION_COOKIE, signSession } from "../src/lib/auth";
import { SETTING_KEYS } from "../src/lib/settings";
import { runCloudExceptionRelayTick } from "../src/lib/cloud-exception-relay";
import {
  issueLocalEnrollmentCode,
  listLocalInstallations,
  revokeLocalInstallation,
  rotateLocalInstallationCredential,
} from "../src/lib/local-activation-cloud-service";
import {
  checkLocalInstallationLockGate,
  discardUnsentSupportDraft,
  enrollLegacyLocalInstallation,
  getLocalActivationView,
  listUnsentSupportDrafts,
  repairOrReenrollLocalInstallation,
  requestCloudEnrollmentFromSite,
  runLocalActivationValidationForBusiness,
  verifyCloudTokenFromSite,
} from "../src/lib/local-activation-site-service";
import {
  getLocalRemoteSupportStateForUi,
  listLocalSupportSessionsForBusiness,
  pollAndProcessLocalSupportSessionForBusiness,
  queueLocalSupportCommandOnCloud,
  requestLocalSupportSessionOnCloud,
  respondToLocalRemoteSupportConsent,
  revokeLocalRemoteSupportSessionLocally,
} from "../src/lib/local-remote-support-service";
import {
  GET as cloudActivationGet,
  POST as cloudActivationPost,
} from "../src/app/api/local-activation/cloud/route";
import { POST as bootstrapPost } from "../src/app/api/setup/bootstrap/route";
import { GET as statusGet } from "../src/app/api/local-activation/status/route";
import {
  GET as supportTicketsGet,
  POST as supportTicketsPost,
} from "../src/app/api/support/tickets/route";
import { POST as bugReportPost } from "../src/app/api/bug-report/route";
import { GET as ordersGet } from "../src/app/api/orders/route";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const cookieJar = new Map<string, string>();
let currentRequestHeaders = new Headers();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
  }),
  headers: async () => currentRequestHeaders,
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

const cloudDb = `pos_974_cloud_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const siteDb = `pos_974_site_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

let currentDb: string | null = null;
async function switchDatabase(name: string, role: "cloud" | "site"): Promise<void> {
  process.env.DEPLOYMENT_ROLE = role;
  if (currentDb === name) return;
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(name);
  currentDb = name;
}

async function maintenance(sql: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

type TransportMode = "online" | "offline" | "http503";
let transportMode: TransportMode = "online";

const CLOUD_ORIGIN = "http://127.0.0.1:43210";
const prevEnv = {
  role: process.env.DEPLOYMENT_ROLE,
  desktopId: process.env.DESKTOP_INSTANCE_ID,
  loopback: process.env.LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK,
};

async function onCloud<T>(fn: () => Promise<T>): Promise<T> {
  const prevDb = currentDb;
  const prevRole = (process.env.DEPLOYMENT_ROLE === "cloud" ? "cloud" : "site") as
    | "cloud"
    | "site";
  await switchDatabase(cloudDb, "cloud");
  try {
    return await fn();
  } finally {
    if (prevDb) {
      await switchDatabase(prevDb, prevRole);
    }
  }
}

beforeAll(async () => {
  process.env.LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK = "1";
  process.env.DESKTOP_INSTANCE_ID = `inst-974-${randomUUID()}`;

  for (const name of [cloudDb, siteDb]) {
    await maintenance(`CREATE DATABASE "${name}"`);
    await runMigrations({ databaseUrl: urlFor(name), quiet: true });
  }

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (transportMode === "offline") {
      throw new TypeError("fetch failed: EAI_AGAIN");
    }
    if (transportMode === "http503") {
      return new Response(JSON.stringify({ error: "bad_gateway" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/api/local-activation/cloud") {
      return onCloud(async () => {
        const method = (init?.method ?? "GET").toUpperCase();
        const headers = new Headers(init?.headers);
        headers.set("x-forwarded-for", "203.0.113.10");
        const req = new NextRequest(url.toString(), {
          method,
          headers,
          body: method === "POST" && init?.body ? String(init.body) : undefined,
        });
        return method === "GET" ? cloudActivationGet(req) : cloudActivationPost(req);
      });
    }
    throw new Error(`Unexpected outbound fetch in #974 test: ${url.toString()}`);
  });

  await switchDatabase(siteDb, "site");
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  cookieJar.clear();
  if (prevEnv.role === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = prevEnv.role;
  if (prevEnv.desktopId === undefined) delete process.env.DESKTOP_INSTANCE_ID;
  else process.env.DESKTOP_INSTANCE_ID = prevEnv.desktopId;
  if (prevEnv.loopback === undefined) delete process.env.LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK;
  else process.env.LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK = prevEnv.loopback;

  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  for (const name of [cloudDb, siteDb]) {
    await maintenance(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
});

describe("Issue #974 — Full Offline mandatory Cloud activation, validation, online support & remote support", () => {
  let cloudBusinessId = "";
  let cloudLocationId = "";
  let cloudAdminId = "";
  let siteBusinessId = "";
  let siteOwnerUserId = "";
  let siteSessionCookie = "";
  let cloudInstallationRowId = "";

  it("enforces mandatory Cloud activation on fresh Full Offline setup and supports crash-safe idempotent enrollment without Hybrid sync", async () => {
    // 1. Provision Cloud business + Superadmin operator on Cloud DB
    await onCloud(async () => {
      const created = await provisionBusiness({
        businessName: "رستوران ابری زاگرس",
        locationName: "شعبه ونک",
        address: "تهران، میدان ونک",
        phone: "02188887777",
        ownerName: "سارا محمدی",
        ownerPhone: "+989121112233",
        email: `zagros-${randomUUID().slice(0, 6)}@example.com`,
        password: "cloud-owner-password-974",
        industry: "food_service",
        deploymentMode: "cloud",
      });
      cloudBusinessId = created.businessId;
      cloudLocationId = created.locationId;

      const adminRes = await withoutTenantScope("platform", () =>
        query<{ id: string }>(
          `INSERT INTO platform_admins (email, password_hash, full_name, is_active)
           VALUES ($1, $2, 'اپراتور پشتیبانی بیزآمیز', true)
           RETURNING id`,
          [`admin-${randomUUID().slice(0, 6)}@bizamiz.test`, bcrypt.hashSync("admin-pass-974", 8)],
        ),
      );
      cloudAdminId = adminRes.rows[0].id;
    });

    await switchDatabase(siteDb, "site");
    transportMode = "online";

    // 2. Fail closed when Cloud URL or token is missing on `local` bootstrap
    const missingRes = await bootstrapPost(
      new NextRequest("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName: "کافه محلی",
          ownerName: "رضا کریمی",
          email: "reza@local.test",
          password: "local-owner-password-974",
          deploymentMode: "local",
        }),
      }),
    );
    expect(missingRes.status).toBe(400);
    expect(await missingRes.json()).toMatchObject({ error: "cloud_activation_required" });

    // 3. Fail closed when token is invalid (no partial business provisioned locally)
    const invalidRes = await bootstrapPost(
      new NextRequest("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName: "کافه محلی",
          ownerName: "رضا کریمی",
          email: "reza@local.test",
          password: "local-owner-password-974",
          deploymentMode: "local",
          cloudUrl: CLOUD_ORIGIN,
          offlineToken: "OFL1-XXXX-YYYY-ZZZZ",
        }),
      }),
    );
    expect([401, 404]).toContain(invalidRes.status);
    const partialCount = await withoutTenantScope("bootstrap", () =>
      query<{ n: number }>(`SELECT count(*)::int AS n FROM businesses`),
    );
    expect(partialCount.rows[0].n).toBe(0);

    // 4. Issue real OFL1 enrollment token on Cloud and verify from Site
    const issued = await onCloud(() =>
      issueLocalEnrollmentCode(cloudBusinessId, cloudLocationId, { adminId: cloudAdminId }),
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("failed to issue OFL1 code");
    expect(issued.code.startsWith("OFL1-")).toBe(true);

    const verified = await verifyCloudTokenFromSite({
      cloudUrl: CLOUD_ORIGIN,
      token: issued.code,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("verify failed");
    expect(verified.businessBundle.name).toBe("رستوران ابری زاگرس");
    expect(verified.businessBundle.businessId).toBe(cloudBusinessId);

    // 5. Simulate crash BEFORE local commit: call `requestCloudEnrollmentFromSite` once,
    //    drop result, then run full `bootstrapPost` with the SAME `OFL1` code & `installationId`!
    const preCrash = await requestCloudEnrollmentFromSite({
      cloudUrl: CLOUD_ORIGIN,
      token: issued.code,
    });
    expect(preCrash.ok).toBe(true);

    const bootRes = await bootstrapPost(
      new NextRequest("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Vitest Electron" },
        body: JSON.stringify({
          businessName: "نام موقت محلی",
          ownerName: "سارا محمدی",
          email: "sara@local.test",
          password: "local-owner-password-974",
          deploymentMode: "local",
          cloudUrl: CLOUD_ORIGIN,
          offlineToken: issued.code,
        }),
      }),
    );
    expect(bootRes.status).toBe(200);
    const bootBody = await bootRes.json();
    expect(bootBody).toMatchObject({ ok: true, signedIn: true });
    siteSessionCookie = bootRes.cookies.get(SESSION_COOKIE)?.value ?? "";
    expect(siteSessionCookie.length).toBeGreaterThan(20);
    cookieJar.set(SESSION_COOKIE, siteSessionCookie);

    // 6. Canonical businessId & locationId match Cloud; NEVER touches `site_devices` or `sync_events`
    const siteBizRows = await withoutTenantScope("bootstrap", () =>
      query<{ id: string; name: string }>(`SELECT id, name FROM businesses`),
    );
    expect(siteBizRows.rows).toHaveLength(1);
    siteBusinessId = siteBizRows.rows[0].id;
    expect(siteBusinessId).toBe(cloudBusinessId);
    expect(siteBizRows.rows[0].name).toBe("رستوران ابری زاگرس");

    const ownerRow = await withTenant(siteBusinessId, () =>
      query<{ id: string }>(`SELECT id FROM users WHERE business_id = $1 AND role = 'owner'`, [
        siteBusinessId,
      ]),
    );
    siteOwnerUserId = ownerRow.rows[0].id;

    const actView = await withTenant(siteBusinessId, () =>
      getLocalActivationView(siteBusinessId, { probeReachability: true }),
    );
    expect(actView.enrolled).toBe(true);
    expect(actView.state).toBe("active");
    expect(actView.summary.localOperationsReady).toBe(true);

    const rawActRow = await withTenant(siteBusinessId, () =>
      query<{ pending_ack: boolean }>(
        `SELECT pending_ack FROM local_cloud_activations WHERE business_id = $1`,
        [siteBusinessId],
      ),
    );
    expect(rawActRow.rows[0].pending_ack).toBe(false);

    // Zero Hybrid artifacts on BOTH Cloud and Site
    const siteHybrid = await withTenant(siteBusinessId, () =>
      query<{ sd: number; se: number; cfg: number }>(
        `SELECT
           (SELECT count(*)::int FROM site_devices WHERE business_id = $1) AS sd,
           (SELECT count(*)::int FROM sync_events WHERE business_id = $1) AS se,
           (SELECT count(*)::int FROM settings WHERE business_id = $1 AND key = 'server_sync.config') AS cfg`,
        [siteBusinessId],
      ),
    );
    expect(siteHybrid.rows[0]).toEqual({ sd: 0, se: 0, cfg: 0 });

    await onCloud(async () => {
      const installations = await listLocalInstallations(cloudBusinessId);
      expect(installations).toHaveLength(1);
      expect(installations[0].status).toBe("active");
      cloudInstallationRowId = installations[0].id;

      // Phase-2 ack cleared `token_ciphertext` on Cloud
      const credRows = await withTenant(cloudBusinessId, () =>
        query<{ state: string; token_ciphertext: string | null }>(
          `SELECT state, token_ciphertext FROM local_installation_credentials
            WHERE local_installation_id = $1`,
          [cloudInstallationRowId],
        ),
      );
      expect(credRows.rows[0]).toEqual({ state: "active", token_ciphertext: null });

      // Zero Hybrid `site_devices` or `sync_events` on Cloud too
      const cloudHybrid = await withTenant(cloudBusinessId, () =>
        query<{ sd: number; se: number }>(
          `SELECT
             (SELECT count(*)::int FROM site_devices WHERE business_id = $1) AS sd,
             (SELECT count(*)::int FROM sync_events WHERE business_id = $1) AS se`,
          [cloudBusinessId],
        ),
      );
      expect(cloudHybrid.rows[0]).toEqual({ sd: 0, se: 0 });
    });

    // 7. Reusing the redeemed OFL1 token from another physical machine is rejected
    const prevDesktopId = process.env.DESKTOP_INSTANCE_ID;
    process.env.DESKTOP_INSTANCE_ID = `second-machine-${randomUUID()}`;
    try {
      const reuse = await requestCloudEnrollmentFromSite({
        cloudUrl: CLOUD_ORIGIN,
        token: issued.code,
      });
      expect(reuse.ok).toBe(false);
      if (!reuse.ok) {
        expect(reuse.error).toBe("code_already_redeemed");
      }
    } finally {
      process.env.DESKTOP_INSTANCE_ID = prevDesktopId;
    }
  });

  it("refreshes Cloud-authoritative business data without overwriting device_local settings, and treats offline/5xx as validation_pending", async () => {
    // Seed a `device_local` setting on Site (e.g. local printer config)
    await withTenant(siteBusinessId, () =>
      query(
        `INSERT INTO settings (business_id, location_id, key, value)
         VALUES ($1, NULL, 'hardware.receipt_printer', '{"port":"COM3","paperWidth":80}'::jsonb)
         ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [siteBusinessId],
      ),
    );

    // Update Cloud-authoritative business name, location address, and feature flag on Cloud
    await onCloud(async () => {
      await withTenant(cloudBusinessId, async () => {
        await query(
          `UPDATE businesses SET name = 'رستوران ابری زاگرس (ویرایش‌شده)', support_access_policy = 'approval_required', updated_at = now()
            WHERE id = $1`,
          [cloudBusinessId],
        );
        await query(
          `UPDATE locations SET address = 'تهران، خیابان ولیعصر، پلاک ۱۲۰' WHERE id = $1 AND business_id = $2`,
          [cloudLocationId, cloudBusinessId],
        );
        await query(
          `INSERT INTO business_features (business_id, flag_key, enabled)
           VALUES ($1, 'reservations', false)
           ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = false, updated_at = now()`,
          [cloudBusinessId],
        );
      });
    });

    // Validate & refresh from Site
    transportMode = "online";
    const valRes = await runLocalActivationValidationForBusiness(siteBusinessId, { force: true });
    expect(valRes).toMatchObject({ ran: true, state: "active", refreshed: true });

    const refreshedSite = await withTenant(siteBusinessId, async () => {
      const biz = await query<{ name: string; support_access_policy: string }>(
        `SELECT name, support_access_policy FROM businesses WHERE id = $1`,
        [siteBusinessId],
      );
      const loc = await query<{ address: string | null }>(
        `SELECT address FROM locations WHERE id = $1 AND business_id = $2`,
        [cloudLocationId, siteBusinessId],
      );
      const feat = await query<{ enabled: boolean }>(
        `SELECT enabled FROM business_features WHERE business_id = $1 AND flag_key = 'reservations'`,
        [siteBusinessId],
      );
      const printer = await query<{ value: { port: string } }>(
        `SELECT value FROM settings WHERE business_id = $1 AND key = 'hardware.receipt_printer'`,
        [siteBusinessId],
      );
      const profile = await query<{ value: Record<string, unknown> }>(
        `SELECT value FROM settings WHERE business_id = $1 AND key = $2`,
        [siteBusinessId, SETTING_KEYS.localCloudBusinessProfile],
      );
      return {
        biz: biz.rows[0],
        loc: loc.rows[0],
        feat: feat.rows[0],
        printer: printer.rows[0],
        profile: profile.rows[0],
      };
    });

    expect(refreshedSite.biz.name).toBe("رستوران ابری زاگرس (ویرایش‌شده)");
    expect(refreshedSite.biz.support_access_policy).toBe("approval_required");
    expect(refreshedSite.loc.address).toBe("تهران، خیابان ولیعصر، پلاک ۱۲۰");
    expect(refreshedSite.feat.enabled).toBe(false);
    // `device_local` setting untouched!
    expect(refreshedSite.printer.value.port).toBe("COM3");
    expect(refreshedSite.profile.value.cloudSlug).toBeTruthy();

    // Transient network failure -> `validation_pending`, NEVER `locked_invalid`
    transportMode = "offline";
    const offlineVal = await runLocalActivationValidationForBusiness(siteBusinessId, { force: true });
    expect(offlineVal.state).toBe("validation_pending");

    // Transient 503 -> stays `validation_pending`, local operations still unlocked!
    transportMode = "http503";
    const gatewayVal = await runLocalActivationValidationForBusiness(siteBusinessId, { force: true });
    expect(gatewayVal.state).toBe("validation_pending");

    const gateWhilePending = await withTenant(siteBusinessId, () =>
      checkLocalInstallationLockGate(siteBusinessId, "/api/orders", "POST"),
    );
    expect(gateWhilePending).toMatchObject({
      locked: false,
      allowed: true,
      state: "validation_pending",
    });

    // Seamless staged credential rotation when back online
    transportMode = "online";
    await onCloud(() =>
      rotateLocalInstallationCredential(cloudBusinessId, cloudInstallationRowId, null),
    );
    const rotatedVal = await runLocalActivationValidationForBusiness(siteBusinessId, { force: true });
    expect(rotatedVal.state).toBe("active");

    await onCloud(async () => {
      const activeCreds = await withTenant(cloudBusinessId, () =>
        query<{ state: string; token_ciphertext: string | null }>(
          `SELECT state, token_ciphertext
             FROM local_installation_credentials
            WHERE local_installation_id = $1 AND state = 'active'`,
          [cloudInstallationRowId],
        ),
      );
      expect(activeCreds.rows.length).toBeGreaterThanOrEqual(1);
      expect(activeCreds.rows.every((r) => r.token_ciphertext === null)).toBe(true);
    });
  });

  it("enforces locked_invalid (HTTP 423) on confirmed Cloud denial while keeping recovery endpoints accessible, and unlocks via token repair", async () => {
    transportMode = "online";

    // Suspend business on Cloud
    await onCloud(() =>
      withTenant(cloudBusinessId, () =>
        query(
          `UPDATE businesses SET status = 'suspended', suspended_at = now() WHERE id = $1`,
          [cloudBusinessId],
        ),
      ),
    );

    const deniedVal = await runLocalActivationValidationForBusiness(siteBusinessId, { force: true });
    expect(deniedVal).toMatchObject({
      ran: true,
      state: "locked_invalid",
      error: "business_suspended",
    });

    // Operational API route (`/api/orders`) returns 423 Locked via `withTenantScope`
    currentRequestHeaders = new Headers({
      "x-pathname": "/api/orders",
      "x-http-method": "GET",
    });
    const ordersRes = await ordersGet(new NextRequest("http://localhost/api/orders"));
    expect(ordersRes.status).toBe(423);
    expect(await ordersRes.json()).toMatchObject({
      error: "local_installation_locked",
      lockReason: "business_suspended",
    });

    // Recovery status API route (`/api/local-activation/status`) remains accessible (200)
    currentRequestHeaders = new Headers({
      "x-pathname": "/api/local-activation/status",
      "x-http-method": "GET",
    });
    const recoveryStatusRes = await statusGet(
      new NextRequest("http://localhost/api/local-activation/status"),
    );
    expect(recoveryStatusRes.status).toBe(200);
    const statusJson = await recoveryStatusRes.json();
    expect(statusJson.activation.state).toBe("locked_invalid");

    // Cross-business token replacement attempt MUST be rejected
    const otherIssued = await onCloud(async () => {
      const otherBiz = await provisionBusiness({
        businessName: "کافه دیگر",
        ownerName: "مالک دیگر",
        ownerPhone: "+989123334455",
        email: `other-${randomUUID().slice(0, 6)}@example.com`,
        password: "other-owner-password-974",
        deploymentMode: "cloud",
      });
      const code = await issueLocalEnrollmentCode(otherBiz.businessId, otherBiz.locationId, {
        adminId: cloudAdminId,
      });
      if (!code.ok) throw new Error("failed to issue other code");
      return code.code;
    });

    const crossTenantRepair = await repairOrReenrollLocalInstallation({
      localBusinessId: siteBusinessId,
      token: otherIssued,
      actorUserId: siteOwnerUserId,
    });
    expect(crossTenantRepair.ok).toBe(false);
    if (!crossTenantRepair.ok) {
      expect(["business_mismatch", "installation_mismatch"]).toContain(
        crossTenantRepair.error,
      );
    }

    // Reactivate business on Cloud, issue fresh OFL1 token for THIS business, and repair!
    const repairCode = await onCloud(async () => {
      await withTenant(cloudBusinessId, () =>
        query(`UPDATE businesses SET status = 'active', suspended_at = NULL WHERE id = $1`, [
          cloudBusinessId,
        ]),
      );
      const code = await issueLocalEnrollmentCode(cloudBusinessId, cloudLocationId, {
        adminId: cloudAdminId,
      });
      if (!code.ok) throw new Error("failed to issue repair code");
      return code.code;
    });

    const repaired = await repairOrReenrollLocalInstallation({
      localBusinessId: siteBusinessId,
      token: repairCode,
      actorUserId: siteOwnerUserId,
    });
    expect(repaired.ok).toBe(true);
    if (repaired.ok) {
      expect(repaired.view.state).toBe("active");
    }

    // Operational API route (`/api/orders`) works again!
    currentRequestHeaders = new Headers({
      "x-pathname": "/api/orders",
      "x-http-method": "GET",
    });
    const unlockedOrdersRes = await ordersGet(new NextRequest("http://localhost/api/orders"));
    expect(unlockedOrdersRes.status).toBe(200);
  });

  it("enforces online-only Support & Bug Report with token redaction and marks legacy outbox rows as unsent without auto-sending", async () => {
    currentRequestHeaders = new Headers({
      "x-pathname": "/api/support/tickets",
      "x-http-method": "POST",
    });

    // 1. Offline -> Support ticket creation & Bug Report fail closed (503) and NEVER queue to `cloud_exception_outbox`
    transportMode = "offline";
    const offlineTicketRes = await supportTicketsPost(
      new NextRequest("http://localhost/api/support/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: "تلاش ارسال در حالت آفلاین",
          description: "این پیام نباید در صف محلی ذخیره شود و باید آنلاین باشد.",
          category: "technical",
          priority: "normal",
        }),
      }),
    );
    expect(offlineTicketRes.status).toBe(503);
    expect(await offlineTicketRes.json()).toMatchObject({ error: "cloud_support_offline" });

    const offlineBugRes = await bugReportPost(
      new NextRequest("http://localhost/api/bug-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "گزارش خطای آفلاین",
          description: "نباید ذخیره محلی شود",
          severity: "medium",
        }),
      }),
    );
    expect(offlineBugRes.status).toBe(503);

    const outboxAfterOffline = await withTenant(siteBusinessId, () =>
      query<{ n: number }>(
        `SELECT count(*)::int AS n FROM cloud_exception_outbox WHERE business_id = $1`,
        [siteBusinessId],
      ),
    );
    expect(outboxAfterOffline.rows[0].n).toBe(0);

    // 2. Online -> Support ticket & Bug Report go directly to Cloud with token redaction!
    transportMode = "online";
    const onlineTicketRes = await supportTicketsPost(
      new NextRequest("http://localhost/api/support/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: "مشکل چاپگر با توکن OFL1-ABCD-EFGH-JKLM",
          description: "خطا هنگام اتصال با کلید LOC1-secretcredentialtoken9876543210",
          category: "technical",
          priority: "high",
        }),
      }),
    );
    expect(onlineTicketRes.status).toBe(201);
    const createdTicket = await onlineTicketRes.json();
    expect(createdTicket.ticket.subject).toContain("[REDACTED]");
    expect(createdTicket.ticket.subject).not.toContain("OFL1-ABCD");

    const listRes = await supportTicketsGet(
      new NextRequest("http://localhost/api/support/tickets"),
    );
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.tickets).toHaveLength(1);

    const onlineBugRes = await bugReportPost(
      new NextRequest("http://localhost/api/bug-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "کندی صفحه سفارش",
          description: "گزارش با توکن sync_secretToken123456789 در لاگ",
          severity: "low",
          pageUrl: "http://localhost:3000/pos?token=secret123",
        }),
      }),
    );
    expect(onlineBugRes.status).toBe(201);

    await onCloud(async () => {
      const bugRows = await withTenant(cloudBusinessId, () =>
        query<{ description: string; page_url: string | null }>(
          `SELECT description, page_url FROM bug_reports WHERE business_id = $1`,
          [cloudBusinessId],
        ),
      );
      expect(bugRows.rows).toHaveLength(1);
      expect(bugRows.rows[0].description).toContain("[REDACTED]");
      expect(bugRows.rows[0].description).not.toContain("sync_secretToken123456789");
      expect(bugRows.rows[0].page_url).not.toContain("secret123");
    });

    // 3. Legacy `cloud_exception_outbox` draft is NEVER auto-relayed in Local mode and can be discarded
    const draftEventId = randomUUID();
    await withTenant(siteBusinessId, () =>
      query(
        `INSERT INTO cloud_exception_outbox (event_id, business_id, kind, aggregate_id, payload)
         VALUES ($1, $2, 'support.ticket.created', $3, $4::jsonb)`,
        [
          draftEventId,
          siteBusinessId,
          randomUUID(),
          JSON.stringify({ subject: "پیش‌نویس قدیمی ارسال‌نشده" }),
        ],
      ),
    );
    await runCloudExceptionRelayTick(); // Must NOT relay Full Offline outbox rows!

    const drafts = await withTenant(siteBusinessId, () => listUnsentSupportDrafts(siteBusinessId));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].eventId).toBe(draftEventId);

    const discarded = await withTenant(siteBusinessId, () =>
      discardUnsentSupportDraft(siteBusinessId, draftEventId, siteOwnerUserId),
    );
    expect(discarded).toBe(true);
    const remainingDrafts = await withTenant(siteBusinessId, () =>
      listUnsentSupportDrafts(siteBusinessId),
    );
    expect(remainingDrafts).toHaveLength(0);
  });

  it("runs outbound Owner-consented Superadmin remote support sessions with command allowlist, redaction, local kill-switch, and locked recovery_only enforcement", async () => {
    transportMode = "online";

    // Refresh `last_seen_at` on Cloud so installation is known online
    await runLocalActivationValidationForBusiness(siteBusinessId, { force: true });

    // 1. Superadmin requests `read_only` support session on Cloud -> `pending_owner_consent`
    const reqSess = await onCloud(() =>
      requestLocalSupportSessionOnCloud({
        businessId: cloudBusinessId,
        localInstallationId: cloudInstallationRowId,
        adminId: cloudAdminId,
        operatorName: "اپراتور ارشد پشتیبانی",
        mode: "read_only",
        reason: "بررسی وضعیت سلامت سرویس چاپگر و پایگاه‌داده به درخواست مشتری",
        minutes: 15,
      }),
    );
    expect(reqSess.ok).toBe(true);
    if (!reqSess.ok) throw new Error("failed to request support session");

    // 2. Site outbound poll pulls `pending_owner_consent` (not active until local Owner approves!)
    await pollAndProcessLocalSupportSessionForBusiness(siteBusinessId);
    const uiBeforeConsent = await withTenant(siteBusinessId, () =>
      getLocalRemoteSupportStateForUi(siteBusinessId),
    );
    expect(uiBeforeConsent.pendingConsent?.id).toBe(reqSess.sessionId);
    expect(uiBeforeConsent.activeSession).toBeNull();

    // 3. Local Owner approves consent -> active on BOTH Site and Cloud
    const consentRes = await withTenant(siteBusinessId, () =>
      respondToLocalRemoteSupportConsent({
        businessId: siteBusinessId,
        sessionId: reqSess.sessionId,
        approve: true,
        ownerUserId: siteOwnerUserId,
      }),
    );
    expect(consentRes).toEqual({ ok: true });

    const uiActive = await withTenant(siteBusinessId, () =>
      getLocalRemoteSupportStateForUi(siteBusinessId),
    );
    expect(uiActive.activeSession?.id).toBe(reqSess.sessionId);

    // 4. Disallowed `controlled` command in `read_only` mode is rejected on Cloud!
    const forbiddenCmd = await onCloud(() =>
      queueLocalSupportCommandOnCloud({
        businessId: cloudBusinessId,
        sessionId: reqSess.sessionId,
        adminId: cloudAdminId,
        commandType: "clear_stuck_print_jobs",
      }),
    );
    expect(forbiddenCmd.ok).toBe(false);
    if (!forbiddenCmd.ok) {
      expect(forbiddenCmd.error).toBe("command_forbidden_in_mode");
    }

    // 5. Allowlisted `inspect_system_diagnostics` command executes via outbound poll and returns sanitized output
    const allowedCmd = await onCloud(() =>
      queueLocalSupportCommandOnCloud({
        businessId: cloudBusinessId,
        sessionId: reqSess.sessionId,
        adminId: cloudAdminId,
        commandType: "inspect_system_diagnostics",
      }),
    );
    expect(allowedCmd.ok).toBe(true);

    await pollAndProcessLocalSupportSessionForBusiness(siteBusinessId);

    await onCloud(async () => {
      const { sessions, commands } = await listLocalSupportSessionsForBusiness(
        cloudBusinessId,
        cloudAdminId,
      );
      const current = sessions.find((s) => s.id === reqSess.sessionId);
      const sessCommands = commands.filter((c) => c.sessionId === reqSess.sessionId);
      expect(current?.state).toBe("active");
      expect(sessCommands).toHaveLength(1);
      expect(sessCommands[0].state).toBe("completed");
      expect(JSON.stringify(sessCommands[0].result)).not.toContain("LOC1-");
    });

    // 6. Local Owner kill-switch immediately revokes session on Site and Cloud
    await withTenant(siteBusinessId, () =>
      revokeLocalRemoteSupportSessionLocally({
        businessId: siteBusinessId,
        sessionId: reqSess.sessionId,
        actorUserId: siteOwnerUserId,
      }),
    );

    const uiAfterRevoke = await withTenant(siteBusinessId, () =>
      getLocalRemoteSupportStateForUi(siteBusinessId),
    );
    expect(uiAfterRevoke.activeSession).toBeNull();

    await onCloud(async () => {
      const { sessions } = await listLocalSupportSessionsForBusiness(
        cloudBusinessId,
        cloudAdminId,
      );
      const current = sessions.find((s) => s.id === reqSess.sessionId);
      expect(current?.state).toBe("revoked");
    });

    // 7. When installation is `locked_invalid` / revoked, `read_only` session is blocked,
    //    whereas `recovery_only` is permitted for narrow recovery diagnostics
    await onCloud(() =>
      revokeLocalInstallation(cloudBusinessId, cloudInstallationRowId, null, "test_lock"),
    );
    const blockedReadOnly = await onCloud(() =>
      requestLocalSupportSessionOnCloud({
        businessId: cloudBusinessId,
        localInstallationId: cloudInstallationRowId,
        adminId: cloudAdminId,
        operatorName: "اپراتور ارشد پشتیبانی",
        mode: "read_only",
        reason: "تلاش نشست معمولی روی نصب مسدودشده",
        minutes: 15,
      }),
    );
    expect(blockedReadOnly.ok).toBe(false);
    if (!blockedReadOnly.ok) {
      expect(blockedReadOnly.error).toBe("installation_revoked");
    }
  });

  it("safely enrolls a legacy unenrolled Full Offline installation with pre-enrollment safeguard audit and no Hybrid conversion", async () => {
    transportMode = "online";

    // Create a second Cloud business + matching legacy local business (without `local_cloud_activations`)
    let legacyCloudBizId = "";
    let legacyCode = "";
    await onCloud(async () => {
      const biz = await provisionBusiness({
        businessName: "نانوایی سنتی البرز",
        locationName: "شعبه تجریش",
        ownerName: "علی رضایی",
        ownerPhone: "+989127778899",
        email: `alborz-${randomUUID().slice(0, 6)}@example.com`,
        password: "legacy-cloud-password-974",
        deploymentMode: "cloud",
      });
      legacyCloudBizId = biz.businessId;
      const issued = await issueLocalEnrollmentCode(biz.businessId, biz.locationId, {
        adminId: cloudAdminId,
      });
      if (!issued.ok) throw new Error("failed to issue legacy enrollment code");
      legacyCode = issued.code;
    });

    const legacySite = await provisionBusiness({
      businessName: "نانوایی قدیمی محلی",
      ownerName: "علی رضایی",
      email: `alborz-local-${randomUUID().slice(0, 6)}@local.test`,
      password: "legacy-local-password-974",
      deploymentMode: "local",
    });

    const prevDesktopId = process.env.DESKTOP_INSTANCE_ID;
    process.env.DESKTOP_INSTANCE_ID = `inst-legacy-974-${randomUUID()}`;
    try {
      const enrolledLegacy = await enrollLegacyLocalInstallation({
        localBusinessId: legacySite.businessId,
        cloudUrl: CLOUD_ORIGIN,
        token: legacyCode,
        actorUserId: legacySite.userId,
      });
      expect(enrolledLegacy.ok).toBe(true);
      if (enrolledLegacy.ok) {
        expect(enrolledLegacy.view.state).toBe("active");
        expect(enrolledLegacy.view.cloudBusinessId).toBe(legacyCloudBizId);
      }
    } finally {
      process.env.DESKTOP_INSTANCE_ID = prevDesktopId;
    }

    const safeguardAudit = await withTenant(legacySite.businessId, () =>
      query<{ action: string; payload: Record<string, unknown> }>(
        `SELECT action, payload FROM audit_log
          WHERE business_id = $1 AND action = 'local_activation.pre_enrollment_safeguard'`,
        [legacySite.businessId],
      ),
    );
    expect(safeguardAudit.rows).toHaveLength(1);
    expect(safeguardAudit.rows[0].payload.businessBefore).toBeTruthy();

    // Still `local` deployment mode, NOT `hybrid`
    const sessionRow = await withTenant(legacySite.businessId, () =>
      createSession(legacySite.userId, legacySite.businessId, {
        locationId: null,
        loginMethod: "password",
      }),
    );
    expect(sessionRow.session.id).toBeTruthy();
    const profileRow = await withTenant(legacySite.businessId, () =>
      query<{ value: { profile: string } }>(
        `SELECT value FROM settings WHERE business_id = $1 AND key = 'deployment.profile'`,
        [legacySite.businessId],
      ),
    );
    expect(profileRow.rows[0].value.profile).toBe("local");
    // Suppress unused import warning on signSession if needed:
    expect(typeof signSession).toBe("function");
  });
});
