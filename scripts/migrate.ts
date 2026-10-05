/**
 * Minimal forward-only SQL migration runner.
 *
 * Applies migrations/NNNN_name.sql files in filename order, each inside a
 * transaction, and records applied files in schema_migrations.
 *
 * Usage: npm run db:migrate
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
export const MIGRATION_ADVISORY_LOCK_ID = "7310318183545164275";

/**
 * One-time historical checksum corrections.
 *
 * Forward-only migrations are immutable once applied: a mismatch is a real
 * deployment hazard (the file a database ran is no longer the file in the
 * image), so it aborts. There is exactly one known exception:
 *
 *   0103_holoo_integration.sql shipped with
 *   integration_connections_provider_credentials demanding the two REST
 *   consumer-key ciphertexts from EVERY WooCommerce row. Migration 0076 had
 *   made those columns NULL-able for plugin-mode rows (and the application
 *   writes NULL there), so on any database holding a plugin connection
 *   ADD CONSTRAINT failed validation and the migration could never apply —
 *   the forward-only runner then never reached the follow-up fix in 0109.
 *   The constraint predicate was corrected in place (plugin-mode rows are
 *   exempt; 0109, which imposes the identical corrected constraint, remains
 *   the forward fix for databases that applied the broken file).
 *
 * Databases that applied the broken original are always non-plugin databases
 * on which 0109 ran immediately afterwards and corrected the constraint, so
 * their resulting schema is identical to what the repaired 0103 + 0109 now
 * produce. Adopting the checksum is therefore schema-neutral; the stored
 * checksum is only updated when it still equals the known-broken value below,
 * so no genuine file tampering or unrelated drift is ever masked.
 *
 * 0127_bug_reports.sql had its leading comment block reworded (the "report
 * button" UI it originally described was replaced by the sidebar footer
 * icon) after it had already been applied. Only comment lines changed —
 * every statement (CREATE TABLE, the index, the RLS policy) is byte-for-byte
 * identical — so a database that applied the original wording has the exact
 * schema the reworded file produces. Adopting the checksum is schema-neutral
 * for the same reason as 0103 above.
 *
 * 0140_installments.sql had its leading comment block reworded too
 * (commit ddab7d11, "harden installment workflows": the note about what a
 * plan's creation posts was expanded to describe interest accrual) after
 * deployments had already applied the original wording from PR #516. Only
 * comment lines changed — every statement is byte-for-byte identical — so
 * adopting the checksum is schema-neutral, exactly like 0127.
 *
 * 0190_hybrid_sync_completeness.sql is deliberately NOT in this map. Commit
 * 8824b59 (PR #844) edited it in place: menu_items' `trg_sync_capture`
 * argument lost `image_media_id`, so the trigger's excluded-columns list
 * changed. That is not a schema-neutral edit — a database holding the
 * original keeps excluding the column — so adopting its checksum would have
 * silently frozen production's old trigger definition. It was restored to the
 * bytes production applied instead, which is what the immutability rule
 * already required; migrations/0204_menu_item_image_media_sync.sql is the
 * forward migration that drops and recreates that trigger without
 * `image_media_id`, for fresh and existing databases alike.
 *
 * Note the second-order trap that restoration avoids: 0204 is itself applied
 * by any database created fresh from a tree at or after 8824b59, so editing
 * 0204 — even its comments — would raise the same mismatch on those
 * databases. That is exactly how 0127 and 0140 ended up in this map. Once a
 * migration file exists in a published image, its bytes are frozen: put the
 * change in a new migration.
 */
const CHECKSUM_REPAIRS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "0103_holoo_integration.sql",
    // sha256 of the original, broken revision (over-strict provider_credentials).
    [
      "889ff7579bd57c57882cde73de2a2bb5cdc7b5f76ffb377532fca3ef6bd614e8",
      "e45906ce02e79f16fb87a838d86bb4e497e37a9591f97608fa013bbcd8b9cbc2",
    ],
  ],
  [
    "0127_bug_reports.sql",
    // sha256 of the original revision (comment block described the since-removed
    // floating "report" button instead of the sidebar footer icon).
    [
      "f780470a9aeebc4400ea14c3fee5ade194d4aa598c5bd79840802b2aa372b5ff",
      "0945fb3adf3714f8293fd5459710432d09c523449d01b0bcce8b194129f95975",
    ],
  ],
  [
    "0140_installments.sql",
    // sha256 of the original revision (comment block predates the
    // interest-accrual wording; SQL statements identical).
    [
      "6ce624cd31cda355f2ca902bfa4482996d1ab67ca67ff6c3d80ef4c2ae170c9d",
      "2f7d0533d17b57793c754daa8c503314f4e627f88ed716a592c7b9a73bee6551",
      "3d120a57d143127361cea6ec598993a80e0e4e2e680f94cb20d26788cc29752b",
    ],
  ],
]);

