/**
 * Minimal forward-only SQL migration runner.
 *
 * Applies migrations/NNNN_name.sql files in filename order, each inside a
 * transaction, and records applied files in schema_migrations.
 *
 * Usage: npm run db:migrate
 *
 * Issue #757's secret-column cutover is a two-step release. While a database
 * still holds an AI gateway credential and AI_GATEWAY_SECRET_CUTOVER_VERIFIED
 * is not "true", 0209 is deferred automatically (and always when
 * AI_GATEWAY_SECRET_CUTOVER_DEFER=true): the ciphertext-only app boots, every
 * later migration still applies, and 0209 stays pending for production read
 * verification. After every deployment passes, set
 * AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true for the controlled migration run.
 * The migration also checks the session GUC set here.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
export const MIGRATION_ADVISORY_LOCK_ID = "7310318183545164275";
const AI_GATEWAY_SECRET_CUTOVER_MIGRATION = "0209_ai_gateway_secret_cutover.sql";
const AI_GATEWAY_SECRET_CUTOVER_DEFER_ENV = "AI_GATEWAY_SECRET_CUTOVER_DEFER";
const AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV = "AI_GATEWAY_SECRET_CUTOVER_VERIFIED";
/** A later migration naming either legacy column depends on 0209's order, so it cannot jump a deferred 0209. */
const AI_GATEWAY_LEGACY_SECRET_COLUMN = /\b(?:master_key|virtual_key)\b/;

/**
 * Whether 0209 would refuse to run without the post-verification confirmation:
 * true when either legacy table still holds a credential, in plaintext or
 * ciphertext. Mirrors the migration's own `stored_secret_count` check, and
 * reads only the columns that exist so it is safe on any schema the runner
 * reaches 0209 with.
 */
async function aiGatewaySecretsStored(client: Client): Promise<boolean> {
  const { rows: columns } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND ((table_name = 'platform_ai_gateway' AND column_name IN ('master_key', 'master_key_ciphertext'))
          OR (table_name = 'ai_business_gateway' AND column_name IN ('virtual_key', 'virtual_key_ciphertext')))`,
  );
  const checks: string[] = [];
  for (const { table_name: table, column_name: column } of columns) {
    checks.push(`EXISTS (SELECT 1 FROM ${table} WHERE NULLIF(btrim(${column}), '') IS NOT NULL)`);
  }
  if (checks.length === 0) return false;
  const { rows } = await client.query<{ stored: boolean }>(`SELECT (${checks.join(" OR ")}) AS stored`);
  return rows[0]?.stored === true;
}

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
 * 0200_crm_automations.sql is the one case where the *statements* changed, and
 * it is admissible because a forward migration restores the neutral result:
 *
 *   The file first shipped with this branch without `created_by_id` and without
 *   the three CHECK constraints 0201 adds, and branch environments applied it
 *   in that form. The revision that added them in place had a different
 *   checksum. 0201 applies the identical additions idempotently to everyone, so
 *   a database that ran the earlier revision and one that ran the original end
 *   up with the same schema once 0201 has run — which is why adopting the
 *   checksum here cannot mask drift. The file is frozen from now on.
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
  [
    "0200_crm_automations.sql",
    // sha256 of the revision this branch's own environments applied before
    // 0201 carried its additions forward (see the note above).
    ["9acc7080334deaa16af7b8a66883a89464b3ae7eb07de5d2094219d2f0d3c3c5"],
  ],
  [
    "0028_bank_reconciliation.sql",
    // sha256 of the original revision, whose leading comment described
    // reconciliation as covering only cash 1100 and bank-clearing 1120 on the
    // reasoning that nothing posted to the plain bank account. Phase 30 made
    // that false (a cheque clears *into* 1110) and issue #830's audit flagged
    // the comment as one of the places the stale two-account story was still
    // being told. Only comment lines changed — every statement in the file is
    // byte-for-byte identical, and the schema was never account-specific — so
    // adopting the checksum is schema-neutral, exactly like 0127 and 0140.
    ["5c0d7299b7d79fb9995fdaf713eeb1fad423515981f924459d18704bb5bd448f"],
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
  deferredMigrations: string[];
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
  const deferSecretCutover = process.env[AI_GATEWAY_SECRET_CUTOVER_DEFER_ENV] === "true";
  const secretCutoverVerified = process.env[AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV] === "true";
  if (deferSecretCutover && secretCutoverVerified) {
    throw new Error("ai_gateway_secret_cutover_flags_conflict");
  }

  const client = new Client({ connectionString: options.databaseUrl });
  let lockAcquired = false;
  let adoptedChecksums = 0;
  let appliedCount = 0;
  const repairedChecksums: string[] = [];
  const deferredMigrations: string[] = [];

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_ADVISORY_LOCK_ID]);
    lockAcquired = true;
    await client.query(
      "SELECT set_config('app.ai_gateway_secret_cutover_verified', $1, false)",
      [secretCutoverVerified ? "true" : "false"],
    );

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

    for (let index = 0; index < migrations.length; index += 1) {
      const migration = migrations[index];
      if (applied.has(migration.filename)) continue;
      // Without the explicit confirmation, a database that still holds a
      // credential defers 0209 instead of failing the boot: the migration
      // would refuse anyway, and refusing on every container start is a
      // restart loop that takes the whole platform down over one AI column.
      // The guard's intent is unchanged — the columns are dropped only on a
      // run that sets AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true.
      if (
        migration.filename === AI_GATEWAY_SECRET_CUTOVER_MIGRATION &&
        (deferSecretCutover || (!secretCutoverVerified && (await aiGatewaySecretsStored(client))))
      ) {
        const dependent = migrations
          .slice(index + 1)
          .find((later) => !applied.has(later.filename) && AI_GATEWAY_LEGACY_SECRET_COLUMN.test(later.sql));
        if (dependent) {
          throw new Error(`ai_gateway_secret_cutover_deferred_blocks_later_migration:${dependent.filename}`);
        }
        deferredMigrations.push(migration.filename);
        if (!options.quiet) {
          console.warn(
            `Deferred ${AI_GATEWAY_SECRET_CUTOVER_MIGRATION}; verify ciphertext-backed production reads on every deployment, then rerun migrations with ${AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV}=true.`,
          );
        }
        continue;
      }
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

    return { applied: appliedCount, adoptedChecksums, repairedChecksums, deferredMigrations };
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
  if (result.deferredMigrations.length > 0) {
    console.log(`Deferred migration(s): ${result.deferredMigrations.join(", ")}.`);
  }
  console.log(
    result.applied === 0 && result.deferredMigrations.length === 0
      ? "Nothing to do — schema is up to date."
      : `Applied ${result.applied} migration(s).`,
  );
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
