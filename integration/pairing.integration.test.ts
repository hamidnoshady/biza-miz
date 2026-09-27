/**
 * Desktop first-run pairing, end to end against a real database.
 *
 * The online and local halves both run here — the "online" business is
 * provisioned and issues a code; redeeming it produces a snapshot; applying
 * that snapshot into a *second* database is the laptop. Two databases is what
 * makes the id-preservation claim testable: the same uuids must land on both
 * sides.
 */
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { getPool, query, withTenant, withoutTenantScope } from "../src/lib/db";
import { provisionBusiness } from "../src/lib/business-provisioning";
import {
  acknowledgePairingSession,
  issuePairingCode,
  listPairingCodes,
  redeemPairingCode,
  revokePairingCode,
} from "../src/lib/pairing-service";
import { applyPairingSnapshot } from "../src/lib/pairing-apply";
import { validateSnapshot } from "../src/lib/pairing-snapshot";
import { acknowledgePendingPairing } from "../src/lib/server-sync";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let serverDb: string;
let localDb: string;

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

/**
 * Point the shared db.ts pool at a different database.
 *
 * db.ts caches its pool on `globalThis` so Next's dev server reuses one across
 * hot reloads, which means neither a fresh dynamic import nor
 * `vi.resetModules()` produces a second pool — the cache outlives both.
 * Ending the pool and clearing that global is what actually lets the next
 * `getPool()` build one against the new DATABASE_URL. Safe to call before any
 * import too, since `getPool()` reads the env var lazily.
 */
const globalForPg = globalThis as unknown as { pgPool?: Pool };

async function useDatabase(name: string): Promise<void> {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(name);
}

async function createDatabase(name: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(name), quiet: true });
}

async function dropDatabase(name: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
}

beforeAll(async () => {
  serverDb = `pos_pair_srv_${randomUUID().replaceAll("-", "")}`;
  localDb = `pos_pair_loc_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(serverDb);
  await createDatabase(localDb);
}, 180_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  await dropDatabase(serverDb);
  await dropDatabase(localDb);
});

/** A platform operator to attribute issued codes to. */
async function createPlatformAdmin(): Promise<string> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO platform_users (email, password_hash, full_name)
       VALUES ($1, 'x', 'operator') RETURNING id`,
      [`admin-${randomUUID()}@example.com`],
    );
    return rows[0].id;
  });
}

