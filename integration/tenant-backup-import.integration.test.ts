/**
 * Issue #903 §2 item 4 / §6 — restoring a business from a **backup file**.
 *
 * The scenario the epic insists on, played out on a real database: the business
 * has a managed backup; the Owner downloads the payload and its signed manifest;
 * the platform then loses the inventory row (a reimaged server, a migration, a
 * restore done from a laptop). The file on the laptop still has to restore the
 * business — and nothing but that file may decide whether it is allowed to.
 *
 * So this suite:
 *
 *  • takes a real managed backup of A and copies the ciphertext out of the
 *    server's directory, exactly as a download would;
 *  • deletes A's inventory rows, which is the "we no longer know about it" state;
 *  • imports the file with its manifest, gets a fresh opaque reference back;
 *  • previews and applies that reference through the ordinary engine, and proves
 *    A's data is the backup's data again;
 *  • and refuses the three forgeries that matter: a tampered payload, another
 *    business's genuine manifest, and a manifest with no valid signature.
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../src/lib/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_import_role";
const APP_PASSWORD = "import-password";

let dbName: string;
let workDir: string;
let seed: Client;
let dbLib: typeof import("../src/lib/db");
let svc: typeof import("../src/lib/backup-service");
let inventory: typeof import("../src/lib/tenant-backup-artifacts-service");
let refs: typeof import("../src/lib/tenant-backup-artifact-ref");
let imports: typeof import("../src/lib/tenant-backup-import");
let restores: typeof import("../src/lib/tenant-restore-apply");

const bizA = { id: "", locationId: "", categoryId: "", itemId: "", ownerId: "" };
const bizB = { id: "", locationId: "", categoryId: "", itemId: "", ownerId: "" };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

async function owner(text: string, params: unknown[] = []) {
  return seed.query(text, params);
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
  const locationId = location.rows[0].id as string;
  const user = await owner(
    "INSERT INTO users (business_id, location_id, role, full_name, email) VALUES ($1,$2,'owner',$3,$4) RETURNING id",
    [id, locationId, `${name} Owner`, `owner-${randomUUID().slice(0, 8)}@example.com`],
  );
  const category = await owner("INSERT INTO menu_categories (location_id, name) VALUES ($1,$2) RETURNING id", [
    locationId,
    `${name} Category`,
  ]);
  const categoryId = category.rows[0].id as string;
  const item = await owner(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1,$2,$3,$4) RETURNING id",
    [locationId, categoryId, `${name} Item`, 12345],
  );
  return { id, locationId, categoryId, itemId: item.rows[0].id as string, ownerId: user.rows[0].id as string };
}

function asTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

const ACTOR = {
  canRestore: true,
  mfaSatisfied: true,
  reauthenticatedAt: new Date().toISOString(),
};

beforeAll(async () => {
  dbName = `pos_import_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-import-"));

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(dbName), quiet: true });
  await createAppRole({ databaseUrl: urlFor(dbName), roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });

  seed = new Client({ connectionString: urlFor(dbName) });
  await seed.connect();

  Object.assign(bizA, await makeBusiness("Alpha Co"));
  Object.assign(bizB, await makeBusiness("Beta Co"));

  process.env.DATABASE_URL = urlFor(dbName, { name: APP_ROLE, password: APP_PASSWORD });
  process.env.DEPLOYMENT_ROLE = "central";
  process.env.BACKUP_DIR = path.join(workDir, "backups");
  process.env.TENANT_BACKUP_STAGING_DIR = path.join(workDir, "staging");
  process.env.RESTORE_JOURNAL_DIR = path.join(workDir, "journal");
  process.env.POS_MASTER_KEY = randomBytes(32).toString("base64");

  dbLib = await import("../src/lib/db");
  svc = await import("../src/lib/backup-service");
  inventory = await import("../src/lib/tenant-backup-artifacts-service");
  refs = await import("../src/lib/tenant-backup-artifact-ref");
  imports = await import("../src/lib/tenant-backup-import");
  restores = await import("../src/lib/tenant-restore-apply");
}, 300_000);

afterAll(async () => {
  await seed?.end().catch(() => {});
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.DEPLOYMENT_ROLE;
  delete process.env.BACKUP_DIR;
  delete process.env.TENANT_BACKUP_STAGING_DIR;
  delete process.env.RESTORE_JOURNAL_DIR;
  delete process.env.POS_MASTER_KEY;
  await fs.rm(workDir, { recursive: true, force: true });

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await dropAppRole(maintenance, APP_ROLE);
  } finally {
    await maintenance.end();
  }
});

/** A managed logical backup of both businesses; returns each one's reference. */
async function backup(biz: typeof bizA): Promise<{ ref: string; artifact: string }> {
  const run = await asTenant(biz.id, () => svc.runLocalBackup(biz.id, "manual"));
  if (run.status !== "ok") throw new Error(JSON.stringify(run));
  const rows = await asTenant(biz.id, () => inventory.listStoredArtifactRows(biz.id));
  const row = rows.find((candidate) => candidate.storageRef === run.artifact && candidate.destination === "local");
  if (!row) throw new Error("no inventory row");
  return { ref: refs.tenantBackupArtifactRef(biz.id, row.destination, row.storageRef), artifact: run.artifact };
}

