/** Central Desktop update policy against PostgreSQL: inheritance, tenant isolation, delivery bookkeeping. */
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");
let databaseName: string;
let appRoleName: string | null = null;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let releases: typeof import("../src/lib/desktop-release-service");
let policies: typeof import("../src/lib/desktop-update-policy-service");

function urlFor(database: string) { const url = new URL(rootDatabaseUrl!); url.pathname = `/${database}`; return url.toString(); }
function maintenanceUrl() { const url = new URL(rootDatabaseUrl!); url.pathname = "/postgres"; return url.toString(); }

beforeAll(async () => {
  databaseName = `pos_update_policy_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect(); await maintenance.query(`CREATE DATABASE "${databaseName}"`); await maintenance.end();
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  releases = await import("../src/lib/desktop-release-service");
  policies = await import("../src/lib/desktop-update-policy-service");
  db = new Client({ connectionString: urlFor(databaseName) }); await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end(); await dbLib?.closeDatabasePool().catch(() => {}); process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() }); await maintenance.connect();
  await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  // The runtime role is cluster-wide; its grants went with the database.
  if (appRoleName) await maintenance.query(`DROP ROLE IF EXISTS "${appRoleName}"`);
  await maintenance.end();
});

async function tenant(name: string) {
  const business = await db.query<{ id: string }>("INSERT INTO businesses (name,slug) VALUES ($1,$2) RETURNING id", [name, `${name}-${randomUUID().slice(0, 8)}`]);
  const businessId = business.rows[0].id;
  const location = await db.query<{ id: string }>("INSERT INTO locations (business_id,name) VALUES ($1,'تهران') RETURNING id", [businessId]);
  const device = await db.query<{ id: string; public_id: string }>(
    `INSERT INTO site_devices (business_id,location_id,display_name,status) VALUES ($1,$2,'صندوق','active') RETURNING id,public_id`,
    [businessId, location.rows[0].id],
  );
  await db.query(
    `INSERT INTO site_sync_credentials (site_device_id,business_id,token_hash,state) VALUES ($1,$2,$3,'active')`,
    [device.rows[0].id, businessId, createHash("sha256").update(`POS1_${randomUUID()}`).digest("hex")],
  );
  return { businessId, locationId: location.rows[0].id, siteDeviceId: device.rows[0].id, publicDeviceId: device.rows[0].public_id };
}

async function release(version: string, rolloutState: "internal" | "full") {
  const row = await db.query<{ id: string }>(
    `INSERT INTO platform_releases
       (version,build_commit,build_id,channel,status,rollout_state,rollout_percentage,released_at,
        installer_url,installer_sha256,installer_size,manifest_signature,expected_publisher,release_notes)
     VALUES ($1,'6f714578',$2,'stable','published',$3,$4,now(),
             'https://github.com/example/releases/update.exe',$5,1000,$6,'Business Suite','[]') RETURNING id`,
    [version, `build-${version}`, rolloutState, rolloutState === "full" ? 100 : 0, "a".repeat(64), "A".repeat(96)],
  );
  return row.rows[0].id;
}

let adminId: string;
async function admin() {
  if (adminId) return adminId;
  const row = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email,password_hash,full_name) VALUES ($1,'x','Owner') RETURNING id`, [`owner-${randomUUID()}@example.com`],
  );
  adminId = row.rows[0].id;
  return adminId;
}

async function write(target: Parameters<typeof policies.writeDesktopUpdatePolicy>[0]["target"], set: object, extra: Partial<Parameters<typeof policies.writeDesktopUpdatePolicy>[0]> = {}) {
  return policies.writeDesktopUpdatePolicy({
    target, set: set as never, clear: [], reason: "تست یکپارچه", adminId: await admin(), expectedVersion: null, ...extra,
  });
}

async function decide(t: Awaited<ReturnType<typeof tenant>>) {
  const all = await releases.listDesktopReleases();
  return dbLib.withTenant(t.businessId, async () => policies.decideDeviceUpdate({
    identity: t, layers: await policies.loadDevicePolicyLayers(t), releases: all, reportedChannel: "stable", now: new Date(),
  }), { locationId: t.locationId });
}

