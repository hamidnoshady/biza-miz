/**
 * The canonical migration-status service against a real Postgres.
 *
 * `src/lib/migration-status-service.test.ts` proves the classifier's pure
 * decisions; this file proves the I/O half against the real schema — that the
 * status the platform health surfaces show agrees with what the migration
 * runner actually does, that the gated cutover is detected from real rows, and
 * that nothing here can leak a credential.
 *
 * It also keeps the production incident from coming back: `/platform/system`
 * used to count unrecorded files and report the deliberately deferred
 * `0209_ai_gateway_secret_cutover.sql` as "running code is ahead of the
 * database — run npm run db:migrate".
 */
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { getMigrationStatus } from "../src/lib/migration-status-service";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../src/lib/integrations/secrets";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const CUTOVER = "0209_ai_gateway_secret_cutover.sql";
// `fileURLToPath`, not `URL.pathname`: the suite also runs on Windows, where
// `pathname` keeps the leading slash of a drive-letter path.
const REPO_MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");

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

/** Restore the legacy plaintext columns and a stored credential, as a pre-cutover deployment has. */
async function storeLegacyCredential(plaintext: string): Promise<void> {
  await db.query("ALTER TABLE platform_ai_gateway ADD COLUMN IF NOT EXISTS master_key text");
  await db.query("ALTER TABLE ai_business_gateway ADD COLUMN IF NOT EXISTS virtual_key text");
  const key = resolveEncryptionKey(process.env);
  await db.query("DELETE FROM platform_ai_gateway WHERE id = true");
  await db.query(
    `INSERT INTO platform_ai_gateway (id, base_url, master_key, master_key_ciphertext)
     VALUES (true, 'http://litellm:4000/v1', $1, $2)`,
    [plaintext, encryptSecret(plaintext, key)],
  );
}