describe("pairing round trip", () => {
  it("issues a code, redeems it once, and replays the business onto a second database", async () => {
    // ---- online side -------------------------------------------------------
    await useDatabase(serverDb);

    const created = await provisionBusiness({
      businessName: "کافه بهار",
      ownerName: "حمید",
      email: `owner-${randomUUID()}@example.com`,
      password: "correct-horse",
      seedChartOfAccounts: true,
    });

    // A menu item, so the snapshot carries something beyond the skeleton.
    await withTenant(created.businessId, async () => {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO menu_categories (location_id, name, sort_order) VALUES ($1, $2, 0) RETURNING id`,
        [created.locationId, "نوشیدنی گرم"],
      );
      const menuItem = await query<{ id: string }>(
        `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, $3, $4) RETURNING id`,
        [created.locationId, rows[0].id, "اسپرسو", 850_000],
      );
      const modifierGroup = await query<{ id: string }>(
        `INSERT INTO modifier_groups (location_id, name, min_select, max_select)
         VALUES ($1, 'نوع شیر', 0, 1) RETURNING id`,
        [created.locationId],
      );
      const modifier = await query<{ id: string }>(
        `INSERT INTO modifiers (location_id, group_id, name, price_delta)
         VALUES ($1, $2, 'شیر جو', 120000) RETURNING id`,
        [created.locationId, modifierGroup.rows[0].id],
      );
      await query(
        `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id) VALUES ($1, $2)`,
        [menuItem.rows[0].id, modifierGroup.rows[0].id],
      );
      const inventory = await query<{ id: string }>(
        `INSERT INTO inventory_items (location_id, name, unit, reorder_level)
         VALUES ($1, 'دانه قهوه', 'g', 1000) RETURNING id`,
        [created.locationId],
      );
      await query(
        `INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 18)`,
        [menuItem.rows[0].id, inventory.rows[0].id],
      );
      await query(
        `INSERT INTO modifier_ingredients (modifier_id, inventory_item_id, quantity_delta) VALUES ($1, $2, 1)`,
        [modifier.rows[0].id, inventory.rows[0].id],
      );
      await query(
        `INSERT INTO dining_tables (location_id, name, capacity) VALUES ($1, 'میز ۱', 4)`,
        [created.locationId],
      );
    });

    const platformAdminId = await createPlatformAdmin();

    const issued = await withoutTenantScope("platform", () =>
      issuePairingCode(created.businessId, platformAdminId, created.locationId),
    );
    expect("code" in issued).toBe(true);
    if (!("code" in issued)) return;
    expect(issued.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const installationId = `desktop-installation-${randomUUID()}`;
    const redeemed = await redeemPairingCode(
      issued.code,
      "127.0.0.1",
      "Windows Business Suite",
      installationId,
    );
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    // Round-tripped through JSON, which is how it actually reaches the laptop.
    const validation = validateSnapshot(
      JSON.parse(JSON.stringify(redeemed.snapshot)),
    );
    expect(validation).toMatchObject({ ok: true });

    // A lost response is resumable from the same installation: the cloud
    // returns the same session/device/token rather than minting another one.
    const second = await redeemPairingCode(
      issued.code,
      "127.0.0.1",
      "Windows Business Suite",
      installationId,
    );
    expect(second).toMatchObject({
      ok: true,
      resumed: true,
      pairingSessionId: redeemed.pairingSessionId,
    });
    if (!second.ok) return;
    expect(second.snapshot.siteDevice).toEqual(redeemed.snapshot.siteDevice);
    expect(second.snapshot.syncToken).toBe(redeemed.snapshot.syncToken);
    const anotherInstall = await redeemPairingCode(
      issued.code,
      "127.0.0.1",
      "Windows Business Suite",
      `desktop-installation-${randomUUID()}`,
    );
    expect(anotherInstall).toEqual({
      ok: false,
      error: "code_already_redeemed",
    });

    const summaries = await withoutTenantScope("platform", () =>
      listPairingCodes(created.businessId),
    );
    expect(summaries[0].state).toBe("code_already_redeemed");

    const snapshot = redeemed.snapshot;

    // ---- local side --------------------------------------------------------
    await useDatabase(localDb);

    const applied = await applyPairingSnapshot(
      snapshot,
      "https://pos.example.com",
      { pairingSessionId: redeemed.pairingSessionId, installationId },
    );
    expect(applied.businessId).toBe(created.businessId);
    expect(applied.locationId).toBe(created.locationId);
    expect(applied.ownerUserId).toBe(created.userId);

    await withTenant(applied.businessId, async () => {
      const items = await query<{ name: string; price: string }>(
        `SELECT name, price FROM menu_items`,
      );
      expect(items.rows).toHaveLength(1);
      expect(items.rows[0].name).toBe("اسپرسو");
      expect(Number(items.rows[0].price)).toBe(850_000);

      const masterData = await query<{
        modifiers: string;
        inventory: string;
        tables: string;
        methods: string;
      }>(
        `SELECT
           (SELECT count(*) FROM modifiers)::text AS modifiers,
           (SELECT count(*) FROM inventory_items)::text AS inventory,
           (SELECT count(*) FROM dining_tables)::text AS tables,
           (SELECT count(*) FROM payment_methods WHERE business_id = $1)::text AS methods`,
        [applied.businessId],
      );
      expect(Number(masterData.rows[0].modifiers)).toBe(1);
      expect(Number(masterData.rows[0].inventory)).toBe(1);
      expect(Number(masterData.rows[0].tables)).toBe(1);
      expect(Number(masterData.rows[0].methods)).toBeGreaterThan(0);
      expect(snapshot.dataClassification.notYetReplicated).toContain(
        "journal entries, fiscal periods, bank reconciliation, payroll, tax filings, and accounting documents",
      );

      const accounts = await query<{ n: string }>(
        `SELECT count(*) AS n FROM accounts WHERE business_id = $1`,
        [applied.businessId],
      );
      expect(Number(accounts.rows[0].n)).toBeGreaterThan(0);

      const mode = await query<{
        value: { profile: string; pairedAt: string };
      }>(
        `SELECT value FROM settings WHERE business_id = $1 AND key = 'deployment.profile'`,
        [applied.businessId],
      );
      expect(mode.rows[0].value.profile).toBe("hybrid");
      expect(typeof mode.rows[0].value.pairedAt).toBe("string");

      const progress = await query<{ value: { completedAt: string | null } }>(
        `SELECT value FROM settings WHERE business_id = $1 AND key = 'setup.progress'`,
        [applied.businessId],
      );
      expect(progress.rows[0].value.completedAt).toBeTruthy();

      const syncTokens = await query<{ n: string }>(
        `SELECT count(*) AS n FROM site_sync_credentials WHERE business_id = $1`,
        [applied.businessId],
      );
      expect(Number(syncTokens.rows[0].n)).toBe(1);
      const sites = await query<{ location_id: string; status: string }>(
        `SELECT location_id, status FROM site_devices WHERE business_id = $1`,
        [applied.businessId],
      );
      expect(sites.rows).toEqual([
        { location_id: applied.locationId, status: "active" },
      ]);
    });

    // Local application committed before activation. Acknowledge from that
    // install to make the cloud-side pending credential usable for sync.
    await useDatabase(serverDb);
    const activated = await acknowledgePairingSession(
      redeemed.pairingSessionId,
      installationId,
      redeemed.snapshot.syncToken,
    );
    expect(activated).toEqual({ ok: true, state: "completed" });
    const cloudDevice = await withoutTenantScope("pairing-redeem", () =>
      query<{ status: string }>("SELECT status FROM site_devices WHERE id=$1", [
        redeemed.snapshot.siteDevice.id,
      ]),
    );
    expect(cloudDevice.rows[0].status).toBe("active");

    // A lost acknowledgement response is recovered from the durable local
    // config and enables normal sync only after its next successful proof.
    await useDatabase(localDb);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });
    try {
      await expect(
        acknowledgePendingPairing(applied.businessId),
      ).resolves.toEqual({ status: "ok" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const activatedConfig = await withTenant(applied.businessId, () =>
      query<{
        value: {
          enabled: boolean;
          pairingSessionId?: string;
          installationId?: string;
        };
      }>(
        `SELECT value FROM settings WHERE business_id=$1 AND key='server_sync.config'`,
        [applied.businessId],
      ),
    );
    expect(activatedConfig.rows[0].value).toMatchObject({ enabled: true });
    expect(activatedConfig.rows[0].value.pairingSessionId).toBeUndefined();
    expect(activatedConfig.rows[0].value.installationId).toBeUndefined();

    // Once acknowledged, recovery material is no longer downloadable with the
    // old one-time code; acknowledgement itself remains idempotent instead.
    await useDatabase(serverDb);
    await expect(
      redeemPairingCode(
        issued.code,
        "127.0.0.1",
        "Windows Business Suite",
        installationId,
      ),
    ).resolves.toEqual({ ok: false, error: "code_already_redeemed" });
  }, 120_000);
});

describe("pairing code lifecycle", () => {
  it("refuses an unknown code and a revoked code", async () => {
    await useDatabase(serverDb);

    const created = await provisionBusiness({
      businessName: "کافه دوم",
      ownerName: "سارا",
      email: `owner2-${randomUUID()}@example.com`,
      password: "correct-horse",
    });

    expect(await redeemPairingCode("ZZZZ-ZZZZ-ZZZZ", null)).toEqual({
      ok: false,
      error: "code_not_found",
    });

    const adminId = await createPlatformAdmin();

    const issued = await withoutTenantScope("platform", () =>
      issuePairingCode(created.businessId, adminId, created.locationId),
    );
    if (!("code" in issued)) throw new Error("expected a code");

    const revoked = await withoutTenantScope("platform", () =>
      revokePairingCode(created.businessId, issued.summary.id),
    );
    expect(revoked).toBe(true);
    expect(await redeemPairingCode(issued.code, null)).toEqual({
      ok: false,
      error: "code_revoked",
    });

    // Re-issuing replaces rather than accumulates: the partial unique index
    // allows only one live code, so this must succeed.
    const reissued = await withoutTenantScope("platform", () =>
      issuePairingCode(created.businessId, adminId, created.locationId),
    );
    expect("code" in reissued).toBe(true);
  }, 120_000);
});
