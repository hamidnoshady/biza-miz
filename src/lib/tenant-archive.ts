/**
 * Issue #903 §4 — the **typed** tenant archive.
 *
 * The Phase 17 export is a text script of `INSERT` statements. It reconstructs
 * state correctly, and it is exactly the wrong thing to feed to a restore path
 * that must never execute untrusted SQL: an uploaded file pretending to be a
 * backup would be handed to the database as code.
 *
 * So a managed backup's logical payload is a typed archive instead — the same
 * rows, as JSON, with an explicit version, the business it belongs to and the
 * schema it was captured under:
 *
 * ```json
 * { "magic": "POSTARC1", "version": 1, "businessId": "…", "capturedAt": "…",
 *   "schemaVersion": 263, "tables": [{ "name": "orders", "columns": [...], "rows": [...] }] }
 * ```
 *
 * `parseTenantArchive` validates it strictly before a single statement is built:
 * every table must be a *tenant* table this build knows (the same enumeration
 * `exportTenantData` reads), every column must be a plain identifier, every row
 * must carry exactly those columns and nothing else. `applyTenantArchive` then
 * issues parameterised `INSERT`s — never text from the file — inside the
 * caller's transaction, after deleting the same tables in reverse dependency
 * order.
 *
 * The pair is deliberately symmetric with `tenant-export.ts`: an archive is what
 * an export becomes once you stop treating a database snapshot as a program.
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import type { TenantExportTable } from "./tenant-export";

export const TENANT_ARCHIVE_MAGIC = "POSTARC1";
export const TENANT_ARCHIVE_VERSION = 1;

export type TenantArchiveCell = string | number | boolean | null | Record<string, unknown> | unknown[];

export interface TenantArchiveTable {
  name: string;
  columns: string[];
  rows: Record<string, TenantArchiveCell>[];
}

export interface TenantArchive {
  magic: typeof TENANT_ARCHIVE_MAGIC;
  version: number;
  businessId: string;
  capturedAt: string;
  schemaVersion: number;
  tables: TenantArchiveTable[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export interface BuildArchiveInput {
  businessId: string;
  capturedAt: Date;
  schemaVersion: number;
  tables: TenantExportTable[];
}

/**
 * Turn exported rows into a typed archive. Values are normalized to JSON-safe
 * scalars so the file round-trips through encryption without depending on the
 * reader's driver: dates become ISO strings (assignment-cast back to
 * `timestamptz`), `bigint` becomes a number when it is safe and a string
 * otherwise.
 */
export function buildTenantArchive(input: BuildArchiveInput): TenantArchive {
  return {
    magic: TENANT_ARCHIVE_MAGIC,
    version: TENANT_ARCHIVE_VERSION,
    businessId: input.businessId,
    capturedAt: input.capturedAt.toISOString(),
    schemaVersion: input.schemaVersion,
    tables: input.tables
      .filter((table) => table.rows.length > 0)
      .map((table) => ({
        name: table.name,
        columns: [...table.columns],
        rows: table.rows.map((row) => {
          const normalized: Record<string, TenantArchiveCell> = {};
          for (const column of table.columns) {
            normalized[column] = normalizeCell(row[column]);
          }
          return normalized;
        }),
      })),
  };
}

function normalizeCell(value: unknown): TenantArchiveCell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => normalizeCell(entry)) as unknown[];
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "object") return { ...(value as Record<string, unknown>) };
  return String(value);
}

export function serializeTenantArchive(archive: TenantArchive): string {
  return JSON.stringify(archive);
}

export type ArchiveParse =
  | { ok: true; archive: TenantArchive }
  | { ok: false; error: string };

/**
 * Strict validation. `allowedTables` is the caller's authoritative tenant-table
 * list; a table outside it is refused rather than skipped, because skipping is
 * how a restore reports success while dropping half a business.
 */
export function parseTenantArchive(
  raw: string,
  options: { allowedTables: ReadonlySet<string>; businessId?: string; maxSchemaVersion?: number },
): ArchiveParse {
  if (raw.length === 0) return { ok: false, error: "archive_empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "archive_not_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "archive_not_object" };
  }
  const value = parsed as Record<string, unknown>;
  if (value.magic !== TENANT_ARCHIVE_MAGIC) return { ok: false, error: "archive_magic_invalid" };
  if (value.version !== TENANT_ARCHIVE_VERSION) {
    return {
      ok: false,
      error: typeof value.version === "number" && value.version > TENANT_ARCHIVE_VERSION
        ? "archive_version_too_new"
        : "archive_version_unsupported",
    };
  }
  if (typeof value.businessId !== "string" || !value.businessId) return { ok: false, error: "archive_business_missing" };
  if (options.businessId && value.businessId !== options.businessId) {
    return { ok: false, error: "archive_business_mismatch" };
  }
  if (typeof value.capturedAt !== "string" || Number.isNaN(Date.parse(value.capturedAt))) {
    return { ok: false, error: "archive_captured_at_invalid" };
  }
  if (!Number.isInteger(value.schemaVersion) || (value.schemaVersion as number) < 1) {
    return { ok: false, error: "archive_schema_invalid" };
  }
  if (options.maxSchemaVersion !== undefined && (value.schemaVersion as number) > options.maxSchemaVersion) {
    return { ok: false, error: "archive_schema_newer_than_installation" };
  }
  if (!Array.isArray(value.tables) || value.tables.length === 0) {
    return { ok: false, error: "archive_tables_missing" };
  }

  const seen = new Set<string>();
  const tables: TenantArchiveTable[] = [];
  for (const entry of value.tables) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "archive_table_invalid" };
    }
    const table = entry as Record<string, unknown>;
    const name = table.name;
    if (typeof name !== "string" || !IDENTIFIER.test(name)) return { ok: false, error: "archive_table_invalid" };
    if (!options.allowedTables.has(name)) return { ok: false, error: `archive_table_not_allowed:${name}` };
    if (seen.has(name)) return { ok: false, error: "archive_table_duplicate" };
    seen.add(name);
    if (!Array.isArray(table.columns) || table.columns.length === 0) {
      return { ok: false, error: "archive_columns_invalid" };
    }
    const columns = table.columns.map((column) => String(column));
    if (columns.some((column) => !IDENTIFIER.test(column)) || new Set(columns).size !== columns.length) {
      return { ok: false, error: "archive_columns_invalid" };
    }
    if (!Array.isArray(table.rows)) return { ok: false, error: "archive_rows_invalid" };
    const rows: Record<string, TenantArchiveCell>[] = [];
    for (const row of table.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return { ok: false, error: "archive_row_invalid" };
      }
      const record = row as Record<string, unknown>;
      const keys = Object.keys(record);
      // Exact column parity: an extra key is how a restore would silently write
      // a column the export never produced.
      if (keys.length !== columns.length || keys.some((key) => !columns.includes(key))) {
        return { ok: false, error: "archive_row_columns_mismatch" };
      }
      rows.push(record as Record<string, TenantArchiveCell>);
    }
    tables.push({ name, columns, rows });
  }

  return {
    ok: true,
    archive: {
      magic: TENANT_ARCHIVE_MAGIC,
      version: TENANT_ARCHIVE_VERSION,
      businessId: value.businessId,
      capturedAt: value.capturedAt,
      schemaVersion: value.schemaVersion as number,
      tables,
    },
  };
}