/** What the Owner gets when they download: the payload and the manifest file. */
async function download(businessId: string, ref: string): Promise<{ payloadPath: string; manifestText: string }> {
  // Both calls run inside the tenant's scope, exactly as the routes do: the
  // services read through RLS rather than filtering by hand.
  const manifest = await asTenant(businessId, () => imports.recoveryManifestFor(businessId, ref));
  if (!manifest.ok) throw new Error(manifest.error);
  const row = await asTenant(businessId, () => inventory.resolveOwnedArtifact(businessId, ref));
  if (!row) throw new Error("artifact_not_found");
  const source = path.join(process.env.BACKUP_DIR!, "tenants", row.storageRef);
  const payloadPath = path.join(workDir, `download-${randomUUID()}.enc`);
  // A real download streams the bytes out of the tenant directory; a copy is the
  // same bytes in a place this test controls.
  await fs.cp(await findStoredFile(businessId, row.storageRef), payloadPath);
  void source;
  return { payloadPath, manifestText: manifest.text };
}

async function findStoredFile(businessId: string, storageRef: string): Promise<string> {
  const dirs = await fs.readdir(path.join(process.env.BACKUP_DIR!, "tenants"));
  for (const dir of dirs) {
    const candidate = path.join(process.env.BACKUP_DIR!, "tenants", dir, storageRef);
    try {
      await fs.stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`no stored file for ${businessId}: ${storageRef}`);
}

describe("restoring a business from a file the Owner kept", () => {
  it("imports a downloaded backup after its inventory row is gone, and restores it", async () => {
    const a = await backup(bizA);
    const saved = await download(bizA.id, a.ref);

    // The owner edits the business *after* the backup, so the restore has
    // something visible to undo.
    await owner("UPDATE menu_items SET name = 'Alpha Item (edited)' WHERE id = $1", [bizA.itemId]);

    // The platform loses the inventory row: a reimaged server, a migration, or a
    // restore done on another installation. The file on the laptop is all that is
    // left of the backup.
    await owner("DELETE FROM tenant_backup_artifacts WHERE business_id = $1", [bizA.id]);
    expect(await asTenant(bizA.id, () => inventory.listStoredArtifactRows(bizA.id))).toHaveLength(0);

    const imported = await asTenant(bizA.id, () =>
      imports.importRecoveryFile({
        businessId: bizA.id,
        uploadPath: saved.payloadPath,
        manifestText: saved.manifestText,
      }),
    );
    expect(imported.ok ? "ok" : JSON.stringify(imported)).toBe("ok");
    if (!imported.ok) return;

    // The import registers a restore source — it does not restore anything.
    const edited = await owner("SELECT name FROM menu_items WHERE id = $1", [bizA.itemId]);
    expect(edited.rows[0].name).toBe("Alpha Item (edited)");

    const row = await asTenant(bizA.id, () => inventory.resolveOwnedArtifact(bizA.id, imported.ref));
    expect(row?.state).toBe("ready");
    expect(row?.origin).toBe("uploaded");
    expect(row?.manifest?.payload.sha256).toBeTruthy();

    const previewed = await asTenant(bizA.id, () =>
      inventory.previewOwnedRestore(bizA.id, imported.ref, { role: "central", profile: "cloud", actor: ACTOR }),
    );
    if ("error" in previewed) throw new Error(previewed.error);
    expect(previewed.preview.canApply).toBe(true);

    const applied = await asTenant(bizA.id, () =>
      restores.applyTenantRestore({
        businessId: bizA.id,
        ref: imported.ref,
        deployment: { role: "central", profile: "cloud" },
        preview: previewed.preview,
        typedConfirmation: previewed.preview.confirmationPhrase,
        minutesSinceReauthentication: 1,
      }),
    );
    expect(applied.ok ? "ok" : JSON.stringify(applied)).toBe("ok");

    // The file restored the business: the post-backup edit is gone.
    const restored = await owner("SELECT name, price FROM menu_items WHERE id = $1", [bizA.itemId]);
    expect(restored.rows[0]).toEqual({ name: "Alpha Co Item", price: "12345" });
    // …and B, which shares every table, is untouched.
    const b = await owner("SELECT name FROM menu_items WHERE id = $1", [bizB.itemId]);
    expect(b.rows[0].name).toBe("Beta Co Item");
  }, 240_000);

  it("refuses a payload that is not the one the manifest signed", async () => {
    const b = await backup(bizB);
    const saved = await download(bizB.id, b.ref);
    const tampered = path.join(workDir, `tampered-${randomUUID()}.enc`);
    const bytes = await fs.readFile(saved.payloadPath);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await fs.writeFile(tampered, bytes);

    const imported = await asTenant(bizB.id, () =>
      imports.importRecoveryFile({ businessId: bizB.id, uploadPath: tampered, manifestText: saved.manifestText }),
    );
    expect(imported).toEqual({ ok: false, error: "recovery_checksum_mismatch" });
    // Nothing was registered from a file that is not the backup.
    const rows = await asTenant(bizB.id, () => inventory.listStoredArtifactRows(bizB.id));
    expect(rows.some((row) => row.origin === "uploaded")).toBe(false);
  }, 240_000);

  it("refuses another business's genuine manifest", async () => {
    const b = await backup(bizB);
    const saved = await download(bizB.id, b.ref);
    const imported = await asTenant(bizA.id, () =>
      imports.importRecoveryFile({ businessId: bizA.id, uploadPath: saved.payloadPath, manifestText: saved.manifestText }),
    );
    expect(imported).toEqual({ ok: false, error: "recovery_file_not_owned_by_business" });
  }, 240_000);

  it("refuses a manifest nobody signed", async () => {
    const b = await backup(bizB);
    const saved = await download(bizB.id, b.ref);
    const parsed = JSON.parse(saved.manifestText) as { manifest: { capturedAt: string }; manifestSignature: string };
    parsed.manifest.capturedAt = new Date("2020-01-01T00:00:00Z").toISOString();
    const imported = await asTenant(bizB.id, () =>
      imports.importRecoveryFile({
        businessId: bizB.id,
        uploadPath: saved.payloadPath,
        manifestText: JSON.stringify(parsed),
      }),
    );
    expect(imported).toEqual({ ok: false, error: "recovery_manifest_signature_invalid" });
  }, 240_000);
});