describe("Desktop update policy", () => {
  it("gives two businesses different targets and policies; an override applies only inside its own business", async () => {
    const canary = await tenant("canary");
    const regular = await tenant("regular");
    const stable = await release("1.0.0", "full");
    const next = await release("2.0.0", "internal"); // registered by the pipeline, not yet rolled out

    expect((await decide(regular)).targetRelease?.id).toBe(stable);
    expect((await decide(canary)).targetRelease?.id).toBe(stable);

    expect(await write({ scope: "business", businessId: canary.businessId }, {
      targetReleaseId: next, automaticInstall: "safe_window", backgroundDownload: true,
    })).toMatchObject({ ok: true });

    const canaryDecision = await decide(canary);
    expect(canaryDecision.targetRelease?.id).toBe(next);
    expect(canaryDecision.document).toMatchObject({ businessId: canary.businessId, deviceId: canary.publicDeviceId });
    expect(canaryDecision.document.policy).toMatchObject({ automaticInstall: "safe_window", backgroundDownload: true, targetReleaseId: next });
    expect(canaryDecision.resolved.sources.automaticInstall).toBe("business");

    const regularDecision = await decide(regular);
    expect(regularDecision.targetRelease?.id).toBe(stable);
    expect(regularDecision.document.policy).toMatchObject({ automaticInstall: "off", targetReleaseId: null });
    expect(regularDecision.resolved.sources.automaticInstall).toBe("default");

    // A device override beats its business, and only for that device's own scope.
    expect(await write({ scope: "device", businessId: canary.businessId, siteDeviceId: canary.siteDeviceId }, { automaticInstall: "off", hold: true })).toMatchObject({ ok: true });
    const held = await decide(canary);
    expect(held.targetRelease).toBeNull();
    expect(held.withheldReason).toBe("hold");
    expect(held.document.policy.automaticInstall).toBe("off");
    expect(held.resolved.sources).toMatchObject({ automaticInstall: "device", hold: "device", backgroundDownload: "business" });
  });

  it("refuses a location or device that belongs to another business, and writes nothing", async () => {
    const a = await tenant("a"); const b = await tenant("b");
    const before = await db.query("SELECT count(*)::int AS n FROM business_desktop_update_policies");
    expect(await write({ scope: "location", businessId: a.businessId, locationId: b.locationId }, { hold: true })).toEqual({ ok: false, error: "target_not_found" });
    expect(await write({ scope: "device", businessId: a.businessId, siteDeviceId: b.siteDeviceId }, { hold: true })).toEqual({ ok: false, error: "target_not_found" });
    expect(await write({ scope: "business", businessId: randomUUID() }, { hold: true })).toEqual({ ok: false, error: "target_not_found" });
    expect((await db.query("SELECT count(*)::int AS n FROM business_desktop_update_policies")).rows[0]).toEqual(before.rows[0]);
  });

  it("row-level security hides one business's layers from another's scope (non-superuser runtime role)", async () => {
    const a = await tenant("iso-a"); const b = await tenant("iso-b");
    await write({ scope: "business", businessId: a.businessId }, { hold: true });
    await write({ scope: "business", businessId: b.businessId }, { backgroundDownload: true });

    // The test database owner is a superuser and ignores RLS; repoint the shared
    // pool at a NOSUPERUSER / NOBYPASSRLS role, exactly as production runs.
    const { createAppRole } = await import("../scripts/create-app-role");
    const roleName = `policy_app_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    appRoleName = roleName;
    await createAppRole({ databaseUrl: urlFor(databaseName), roleName, password: "test-password", quiet: true });
    const appUrl = new URL(urlFor(databaseName)); appUrl.username = roleName; appUrl.password = "test-password";
    await dbLib.closeDatabasePool();
    process.env.DATABASE_URL = appUrl.toString();
    try {
      const role = await dbLib.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      const seenByB = await dbLib.withTenant(b.businessId, async () => {
        const { rows } = await dbLib.query<{ business_id: string }>("SELECT business_id FROM business_desktop_update_policies");
        return rows.map((row) => row.business_id);
      });
      expect(seenByB.length).toBeGreaterThan(0);
      expect(new Set(seenByB)).toEqual(new Set([b.businessId]));
      // Even if B's device asked for A's layers by id, the scoped read cannot return them.
      const layers = await dbLib.withTenant(
        b.businessId, () => policies.loadDevicePolicyLayers({ ...b, businessId: a.businessId }), { locationId: b.locationId },
      );
      expect(layers.filter((layer) => layer.scope !== "platform")).toEqual([]);
      // And a tenant scope cannot write another business's layer.
      await expect(dbLib.withTenant(b.businessId, () => dbLib.query(
        `INSERT INTO business_desktop_update_policies (business_id,scope,version) VALUES ($1,'business',1)`, [a.businessId],
      ))).rejects.toThrow();
    } finally {
      await dbLib.closeDatabasePool();
      process.env.DATABASE_URL = urlFor(databaseName);
    }
  }, 60_000);

  it("versions only grow; a clear keeps the row and raises the version; a stale editor gets a conflict", async () => {
    const t = await tenant("versions");
    const target = { scope: "business", businessId: t.businessId } as const;
    const first = await write(target, { hold: true });
    const second = await write(target, { backgroundDownload: true });
    if (!first.ok || !second.ok) throw new Error("writes failed");
    expect(second.layer.version).toBeGreaterThan(first.layer.version);
    expect(second.layer.patch).toEqual({ hold: true, backgroundDownload: true });
    expect(await write(target, { channel: "beta" }, { expectedVersion: first.layer.version })).toEqual({ ok: false, error: "version_conflict" });

    const cleared = await write(target, {}, { clear: ["hold"], expectedVersion: second.layer.version });
    if (!cleared.ok) throw new Error("clear failed");
    expect(cleared.layer.version).toBeGreaterThan(second.layer.version);
    expect(cleared.layer.patch).toEqual({ backgroundDownload: true });
    expect((await db.query("SELECT count(*)::int AS n FROM business_desktop_update_policies WHERE business_id=$1", [t.businessId])).rows[0].n).toBe(1);
    expect(await write(target, {}, { clear: ["notAPolicyKey"] })).toEqual({ ok: false, error: "unknown_policy_key" });
    expect((await decide(t)).document.policyVersion).toBe(cleared.layer.version);
  });

  it("ignores a hand-edited row that smuggles a non-policy key instead of widening authority", async () => {
    const t = await tenant("tampered");
    await db.query(
      `INSERT INTO business_desktop_update_policies (business_id,scope,policy,version) VALUES ($1,'business',$2,nextval('desktop_update_policy_seq'))`,
      [t.businessId, JSON.stringify({ automaticInstall: "safe_window", installerUrl: "http://evil.example/x.exe" })],
    );
    const decision = await decide(t);
    expect(decision.document.policy.automaticInstall).toBe("off");
    expect(JSON.stringify(decision.document)).not.toContain("evil.example");
  });

  it("the database refuses a layer whose shape or business does not match", async () => {
    const a = await tenant("shape-a"); const b = await tenant("shape-b");
    await expect(db.query(
      `INSERT INTO business_desktop_update_policies (business_id,scope,location_id,version) VALUES ($1,'location',$2,1)`, [a.businessId, b.locationId],
    )).rejects.toThrow();
    await expect(db.query(
      `INSERT INTO business_desktop_update_policies (business_id,scope,location_id,site_device_id,version) VALUES ($1,'device',$2,$3,1)`, [a.businessId, a.locationId, a.siteDeviceId],
    )).rejects.toThrow();
  });

  it("tracks requested → delivered → acknowledged separately, and an offline device is never 'acknowledged'", async () => {
    const t = await tenant("delivery");
    const written = await write({ scope: "business", businessId: t.businessId }, { automaticInstall: "safe_window" });
    if (!written.ok) throw new Error("write failed");
    const report = { appVersion: "1.0.0", commitSha: "1234567", buildId: "b", schemaVersion: 226, electronVersion: "44", platform: "win32",
      releaseChannel: "stable" as const, clientCheckedAt: new Date().toISOString(), updateState: null, updateTargetVersion: null,
      lastErrorCode: null, lastErrorMessage: null, appliedPolicyVersion: null };
    await dbLib.withTenant(t.businessId, () => releases.reportDeviceRuntimeStatus(t, report), { locationId: t.locationId });

    const delivery = async () => (await releases.desktopFleetCompliance()).devices.find((device) => device.siteDeviceId === t.siteDeviceId)!.policy;
    expect(await delivery()).toMatchObject({ effectiveVersion: written.layer.version, delivery: "requested", deliveredVersion: null, acknowledgedVersion: null });

    await dbLib.withTenant(t.businessId, () => policies.recordPolicyDelivery(t, written.layer.version, null), { locationId: t.locationId });
    expect(await delivery()).toMatchObject({ delivery: "delivered", deliveredVersion: written.layer.version, acknowledgedVersion: null });

    await dbLib.withTenant(t.businessId, () => policies.recordPolicyDelivery(t, written.layer.version, written.layer.version), { locationId: t.locationId });
    expect(await delivery()).toMatchObject({ delivery: "acknowledged", acknowledgedVersion: written.layer.version, automaticInstall: "safe_window" });

    // A late, older acknowledgement must not move the device backwards.
    await dbLib.withTenant(t.businessId, () => policies.recordPolicyDelivery(t, written.layer.version, 1), { locationId: t.locationId });
    expect((await delivery()).acknowledgedVersion).toBe(written.layer.version);

    // A newer write is "requested" again until the device catches up.
    const newer = await write({ scope: "business", businessId: t.businessId }, { hold: true });
    if (!newer.ok) throw new Error("write failed");
    expect(await delivery()).toMatchObject({ delivery: "requested", effectiveVersion: newer.layer.version, hold: true });
  });

  it("previews the resolved policy for a device exactly as the device would receive it", async () => {
    const t = await tenant("preview");
    const pinned = await release("3.0.0", "internal");
    await write({ scope: "location", businessId: t.businessId, locationId: t.locationId }, { targetReleaseId: pinned });
    const all = await releases.listDesktopReleases();
    const preview = await policies.previewDevicePolicy(t.siteDeviceId, all);
    expect(preview?.targetRelease?.id).toBe(pinned);
    expect(preview?.resolved.sources.targetReleaseId).toBe("location");
    expect(await policies.previewDevicePolicy(randomUUID(), all)).toBeNull();
  });
});
