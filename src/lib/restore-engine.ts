/**
 * The physical half of a whole-database restore, shared by every caller.
 *
 * Two things restore a `pg_dump --format=custom` artifact: the Owner's
 * dashboard on a single-business install (`backup-service.ts`'s
 * `restoreFromArtifact`) and the super-admin console's full-system restore
 * (`platform-backup-service.ts`), and they used to carry two near-copies of
 * the same dangerous procedure. Copying it twice is how one half gets a safety
 * fix and the other doesn't, so the procedure lives here once:
 *
 *   verify → scratch.  The artifact is restored into a throwaway database and
 *            validated (migrations present, core tables present, row counts
 *            reported). Production is not touched. This runs FIRST on every
 *            path, including the apply path — an apply never trusts a verify
 *            that happened on an earlier request, because the artifact could
 *            have been pruned, replaced or re-uploaded since.
 *   apply → drop + recreate. `DROP DATABASE … WITH (FORCE)` terminates the
 *            app's own sessions atomically; a separate `pg_terminate_backend`
 *            would leave a window for the pool (or a background tick) to
 *            reconnect and make the DROP fail.
 *   re-grant. `pg_restore --no-privileges` lands a database with no ACLs, so
 *            `pos_app` would come up unable to read a single table; the same
 *            idempotent provisioning `create-app-role` performs is re-run
 *            against the restored database.
 *   scratch cleanup. Always, success or failure — a failed pg_restore used to
 *            leave a half-populated `<target>_restore_verify` behind.
 *
 * The binaries are resolved from `PG_RESTORE_PATH` (default `pg_restore`) — the
 * same indirection `backup.ts`'s `dumpDatabaseUrl`/`PG_DUMP_PATH` use, and what
 * lets the integration test drive a whole restore round-trip against a stub.
 */
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { decryptBackup, isEncryptedBackup } from "./backup";
import { decryptFileToFile, fileHasBackupMagic, sha256File } from "./backup-streams";
import { pgRestoreBin, runPgDump, runPgRestore } from "./pg-tools";
import { createAppRole, decodeUrlCredential } from "./create-app-role";
import { secureRemoveDirectory } from "./secure-temp";
import { appendRestoreJournal, tryAppendRestoreJournal, type RestoreJournalEntry, type RestorePhase } from "./restore-journal";

/** Re-exported so existing importers (`backup-service.ts`, the console routes) keep one name for them. */
export { PG_RESTORE_TIMEOUT_MS, runPgRestore } from "./pg-tools";

/**
 * What a restore found in the artifact — the numbers an operator reads before
 * agreeing to replace a live system, and the ones written into the restore run
 * row afterwards.
 */
export interface RestoreSummary {
  source: string;
  migrations: number;
  latestMigration: string;
  tables: { name: string; rows: number }[];
  integrity: {
    encoding: "UTF8";
    validatedForeignKeys: number;
    checkedSequences: number;
  };
  /** Persistent pre-restore safety dump; present only after an apply. */
  emergencyBackup?: string;
  /**
   * Non-fatal conditions the operator has to be told about — today, a runtime
   * role that could not be stripped of SUPERUSER because the restore ran as
   * that very role (issue #807; see create-app-role.ts). The restore is still a
   * success, so it is a warning and not an error, but it must not be invisible.
   */
  warnings?: string[];
}

/** The core tables a dump must contain to be worth restoring at all. */
export const RESTORE_CORE_TABLES = ["businesses", "locations", "users", "orders", "journal_entries"];

/** Same server, different database — for admin commands and the scratch restore. */
export function withDatabase(databaseUrl: string, dbName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export async function adminClient(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: withDatabase(databaseUrl, "postgres") });
  await client.connect();
  return client;
}


/**
 * Is what landed in that database actually a backup of this app?
 *
 * `schema_migrations` having rows is the discriminator between "a dump of this
 * product's database" and "a dump of some other Postgres" (or an empty
 * database), and the core-table counts are what an operator reads before
 * agreeing to replace a live system. Row counts are read as the *owner*
 * connection (which is what `databaseUrl` is here — see
 * `dumpDatabaseUrl()`), so RLS cannot report zero and mislead.
 */