beforeAll(async () => {
  databaseName = `pos_migration_status_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  // A clean, fully migrated database with no stored credential.
  await db.query("DELETE FROM ai_business_gateway");
  await db.query("DELETE FROM platform_ai_gateway WHERE id = true");
  await db.query("ALTER TABLE platform_ai_gateway DROP COLUMN IF EXISTS master_key");
  await db.query("ALTER TABLE ai_business_gateway DROP COLUMN IF EXISTS virtual_key");
  await db.query(
    `INSERT INTO schema_migrations (filename, checksum)
     SELECT '${CUTOVER}', 'x'
     WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '${CUTOVER}')`,
  );
});

describe("migration status against a real database", () => {
  it("reports nothing pending on a fully migrated database", async () => {
    const status = await getMigrationStatus({ migrationsDir: REPO_MIGRATIONS });
    expect(status.available).toBe(true);
    expect(status.pendingTotal).toBe(0);
    expect(status.ordinaryPending).toEqual([]);
    expect(status.gated).toEqual([]);
    expect(status.reasonCode).toBe("up_to_date");
    expect(status.appliedCount).toBeGreaterThan(10);
    expect(status.cutover.applied).toBe(true);
    expect(status.cutover.legacyColumnsPresent).toBe(false);
    expect(status.lastAppliedAt).toBeTruthy();
  });

  it("reports an ordinary pending migration that the runner would apply", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migration-status-extra-"));
    try {
      await cp(REPO_MIGRATIONS, dir, { recursive: true });
      await writeFile(join(dir, "9999_status_probe.sql"), "CREATE TABLE status_probe (id int);\n");
      const status = await getMigrationStatus({ migrationsDir: dir });
      expect(status.ordinaryPending.map((m) => m.filename)).toEqual(["9999_status_probe.sql"]);
      expect(status.ordinaryPending[0].reasonCode).toBe("ordinary_pending");
      expect(status.gated).toEqual([]);
      expect(status.pendingTotal).toBe(1);
      expect(status.reasonCode).toBe("ordinary_pending");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports 0209 as gated while a credential is still stored", async () => {
    await db.query("DELETE FROM schema_migrations WHERE filename = $1", [CUTOVER]);
    await storeLegacyCredential("sk-legacy-master");

    const status = await getMigrationStatus({ migrationsDir: REPO_MIGRATIONS });
    expect(status.gated.map((m) => m.filename)).toEqual([CUTOVER]);
    expect(status.gated[0].state).toBe("gated");
    expect(status.gated[0].reasonCode).toBe("ai_gateway_secret_cutover_awaiting_verification");
    expect(status.cutover.applied).toBe(false);
    expect(status.cutover.gated).toBe(true);
    expect(status.cutover.legacyColumnsPresent).toBe(true);
    expect(status.cutover.legacyPlaintextRows).toBe(1);
    expect(status.pendingTotal).toBe(1);
    expect(status.reasonCode).toBe("ai_gateway_secret_cutover_awaiting_verification");
  });

  it("shows ordinary and gated migrations as separate categories", async () => {
    await db.query("DELETE FROM schema_migrations WHERE filename = $1", [CUTOVER]);
    await storeLegacyCredential("sk-legacy-master");
    const dir = await mkdtemp(join(tmpdir(), "migration-status-mixed-"));
    try {
      await cp(REPO_MIGRATIONS, dir, { recursive: true });
      await writeFile(join(dir, "9999_status_probe.sql"), "CREATE TABLE status_probe (id int);\n");
      const status = await getMigrationStatus({ migrationsDir: dir });
      expect(status.gated.map((m) => m.filename)).toEqual([CUTOVER]);
      expect(status.ordinaryPending.map((m) => m.filename)).toEqual(["9999_status_probe.sql"]);
      expect(status.pendingTotal).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a plaintext credential that has not been backfilled", async () => {
    await db.query("DELETE FROM schema_migrations WHERE filename = $1", [CUTOVER]);
    await db.query("ALTER TABLE platform_ai_gateway ADD COLUMN IF NOT EXISTS master_key text");
    await db.query("DELETE FROM platform_ai_gateway WHERE id = true");
    await db.query(
      `INSERT INTO platform_ai_gateway (id, base_url, master_key)
       VALUES (true, 'http://litellm:4000/v1', 'sk-unbackfilled')`,
    );
    const status = await getMigrationStatus({ migrationsDir: REPO_MIGRATIONS });
    expect(status.cutover.rowsMissingCiphertext).toBe(1);
    expect(status.gated).toHaveLength(1);
  });

  it("reports a completed cutover with the legacy columns gone", async () => {
    await db.query("DELETE FROM schema_migrations WHERE filename = $1", [CUTOVER]);
    await storeLegacyCredential("sk-cutover-master");

    const previousVerified = process.env.AI_GATEWAY_SECRET_CUTOVER_VERIFIED;
    process.env.AI_GATEWAY_SECRET_CUTOVER_VERIFIED = "true";
    try {
      const run = await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
      expect(run.deferredMigrations).toEqual([]);
      expect(run.applied).toBeGreaterThanOrEqual(1);
    } finally {
      if (previousVerified === undefined) delete process.env.AI_GATEWAY_SECRET_CUTOVER_VERIFIED;
      else process.env.AI_GATEWAY_SECRET_CUTOVER_VERIFIED = previousVerified;
    }

    const status = await getMigrationStatus({ migrationsDir: REPO_MIGRATIONS });
    expect(status.cutover.applied).toBe(true);
    expect(status.cutover.gated).toBe(false);
    expect(status.cutover.reasonCode).toBe("ai_gateway_secret_cutover_applied");
    expect(status.cutover.legacyColumnsPresent).toBe(false);
    expect(status.gated).toEqual([]);
    expect(status.pendingTotal).toBe(0);

    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'platform_ai_gateway' AND column_name = 'master_key')
            OR (table_name = 'ai_business_gateway' AND column_name = 'virtual_key'))`,
    );
    expect(rows).toEqual([]);
  });

  it("agrees with the runner: gated exactly when the runner defers", async () => {
    await db.query("DELETE FROM schema_migrations WHERE filename = $1", [CUTOVER]);
    await storeLegacyCredential("sk-agree-master");
    const dir = await mkdtemp(join(tmpdir(), "migration-status-agree-"));
    try {
      await cp(REPO_MIGRATIONS, dir, { recursive: true });
      const gated = await getMigrationStatus({ migrationsDir: dir });
      expect(gated.gated.map((m) => m.filename)).toEqual([CUTOVER]);

      const deferred = await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: dir, quiet: true });
      expect(deferred.deferredMigrations).toEqual([CUTOVER]);

      // …and the runner's own guard still refuses the raw migration.
      const { readFile } = await import("node:fs/promises");
      const migration = await readFile(join(REPO_MIGRATIONS, CUTOVER), "utf8");
      await db.query("SELECT set_config('app.ai_gateway_secret_cutover_verified', 'false', false)");
      await db.query("BEGIN");
      try {
        await expect(db.query(migration)).rejects.toThrow(
          /ai_gateway_secret_runtime_verification_required/,
        );
      } finally {
        await db.query("ROLLBACK");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a later migration that names a legacy column as blocking the deferral", async () => {
    await db.query("DELETE FROM schema_migrations WHERE filename = $1", [CUTOVER]);
    await storeLegacyCredential("sk-block-master");
    const dir = await mkdtemp(join(tmpdir(), "migration-status-block-"));
    try {
      await cp(REPO_MIGRATIONS, dir, { recursive: true });
      await writeFile(
        join(dir, "9999_reads_master_key.sql"),
        "SELECT master_key FROM platform_ai_gateway LIMIT 0;\n",
      );
      const status = await getMigrationStatus({ migrationsDir: dir });
      expect(status.cutover.blockedBy).toBe("9999_reads_master_key.sql");
      expect(status.reasonCode).toBe("ai_gateway_secret_cutover_blocks_later_migration");

      await expect(
        runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: dir, quiet: true }),
      ).rejects.toThrow("ai_gateway_secret_cutover_deferred_blocks_later_migration:9999_reads_master_key.sql");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports an unreadable migration inventory as unknown, never as zero pending", async () => {
    const status = await getMigrationStatus({ migrationsDir: join(tmpdir(), "does-not-exist-xyz") });
    expect(status.available).toBe(false);
    expect(status.reasonCode).toBe("migration_inventory_unreadable");
    expect(status.pendingTotal).toBeNull();
    expect(status.ordinaryPending).toEqual([]);
    expect(status.gated).toEqual([]);
  });

  it("reports conflicting defer/verification settings", async () => {
    await db.query("DELETE FROM schema_migrations WHERE filename = $1", [CUTOVER]);
    await storeLegacyCredential("sk-conflict-master");
    const previous = {
      defer: process.env.AI_GATEWAY_SECRET_CUTOVER_DEFER,
      verified: process.env.AI_GATEWAY_SECRET_CUTOVER_VERIFIED,
    };
    process.env.AI_GATEWAY_SECRET_CUTOVER_DEFER = "true";
    process.env.AI_GATEWAY_SECRET_CUTOVER_VERIFIED = "true";
    try {
      const status = await getMigrationStatus({ migrationsDir: REPO_MIGRATIONS });
      expect(status.cutover.flagsConflict).toBe(true);
      expect(status.reasonCode).toBe("ai_gateway_secret_cutover_flags_conflict");
      expect(status.gated.map((m) => m.filename)).toEqual([CUTOVER]);
      expect(status.pendingTotal).toBe(1);
      await expect(
        runMigrations({ databaseUrl: urlFor(databaseName), quiet: true }),
      ).rejects.toThrow("ai_gateway_secret_cutover_flags_conflict");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("never returns credential material, only redacted counts", async () => {
    await db.query("DELETE FROM schema_migrations WHERE filename = $1", [CUTOVER]);
    await storeLegacyCredential("sk-super-secret-value");
    const status = await getMigrationStatus({ migrationsDir: REPO_MIGRATIONS });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("sk-super-secret-value");
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(status.cutover.legacyPlaintextRows).toBe(1);
    // The ciphertext that IS stored decrypts with this process's key — proving
    // the row really holds a credential — and still never reaches the status.
    const { rows } = await db.query<{ master_key_ciphertext: string }>(
      "SELECT master_key_ciphertext FROM platform_ai_gateway WHERE id = true",
    );
    expect(decryptSecret(rows[0].master_key_ciphertext, resolveEncryptionKey(process.env))).toBe(
      "sk-super-secret-value",
    );
    expect(serialized).not.toContain(rows[0].master_key_ciphertext);
  });
});
