/**
 * The one canonical migration-status service.
 *
 * `/api/platform/system` and `/api/platform/overview` both need to answer "is
 * this deployment's database behind its code, and if so why?". They used to
 * each carry their own `pendingMigrationCount()` that read the migrations
 * directory and `schema_migrations` and returned a bare number — which had two
 * failure modes that mattered in production:
 *
 *   1. a number cannot say *why* a migration is pending, so the deliberately
 *      deferred `0209_ai_gateway_secret_cutover.sql` was reported with the same
 *      generic "running code is ahead of the database, run npm run db:migrate"
 *      warning as an ordinary forgotten migration — advice that is wrong for the
 *      cutover, because a bare `db:migrate` defers it again; and
 *   2. an unreadable migrations directory was swallowed and reported as `0`
 *      pending, i.e. "healthy", which is the one answer that must never be
 *      invented.
 *
 * This module replaces both copies. It is server-only (it touches the database
 * and the filesystem) and returns a typed status that distinguishes applied,
 * ordinary pending, gated/deferred, and unknown. `pendingTotal` keeps the old
 * count meaningful for existing consumers and always includes the gated
 * migration — the cleanup is never hidden by reclassifying it as "done".
 *
 * Read-only by construction: nothing here applies a migration, clears a
 * credential, or probes a provider. No credential material is ever read, only
 * counts of rows and the presence of columns.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "./db";
import {
  AI_GATEWAY_SECRET_COLUMN_PROBE_SQL,
  AI_GATEWAY_SECRET_CUTOVER_MIGRATION,
  MIGRATION_FILENAME,
  cutoverReasonCode,
  isSecretCutoverMigration,
  migrationDependsOnLegacySecretColumn,
  readCutoverFlags,
  type AiGatewaySecretColumn,
  type CutoverFlags,
  type CutoverReasonCode,
} from "./ai-gateway-secret-cutover-policy";

/** How many applied migrations the health payload carries. */
const APPLIED_PREVIEW = 30;