export interface MigrationRunOptions {
  databaseUrl: string;
  migrationsDir?: string;
  quiet?: boolean;
}

export interface MigrationRunResult {
  applied: number;
  adoptedChecksums: number;
  repairedChecksums: string[];
}

interface MigrationFile {
  filename: string;
  checksum: string;
  sql: string;
}

function loadMigrations(directory: string): MigrationFile[] {
  return readdirSync(directory)
    .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
    .sort()
    .map((filename) => {
      const contents = readFileSync(join(directory, filename));
      return {
        filename,
        checksum: createHash("sha256").update(contents).digest("hex"),
        sql: contents.toString("utf8"),
      };
    });
}

export async function runMigrations(options: MigrationRunOptions): Promise<MigrationRunResult> {
  const client = new Client({ connectionString: options.databaseUrl });
  let lockAcquired = false;
  let adoptedChecksums = 0;
  let appliedCount = 0;
  const repairedChecksums: string[] = [];

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_ADVISORY_LOCK_ID]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");

    const migrations = loadMigrations(options.migrationsDir ?? MIGRATIONS_DIR);
    const { rows } = await client.query<{ filename: string; checksum: string | null }>(
      "SELECT filename, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.map((row) => [row.filename, row.checksum]));

    for (const migration of migrations) {
      if (!applied.has(migration.filename)) continue;
      const storedChecksum = applied.get(migration.filename);
      if (storedChecksum === null) {
        await client.query(
          "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1 AND checksum IS NULL",
          [migration.filename, migration.checksum],
        );
        applied.set(migration.filename, migration.checksum);
        adoptedChecksums++;
        continue;
      }
      if (storedChecksum !== migration.checksum) {
        const knownBrokenChecksums = CHECKSUM_REPAIRS.get(migration.filename);
        if (storedChecksum && knownBrokenChecksums && knownBrokenChecksums.includes(storedChecksum)) {
          // The applied revision is the documented broken one; the current
          // file repairs it with a schema-neutral result (see CHECKSUM_REPAIRS).
          await client.query(
            "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1 AND checksum = $3",
            [migration.filename, migration.checksum, storedChecksum],
          );
          applied.set(migration.filename, migration.checksum);
          repairedChecksums.push(migration.filename);
          if (!options.quiet) {
            console.warn(
              `Checksum repaired for previously applied ${migration.filename}: it had shipped with a broken revision (see CHECKSUM_REPAIRS in scripts/migrate.ts).`,
            );
          }
          continue;
        }
        throw new Error(`migration_checksum_mismatch: ${migration.filename}`);
      }
    }

    for (const migration of migrations) {
      if (applied.has(migration.filename)) continue;
      if (!options.quiet) process.stdout.write(`Applying ${migration.filename} ... `);
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [migration.filename, migration.checksum],
        );
        await client.query("COMMIT");
        if (!options.quiet) console.log("ok");
        appliedCount++;
      } catch (error) {
        await client.query("ROLLBACK");
        if (!options.quiet) console.log("FAILED");
        throw error;
      }
    }

    return { applied: appliedCount, adoptedChecksums, repairedChecksums };
  } finally {
    try {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_ID]);
      }
    } finally {
      await client.end();
    }
  }
}

export async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exitCode = 1;
    return;
  }

  const result = await runMigrations({ databaseUrl });
  if (result.repairedChecksums.length > 0) {
    console.log(
      `Repaired checksum(s) for corrected migration(s): ${result.repairedChecksums.join(", ")}.`,
    );
  }
  if (result.adoptedChecksums > 0) {
    console.log(`Adopted checksum(s) for ${result.adoptedChecksums} existing migration(s).`);
  }
  console.log(result.applied === 0 ? "Nothing to do — schema is up to date." : `Applied ${result.applied} migration(s).`);
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
