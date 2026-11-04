/**
 * Issue #807 — the deployment-role boundary and tenant-artifact isolation,
 * proved against a real multi-tenant database.
 *
 * The audit's critical finding was architectural: on a **central** deployment
 * one tenant's "backup" ran a privileged whole-database `pg_dump`, so the
 * artifact necessarily contained every other tenant. The fix is asserted here
 * the only way it can be: with two businesses' rows actually sitting in the
 * same tables, take business A's backup on a central deployment and read the
 * artifact back — it must be a logical SQL snapshot, carry A's scope tag, and
 * contain A's rows and *nothing* of B's.
 *
 * The same database drives the rest of the boundary: the site worker refuses to
 * run, a tenant-facing restore refuses outright, and the cloud destination
 * refuses both a physical `.dump` and another scope's snapshot before any S3
 * credential is touched.
 *
 * RLS is the actual filter, so the pool has to run as the unprivileged app role
 * — exactly as `tenant-export.integration.test.ts` explains.
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { decryptFileToFile } from "../src/lib/backup-streams";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_backup_iso_role";
const APP_PASSWORD = "backup-iso-password";

let dbName: string;
let workDir: string;
let seed: Client;
let svc: typeof import("../src/lib/backup-service");
let dbLib: typeof import("../src/lib/db");
let policy: typeof import("../src/lib/backup-policy");
let custodyKeys: typeof import("../src/lib/tenant-backup-artifacts-service");
let artifactNaming: typeof import("../src/lib/backup");

const bizA = { id: "", locationId: "" };
const bizB = { id: "", locationId: "" };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

beforeAll(async () => {
  dbName = `pos_bkp_iso_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-tenant-iso-"));

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
  const a = await seed.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Alpha Co', $1) RETURNING id",
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  bizA.id = a.rows[0].id;
  const locA = await seed.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Alpha Main') RETURNING id",
    [bizA.id],
  );
  bizA.locationId = locA.rows[0].id;
  const catA = await seed.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Alpha Category') RETURNING id",
    [bizA.locationId],
  );
  await seed.query(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'Alpha Item', 12345)",
    [bizA.locationId, catA.rows[0].id],
  );

  const b = await seed.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Beta Co', $1) RETURNING id",
    [`beta-${randomUUID().slice(0, 8)}`],
  );
  bizB.id = b.rows[0].id;
  const locB = await seed.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Beta Main') RETURNING id",
    [bizB.id],
  );
  bizB.locationId = locB.rows[0].id;
  const catB = await seed.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Beta Category') RETURNING id",
    [bizB.locationId],
  );
  await seed.query(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'Beta Item', 99999)",
    [bizB.locationId, catB.rows[0].id],
  );

  // The app pool runs as the unprivileged role, so RLS really filters.
  process.env.DATABASE_URL = urlFor(dbName, { name: APP_ROLE, password: APP_PASSWORD });
  process.env.DEPLOYMENT_ROLE = "central";
  process.env.BACKUP_DIR = path.join(workDir, "backups");
  delete process.env.BACKUP_SECONDARY_DIR;
  // Issue #903: a managed artifact's manifest is signed with the platform KEK
  // and its key is minted under it, so the suite runs the way a managed install
  // does instead of leaving the service unconfigured.
  process.env.POS_MASTER_KEY = randomBytes(32).toString("base64");

  dbLib = await import("../src/lib/db");
  svc = await import("../src/lib/backup-service");
  policy = await import("../src/lib/backup-policy");
  artifactNaming = await import("../src/lib/backup");
  custodyKeys = await import("../src/lib/tenant-backup-artifacts-service");
}, 240_000);

afterAll(async () => {
  await seed?.end().catch(() => {});
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.DEPLOYMENT_ROLE;
  delete process.env.BACKUP_DIR;
  delete process.env.POS_MASTER_KEY;
  await fs.rm(workDir, { recursive: true, force: true });

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

/** Everything a service call expects to run inside one business's RLS scope. */
function asTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

/**
 * The passphrase a self-hosted install protects its artifacts with.
 *
 * Issue #903 refuses to write an artifact when neither the platform's managed
 * custody nor the Owner's passphrase exists — "no plaintext artifacts" — so a
 * configured install always has one of the two. This suite holds a platform key
 * (managed custody wins) and carries the passphrase as the documented fallback.
 */
const PASSPHRASE = "isolation-test-passphrase";

/** A local backup config for an install with a key and a passphrase. */
function localConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    intervalHours: 24,
    anchorTime: "03:30",
    localRetention: 5,
    directory: "",
    passphrase: PASSPHRASE,
    encryptLocal: true,
    ...overrides,
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
      ...((overrides.cloud as Record<string, unknown>) ?? {}),
    },
  } as Parameters<typeof svc.setBackupConfig>[1];
}