/** The default location: the repository's own `migrations/` directory. */
export function defaultMigrationsDir(): string {
  return join(process.cwd(), "migrations");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One migration file's state on THIS deployment. */
export interface MigrationEntry {
  filename: string;
  /**
   * `applied` — recorded in `schema_migrations`;
   * `pending` — not recorded, and `npm run db:migrate` would apply it;
   * `gated` — not recorded, and deliberately withheld until an operator
   *           completes the AI gateway secret cutover's verification.
   */
  state: "applied" | "pending" | "gated";
  /** Stable machine-readable code for `state`. Never free-form prose. */
  reasonCode: string;
  /** Operator-facing detail (counts, flag names). Never credential material. */
  detail: string | null;
  /** When this migration was last successfully applied (ISO 8601), or null. */
  appliedAt: string | null;
}

/** Redacted AI gateway secret-cutover state: counts and flags, never keys. */
export interface AiGatewaySecretCutoverState {
  /** The gated migration's filename. */
  migration: string;
  /** Recorded in `schema_migrations` — the legacy columns are gone. */
  applied: boolean;
  /** Pending and deliberately withheld pending operator verification. */
  gated: boolean;
  reasonCode: CutoverReasonCode;
  /** `AI_GATEWAY_SECRET_CUTOVER_DEFER` as this process sees it. */
  deferFlag: boolean;
  /** `AI_GATEWAY_SECRET_CUTOVER_VERIFIED` as this process sees it. */
  verifiedFlag: boolean;
  /** Both switches set at once; the runner refuses to run until one is removed. */
  flagsConflict: boolean;
  /** Legacy plaintext columns still exist, or null when that could not be read. */
  legacyColumnsPresent: boolean | null;
  /** Rows whose plaintext credential has no ciphertext twin (redacted count). */
  rowsMissingCiphertext: number | null;
  /** Rows still holding a legacy plaintext credential (redacted count). */
  legacyPlaintextRows: number | null;
  /** A later unapplied migration names a legacy column, so the runner blocks. */
  blockedBy: string | null;
}

/** Why a status could not be produced, or what its headline is. */
export type MigrationStatusReasonCode =
  | "up_to_date"
  | "ordinary_pending"
  | "migration_inventory_unreadable"
  | "applied_migrations_unreadable"
  | "ai_gateway_secret_cutover_flags_conflict"
  | "ai_gateway_secret_cutover_blocks_later_migration"
  | "ai_gateway_secret_cutover_state_unknown"
  | CutoverReasonCode;

export interface MigrationStatus {
  /**
   * False when either half of the inventory (the files on disk, or
   * `schema_migrations`) could not be read. Every count below is then null and
   * `reasonCode` says which half failed — never a confident zero.
   */
  available: boolean;
  /** The single most important thing about this status; null only when available. */
  reasonCode: MigrationStatusReasonCode | null;
  /** When this status was computed (ISO 8601). */
  checkedAt: string;
  /** How many migrations `schema_migrations` records. */
  appliedCount: number;
  /** The most recently applied migrations, newest first (capped). */
  applied: MigrationEntry[];
  /** Newest `applied_at` in `schema_migrations` (ISO 8601) — the last time the schema was known to advance. */
  lastAppliedAt: string | null;
  /** Unapplied migrations an ordinary `npm run db:migrate` would apply. */
  ordinaryPending: MigrationEntry[];
  /** Unapplied migrations deliberately withheld pending operator verification. */
  gated: MigrationEntry[];
  /**
   * `ordinaryPending.length + gated.length`, or null when `available` is false.
   * Retained for existing consumers; the gated migration is always counted.
   */
  pendingTotal: number | null;
  cutover: AiGatewaySecretCutoverState;
}

/** What the pure classifier needs to know about the database's secret state. */
export interface CutoverDatabaseState {
  /** Any AI gateway credential (plaintext or ciphertext) still stored; null if unknown. */
  secretsStored: boolean | null;
  legacyColumnsPresent: boolean | null;
  rowsMissingCiphertext: number | null;
  legacyPlaintextRows: number | null;
}

export interface MigrationStatusInput {
  /** Migration filenames on disk, sorted; null when the directory could not be read. */
  files: readonly string[] | null;
  /** Applied filenames → `applied_at`; null when `schema_migrations` could not be read. */
  applied: ReadonlyMap<string, string | null> | null;
  /** The AI gateway secret state as the database reports it. */
  cutoverDatabase: CutoverDatabaseState;
  /** A later unapplied migration naming a legacy column, if any. */
  blockedBy?: string | null;
  /** The cutover switches; defaults to reading them from `process.env`. */
  flags?: CutoverFlags;
  /** Injected for tests. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// The pure classifier
// ---------------------------------------------------------------------------

const UNKNOWN_CUTOVER_DATABASE: CutoverDatabaseState = {
  secretsStored: null,
  legacyColumnsPresent: null,
  rowsMissingCiphertext: null,
  legacyPlaintextRows: null,
};

function unavailable(
  reasonCode: MigrationStatusReasonCode,
  now: Date,
): MigrationStatus {
  return {
    available: false,
    reasonCode,
    checkedAt: now.toISOString(),
    appliedCount: 0,
    applied: [],
    lastAppliedAt: null,
    ordinaryPending: [],
    gated: [],
    pendingTotal: null,
    cutover: {
      migration: AI_GATEWAY_SECRET_CUTOVER_MIGRATION,
      applied: false,
      gated: false,
      reasonCode: "ai_gateway_secret_cutover_state_unknown",
      deferFlag: false,
      verifiedFlag: false,
      flagsConflict: false,
      legacyColumnsPresent: null,
      rowsMissingCiphertext: null,
      legacyPlaintextRows: null,
      blockedBy: null,
    },
  };
}

/**
 * Turn the raw inventory into the typed status. Pure so every state — including
 * the ones that are hard to reproduce against a live database — is unit-testable
 * without one.
 */
export function buildMigrationStatus(input: MigrationStatusInput): MigrationStatus {
  const now = input.now ?? new Date();
  const files = input.files;
  const applied = input.applied;

  if (files === null) return unavailable("migration_inventory_unreadable", now);
  if (applied === null) return unavailable("applied_migrations_unreadable", now);

  const flags = input.flags ?? readCutoverFlags();
  const db = input.cutoverDatabase ?? UNKNOWN_CUTOVER_DATABASE;
  const cutoverApplied = applied.has(AI_GATEWAY_SECRET_CUTOVER_MIGRATION);

  const appliedEntries: MigrationEntry[] = [...applied.entries()]
    .map(([filename, appliedAt]) => ({
      filename,
      state: "applied" as const,
      reasonCode: "applied",
      detail: null,
      appliedAt: appliedAt ?? null,
    }))
    .sort((a, b) => b.filename.localeCompare(a.filename));

  const lastAppliedAt = appliedEntries.reduce<string | null>(
    (newest, entry) => (entry.appliedAt && (!newest || entry.appliedAt > newest) ? entry.appliedAt : newest),
    null,
  );

  const cutoverReason: CutoverReasonCode = cutoverApplied
    ? "ai_gateway_secret_cutover_applied"
    : cutoverReasonCode({
        defer: flags.defer,
        verified: flags.verified,
        secretsStored: db.secretsStored,
      });

  // 0209 is gated when it is unapplied AND the runner would defer it. A
  // conflicting pair of flags is reported as gated too: the runner refuses to
  // start, so the migration cannot move until the operator removes one.
  const cutoverGated =
    !cutoverApplied &&
    (flags.conflict ||
      cutoverReason === "ai_gateway_secret_cutover_awaiting_verification" ||
      cutoverReason === "ai_gateway_secret_cutover_deferred_by_flag" ||
      cutoverReason === "ai_gateway_secret_cutover_state_unknown");

  const ordinaryPending: MigrationEntry[] = [];
  const gated: MigrationEntry[] = [];

  for (const filename of files) {
    if (applied.has(filename)) continue;
    if (isSecretCutoverMigration(filename) && cutoverGated) {
      gated.push({
        filename,
        state: "gated",
        reasonCode: cutoverReason,
        detail: cutoverDetail(cutoverReason, db, flags.conflict),
        appliedAt: null,
      });
      continue;
    }
    ordinaryPending.push({
      filename,
      state: "pending",
      reasonCode: isSecretCutoverMigration(filename)
        ? "ai_gateway_secret_cutover_applicable"
        : "ordinary_pending",
      detail: isSecretCutoverMigration(filename)
        ? "AI gateway secret cutover; no credential is stored, so it applies without a confirmation flag."
        : null,
      appliedAt: null,
    });
  }

  const blockedBy = input.blockedBy ?? null;

  let reasonCode: MigrationStatusReasonCode;
  if (flags.conflict) reasonCode = "ai_gateway_secret_cutover_flags_conflict";
  else if (blockedBy) reasonCode = "ai_gateway_secret_cutover_blocks_later_migration";
  else if (gated.length > 0) reasonCode = cutoverReason;
  else if (ordinaryPending.length > 0) reasonCode = "ordinary_pending";
  else reasonCode = "up_to_date";

  return {
    available: true,
    reasonCode,
    checkedAt: now.toISOString(),
    appliedCount: applied.size,
    applied: appliedEntries.slice(0, APPLIED_PREVIEW),
    lastAppliedAt,
    ordinaryPending,
    gated,
    pendingTotal: ordinaryPending.length + gated.length,
    cutover: {
      migration: AI_GATEWAY_SECRET_CUTOVER_MIGRATION,
      applied: cutoverApplied,
      gated: cutoverGated,
      reasonCode: cutoverReason,
      deferFlag: flags.defer,
      verifiedFlag: flags.verified,
      flagsConflict: flags.conflict,
      legacyColumnsPresent: db.legacyColumnsPresent,
      rowsMissingCiphertext: db.rowsMissingCiphertext,
      legacyPlaintextRows: db.legacyPlaintextRows,
      blockedBy,
    },
  };
}

function cutoverDetail(
  reason: CutoverReasonCode,
  db: CutoverDatabaseState,
  conflict: boolean,
): string | null {
  switch (reason) {
    case "ai_gateway_secret_cutover_awaiting_verification":
      return "Legacy plaintext AI credentials are still stored; the column drop waits for verified ciphertext-backed production reads.";
    case "ai_gateway_secret_cutover_deferred_by_flag":
      return "AI_GATEWAY_SECRET_CUTOVER_DEFER=true withholds this migration on purpose.";
    case "ai_gateway_secret_cutover_flags_conflict":
      return conflict
        ? "AI_GATEWAY_SECRET_CUTOVER_DEFER and AI_GATEWAY_SECRET_CUTOVER_VERIFIED are both set; the migration runner refuses to start until one is removed."
        : null;
    case "ai_gateway_secret_cutover_state_unknown":
      return "Whether a credential is still stored could not be determined from this database.";
    default:
      return db.legacyColumnsPresent === false
        ? "Legacy plaintext columns are already gone."
        : null;
  }
}

// ---------------------------------------------------------------------------
// The I/O layer
// ---------------------------------------------------------------------------

/** The migration filenames on disk, or null when the directory cannot be read. */
export function readMigrationInventory(migrationsDir: string): string[] | null {
  try {
    return readdirSync(migrationsDir).filter((filename) => MIGRATION_FILENAME.test(filename)).sort();
  } catch {
    // An unreadable inventory is an operational fact worth reporting, not a
    // reason to answer "nothing pending".
    return null;
  }
}

interface AppliedRow extends Record<string, unknown> {
  filename: string;
  applied_at: Date | string | null;
}

/** `schema_migrations` as filename → applied_at, or null when unreadable. */
export async function readAppliedMigrations(): Promise<Map<string, string | null> | null> {
  try {
    const { rows } = await query<AppliedRow>("SELECT filename, applied_at FROM schema_migrations");
    const map = new Map<string, string | null>();
    for (const row of rows) {
      map.set(
        row.filename,
        row.applied_at instanceof Date
          ? row.applied_at.toISOString()
          : (row.applied_at ?? null),
      );
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Redacted AI gateway secret state: which legacy columns exist, and how many
 * rows still hold a plaintext credential or lack a ciphertext twin. Counts only
 * — no credential is selected, decrypted or returned.
 */
export async function readCutoverDatabaseState(): Promise<CutoverDatabaseState> {
  try {
    const { rows: columns } = await query<AiGatewaySecretColumn>(
      AI_GATEWAY_SECRET_COLUMN_PROBE_SQL,
    );

    const has = (table: string, column: string) =>
      columns.some((c) => c.table_name === table && c.column_name === column);
    const legacyColumnsPresent =
      has("platform_ai_gateway", "master_key") || has("ai_business_gateway", "virtual_key");

    // Post-0209 there is nothing left to count, and the tables may not exist at
    // all on a partially migrated database.
    if (columns.length === 0) {
      return {
        secretsStored: false,
        legacyColumnsPresent: false,
        rowsMissingCiphertext: 0,
        legacyPlaintextRows: 0,
      };
    }

    // One scalar subquery per column that actually exists, so the statement is
    // valid on any schema the reporter can reach — the same trick
    // `scripts/migrate.ts` uses before it decides to defer 0209.
    const storedChecks: string[] = [];
    const missingChecks: string[] = [];
    const legacyChecks: string[] = [];
    if (has("platform_ai_gateway", "master_key")) {
      storedChecks.push(
        `EXISTS (SELECT 1 FROM platform_ai_gateway WHERE NULLIF(btrim(master_key), '') IS NOT NULL)`,
      );
      missingChecks.push(
        `(SELECT count(*) FROM platform_ai_gateway WHERE NULLIF(btrim(master_key), '') IS NOT NULL AND NULLIF(btrim(master_key_ciphertext), '') IS NULL)`,
      );
      legacyChecks.push(
        `(SELECT count(*) FROM platform_ai_gateway WHERE NULLIF(btrim(master_key), '') IS NOT NULL)`,
      );
    }
    if (has("ai_business_gateway", "virtual_key")) {
      storedChecks.push(
        `EXISTS (SELECT 1 FROM ai_business_gateway WHERE NULLIF(btrim(virtual_key), '') IS NOT NULL)`,
      );
      missingChecks.push(
        `(SELECT count(*) FROM ai_business_gateway WHERE NULLIF(btrim(virtual_key), '') IS NOT NULL AND NULLIF(btrim(virtual_key_ciphertext), '') IS NULL)`,
      );
      legacyChecks.push(
        `(SELECT count(*) FROM ai_business_gateway WHERE NULLIF(btrim(virtual_key), '') IS NOT NULL)`,
      );
    }
    // Ciphertext-only rows still count as "a credential is stored": the
    // migration's own guard refuses to drop the columns while any exist.
    if (has("platform_ai_gateway", "master_key_ciphertext")) {
      storedChecks.push(
        `EXISTS (SELECT 1 FROM platform_ai_gateway WHERE NULLIF(btrim(master_key_ciphertext), '') IS NOT NULL)`,
      );
    }
    if (has("ai_business_gateway", "virtual_key_ciphertext")) {
      storedChecks.push(
        `EXISTS (SELECT 1 FROM ai_business_gateway WHERE NULLIF(btrim(virtual_key_ciphertext), '') IS NOT NULL)`,
      );
    }

    // A post-0209 schema has the ciphertext twins but no plaintext column, so
    // either list can legitimately be empty — `0::bigint` keeps the statement
    // valid instead of producing `()::bigint`.
    const missing = missingChecks.length > 0 ? missingChecks.join(" + ") : "0";
    const legacy = legacyChecks.length > 0 ? legacyChecks.join(" + ") : "0";

    const { rows } = await query<{ stored: boolean; missing: string; legacy: string }>(
      `SELECT (${storedChecks.join(" OR ")}) AS stored,
              (${missing})::bigint AS missing,
              (${legacy})::bigint AS legacy`,
    );
    return {
      secretsStored: rows[0]?.stored === true,
      legacyColumnsPresent,
      rowsMissingCiphertext: Number(rows[0]?.missing ?? 0),
      legacyPlaintextRows: Number(rows[0]?.legacy ?? 0),
    };
  } catch {
    return {
      secretsStored: null,
      legacyColumnsPresent: null,
      rowsMissingCiphertext: null,
      legacyPlaintextRows: null,
    };
  }
}

/**
 * A later unapplied migration that still names a legacy plaintext column. The
 * runner refuses to defer 0209 when one exists (it could not run either), so
 * the health surface must say so rather than showing a quiet "deferred" badge.
 */
export function findBlockingDependentMigration(
  migrationsDir: string,
  files: readonly string[],
  applied: ReadonlySet<string>,
): string | null {
  const cutoverIndex = files.indexOf(AI_GATEWAY_SECRET_CUTOVER_MIGRATION);
  if (cutoverIndex < 0) return null;
  for (const filename of files.slice(cutoverIndex + 1)) {
    if (applied.has(filename)) continue;
    let sql: string;
    try {
      sql = readFileSync(join(migrationsDir, filename), "utf8");
    } catch {
      continue;
    }
    if (migrationDependsOnLegacySecretColumn(sql)) return filename;
  }
  return null;
}

export interface MigrationStatusOptions {
  migrationsDir?: string;
  now?: Date;
}

/**
 * The deployment's migration status, for the health surfaces.
 *
 * Never throws: a database or filesystem failure is reported as an unavailable
 * status with a reason code, because a health endpoint that 500s is less useful
 * than one that says "I could not tell".
 */
export async function getMigrationStatus(
  options: MigrationStatusOptions = {},
): Promise<MigrationStatus> {
  const now = options.now ?? new Date();
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();

  const files = readMigrationInventory(migrationsDir);
  const [applied, cutoverDatabase] = await Promise.all([
    readAppliedMigrations(),
    readCutoverDatabaseState(),
  ]);

  const blockedBy =
    files && applied
      ? findBlockingDependentMigration(migrationsDir, files, new Set(applied.keys()))
      : null;

  return buildMigrationStatus({
    files,
    applied,
    cutoverDatabase,
    blockedBy,
    now,
  });
}