export async function validateRestoredDb(databaseUrl: string, source: string): Promise<RestoreSummary> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    if (rows.length === 0) {
      throw new Error("این فایل یک پشتیبان معتبر نیست (جدول schema_migrations خالی است).");
    }
    const encoding = await client.query<{ encoding: string }>(
      "SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()",
    );
    if (encoding.rows[0]?.encoding !== "UTF8") throw new Error("restore_database_encoding_must_be_utf8");

    const tables: { name: string; rows: number }[] = [];
    for (const name of RESTORE_CORE_TABLES) {
      try {
        const { rows: countRows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${name}`,
        );
        const count = BigInt(countRows[0].n);
        if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`restore_row_count_too_large:${name}`);
        tables.push({ name, rows: Number(count) });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("restore_row_count_too_large:")) throw error;
        throw new Error(`فایل پشتیبان جدول «${name}» را ندارد.`);
      }
    }

    const fk = await client.query<{ total: string; invalid: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE NOT convalidated)::text AS invalid
         FROM pg_constraint WHERE contype = 'f'`,
    );
    if (fk.rows[0]?.invalid !== "0") throw new Error("restore_contains_unvalidated_foreign_keys");

    // A dump must restore sequence setval state as well as bigint IDs. Compare
    // using BigInt strings so values above JavaScript's safe integer range are
    // never rounded by validation.
    const sequences = await client.query<{
      sequence_schema: string;
      sequence_name: string;
      table_schema: string;
      table_name: string;
      column_name: string;
    }>(
      `SELECT sn.nspname AS sequence_schema, s.relname AS sequence_name,
              tn.nspname AS table_schema, t.relname AS table_name, a.attname AS column_name
         FROM pg_class s
         JOIN pg_namespace sn ON sn.oid = s.relnamespace
         JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
         JOIN pg_class t ON t.oid = d.refobjid
         JOIN pg_namespace tn ON tn.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
        WHERE s.relkind = 'S'`,
    );
    for (const sequence of sequences.rows) {
      const sequenceSql = `${quoteIdentifier(sequence.sequence_schema)}.${quoteIdentifier(sequence.sequence_name)}`;
      const tableSql = `${quoteIdentifier(sequence.table_schema)}.${quoteIdentifier(sequence.table_name)}`;
      const state = await client.query<{ last_value: string; maximum: string | null }>(
        `SELECT (SELECT last_value::text FROM ${sequenceSql}) AS last_value,
                (SELECT max(${quoteIdentifier(sequence.column_name)})::text FROM ${tableSql}) AS maximum`,
      );
      const maximum = state.rows[0]?.maximum;
      if (maximum !== null && maximum !== undefined && BigInt(state.rows[0].last_value) < BigInt(maximum)) {
        throw new Error(`restore_sequence_behind_table:${sequence.table_schema}.${sequence.table_name}.${sequence.column_name}`);
      }
    }

    return {
      source,
      migrations: rows.length,
      latestMigration: rows.at(-1)!.filename,
      tables,
      integrity: {
        encoding: "UTF8",
        validatedForeignKeys: Number(fk.rows[0]?.total ?? 0),
        checkedSequences: sequences.rows.length,
      },
    };
  } finally {
    await client.end();
  }
}

/**
 * pg_restore runs with `--no-privileges`, so the restored database has none of
 * the ACLs a normal deployment gets from scripts/create-app-role.ts — the app's
 * `pos_app` connection would come up with no table access. Re-provision the
 * same grants (idempotently, the same way derive-runtime-database-url.ts does
 * at boot) using the app role's credentials from the running process's own
 * DATABASE_URL. On a fresh machine where the role does not exist yet,
 * createAppRole creates it; the next boot's derive-runtime then keeps it.
 *
 * Returns whether the runtime role is still a superuser (only possible when the
 * role *is* the connection's own role, which PostgreSQL will not let a session
 * demote) so the apply path can warn the operator instead of implying a
 * hardening that did not happen.
 */
