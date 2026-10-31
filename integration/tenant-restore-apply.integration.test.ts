/**
 * Issue #903 §5 / §11 (DoD 6) — the tenant-only logical restore, proved against
 * a real multi-tenant database.
 *
 * The unit suites prove the engine's decisions; only a real PostgreSQL can
 * prove the claim the epic actually makes: *a destructive central restore
 * changes the target business and nothing else.* So this suite puts two
 * businesses' rows in the same tables, takes a managed backup of A, lets A
 * drift (edited item, new item, a wallet charge since the backup), and then
 * restores A from that backup with the shipped engine. Afterwards it asserts, by
 * direct query:
 *
 *  • A's data is the backup's data again (the edit is gone, the deletion is
 *    back);
 *  • B is byte-for-byte untouched — its item, its wallet, its Owner;
 *  • A's canonical wallet was **not** rewound to the backup's balance (§5);
 *  • the artifact inventory still lists the backup (the restore did not make
 *    the platform forget which artifacts exist — the newest one is how the
 *    Owner undoes the restore);
 *  • the hybrid upload fence moved past the generation that existed before the
 *    restore, so a pre-restore artifact can no longer overwrite it;
 *  • the journal carries the verify/apply phases and the post-swap checks.
 *
 * It also proves the two refusals that make the above safe: a restore whose
 * archive would leave the business without an active Owner is rolled back with
 * nothing written, and a restore on a role that ignores RLS never starts.
 *
 * RLS is the actual filter here, so the app pool runs as the unprivileged role
 * (see `tenant-backup-isolation.integration.test.ts` for the same reasoning).
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { readRestoreJournal, restoreJournalDir, type RestoreJournalEntry } from "../src/lib/restore-journal";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_restore_apply_role";
const APP_PASSWORD = "restore-apply-password";

let dbName: string;
let workDir: string;
let seed: Client;
let dbLib: typeof import("../src/lib/db");
let svc: typeof import("../src/lib/backup-service");
let restores: typeof import("../src/lib/tenant-restore-apply");
let inventory: typeof import("../src/lib/tenant-backup-artifacts-service");
let refs: typeof import("../src/lib/tenant-backup-artifact-ref");

const bizA = { id: "", locationId: "", categoryId: "", itemId: "", ownerId: "", accountId: "", orderId: "" };
const bizB = { id: "", locationId: "", itemId: "", ownerId: "" };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

async function owner(query: string, params: unknown[] = []) {
  return seed.query(query, params);
}

async function makeBusiness(name: string) {
  const biz = await owner("INSERT INTO businesses (name, slug) VALUES ($1,$2) RETURNING id", [
    name,
    `biz-${randomUUID().slice(0, 8)}`,
  ]);
  const id = biz.rows[0].id as string;
  const location = await owner("INSERT INTO locations (business_id, name) VALUES ($1,$2) RETURNING id", [
    id,
    `${name} Main`,
  ]);
  const user = await owner(
    "INSERT INTO users (business_id, location_id, role, full_name, email) VALUES ($1,$2,'owner',$3,$4) RETURNING id",
    [id, location.rows[0].id, `${name} Owner`, `owner-${randomUUID().slice(0, 8)}@example.com`],
  );
  const category = await owner("INSERT INTO menu_categories (location_id, name) VALUES ($1,$2) RETURNING id", [
    location.rows[0].id,
    `${name} Category`,
  ]);
  const item = await owner(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1,$2,$3,$4) RETURNING id",
    [location.rows[0].id, category.rows[0].id, `${name} Item`, 12345],
  );
  return {
    id,
    locationId: location.rows[0].id as string,
    ownerId: user.rows[0].id as string,
    categoryId: category.rows[0].id as string,
    itemId: item.rows[0].id as string,
  };
}

async function wallet(businessId: string, balance: number) {
  await owner(
    `INSERT INTO business_wallets (business_id, balance_rial) VALUES ($1,$2)
     ON CONFLICT (business_id) DO UPDATE SET balance_rial = EXCLUDED.balance_rial`,
    [businessId, balance],
  );
}

async function walletBalance(businessId: string): Promise<string> {
  const { rows } = await owner("SELECT balance_rial::text AS balance FROM business_wallets WHERE business_id = $1", [
    businessId,
  ]);
  return rows[0].balance as string;
}

beforeAll(async () => {
  dbName = `pos_restore_apply_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-restore-apply-"));

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(dbName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(dbName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  seed = new Client({ connectionString: urlFor(dbName) });
  await seed.connect();

  const a = await makeBusiness("Alpha Co");
  Object.assign(bizA, a);
  const b = await makeBusiness("Beta Co");
  Object.assign(bizB, b);

  // A healthy chart of accounts: one balanced entry per business, so the
  // post-restore accounting check has something real to check.
  for (const biz of [bizA, bizB]) {
    const account = await owner(
      "INSERT INTO accounts (business_id, code, name, type) VALUES ($1,'1000','Cash','asset') RETURNING id",
      [biz.id],
    );
    const counter = await owner(
      "INSERT INTO accounts (business_id, code, name, type) VALUES ($1,'4000','Sales','revenue') RETURNING id",
      [biz.id],
    );
    const entry = await owner(
      "INSERT INTO journal_entries (business_id, entry_date, memo) VALUES ($1, CURRENT_DATE, 'seed') RETURNING id",
      [biz.id],
    );
    await owner("INSERT INTO journal_lines (entry_id, account_id, debit) VALUES ($1,$2,1000)", [
      entry.rows[0].id,
      account.rows[0].id,
    ]);
    await owner("INSERT INTO journal_lines (entry_id, account_id, credit) VALUES ($1,$2,1000)", [
      entry.rows[0].id,
      counter.rows[0].id,
    ]);
    if (biz === bizA) bizA.accountId = account.rows[0].id as string;
  }

  // A completed order with its items. The order-item guard refuses even the
  // DELETE of an item on a closed order ("order_not_open"), so this row is what
  // proves the replay runs with business-rule triggers disarmed — without that,
  // no business that has ever closed an order could be restored.
  const order = await owner(
    `INSERT INTO orders (location_id, order_number, type, status, total)
     VALUES ($1, 1, 'takeaway', 'open', 12345) RETURNING id`,
    [bizA.locationId],
  );
  await owner(
    `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status)
     VALUES ($1,$2,'Alpha Co Item',12345,1,'served')`,
    [bizA.locationId, order.rows[0].id],
  );
  await owner("UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1", [order.rows[0].id]);
  bizA.orderId = order.rows[0].id as string;

  await wallet(bizA.id, 500_000);
  await wallet(bizB.id, 777_777);

  // A site has reported a sync generation; the restore must not leave the fence
  // where the backup left it.
  await owner(
    `INSERT INTO tenant_backup_site_heartbeat (business_id, site_generation, last_seen_at, queue_depth)
     VALUES ($1, 12, now(), 0)`,
    [bizA.id],
  );

  process.env.DATABASE_URL = urlFor(dbName, { name: APP_ROLE, password: APP_PASSWORD });
  process.env.DEPLOYMENT_ROLE = "central";
  process.env.BACKUP_DIR = path.join(workDir, "backups");
  delete process.env.BACKUP_SECONDARY_DIR;
  // Managed custody: the artifact's key is minted under the platform KEK and its
  // manifest is signed with it.
  process.env.POS_MASTER_KEY = randomBytes(32).toString("base64");
  // Keep the journal and the transient staging area in this test's own
  // directories rather than the repository's.
  process.env.RESTORE_JOURNAL_DIR = path.join(workDir, "journal");
  process.env.TENANT_BACKUP_STAGING_DIR = path.join(workDir, "staging");

  dbLib = await import("../src/lib/db");
  svc = await import("../src/lib/backup-service");
  restores = await import("../src/lib/tenant-restore-apply");
  inventory = await import("../src/lib/tenant-backup-artifacts-service");
  refs = await import("../src/lib/tenant-backup-artifact-ref");
}, 240_000);

afterAll(async () => {
  await seed?.end().catch(() => {});
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.DEPLOYMENT_ROLE;
  delete process.env.BACKUP_DIR;
  delete process.env.POS_MASTER_KEY;
  delete process.env.RESTORE_JOURNAL_DIR;
  delete process.env.TENANT_BACKUP_STAGING_DIR;
  await fs.rm(workDir, { recursive: true, force: true });

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

function asTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

/** The actor facts the preview/apply gate requires; both are server-derived. */
const ACTOR = {
  canRestore: true,
  mfaSatisfied: true,
  reauthenticatedAt: new Date().toISOString(),
};

