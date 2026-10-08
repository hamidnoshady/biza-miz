import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_ADVISORY_LOCK_ID, runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;

if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const databases: string[] = [];
const tempDirs: string[] = [];
const migrationsDirectory = join(process.cwd(), "migrations");

function maintenanceDatabaseUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrl(name: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(): Promise<{ name: string; url: string }> {
  const name = `pos_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: maintenanceDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  databases.push(name);
  return { name, url: databaseUrl(name) };
}

async function tempMigrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pos-migrations-"));
  tempDirs.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, sql]) =>
      writeFile(join(dir, name), sql, "utf8"),
    ),
  );
  return dir;
}

afterEach(async () => {
  for (const name of databases.splice(0)) {
    const client = new Client({ connectionString: maintenanceDatabaseUrl() });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("migration runner", () => {
  it("applies the repository migrations to a clean database and is a no-op on rerun", async () => {
    const database = await createDatabase();

    const first = await runMigrations({ databaseUrl: database.url });
    const second = await runMigrations({ databaseUrl: database.url });

    const expectedMigrations = readdirSync(migrationsDirectory)
      .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
      .sort()
      .map((filename) => ({
        filename,
        checksum: createHash("sha256")
          .update(readFileSync(join(migrationsDirectory, filename)))
          .digest("hex"),
      }));
    const client = new Client({ connectionString: database.url });
    await client.connect();
    const actualMigrations = await client.query<{
      filename: string;
      checksum: string;
    }>("SELECT filename, checksum FROM schema_migrations ORDER BY filename");
    await client.end();

    expect(first).toEqual({
      applied: expectedMigrations.length,
      adoptedChecksums: 0,
      repairedChecksums: [],
      deferredMigrations: [],
    });
    expect(actualMigrations.rows).toEqual(expectedMigrations);
    expect(second).toEqual({
      applied: 0,
      adoptedChecksums: 0,
      repairedChecksums: [],
      deferredMigrations: [],
    });
  }, 60_000);

  it("serializes concurrent runners with the advisory lock", async () => {
    const database = await createDatabase();
    const migrationsDir = await tempMigrations({
      "0001_guard.sql":
        "CREATE TABLE concurrency_guard(id integer PRIMARY KEY);",
    });
    const blocker = new Client({ connectionString: database.url });
    await blocker.connect();
    await blocker.query("SELECT pg_advisory_lock($1::bigint)", [
      MIGRATION_ADVISORY_LOCK_ID,
    ]);

    const runners = [
      runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true }),
      runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true }),
    ];

    const deadline = Date.now() + 5_000;
    let waitingRunners = 0;
    while (Date.now() < deadline) {
      const result = await blocker.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `);
      waitingRunners = Number(result.rows[0]?.count ?? 0);
      if (waitingRunners === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waitingRunners).toBe(2);
    await blocker.query("SELECT pg_advisory_unlock($1::bigint)", [
      MIGRATION_ADVISORY_LOCK_ID,
    ]);
    await blocker.end();

    const [first, second] = await Promise.all(runners);

    expect([first.applied, second.applied].sort()).toEqual([0, 1]);
  });

  it("upgrades an existing 0011 database through every later migration", async () => {
    const database = await createDatabase();
    const dir = await mkdtemp(join(tmpdir(), "pos-upgrade-"));
    tempDirs.push(dir);
    const files = readdirSync(migrationsDirectory)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const file of files.filter((name) => name <= "0011_delivery.sql")) {
      await copyFile(join(migrationsDirectory, file), join(dir, file));
    }
    await runMigrations({
      databaseUrl: database.url,
      migrationsDir: dir,
      quiet: true,
    });
    for (const file of files.filter((name) => name > "0011_delivery.sql")) {
      await copyFile(join(migrationsDirectory, file), join(dir, file));
    }
    const upgraded = await runMigrations({
      databaseUrl: database.url,
      migrationsDir: dir,
      quiet: true,
    });
    const rerun = await runMigrations({
      databaseUrl: database.url,
      migrationsDir: dir,
      quiet: true,
    });
    expect(upgraded.applied).toBe(files.length - 11);
    expect(rerun).toEqual({
      applied: 0,
      adoptedChecksums: 0,
      repairedChecksums: [],
      deferredMigrations: [],
    });
  }, 60_000);

  it("backfills legacy pull dead letters into the canonical replay store before dropping the old table", async () => {
    const database = await createDatabase();
    const dir = await mkdtemp(join(tmpdir(), "pos-0185-upgrade-"));
    tempDirs.push(dir);
    const files = readdirSync(migrationsDirectory)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const file of files.filter(
      (name) => name < "0185_durable_pairing_and_sync_recovery.sql",
    )) {
      await copyFile(join(migrationsDirectory, file), join(dir, file));
    }
    await runMigrations({
      databaseUrl: database.url,
      migrationsDir: dir,
      quiet: true,
    });

    const client = new Client({ connectionString: database.url });
    await client.connect();
    const seeded = await client.query<{ business_id: string }>(`
      WITH business AS (
        INSERT INTO businesses(name,slug) VALUES ('Legacy recovery cafe','legacy-recovery-cafe')
        RETURNING id
      ), location AS (
        INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id,business_id
      )
      SELECT business_id FROM location
    `);
    const businessId = seeded.rows[0].business_id;
    await client.query(
      `INSERT INTO server_sync_dead_letters
         (business_id,remote_event_id,location_id,client_event_id,event_type,payload,error)
       VALUES($1,42,'not-a-uuid','legacy-client-event','order_item.status',$2::jsonb,'invalid location')`,
      [
        businessId,
        JSON.stringify({ itemId: "private-item", status: "preparing" }),
      ],
    );
    await client.end();

    await copyFile(
      join(migrationsDirectory, "0185_durable_pairing_and_sync_recovery.sql"),
      join(dir, "0185_durable_pairing_and_sync_recovery.sql"),
    );
    await runMigrations({
      databaseUrl: database.url,
      migrationsDir: dir,
      quiet: true,
    });

    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    const rows = await verify.query<{
      source: string;
      remote_event_id: string;
      location_id: string | null;
      payload: { itemId: string };
      payload_sha256: string;
      status: string;
    }>(
      `SELECT source,remote_event_id::text,location_id::text,payload,payload_sha256,status
         FROM sync_event_dead_letters WHERE business_id=$1`,
      [businessId],
    );
    const oldTable = await verify.query<{ present: string | null }>(
      "SELECT to_regclass('server_sync_dead_letters')::text AS present",
    );
    await verify.end();

    expect(rows.rows).toEqual([
      {
        source: "server_pull",
        remote_event_id: "42",
        location_id: null,
        payload: { itemId: "private-item", status: "preparing" },
        payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        status: "open",
      },
    ]);
    expect(oldTable.rows[0].present).toBeNull();
  }, 60_000);

  it("adopts a checksum for legacy migration rows once", async () => {
    const database = await createDatabase();
    const migrationsDir = await tempMigrations({
      "0001_legacy.sql": "SELECT 1;",
    });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query(
        "CREATE TABLE schema_migrations(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      await client.query(
        "INSERT INTO schema_migrations(filename) VALUES('0001_legacy.sql')",
      );
    } finally {
      await client.end();
    }

    await expect(
      runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true }),
    ).resolves.toEqual({
      applied: 0,
      adoptedChecksums: 1,
      repairedChecksums: [],
      deferredMigrations: [],
    });
    await expect(
      runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true }),
    ).resolves.toEqual({
      applied: 0,
      adoptedChecksums: 0,
      repairedChecksums: [],
      deferredMigrations: [],
    });
  });

  it("repairs the checksum of a known-broken applied migration without re-running it", async () => {
    const database = await createDatabase();
    // The repaired content keeps the real filename so CHECKSUM_REPAIRS
    // recognises it (see scripts/migrate.ts).
    const migrationsDir = await tempMigrations({
      "0103_holoo_integration.sql": "CREATE TABLE repair_probe(id integer);",
    });
    const repairedPath = join(migrationsDir, "0103_holoo_integration.sql");
    const repairedChecksum = createHash("sha256")
      .update(readFileSync(repairedPath))
      .digest("hex");

    // Record it as applied under the checksum of the original broken revision
    // (the sha-256 pinned in CHECKSUM_REPAIRS).
    const client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `CREATE TABLE schema_migrations(
         filename text PRIMARY KEY, checksum text,
         applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await client.query(
      "INSERT INTO schema_migrations(filename, checksum) VALUES($1, $2)",
      [
        "0103_holoo_integration.sql",
        "889ff7579bd57c57882cde73de2a2bb5cdc7b5f76ffb377532fca3ef6bd614e8",
      ],
    );
    await client.end();

    const first = await runMigrations({
      databaseUrl: database.url,
      migrationsDir,
      quiet: true,
    });
    expect(first).toEqual({
      applied: 0,
      adoptedChecksums: 0,
      repairedChecksums: ["0103_holoo_integration.sql"],
      deferredMigrations: [],
    });

    // The stored checksum now matches the repaired file, and the migration was
    // not re-applied (the probe table is absent because the recorded row was
    // treated as already applied).
    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    const { rows } = await verify.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE filename = '0103_holoo_integration.sql'",
    );
    const { rows: probe } = await verify.query(
      "SELECT to_regclass('repair_probe') AS present",
    );
    await verify.end();
    expect(rows[0].checksum).toBe(repairedChecksum);
    expect(probe[0].present).toBeNull();

    // Second run is a plain no-op: the repair fires exactly once.
    const second = await runMigrations({
      databaseUrl: database.url,
      migrationsDir,
      quiet: true,
    });
    expect(second).toEqual({
      applied: 0,
      adoptedChecksums: 0,
      repairedChecksums: [],
      deferredMigrations: [],
    });
  });

  it("repairs the checksum of 0140_installments.sql and 0127_bug_reports.sql across revisions", async () => {
    const database = await createDatabase();
    const migrationsDir = await tempMigrations({
      "0127_bug_reports.sql": "CREATE TABLE probe_127(id integer);",
      "0140_installments.sql": "CREATE TABLE probe_140(id integer);",
    });
    const repairedChecksum127 = createHash("sha256")
      .update(readFileSync(join(migrationsDir, "0127_bug_reports.sql")))
      .digest("hex");
    const repairedChecksum140 = createHash("sha256")
      .update(readFileSync(join(migrationsDir, "0140_installments.sql")))
      .digest("hex");

    const client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `CREATE TABLE schema_migrations(
         filename text PRIMARY KEY, checksum text,
         applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await client.query(
      "INSERT INTO schema_migrations(filename, checksum) VALUES($1, $2), ($3, $4)",
      [
        "0127_bug_reports.sql",
        "f780470a9aeebc4400ea14c3fee5ade194d4aa598c5bd79840802b2aa372b5ff",
        "0140_installments.sql",
        "6ce624cd31cda355f2ca902bfa4482996d1ab67ca67ff6c3d80ef4c2ae170c9d",
      ],
    );
    await client.end();

    const first = await runMigrations({
      databaseUrl: database.url,
      migrationsDir,
      quiet: true,
    });
    expect(first).toEqual({
      applied: 0,
      adoptedChecksums: 0,
      repairedChecksums: ["0127_bug_reports.sql", "0140_installments.sql"],
      deferredMigrations: [],
    });

    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    const { rows } = await verify.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations WHERE filename IN ('0127_bug_reports.sql', '0140_installments.sql') ORDER BY filename",
    );
    await verify.end();
    expect(rows).toEqual([
      { filename: "0127_bug_reports.sql", checksum: repairedChecksum127 },
      { filename: "0140_installments.sql", checksum: repairedChecksum140 },
    ]);

    const second = await runMigrations({
      databaseUrl: database.url,
      migrationsDir,
      quiet: true,
    });
    expect(second).toEqual({
      applied: 0,
      adoptedChecksums: 0,
      repairedChecksums: [],
      deferredMigrations: [],
    });
  });

  it("rejects drift in an already-applied migration", async () => {
    const database = await createDatabase();
    const migrationsDir = await tempMigrations({
      "0001_value.sql": "CREATE TABLE value_one(id integer);",
    });
    await runMigrations({
      databaseUrl: database.url,
      migrationsDir,
      quiet: true,
    });
    await writeFile(
      join(migrationsDir, "0001_value.sql"),
      "CREATE TABLE value_two(id integer);",
      "utf8",
    );

    await expect(
      runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true }),
    ).rejects.toThrow("migration_checksum_mismatch: 0001_value.sql");
  });
});