export async function regrantAppRole(
  databaseUrl: string,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): Promise<{ role: string; superuser: boolean }> {
  const runtimeUrl = env.DATABASE_URL?.trim();
  if (!runtimeUrl) {
    // Without a runtime URL there is no role to grant to and no way to prove
    // the restored database is usable by the application. Issue #807: this is
    // a hard failure, not a log line — a "successful" restore the app cannot
    // read is indistinguishable from data loss.
    throw new Error("restore_runtime_url_missing: DATABASE_URL is not set, so the app role cannot be re-granted or validated");
  }
  let parsed: URL;
  try {
    parsed = new URL(runtimeUrl);
  } catch {
    throw new Error("restore_runtime_url_invalid: DATABASE_URL is not a usable connection string");
  }
  // Decode: URL keeps the percent-encoded spelling that `pg` decodes when it
  // connects, so re-provisioning with the raw value would set a different
  // password on the role and lock the application out of the database it just
  // restored.
  const roleName = decodeUrlCredential(parsed.username);
  const password = decodeUrlCredential(parsed.password);
  if (!roleName || !password) {
    throw new Error("restore_runtime_url_incomplete: DATABASE_URL must carry a role name and password");
  }
  try {
    const result = await createAppRole({ databaseUrl, roleName, password, quiet: true });
    return { role: result.role, superuser: result.superuser };
  } catch (err) {
    // Fail hard. The previous behaviour swallowed this and then validated the
    // restored database through the *privileged* connection, so a database the
    // runtime role could not read was reported healthy; the apply path's
    // rollback now runs instead.
    throw new Error(`restore_regrant_failed:${errText(err)}`);
  }
}

/**
 * Minimum application-level proof that the *runtime* role can use the restored
 * database. Issue #807: validation used to run only over the privileged
 * connection, which says nothing about `pos_app`. This opens a connection with
 * the process's own DATABASE_URL — the credentials the app boots with — and
 * checks it can read the schema and the core tables and write to them.
 *
 * Read-only by design: the check must be safe to run on a database that is
 * about to be reported as restored, and an actual write probe would mutate
 * production data.
 */
export async function validateRuntimeAccess(env: Partial<NodeJS.ProcessEnv> = process.env): Promise<void> {
  const runtimeUrl = env.DATABASE_URL?.trim();
  if (!runtimeUrl) throw new Error("runtime_role_validation_failed:not_configured");
  const client = new Client({ connectionString: runtimeUrl });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`runtime_role_validation_failed:connect:${errText(err)}`);
  }
  try {
    const migrations = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM schema_migrations",
    );
    if (Number(migrations.rows[0]?.n ?? 0) === 0) {
      throw new Error("runtime_role_validation_failed:no_migrations_visible");
    }
    for (const table of RESTORE_CORE_TABLES) {
      // A plain read proves SELECT (and therefore the schema) is reachable for
      // this role; RLS may legitimately return zero rows with no tenant scope.
      await client.query(`SELECT 1 FROM ${table} LIMIT 1`);
    }
    const writeCheck = await client.query<{ ok: boolean }>(
      `SELECT bool_and(has_table_privilege(current_user, t, 'INSERT')) AS ok
         FROM unnest($1::text[]) AS t`,
      [RESTORE_CORE_TABLES],
    );
    if (!writeCheck.rows[0]?.ok) {
      throw new Error("runtime_role_validation_failed:missing_insert_privilege");
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("runtime_role_validation_failed:")) throw err;
    throw new Error(`runtime_role_validation_failed:${errText(err)}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Durable restore journal (issue #807)
// ---------------------------------------------------------------------------

/**
 * Everything the engine needs to journal one restore end to end. Optional so
 * unit/integration callers that are not a real restore (the engine's own tests)
 * can run without writing to a journal.
 */
export interface RestoreJournalContext {
  id: string;
  scope: string;
  source: string;
  artifact: string;
  mode: "verify" | "apply";
  actorId?: string | null;
  actorLabel?: string | null;
  /** journal directory override — the platform service passes its configured one */
  dir?: string;
}

async function journal(
  context: RestoreJournalContext | undefined,
  phase: RestorePhase,
  detail?: Record<string, unknown>,
): Promise<boolean> {
  if (!context) return true;
  return tryAppendRestoreJournal(
    {
      id: context.id,
      phase,
      scope: context.scope,
      source: context.source,
      artifact: context.artifact,
      mode: context.mode,
      actorId: context.actorId ?? null,
      actorLabel: context.actorLabel ?? null,
      detail,
    },
    context.dir,
  );
}

/**
 * The pre-apply journal write, which must be durable: a destructive act that
 * cannot be recorded does not happen. Throws so the apply is refused before the
 * first rename.
 */
async function journalApplyStarted(
  context: RestoreJournalContext | undefined,
  detail?: Record<string, unknown>,
): Promise<void> {
  if (!context) return;
  await appendRestoreJournal(
    {
      id: context.id,
      phase: "apply_started",
      scope: context.scope,
      source: context.source,
      artifact: context.artifact,
      mode: "apply",
      actorId: context.actorId ?? null,
      actorLabel: context.actorLabel ?? null,
      detail,
    },
    context.dir,
  );
}

/** The last phase a failed apply reached, so the journal tells the truth about it. */
export class RestoreApplyError extends Error {
  readonly phase: "apply_failed_before_swap" | "apply_rolled_back";
  readonly rollbackFailed: boolean;
  constructor(phase: "apply_failed_before_swap" | "apply_rolled_back", message: string, rollbackFailed = false) {
    super(message);
    this.name = "RestoreApplyError";
    this.phase = phase;
    this.rollbackFailed = rollbackFailed;
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Best-effort: a scratch database left behind is untidy, not dangerous. */
export async function dropDatabase(databaseUrl: string, dbName: string): Promise<void> {
  let admin: Client | null = null;
  try {
    admin = await adminClient(databaseUrl);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)} WITH (FORCE)`);
  } catch (err) {
    console.error(`restore: dropping scratch database ${dbName} failed (best effort):`, errText(err));
  } finally {
    await admin?.end().catch(() => {});
  }
}