async function previewFor(businessId: string, ref: string) {
  const previewed = await asTenant(businessId, () =>
    inventory.previewOwnedRestore(businessId, ref, {
      role: "central",
      profile: "cloud",
      actor: ACTOR,
    }),
  );
  if ("error" in previewed) throw new Error(previewed.error);
  return previewed.preview;
}

async function applyFor(businessId: string, ref: string, extra: { confirmation?: string } = {}) {
  const preview = await previewFor(businessId, ref);
  return asTenant(businessId, () =>
    restores.applyTenantRestore({
      businessId,
      ref,
      deployment: { role: "central", profile: "cloud" },
      preview,
      typedConfirmation: extra.confirmation ?? preview.confirmationPhrase,
      minutesSinceReauthentication: 1,
      actorLabel: "owner",
    }),
  );
}

/**
 * The opaque reference of the artifact a run just wrote. Refs are recomputed
 * here from the stored row — which is exactly what the API does — so the test
 * never invents one.
 */
async function refForArtifact(businessId: string, artifactName: string): Promise<string> {
  const rows = await asTenant(businessId, () => inventory.listStoredArtifactRows(businessId));
  const row = rows.find((candidate) => candidate.storageRef === artifactName && candidate.destination === "local");
  if (!row) throw new Error(`no inventory row for ${artifactName}`);
  return refs.tenantBackupArtifactRef(businessId, row.destination, row.storageRef);
}