/** Row counts per table, for the preview and the post-restore verification. */
export function archiveRowCounts(archive: TenantArchive): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of archive.tables) counts[table.name] = table.rows.length;
  return counts;
}

/** Columns eligible for an `INSERT`: the archive's own list, validated again here. */
function assertIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error("archive_identifier_invalid");
  return value;
}

/** Identifiers are validated above and quoted here, so a reserved word is legal. */
function quoteIdentifier(value: string): string {
  return `"${assertIdentifier(value)}"`;
}

export interface ApplyArchiveResult {
  deleted: number;
  inserted: number;
  tables: number;
}

/**
 * Replace this tenant's rows for every table the archive contains.
 *
 * MUST run inside a transaction pinned to the business (see
 * `applyTenantArchiveInTransaction`), so RLS confines every DELETE and INSERT to
 * one tenant and a failure rolls the whole replacement back. Tables are cleared
 * in reverse dependency order and filled in dependency order, so foreign keys
 * hold at every step.
 */
/**
 * Tables a tenant restore must **never** delete and refill (issue #903 §5).
 *
 * The archive is captured table by table from everything that carries a
 * `business_id`, and the money tables carry one. Without this set a restore
 * rewinds them: `business_wallets.balance_rial` goes back to the balance at the
 * moment of the backup — refunding every charge since — and
 * `wallet_ledger` loses the entries that explain the difference.
 *
 * `billing_usage_events` is the subtler one: it is what makes charging
 * idempotent (its `event_id` is the dedupe identity). Deleting a day's events
 * and re-inserting an older day's would let the settlement job re-charge a
 * window it had already charged, because the evidence that it had is gone.
 *
 * §5 states it directly: a restore must prove "the canonical wallet is
 * unchanged". These are skipped rather than checked afterwards, so the property
 * holds by construction: no statement is ever issued against them.
 */
export const RESTORE_IMMUTABLE_TABLES: ReadonlySet<string> = new Set([
  "business_wallets",
  "wallet_ledger",
  "billing_usage_events",
]);

export async function applyTenantArchive(
  client: PoolClient,
  archive: TenantArchive,
  options: { tablesInOrder: readonly string[]; skipTables?: ReadonlySet<string> },
): Promise<ApplyArchiveResult> {
  const skipped = options.skipTables ?? new Set<string>();
  const restorable = archive.tables.filter((table) => !skipped.has(table.name));
  const present = new Set(restorable.map((table) => table.name));
  const ordered = options.tablesInOrder.filter((table) => present.has(table));
  // An archive table missing from the caller's dependency order would be
  // applied in an arbitrary position — refuse instead.
  if (ordered.length !== present.size) throw new Error("archive_table_order_incomplete");

  let deleted = 0;
  for (const table of [...ordered].reverse()) {
    const result = await client.query(`DELETE FROM ${quoteIdentifier(table)}`);
    deleted += result.rowCount ?? 0;
  }

  let inserted = 0;
  for (const table of ordered) {
    const entry = archive.tables.find((candidate) => candidate.name === table)!;
    if (entry.rows.length === 0) continue;
    const columns = entry.columns.map(assertIdentifier);
    const columnList = columns.map((column) => `"${column}"`).join(", ");
    // One statement per row: self-referencing parents are already ordered by the
    // export, and batching them would lose that guarantee.
    for (const row of entry.rows) {
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      const values = columns.map((column) => {
        const cell = row[column];
        if (cell !== null && typeof cell === "object" && !Array.isArray(cell)) return JSON.stringify(cell);
        return cell as unknown;
      });
      await client.query(
        `INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES (${placeholders})`,
        values,
      );
      inserted += 1;
    }
  }
  return { deleted, inserted, tables: ordered.length };
}

/** Tables a validated archive touched, for the restore journal. */
export async function tenantTableSet(): Promise<Set<string>> {
  const { rows } = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'business_id'
        AND table_name <> 'businesses'`,
  );
  return new Set(rows.map((row) => row.table_name));
}