/**
 * Restore one dump into a scratch database and validate it — the dry-run half.
 * Never touches production; throws with pg_restore's own stderr when the dump
 * is unreadable.
 */
export async function verifyIntoScratch(
  databaseUrl: string,
  scratchDb: string,
  pgRestore: string,
  dumpPath: string,
  source: string,
): Promise<RestoreSummary> {
  const admin = await adminClient(databaseUrl);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(scratchDb)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(scratchDb)} ENCODING 'UTF8'`);
  } finally {
    await admin.end();
  }
  await runPgRestore(pgRestore, [
    "--exit-on-error",
    "--no-owner",
    "--no-privileges",
    `--dbname=${withDatabase(databaseUrl, scratchDb)}`,
    dumpPath,
  ], databaseUrl);
  return validateRestoredDb(withDatabase(databaseUrl, scratchDb), source);
}

/** Create, fsync and retain a verified safety dump of the live database. */
async function createEmergencyBackup(opts: {
  databaseUrl: string;
  targetDb: string;
  pgDump?: string;
  pgRestore: string;
  emergencyDir?: string;
}): Promise<string> {
  const directory = path.resolve(opts.emergencyDir || process.env.RESTORE_EMERGENCY_DIR || path.join(os.tmpdir(), "business-suite-emergency-backups"));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const finalPath = path.join(directory, `${opts.targetDb.replace(/[^A-Za-z0-9_-]/g, "_")}-emergency-${stamp}-${process.pid}-${randomUUID().slice(0, 8)}.dump`);
  const partialPath = `${finalPath}.partial`;
  try {
    await runPgDump(partialPath, opts.databaseUrl, opts.pgDump);
    await fs.chmod(partialPath, 0o600).catch(() => {});
    const handle = await fs.open(partialPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(partialPath, finalPath);

    // A backup existing is not enough; prove it can be restored before the live
    // database is renamed. This scratch is independent from the incoming dump.
    const emergencyScratch = databaseName(`${opts.targetDb}_emergency_verify_${process.pid}`);
    try {
      await verifyIntoScratch(opts.databaseUrl, emergencyScratch, opts.pgRestore, finalPath, path.basename(finalPath));
    } catch (error) {
      await fs.unlink(finalPath).catch(() => {});
      throw new Error(`emergency_backup_verification_failed:${errText(error)}`);
    } finally {
      await dropDatabase(opts.databaseUrl, emergencyScratch);
    }
    return finalPath;
  } finally {
    await fs.unlink(partialPath).catch(() => {});
  }
}

function databaseName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_]/g, "_");
  return safe.slice(0, 63) || "pos_restore";
}

async function setDatabaseConnections(admin: Client, name: string, allowed: boolean): Promise<void> {
  await admin.query(`ALTER DATABASE ${quoteIdentifier(name)} WITH ALLOW_CONNECTIONS ${allowed ? "true" : "false"}`);
  if (!allowed) {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
  }
}

async function rollbackDatabaseSwap(databaseUrl: string, targetDb: string, recoveryDb: string): Promise<void> {
  const admin = await adminClient(databaseUrl);
  try {
    const target = await admin.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists", [targetDb]);
    if (target.rows[0]?.exists) {
      await setDatabaseConnections(admin, targetDb, false);
      await admin.query(`DROP DATABASE ${quoteIdentifier(targetDb)}`);
    }
    const recovery = await admin.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists", [recoveryDb]);
    if (!recovery.rows[0]?.exists) throw new Error(`recovery_database_missing:${recoveryDb}`);
    await admin.query(`ALTER DATABASE ${quoteIdentifier(recoveryDb)} RENAME TO ${quoteIdentifier(targetDb)}`);
    await setDatabaseConnections(admin, targetDb, true);
  } finally {
    await admin.end().catch(() => {});
  }
}

/**
 * Apply an already-restored and validated scratch database by a controlled name
 * swap. The original database is retained under a recovery name until the new
 * target passes application validation and grants. Any failure rolls the name
 * swap back; the persistent, verified emergency dump is retained either way.
 */
export async function applyDumpToTarget(opts: {
  databaseUrl: string;
  targetDb: string;
  pgRestore: string;
  pgDump?: string;
  dumpPath: string;
  source: string;
  verifiedDb?: string;
  emergencyDir?: string;
  /** where to look for the runtime-role credentials; defaults to process.env */
  runtimeEnv?: Partial<NodeJS.ProcessEnv>;
  /** Integration-only deterministic crash points; never sourced from a request. */
  failureInjection?: "after_original_rename" | "after_target_swap" | "after_regrant";
}): Promise<RestoreSummary> {
  const { databaseUrl, targetDb, pgRestore, dumpPath, source } = opts;
  const preparedDb = opts.verifiedDb ?? databaseName(`${targetDb}_restore_prepared_${process.pid}`);
  let ownsPreparedDb = !opts.verifiedDb;
  if (ownsPreparedDb) await verifyIntoScratch(databaseUrl, preparedDb, pgRestore, dumpPath, source);
  else await validateRestoredDb(withDatabase(databaseUrl, preparedDb), source);

  const emergencyBackup = await createEmergencyBackup({
    databaseUrl,
    targetDb,
    pgDump: opts.pgDump,
    pgRestore,
    emergencyDir: opts.emergencyDir,
  });
  const recoveryDb = databaseName(`${targetDb}_restore_original_${Date.now().toString(36)}`);
  let originalRenamed = false;
  let preparedRenamed = false;
  try {
    const admin = await adminClient(databaseUrl);
    try {
      await setDatabaseConnections(admin, targetDb, false);
      await admin.query(`ALTER DATABASE ${quoteIdentifier(targetDb)} RENAME TO ${quoteIdentifier(recoveryDb)}`);
      originalRenamed = true;
      if (opts.failureInjection === "after_original_rename") throw new Error("injected_failure_after_original_rename");
      await admin.query(`ALTER DATABASE ${quoteIdentifier(preparedDb)} RENAME TO ${quoteIdentifier(targetDb)}`);
      preparedRenamed = true;
      if (opts.failureInjection === "after_target_swap") throw new Error("injected_failure_after_target_swap");
      ownsPreparedDb = false;
    } finally {
      await admin.end().catch(() => {});
    }

    // Re-grant and then prove the *runtime* role can actually use the restored
    // database before anything is reported successful (issue #807). Both are
    // inside this try block on purpose: either failing rolls the swap back.
    const regrant = await regrantAppRole(databaseUrl, opts.runtimeEnv ?? process.env);
    if (opts.failureInjection === "after_regrant") throw new Error("injected_failure_after_regrant");
    await validateRuntimeAccess(opts.runtimeEnv ?? process.env);
    const summary = await validateRestoredDb(databaseUrl, source);
    const warnings = regrant.superuser
      ? [
          `The runtime role ${regrant.role} could not be demoted: it is this connection's own role and PostgreSQL does not allow a session to remove its own SUPERUSER attribute. ` +
            "The restored database is reachable, but the application still runs with unrestricted access — provision the runtime role from a separate admin connection.",
        ]
      : undefined;
    if (warnings) console.warn(`restore: ${warnings[0]}`);

    // The new target is now fully usable. Only now may the preserved original
    // be removed; the verified emergency dump remains for operator recovery.
    await dropDatabase(databaseUrl, recoveryDb);
    originalRenamed = false;
    return { ...summary, emergencyBackup, ...(warnings ? { warnings } : {}) };
  } catch (error) {
    // The swap had not happened yet (the failure is in emergency-backup
    // creation, in the pre-swap admin work, or before the first rename): the
    // production database is untouched, and the journal must say so rather than
    // claiming a rollback that never ran.
    if (!originalRenamed) {
      throw new RestoreApplyError(
        "apply_failed_before_swap",
        `restore_apply_failed_before_swap:${errText(error)}`,
      );
    }
    try {
      await rollbackDatabaseSwap(databaseUrl, targetDb, recoveryDb);
      originalRenamed = false;
    } catch (rollbackError) {
      throw new RestoreApplyError(
        "apply_rolled_back",
        `restore_failed_and_rollback_requires_intervention:${errText(error)};rollback:${errText(rollbackError)};recovery_database:${recoveryDb};emergency_backup:${emergencyBackup}`,
        true,
      );
    }
    throw new RestoreApplyError(
      "apply_rolled_back",
      `restore_apply_rolled_back:${errText(error)};emergency_backup:${emergencyBackup}`,
    );
  } finally {
    if (ownsPreparedDb && !preparedRenamed) await dropDatabase(databaseUrl, preparedDb);
  }
}