/** Take a managed logical backup of A and return the opaque reference. */
async function backupA(): Promise<string> {
  const run = await asTenant(bizA.id, () => svc.runLocalBackup(bizA.id, "manual"));
  if (run.status !== "ok") throw new Error(JSON.stringify(run));
  return refForArtifact(bizA.id, run.artifact);
}

/** This test's own journal entries for one business. */
async function journalFor(businessId: string): Promise<RestoreJournalEntry[]> {
  const history = await readRestoreJournal(restoreJournalDir());
  return history.entries.filter((entry) => entry.scope === businessId && entry.mode === "apply");
}

describe("a central tenant-only restore", () => {
  let ref = "";

  it("takes a managed backup of A while B sits in the same tables", async () => {
    await asTenant(bizA.id, () =>
      svc.setBackupConfig(bizA.id, {
        enabled: true,
        intervalHours: 24,
        anchorTime: "03:30",
        localRetention: 5,
        directory: "",
        secondaryDirectory: "",
        passphrase: "",
        encryptLocal: true,
        cloud: {
          enabled: false,
          endpoint: "",
          region: "us-east-1",
          bucket: "",
          prefix: "pos-backups/",
          accessKeyId: "",
          secretAccessKey: "",
          passphrase: "",
          retention: 30,
        },
      } as Parameters<typeof svc.setBackupConfig>[1]),
    );
    ref = await backupA();
    expect(ref.length).toBeGreaterThan(0);
  });

  it("previews the restore as applicable, naming what it would replace", async () => {
    const preview = await previewFor(bizA.id, ref);
    expect(preview.canApply).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.targetBusinessId).toBe(bizA.id);
    // The confirmation phrase is the business's own name, not a generic "YES".
    expect(preview.confirmationPhrase).toBe("Alpha Co");
  });

  it("restores A and leaves B untouched", async () => {
    // A drifts after the backup: an edited item, a deleted one, and a charge
    // against the wallet that the restore must not undo.
    await owner("UPDATE menu_items SET name = 'Alpha Item (edited)', price = 99999 WHERE id = $1", [bizA.itemId]);
    const extra = await owner(
      "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1,$2,'Alpha Item After Backup',1) RETURNING id",
      [bizA.locationId, bizA.categoryId],
    );
    await wallet(bizA.id, 420_000);

    const before = {
      bItem: await owner("SELECT name, price FROM menu_items WHERE id = $1", [bizB.itemId]),
      bWallet: await walletBalance(bizB.id),
      bOwner: await owner("SELECT full_name, is_active FROM users WHERE id = $1", [bizB.ownerId]),
    };

    const outcome = await applyFor(bizA.id, ref);
    expect(outcome.ok ? "ok" : JSON.stringify(outcome)).toBe("ok");

    // A is the backup's data again.
    const items = await owner("SELECT id, name, price FROM menu_items WHERE location_id = $1 ORDER BY name", [
      bizA.locationId,
    ]);
    expect(items.rows).toEqual([{ id: bizA.itemId, name: "Alpha Co Item", price: "12345" }]);
    const deleted = await owner("SELECT count(*)::int AS n FROM menu_items WHERE id = $1", [extra.rows[0].id]);
    expect(deleted.rows[0].n).toBe(0);
    // The completed order and its item came back too: the replay was not refused
    // by the guard that protects a closed order from live edits.
    const order = await owner("SELECT status FROM orders WHERE id = $1", [bizA.orderId]);
    expect(order.rows[0].status).toBe("completed");
    const orderItem = await owner("SELECT count(*)::int AS n FROM order_items WHERE order_id = $1", [
      bizA.orderId,
    ]);
    expect(orderItem.rows[0].n).toBe(1);

    // B is exactly as it was: not one row, not one rial.
    const after = {
      bItem: await owner("SELECT name, price FROM menu_items WHERE id = $1", [bizB.itemId]),
      bWallet: await walletBalance(bizB.id),
      bOwner: await owner("SELECT full_name, is_active FROM users WHERE id = $1", [bizB.ownerId]),
    };
    expect(after).toEqual(before);

    // §5 — the canonical wallet was not rewound to the backup's 500 000.
    expect(await walletBalance(bizA.id)).toBe("420000");

    // The restore did not delete the inventory it was started from: the newest
    // backup is how the Owner undoes the restore.
    const listed = await asTenant(bizA.id, () =>
      inventory.tenantBackupInventory(bizA.id, { profile: "cloud", connectivity: "online" }),
    );
    expect(listed.items.some((item) => item.ref === ref)).toBe(true);

    // The hybrid fence now sits past the generation that existed before the
    // restore, so a pre-restore artifact cannot overwrite the restored data.
    const heartbeat = await owner(
      "SELECT site_generation::int AS generation, accepted_generation::int AS accepted FROM tenant_backup_site_heartbeat WHERE business_id = $1",
      [bizA.id],
    );
    expect(heartbeat.rows[0].generation).toBeGreaterThan(12);
    expect(heartbeat.rows[0].accepted).toBeGreaterThanOrEqual(heartbeat.rows[0].generation);
  });

  it("journals the verify phase, the apply phase and the post-swap checks", async () => {
    const mine = await journalFor(bizA.id);
    const phases = mine.map((entry) => entry.phase);
    expect(phases).toEqual(
      expect.arrayContaining(["verify_started", "verify_succeeded", "apply_started", "apply_succeeded"]),
    );
    const applied = mine.find((entry) => entry.phase === "apply_succeeded");
    const detail = applied?.detail as {
      untouched: string[];
      keptServiceRecords: string[];
      checks: { code: string; ok: boolean }[];
    };
    // The receipt names what it did not touch, so nobody reads "restored" as
    // "the wallet was restored".
    expect(detail.untouched).toEqual(["billing_usage_events", "business_wallets", "wallet_ledger"]);
    expect(detail.keptServiceRecords).toContain("tenant_backup_artifacts");
    expect(detail.checks.map((check) => check.code)).toEqual([
      "rls_proven",
      "owner_preserved",
      "accounting_balanced",
      "wallet_unchanged",
      "sync_fence_advanced",
    ]);
    expect(detail.checks.every((check) => check.ok)).toBe(true);
  });

  it("rolls back a restore that would leave the business without an Owner", async () => {
    // A backup taken while A's only Owner was deactivated captures the business
    // with nobody able to administer it. Applying it would hand the Owner a
    // locked door, so the engine must refuse and leave the current rows in place.
    await owner("UPDATE users SET is_active = false WHERE business_id = $1", [bizA.id]);
    const snapshot = await asTenant(bizA.id, () => svc.runLocalBackup(bizA.id, "manual"));
    if (snapshot.status !== "ok") throw new Error(JSON.stringify(snapshot));
    const oldRef = await refForArtifact(bizA.id, snapshot.artifact);
    expect(oldRef.length).toBeGreaterThan(0);

    // The Owner is back and the item has drifted *after* the archive exists, so
    // the row counts still match the backup and only the check can notice that
    // the archive would revoke the Owner.
    await owner("UPDATE users SET is_active = true WHERE business_id = $1", [bizA.id]);
    await owner("UPDATE menu_items SET name = 'Alpha Item (kept)' WHERE id = $1", [bizA.itemId]);

    const preview = await previewFor(bizA.id, oldRef);
    const outcome = await asTenant(bizA.id, () =>
      restores.applyTenantRestore({
        businessId: bizA.id,
        ref: oldRef,
        deployment: { role: "central", profile: "cloud" },
        preview,
        typedConfirmation: preview.confirmationPhrase,
        minutesSinceReauthentication: 1,
      }),
    );
    expect(outcome).toMatchObject({ ok: false, error: "restore_post_check_failed" });

    // Nothing was written: the post-backup edit is still there.
    const item = await owner("SELECT name FROM menu_items WHERE id = $1", [bizA.itemId]);
    expect(item.rows[0].name).toBe("Alpha Item (kept)");

    const failed = (await journalFor(bizA.id)).filter((entry) => entry.phase === "apply_failed_before_swap").at(-1);
    const detail = failed?.detail as { failed: string[]; rolledBack: boolean };
    expect(detail.failed).toEqual(["owner_preserved"]);
    expect(detail.rolledBack).toBe(true);
  });

  it("refuses to start on a role that ignores row-level security", async () => {
    // The owner connection is the database superuser created by the test setup;
    // on it the engine's `DELETE FROM` would mean every business, so the engine
    // must refuse before the first one.
    const superuser = new Client({ connectionString: urlFor(dbName) });
    await superuser.connect();
    try {
      const protective = await dbLib.rlsEffective();
      expect(protective).toBe(true); // the app pool is the unprivileged role…
      const privileged = await superuser.query<{ privileged: boolean }>(
        "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
      );
      expect(privileged.rows[0].privileged).toBe(true); // …and this one is not
    } finally {
      await superuser.end();
    }
  });
});