describe("central tenant backups are logical and tenant-only", () => {
  it("writes a scoped .sql snapshot containing A's rows and none of B's", async () => {
    await asTenant(bizA.id, () => svc.setBackupConfig(bizA.id, localConfig()));
    const result = await asTenant(bizA.id, () => svc.runLocalBackup(bizA.id, "manual"));
    expect(result.status === "ok" ? "ok" : JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;

    // The artifact grammar itself records what it is and whose it is.
    expect(result.mode).toBe("logical");
    expect(result.artifact.endsWith(".sql.enc")).toBe(true);
    const parsed = artifactNaming.parseArtifactName(result.artifact);
    expect(parsed?.format).toBe("sql");
    expect(parsed?.encrypted).toBe(true);
    expect(parsed?.scope).toBe(artifactNaming.artifactScopeTag(bizA.id));
    expect(parsed?.runId).toBeTruthy();

    // …and central puts it under the business's own directory, not the flat one.
    const dir = svc.tenantBackupDir(bizA.id);
    expect(dir).toContain(path.join("tenants", artifactNaming.artifactScopeTag(bizA.id)));

    // The bytes on disk are ciphertext — the payload is not readable as it sits
    // there, which is what "no plaintext artifacts" means — so the scope check
    // reads the artifact the only way a recovery would: decrypt it first.
    const onDisk = await fs.readFile(path.join(dir, result.artifact));
    expect(onDisk.includes(Buffer.from("Alpha Item"))).toBe(false);

    const plainPath = path.join(workDir, "decrypted-archive.json");
    // The platform's custody generation is the secret this artifact was written
    // with: nothing has rotated in between, and the run just minted or reused
    // the active one.
    const custody = await custodyKeys.currentArtifactCustodyKey(bizA.id);
    if (!custody.ok) throw new Error(custody.error);
    await decryptFileToFile(path.join(dir, result.artifact), plainPath, custody.secret);
    const sql = await fs.readFile(plainPath, "utf8");

    expect(sql).toContain(bizA.id);
    expect(sql).toContain("Alpha Item");
    // The whole point: no trace of the other tenant in the same database.
    expect(sql).not.toContain(bizB.id);
    expect(sql).not.toContain("Beta Item");
    expect(sql).not.toContain("Beta Co");

    // The scope is recorded on the run row too, so the console can say what the
    // artifact contains without parsing its name.
    const runs = await asTenant(bizA.id, () => svc.listBackupRuns(bizA.id));
    expect(runs[0]?.scope).toBe("logical");
    expect(runs[0]?.artifact).toBe(result.artifact);
  });

  it("refuses the site physical worker before enumerating a single business", async () => {
    const dir = svc.tenantBackupDir(bizA.id);
    const before = (await fs.readdir(dir)).length;
    // The site worker is a no-op on central (and server.ts never schedules it
    // there); this is the second, server-side half of that boundary.
    await svc.runBackupTick();
    expect((await fs.readdir(dir)).length).toBe(before);
    expect(policy.tenantPhysicalDumpAllowed("central")).toBe(false);
  });

  it("refuses a tenant-facing restore outright", async () => {
    expect(await asTenant(bizA.id, () => svc.restoreAvailable())).toBe(false);
    const runs = await asTenant(bizA.id, () => svc.listBackupRuns(bizA.id));
    const artifact = runs.find((r) => r.artifact)?.artifact ?? "";
    const outcome = await asTenant(bizA.id, () =>
      svc.restoreFromArtifact(bizA.id, { source: "local", artifact, apply: false }),
    );
    expect(outcome.status).toBe("failed");
    expect("error" in outcome ? outcome.error : "").toBe("physical_tenant_restore_forbidden_on_central");
  });
});

describe("a tenant's destinations can never receive another tenant's data", () => {
  it("refuses a physical dump and a foreign-scope snapshot before any S3 call", async () => {
    // Cloud enabled with dummy credentials: the admission guard must fire
    // *before* the endpoint is ever contacted, so these refusals cannot depend
    // on a reachable bucket.
    await asTenant(bizA.id, () =>
      svc.setBackupConfig(
        bizA.id,
        localConfig({
          cloud: {
            enabled: true,
            endpoint: "http://127.0.0.1:9/never-contacted",
            bucket: "bucket",
            accessKeyId: "key",
            secretAccessKey: "secret",
          },
        }),
      ),
    );

    const physical = await asTenant(bizA.id, () =>
      svc.runCloudUpload(bizA.id, "pos-backup-20260101-000000.dump", "manual"),
    );
    expect(physical.status).toBe("failed");
    expect("error" in physical ? physical.error : "").toBe(
      policy.PHYSICAL_TENANT_BACKUP_FORBIDDEN,
    );

    // A logical snapshot whose scope tag belongs to the *other* business is
    // refused as well: "it's a .sql" is not enough, it has to be *this*
    // tenant's.
    const foreignScope = artifactNaming.artifactScopeTag(bizB.id);
    const foreign = await asTenant(bizA.id, () =>
      svc.runCloudUpload(bizA.id, `pos-backup-${foreignScope}-20260101-000000-abcdef01.sql`, "manual"),
    );
    expect(foreign.status).toBe("failed");
    expect("error" in foreign ? foreign.error : "").toBe("artifact_scope_mismatch");
  });
});