/**
 * The whole sequence both callers share: verify, and only after it passes,
 * apply — with the scratch database dropped and the temp directory removed on
 * every path. `apply: false` stops after the verification and returns its
 * summary. Throws on any failure; the callers decide how to report it (they each
 * record a run row of their own).
 */
export async function restoreDumpFile(opts: {
  databaseUrl: string;
  dumpPath: string;
  source: string;
  apply: boolean;
  /** the scratch name to use; `<target>_restore_verify` at every real call site */
  scratchDb?: string;
  pgRestore?: string;
  pgDump?: string;
  emergencyDir?: string;
  /** the durable journal to record every phase into (issue #807) */
  journal?: RestoreJournalContext;
  /** where to look for the runtime-role credentials; defaults to process.env */
  runtimeEnv?: Partial<NodeJS.ProcessEnv>;
  failureInjection?: "after_original_rename" | "after_target_swap" | "after_regrant";
}): Promise<{ verified: RestoreSummary; applied: RestoreSummary | null }> {
  const databaseUrl = opts.databaseUrl;
  const targetDb = new URL(databaseUrl).pathname.replace(/^\//, "") || "pos";
  const scratchDb = opts.scratchDb ?? `${targetDb}_restore_verify`;
  const pgRestore = opts.pgRestore ?? pgRestoreBin();
  const journalContext = opts.journal;

  await journal(journalContext, "verify_started");
  let verified: RestoreSummary;
  try {
    verified = await verifyIntoScratch(databaseUrl, scratchDb, pgRestore, opts.dumpPath, opts.source);
  } catch (error) {
    // A scratch database that failed to build must not be left behind either:
    // a leak per failed verify is what fills a CI cluster with `*_restore_verify`
    // databases (issue #807's "leaves nothing behind" contract).
    await dropDatabase(databaseUrl, scratchDb);
    await journal(journalContext, "verify_failed", { error: errText(error).slice(0, 500) });
    throw error;
  }
  await journal(journalContext, "verify_succeeded", {
    migrations: verified.migrations,
    latestMigration: verified.latestMigration,
  });

  try {
    if (!opts.apply) return { verified, applied: null };

    // A destructive apply requires a durable record *before* it starts. If the
    // journal cannot be written, the apply does not happen — and because the
    // scratch verify above already succeeded, nothing on disk has changed.
    await journalApplyStarted(journalContext, { migrations: verified.migrations });

    try {
      const applied = await applyDumpToTarget({
        databaseUrl,
        targetDb,
        pgRestore,
        pgDump: opts.pgDump,
        dumpPath: opts.dumpPath,
        source: opts.source,
        verifiedDb: scratchDb,
        emergencyDir: opts.emergencyDir,
        runtimeEnv: opts.runtimeEnv,
        failureInjection: opts.failureInjection,
      });
      await journal(journalContext, "apply_succeeded", {
        migrations: applied.migrations,
        emergencyBackup: applied.emergencyBackup,
        ...(applied.warnings ? { warnings: applied.warnings } : {}),
      });
      return { verified, applied };
    } catch (error) {
      const phase = error instanceof RestoreApplyError ? error.phase : "apply_failed_before_swap";
      await journal(journalContext, phase, { error: errText(error).slice(0, 500) });
      throw error;
    }
  } finally {
    // After a successful apply the scratch database has been renamed to the
    // target, so this is a no-op. On every other path — verify-only included —
    // it removes the scratch database the dry run built.
    await dropDatabase(databaseUrl, scratchDb);
  }
}

/**
 * A refusal whose *code* is part of the API (the dashboards translate these into
 * Persian), as opposed to a crash whose message is only ever logged. Thrown by
 * the staging steps below so the caller can tell "no such artifact" from
 * "pg_restore died".
 */
export class RestoreRefusal extends Error {
  readonly refusalCode: string;
  constructor(code: string) {
    super(code);
    this.name = "RestoreRefusal";
    this.refusalCode = code;
  }
}

/**
 * Stage one artifact's bytes as a plaintext dump file for pg_restore: decrypt
 * when the bytes carry the POSBKP1 envelope, then write them into a private
 * temp directory the caller removes.
 *
 * The passphrase comes from the caller by design — the tenant half reads it from
 * the business's stored config, the platform half from the platform config or a
 * passphrase the operator typed into the restore dialog — because after a total
 * machine loss there is no config left to read, and that is exactly when a
 * restore has to work.
 */
export async function stageDumpFile(
  data: Buffer,
  passphrase: string,
  sourceName: string,
): Promise<{ workDir: string; dumpPath: string; sourceName: string }> {
  let bytes = data;
  if (isEncryptedBackup(bytes)) {
    if (!passphrase) throw new RestoreRefusal("passphrase_required");
    try {
      bytes = decryptBackup(bytes, passphrase);
    } catch (err) {
      throw new RestoreRefusal(`decrypt_failed:${errText(err)}`);
    }
  }
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-restore-"));
  const dumpPath = path.join(workDir, "restore.dump");
  try {
    await fs.writeFile(dumpPath, bytes, { mode: 0o600 });
    return { workDir, dumpPath, sourceName };
  } catch (error) {
    await secureRemoveDirectory(workDir);
    throw error;
  }
}

/**
 * The streaming twin of `stageDumpFile` (issue #807): take an artifact that is
 * already a file on disk (a peer download, a cloud download, a local backup
 * file, an uploaded chunk set) and produce a plaintext dump path for
 * `pg_restore`, decrypting file → file and never holding the artifact in
 * memory.
 *
 * A plaintext source is hard-linked into the private work directory when the
 * filesystem allows it (no second copy of a multi-GB dump) and stream-copied
 * when it does not. The work directory is removed by the caller either way, so
 * a hard link can never be mistaken for "the artifact was deleted" — the
 * original path is untouched.
 */
export async function stageDumpFileFromPath(
  sourcePath: string,
  passphrase: string,
  sourceName: string,
): Promise<{ workDir: string; dumpPath: string; sourceName: string; sha256: string }> {
  const encrypted = await fileHasBackupMagic(sourcePath);
  const digest = await sha256File(sourcePath);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-restore-"));
  const dumpPath = path.join(workDir, "restore.dump");
  try {
    if (encrypted) {
      if (!passphrase) throw new RestoreRefusal("passphrase_required");
      try {
        await decryptFileToFile(sourcePath, dumpPath, passphrase);
      } catch (err) {
        throw new RestoreRefusal(`decrypt_failed:${errText(err)}`);
      }
    } else {
      try {
        await fs.link(sourcePath, dumpPath);
      } catch {
        await fs.copyFile(sourcePath, dumpPath, constants.COPYFILE_FICLONE);
      }
      await fs.chmod(dumpPath, 0o600).catch(() => {});
    }
    return { workDir, dumpPath, sourceName, sha256: digest };
  } catch (error) {
    await secureRemoveDirectory(workDir);
    throw error;
  }
}

/** Scrub the staged plaintext dump before removing its private directory. */
export async function cleanupStagedDump(workDir: string): Promise<void> {
  await secureRemoveDirectory(workDir);
}

/** The target database name a whole-system dump would replace. */
export function targetDatabaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, "") || "pos";
}
