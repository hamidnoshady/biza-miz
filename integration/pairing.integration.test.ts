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
import { createAccount } from "../src/lib/accounts-service";
import {
  acknowledgePairingSession,
  issuePairingCode,
  listPairingCodes,
  redeemPairingCode,
  revokePairingCode,
} from "../src/lib/pairing-service";
import { applyPairingSnapshot, repairPairingSnapshot } from "../src/lib/pairing-apply";
import { validateSnapshot, type PairingSnapshot } from "../src/lib/pairing-snapshot";
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
    expect(JSON.stringify(snapshot)).not.toContain("platformUserPasswordHash");
    expect(JSON.stringify(snapshot)).not.toContain("passwordHash");
    expect(snapshot.users.every((user) => !("pinHash" in user))).toBe(true);

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

  it("repairs an already-paired install and activates the new cloud device", async () => {
    // Regression: repair used to drop the pairing session, so the sync tick
    // never acknowledged it and the cloud device stayed pending (sync = 401).
    await useDatabase(serverDb);
    const created = await provisionBusiness({
      businessName: "کافه تعمیر",
      ownerName: "حمید",
      email: `owner-${randomUUID()}@example.com`,
      password: "correct-horse",
      seedChartOfAccounts: true,
    });
    const adminId = await createPlatformAdmin();
    const installationId = `desktop-installation-${randomUUID()}`;
    const redeem = async () => {
      const issued = await withoutTenantScope("platform", () =>
        issuePairingCode(created.businessId, adminId, created.locationId),
      );
      if (!("code" in issued)) throw new Error("no code");
      const redeemed = await redeemPairingCode(issued.code, "127.0.0.1", "Windows Business Suite", installationId);
      if (!redeemed.ok) throw new Error(redeemed.error);
      return redeemed;
    };

    const first = await redeem();
    await useDatabase(localDb);
    await applyPairingSnapshot(first.snapshot, "https://pos.example.com", {
      pairingSessionId: first.pairingSessionId,
      installationId,
    });

    await useDatabase(serverDb);
    const repair = await redeem();
    await useDatabase(localDb);
    await repairPairingSnapshot(repair.snapshot, "https://pos.example.com", {
      pairingSessionId: repair.pairingSessionId,
      installationId,
    });

    let sent: { pairingSessionId?: string; installationId?: string; token?: string } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      sent = {
        ...JSON.parse(String(init?.body)),
        token: new Headers(init?.headers).get("authorization")?.slice("Bearer ".length),
      };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
      await expect(
        withTenant(created.businessId, () => acknowledgePendingPairing(created.businessId)),
      ).resolves.toEqual({ status: "ok" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(sent).toEqual({
      pairingSessionId: repair.pairingSessionId,
      installationId,
      token: repair.snapshot.syncToken,
    });

    await useDatabase(serverDb);
    await expect(
      acknowledgePairingSession(sent.pairingSessionId!, sent.installationId!, sent.token!),
    ).resolves.toEqual({ ok: true, state: "completed" });
    const device = await withoutTenantScope("pairing-redeem", () =>
      query<{ status: string }>("SELECT status FROM site_devices WHERE id=$1", [repair.snapshot.siteDevice.id]),
    );
    expect(device.rows[0].status).toBe("active");
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

/**
 * Issue #824 finding 2: restore the chart as a tree. A four-level chain must
 * come back with the levels its parents imply; a fifth tier, a missing parent or
 * a cycle must refuse the whole snapshot and leave nothing behind; an archived
 * account must keep its flag; and two businesses that share codes must not see
 * or disturb each other on the same device.
 */
describe("issue #824 finding 2: pairing restores the account chart as a tree", () => {
  type Snapshot = PairingSnapshot;

  function localClient(): Client {
    return new Client({ connectionString: urlFor(localDb) });
  }

  /**
   * Provision a business, shape its chart, and redeem a code for its snapshot.
   * The caller points the pool at the server database first.
   */
  async function snapshotWithChart(
    name: string,
    shape: (businessId: string) => Promise<void>,
  ): Promise<{ businessId: string; snapshot: Snapshot }> {
    const created = await provisionBusiness({
      businessName: name,
      ownerName: "مالک",
      email: `owner-${randomUUID()}@example.com`,
      password: "correct-horse",
      seedChartOfAccounts: false,
    });
    await shape(created.businessId);
    const adminId = await createPlatformAdmin();
    const issued = await withoutTenantScope("platform", () =>
      issuePairingCode(created.businessId, adminId, created.locationId),
    );
    if (!("code" in issued)) throw new Error("expected a code");
    const redeemed = await redeemPairingCode(issued.code, "127.0.0.1", "Windows Business Suite", `desktop-${randomUUID()}`);
    if (!redeemed.ok) throw new Error(`redeem failed: ${redeemed.error}`);
    const validation = validateSnapshot(JSON.parse(JSON.stringify(redeemed.snapshot)));
    if (!validation.ok) throw new Error("snapshot did not validate");
    return { businessId: created.businessId, snapshot: validation.snapshot };
  }

  /** Four tiers under one root, built through the editor, so levels are real. */
  async function fourTierChart(businessId: string): Promise<void> {
    await withTenant(businessId, async () => {
      const root = await createAccount({ businessId, code: "9100", name: "دارایی تست", type: "asset" });
      const kol = await createAccount({ businessId, code: "9110", name: "کل", type: "asset", parentId: root.id });
      const moein = await createAccount({ businessId, code: "9111", name: "معین", type: "asset", parentId: kol.id });
      await createAccount({ businessId, code: "9112", name: "تفصیلی", type: "asset", parentId: moein.id });
    });
  }

  async function localAccounts(businessId: string): Promise<Array<{ code: string; level: string; is_active: boolean; parent_code: string | null }>> {
    const c = localClient();
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT a.code, a.level::text AS level, a.is_active, p.code AS parent_code
           FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
          WHERE a.business_id = $1 ORDER BY a.code`,
        [businessId],
      );
      return rows;
    } finally {
      await c.end();
    }
  }

  async function localBusinessCount(businessId: string): Promise<number> {
    const c = localClient();
    await c.connect();
    try {
      const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM businesses WHERE id = $1`, [businessId]);
      return Number(rows[0].n);
    } finally {
      await c.end();
    }
  }

  it("restores a four-tier chain with each level derived from its parent, and keeps an archived kol with its active children", async () => {
    await useDatabase(serverDb);
    const { businessId, snapshot } = await snapshotWithChart("چهار سطحی", async (id) => {
      await fourTierChart(id);
      // The legacy state the editor now forbids: an archived kol whose moein and
      // tafsili are still active. The restore must mirror it, not flatten it.
      await withTenant(id, () => query(`UPDATE accounts SET is_active = false WHERE code = '9110'`));
    });

    await useDatabase(localDb);
    await applyPairingSnapshot(snapshot, "https://pos.example.com", {});

    const restored = await localAccounts(businessId);
    expect(restored.map((a) => [a.code, a.level, a.is_active, a.parent_code])).toEqual([
      ["9100", "group", true, null],
      ["9110", "kol", false, "9100"],
      ["9111", "moein", true, "9110"],
      ["9112", "tafsili", true, "9111"],
    ]);
  }, 120_000);

  it("restores a snapshot written before archived accounts travelled: every account is active", async () => {
    await useDatabase(serverDb);
    const { businessId, snapshot } = await snapshotWithChart("قدیمی", fourTierChart);
    const legacy = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
    for (const account of legacy.accounts) delete (account as { isActive?: boolean }).isActive;

    await useDatabase(localDb);
    await applyPairingSnapshot(legacy, "https://pos.example.com", {});
    const restored = await localAccounts(businessId);
    expect(restored).toHaveLength(4);
    expect(restored.every((a) => a.is_active)).toBe(true);
  }, 120_000);

  it("refuses a fifth tier, a missing parent and a cycle, each with nothing written", async () => {
    await useDatabase(serverDb);
    const { businessId, snapshot } = await snapshotWithChart("نامعتبر", fourTierChart);
    const tafsili = snapshot.accounts.find((a) => a.code === "9112")!;
    const withExtra = (extra: Snapshot["accounts"][number]) => ({ ...snapshot, accounts: [...snapshot.accounts, extra] }) as Snapshot;
    const base = { id: randomUUID(), name: "نامعتبر", type: "asset" };

    await useDatabase(localDb);
    const cases: Array<{ label: string; bad: Snapshot; reason: string }> = [
      {
        label: "fifth tier",
        bad: withExtra({ ...base, parentCode: tafsili.code, code: "9113" }),
        reason: "too_deep",
      },
      {
        label: "missing parent",
        bad: withExtra({ ...base, parentCode: "9999", code: "9120" }),
        reason: "parent_missing",
      },
      {
        label: "cycle",
        bad: {
          ...snapshot,
          accounts: [
            ...snapshot.accounts,
            { ...base, parentCode: "9130", code: "9121" },
            { ...base, id: randomUUID(), parentCode: "9121", code: "9130" },
          ],
        } as Snapshot,
        reason: "parent_cycle",
      },
    ];
    for (const { label, bad, reason } of cases) {
      expect(validateSnapshot(JSON.parse(JSON.stringify(bad))).ok, label).toBe(false);
      await expect(applyPairingSnapshot(bad, "https://pos.example.com", {}), label).rejects.toThrow(
        `account_tree_${reason}`,
      );
      expect(await localBusinessCount(businessId), label).toBe(0);
      expect(await localAccounts(businessId), label).toEqual([]);
    }
  }, 120_000);

  it("keeps two businesses that share codes apart on one device", async () => {
    await useDatabase(serverDb);
    const first = await snapshotWithChart("شرکت اول", async (id) => {
      await withTenant(id, async () => {
        await createAccount({ businessId: id, code: "9500", name: "اول", type: "asset" });
      });
    });
    await useDatabase(serverDb);
    const second = await snapshotWithChart("شرکت دوم", async (id) => {
      await withTenant(id, async () => {
        await createAccount({ businessId: id, code: "9500", name: "دوم", type: "liability" });
      });
    });

    await useDatabase(localDb);
    await applyPairingSnapshot(first.snapshot, "https://pos.example.com", {});
    await applyPairingSnapshot(second.snapshot, "https://pos.example.com", {});

    expect(await localAccounts(first.businessId)).toEqual([
      { code: "9500", level: "group", is_active: true, parent_code: null },
    ]);
    expect(await localAccounts(second.businessId)).toEqual([
      { code: "9500", level: "group", is_active: true, parent_code: null },
    ]);
    // The same code resolves to each business's own row, by name. (Row-level
    // isolation for a non-superuser runtime role is asserted separately, in
    // chart-of-accounts.integration.test.ts; this pool owns the tables.)
    const c = localClient();
    await c.connect();
    try {
      const { rows } = await c.query<{ business_id: string; name: string; type: string }>(
        `SELECT business_id, name, type::text AS type FROM accounts WHERE code = '9500' ORDER BY name`,
      );
      expect(rows).toEqual([
        { business_id: first.businessId, name: "اول", type: "asset" },
        { business_id: second.businessId, name: "دوم", type: "liability" },
      ]);
    } finally {
      await c.end();
    }
  }, 180_000);
});
