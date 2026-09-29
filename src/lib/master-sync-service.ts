/**
 * Continuous master-data sync (migration 0190): customers, the menu, dining
 * tables and payment ways, in both directions, merged field by field.
 *
 * Capture is a trigger on every synchronised table, so no write path can
 * forget it: the owner's form, an importer, the AI assistant and a bulk edit
 * all land in `sync_row_clocks` the same way. This module is the transport
 * half — reading a peer's feed and merging a peer's changes in — and is used
 * identically on the desktop and on the central server.
 *
 * DB-touching; the merge rules are pure and unit-tested in master-sync-merge.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { getBusinessDek } from "./business-keys";
import { ENCRYPTED_TABLES } from "./encrypted-columns";
import { decryptOptional, encryptOptional } from "./field-crypto";
import {
  MASTER_SYNC_TABLES,
  masterTableConfig,
  masterTableRank,
  splitRowKey,
  type MasterTableConfig,
} from "./master-sync-registry";
import { planMasterMerge, type LocalMasterState, type MasterChange } from "./master-sync-merge";
import { identityColumns, phoneColumns } from "./parties-service";
import { hlcNode, isHlc, maxHlc, ZERO_HLC } from "./sync-hlc";

/** A change as it crosses the wire: the merge input plus where it came from. */
export interface MasterFeedChange extends MasterChange {
  /** The node whose edit this row state carries; used to avoid echoing it back. */
  writerNode: string | null;
  /** The branch a location-scoped row belongs to; null for business-wide rows. */
  locationId: string | null;
  /** Feed position of this change (the writing transaction), for cursor bookkeeping. */
  txid: string;
}

/** Position in a peer's feed: (txid, table, row) of the last change read. */
export interface MasterCursor {
  txid: string;
  table: string;
  rowId: string;
}

export const MASTER_CURSOR_START: MasterCursor = { txid: "0", table: "", rowId: "" };

export function encodeMasterCursor(cursor: MasterCursor): string {
  return `${cursor.txid}:${cursor.table}:${cursor.rowId}`;
}

export function decodeMasterCursor(value: unknown): MasterCursor | null {
  if (typeof value !== "string" || value === "") return null;
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  if (first < 1 || second < 0) return null;
  const txid = value.slice(0, first);
  if (!/^[0-9]{1,20}$/.test(txid)) return null;
  return { txid, table: value.slice(first + 1, second), rowId: value.slice(second + 1) };
}

// ---------------------------------------------------------------------------
// Column metadata
// ---------------------------------------------------------------------------

interface ColumnMeta {
  name: string;
  /** SQL type to cast a parameter to on write. */
  castType: string;
  /** How the column is read so its value survives JSON exactly. */
  readExpr: string;
  isJson: boolean;
}

let columnCache: Map<string, ColumnMeta[]> | null = null;

async function masterColumns(): Promise<Map<string, ColumnMeta[]>> {
  if (columnCache) return columnCache;
  const tables = MASTER_SYNC_TABLES.map((config) => config.table);
  const { rows } = await query<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_generated: string;
    is_identity: string;
  }>(
    `SELECT table_name, column_name, data_type, udt_name, is_generated, is_identity
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [tables],
  );
  const map = new Map<string, ColumnMeta[]>();
  for (const config of MASTER_SYNC_TABLES) {
    const excluded = new Set(config.excluded);
    map.set(
      config.table,
      rows
        .filter(
          (row) =>
            row.table_name === config.table &&
            row.is_generated !== "ALWAYS" &&
            row.is_identity !== "YES" &&
            !excluded.has(row.column_name),
        )
        .map((row) => columnMeta(row.column_name, row.data_type, row.udt_name)),
    );
  }
  columnCache = map;
  return map;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe_identifier: ${name}`);
  return `"${name}"`;
}

function columnMeta(name: string, dataType: string, udtName: string): ColumnMeta {
  const column = quoteIdent(name);
  switch (dataType) {
    case "bigint":
    case "numeric":
      // Exact digits: a JSON number would round a large Rial amount or a
      // fractional quantity.
      return { name, castType: dataType, readExpr: `${column}::text`, isJson: false };
    case "date":
      return { name, castType: "date", readExpr: `to_char(${column}, 'YYYY-MM-DD')`, isJson: false };
    case "timestamp with time zone":
      return { name, castType: "timestamptz", readExpr: `${column}`, isJson: false };
    case "jsonb":
    case "json":
      return { name, castType: dataType, readExpr: column, isJson: true };
    case "USER-DEFINED":
      return { name, castType: quoteIdent(udtName), readExpr: `${column}::text`, isJson: false };
    case "ARRAY":
      return { name, castType: `${udtName.replace(/^_/, "")}[]`, readExpr: column, isJson: false };
    default:
      return { name, castType: dataType, readExpr: column, isJson: false };
  }
}

function pkWhere(config: MasterTableConfig, firstParam: number): string {
  return config.pk.map((column, index) => `${quoteIdent(column)} = $${firstParam + index}::uuid`).join(" AND ");
}

// ---------------------------------------------------------------------------
// Reading a feed
// ---------------------------------------------------------------------------

export interface MasterFeedPage {
  changes: MasterFeedChange[];
  /** Where the next read starts; unchanged when nothing new was committed. */
  cursor: MasterCursor;
  hasMore: boolean;
  /** This database's clock node, so the peer can skip echoing its edits back. */
  node: string;
}

/**
 * The next page of master changes for one business, in commit-safe order.
 *
 * Only rows whose writing transaction is below the snapshot's xmin are read,
 * so a change still committing can never land behind the returned cursor.
 * `locationId` narrows location-scoped rows to one branch (the central server
 * serving one desktop); business-wide rows always pass. Rows last written by
 * `excludeNode` are skipped but still advance the cursor: that node already
 * holds them.
 */
export async function readMasterFeed(
  businessId: string,
  options: { cursor: MasterCursor | null; limit?: number; locationId: string | null; excludeNode: string | null },
): Promise<MasterFeedPage> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const cursor = options.cursor ?? MASTER_CURSOR_START;
  const columns = await masterColumns();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const node = (await client.query<{ node: string }>("SELECT app_sync_node_id() AS node")).rows[0]?.node ?? "";
    const { rows: clockRows } = await client.query<{
      table_name: string;
      row_id: string;
      location_id: string | null;
      field_clocks: Record<string, string>;
      row_hlc: string;
      deleted: boolean;
      writer_node: string | null;
      txid: string;
    }>(
      `SELECT table_name, row_id, location_id::text, field_clocks, row_hlc, deleted, writer_node, txid::text
         FROM sync_row_clocks
        WHERE business_id = $1
          AND (txid, table_name, row_id) > ($2::xid8, $3::text, $4::text)
          AND txid < pg_snapshot_xmin(pg_current_snapshot())
          AND ($5::uuid IS NULL OR location_id IS NULL OR location_id = $5::uuid)
          AND table_name = ANY($6::text[])
        ORDER BY txid, table_name, row_id
        LIMIT $7`,
      [
        businessId,
        cursor.txid,
        cursor.table,
        cursor.rowId,
        options.locationId,
        MASTER_SYNC_TABLES.map((config) => config.table),
        limit,
      ],
    );
    const last = clockRows.at(-1);
    const nextCursor: MasterCursor = last ? { txid: last.txid, table: last.table_name, rowId: last.row_id } : cursor;
    const wanted = clockRows.filter((row) => !options.excludeNode || row.writer_node !== options.excludeNode);

    // Current row values, read in the same snapshot as their clocks.
    const rowsByKey = new Map<string, Record<string, unknown>>();
    const byTable = new Map<string, string[]>();
    for (const row of wanted) {
      if (row.deleted) continue;
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.row_id]);
    }
    for (const [table, keys] of byTable) {
      const config = masterTableConfig(table);
      const meta = columns.get(table);
      if (!config || !meta) continue;
      const fetched = await readRows(client, businessId, config, meta, keys);
      for (const [key, row] of fetched) rowsByKey.set(`${table}\u0000${key}`, row);
    }
    await client.query("COMMIT");

    const changes: MasterFeedChange[] = [];
    for (const row of wanted) {
      const data = row.deleted ? null : rowsByKey.get(`${row.table_name}\u0000${row.row_id}`) ?? null;
      // A tracked row that is gone without a tombstone went with its parent by
      // cascade; the parent's own delete carries it.
      if (!row.deleted && !data) continue;
      changes.push({
        table: row.table_name,
        rowId: row.row_id,
        deleted: row.deleted,
        rowHlc: row.row_hlc,
        clocks: row.field_clocks ?? {},
        row: data,
        writerNode: row.writer_node,
        locationId: row.location_id,
        txid: row.txid,
      });
    }
    return { changes, cursor: nextCursor, hasMore: clockRows.length === limit, node };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function readRows(
  client: PoolClient,
  businessId: string,
  config: MasterTableConfig,
  meta: ColumnMeta[],
  keys: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const encrypted = ENCRYPTED_TABLES[config.table]?.columns ?? [];
  const select = [
    ...meta.map((column) => `${column.readExpr} AS ${quoteIdent(column.name)}`),
    ...encrypted.map((column) => quoteIdent(column.encColumn)),
  ].join(", ");
  const splits = keys.map((key) => splitRowKey(config, key)).filter((split): split is Record<string, string> => !!split);
  if (splits.length === 0) return new Map();
  const params = config.pk.map((column) => splits.map((split) => split[column]));
  const unnest = config.pk.map((_, index) => `$${index + 1}::uuid[]`).join(", ");
  const tuple = config.pk.map(quoteIdent).join(", ");
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT ${select} FROM ${quoteIdent(config.table)}
      WHERE (${tuple}) IN (SELECT * FROM unnest(${unnest}))`,
    params,
  );
  const dek = encrypted.length > 0 ? await getBusinessDek(businessId) : null;
  const out = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    // Ciphertext is under this install's key only; the peer receives the
    // plaintext and encrypts it under its own.
    for (const column of encrypted) {
      row[column.column] = decryptOptional(
        row[column.encColumn] as Buffer | null,
        dek,
        (row[column.column] as string | null) ?? null,
      );
      delete row[column.encColumn];
    }
    for (const [key, value] of Object.entries(row)) if (value instanceof Date) row[key] = value.toISOString();
    out.set(config.pk.map((column) => String(row[column])).join("|"), row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Applying a peer's changes
// ---------------------------------------------------------------------------

export type MasterApplyOutcome = "applied" | "noop" | "deferred" | "conflict";

export interface MasterApplyResult {
  outcomes: MasterApplyOutcome[];
  /**
   * Index of the first change that must be retried (a parent row that has not
   * arrived yet), or -1 when every change is settled. A caller advances its
   * cursor only to the change before it.
   */
  firstDeferred: number;
}

/** After this many attempts a change still missing its parent is recorded as a conflict and skipped. */
export const MAX_DEPENDENCY_ATTEMPTS = 10;

class DependencyMissing extends Error {}
class MergeConflict extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
  }
}

function pgCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : null;
}

function pgConstraint(error: unknown): string {
  return error && typeof error === "object" && "constraint" in error
    ? String((error as { constraint: unknown }).constraint ?? "")
    : "";
}

/**
 * Merge a batch of a peer's master changes into this database.
 *
 * One transaction, one savepoint per change. Parents are applied before
 * children and deletes after upserts, whatever order the feed delivered them
 * in — the merge is order-independent per row, so only foreign keys care.
 */
export async function applyMasterChanges(
  businessId: string,
  changes: MasterFeedChange[],
  options: { receiverLocationId: string | null } = { receiverLocationId: null },
): Promise<MasterApplyResult> {
  const outcomes: MasterApplyOutcome[] = changes.map(() => "noop");
  if (changes.length === 0) return { outcomes, firstDeferred: -1 };
  const columns = await masterColumns();
  const dek = changes.some((change) => change.table === "parties") ? await getBusinessDek(businessId) : null;

  const order = changes
    .map((change, index) => ({ change, index }))
    .sort((a, b) => {
      if (a.change.deleted !== b.change.deleted) return a.change.deleted ? 1 : -1;
      const rank = masterTableRank(a.change.table) - masterTableRank(b.change.table);
      return a.change.deleted ? -rank : rank || a.index - b.index;
    });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // The trigger records nothing while a peer's change is merged in: this
    // code writes the merged clocks itself, and a captured copy would bounce
    // the edit straight back to where it came from.
    await client.query("SET LOCAL app.sync_replay = 'on'");
    const localNode = (await client.query<{ node: string }>("SELECT app_sync_node_id() AS node")).rows[0]?.node ?? "";

    for (const { change, index } of order) {
      await client.query("SAVEPOINT master_change");
      try {
        outcomes[index] = await applyOne(client, businessId, change, columns, dek, localNode, options.receiverLocationId);
        await client.query("RELEASE SAVEPOINT master_change");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT master_change");
        const code = error instanceof MergeConflict ? error.code : error instanceof DependencyMissing ? "dependency_missing" : pgCode(error) ?? "apply_failed";
        const detail = error instanceof Error ? error.message.slice(0, 500) : String(error);
        const attempts = await recordConflict(client, businessId, change, code, detail);
        outcomes[index] =
          error instanceof DependencyMissing && attempts < MAX_DEPENDENCY_ATTEMPTS ? "deferred" : "conflict";
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const firstDeferred = outcomes.findIndex((outcome) => outcome === "deferred");
  return { outcomes, firstDeferred };
}

async function recordConflict(
  client: PoolClient,
  businessId: string,
  change: MasterFeedChange,
  code: string,
  detail: string,
): Promise<number> {
  const { rows } = await client.query<{ attempts: number }>(
    `INSERT INTO sync_master_conflicts (business_id, table_name, row_id, error_code, detail, incoming)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (business_id, table_name, row_id, error_code) DO UPDATE
       SET attempts = sync_master_conflicts.attempts + 1, detail = EXCLUDED.detail,
           incoming = EXCLUDED.incoming, status = 'open', last_seen_at = now()
     RETURNING attempts`,
    [
      businessId,
      String(change.table).slice(0, 120),
      String(change.rowId).slice(0, 200),
      code.slice(0, 120),
      detail,
      JSON.stringify({ deleted: change.deleted, rowHlc: change.rowHlc, clocks: change.clocks }),
    ],
  );
  return rows[0]?.attempts ?? 1;
}

async function applyOne(
  client: PoolClient,
  businessId: string,
  change: MasterFeedChange,
  columnsByTable: Map<string, ColumnMeta[]>,
  dek: Buffer | null,
  localNode: string,
  receiverLocationId: string | null,
): Promise<MasterApplyOutcome> {
  const config = masterTableConfig(change.table);
  const meta = columnsByTable.get(change.table);
  if (!config || !meta) throw new MergeConflict("unknown_table", `table ${String(change.table)} is not synchronised`);
  const pk = splitRowKey(config, String(change.rowId));
  if (!pk) throw new MergeConflict("invalid_row_id", String(change.rowId));
  if (!isHlc(change.rowHlc) || Object.values(change.clocks ?? {}).some((clock) => !isHlc(clock))) {
    throw new MergeConflict("invalid_clock", "malformed clock");
  }
  // A branch only ever holds its own menu. Defensive: the central server
  // already filters, but a row for another branch must never be written here.
  if (
    receiverLocationId &&
    config.scope.kind === "location" &&
    change.row &&
    change.row.location_id !== receiverLocationId
  ) {
    return "noop";
  }

  const columnNames = meta.map((column) => column.name);
  const pkValues = config.pk.map((column) => pk[column]);
  const { rows: clockRows } = await client.query<{
    field_clocks: Record<string, string>;
    row_hlc: string;
    deleted: boolean;
    location_id: string | null;
  }>(
    `SELECT field_clocks, row_hlc, deleted, location_id::text FROM sync_row_clocks
      WHERE business_id = $1 AND table_name = $2 AND row_id = $3 FOR UPDATE`,
    [businessId, config.table, change.rowId],
  );
  const { rowCount: existsCount } = await client.query(
    `SELECT 1 FROM ${quoteIdent(config.table)} WHERE ${pkWhere(config, 1)} FOR UPDATE`,
    pkValues,
  );
  const local: LocalMasterState = {
    exists: (existsCount ?? 0) > 0,
    deleted: clockRows[0]?.deleted ?? false,
    rowHlc: clockRows[0]?.row_hlc ?? null,
    clocks: clockRows[0]?.field_clocks ?? {},
  };

  const plan = planMasterMerge(change, local, columnNames);
  if (plan.action === "noop") return "noop";

  await client.query("SELECT app_sync_observe_hlc($1)", [maxHlc(change.rowHlc, ...Object.values(change.clocks))]);
  const incomingNode = change.writerNode || hlcNode(change.rowHlc);

  if (plan.action === "tombstone") {
    await writeClocks(client, businessId, config, change, {}, plan.rowHlc, true, incomingNode, change.locationId);
    return "applied";
  }

  if (plan.action === "delete") {
    await client.query("SAVEPOINT master_delete");
    try {
      await client.query(`DELETE FROM ${quoteIdent(config.table)} WHERE ${pkWhere(config, 1)}`, pkValues);
      await client.query("RELEASE SAVEPOINT master_delete");
      await writeClocks(client, businessId, config, change, {}, plan.rowHlc, true, incomingNode, clockRows[0]?.location_id ?? change.locationId);
      return "applied";
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT master_delete");
      if (pgCode(error) !== "23503") throw error;
      // Other records here still point at the row (an order that used the
      // item, a receivable on the customer): archive it instead, which is
      // what the owner's own delete does in the same situation.
      if (!config.softDeleteColumn) {
        throw new MergeConflict("delete_blocked", `${config.table} ${change.rowId} is still referenced`);
      }
      await client.query(
        `UPDATE ${quoteIdent(config.table)} SET ${quoteIdent(config.softDeleteColumn)} = false WHERE ${pkWhere(config, 1)}`,
        pkValues,
      );
      const clocks = { ...local.clocks, [config.softDeleteColumn]: plan.rowHlc };
      await writeClocks(client, businessId, config, change, clocks, maxHlc(...Object.values(clocks)), false, localNode, clockRows[0]?.location_id ?? change.locationId);
      return "applied";
    }
  }

  const fields: Record<string, unknown> = { ...plan.fields };
  if (config.table === "parties") await addPartyDerivedColumns(client, fields, pkValues[0], dek);

  const metaByName = new Map(meta.map((column) => [column.name, column]));
  const writeRow = async (values: Record<string, unknown>) => {
    const entries = Object.entries(values);
    const cast = (name: string) => {
      const column = metaByName.get(name);
      return column ? column.castType : derivedCast(name);
    };
    const param = (name: string, value: unknown) => {
      const column = metaByName.get(name);
      if (value === null || value === undefined) return null;
      return column?.isJson ? JSON.stringify(value) : value;
    };
    if (plan.action === "insert") {
      const names = entries.map(([name]) => quoteIdent(name));
      const placeholders = entries.map(([name], index) => `$${index + 1}::${cast(name)}`);
      await client.query(
        `INSERT INTO ${quoteIdent(config.table)} (${names.join(", ")}) VALUES (${placeholders.join(", ")})`,
        entries.map(([name, value]) => param(name, value)),
      );
    } else {
      const sets = entries.map(([name], index) => `${quoteIdent(name)} = $${index + 1}::${cast(name)}`);
      if (config.touchColumn) sets.push(`${quoteIdent(config.touchColumn)} = now()`);
      await client.query(
        `UPDATE ${quoteIdent(config.table)} SET ${sets.join(", ")}
          WHERE ${pkWhere(config, entries.length + 1)}`,
        [...entries.map(([name, value]) => param(name, value)), ...pkValues],
      );
    }
  };

  // A nullable reference to something this side does not hold (another
  // branch, a login never paired here) is written as NULL rather than
  // blocking the row; a required one waits for its parent to arrive.
  const values = { ...fields };
  for (let attempt = 0; ; attempt += 1) {
    await client.query("SAVEPOINT master_write");
    try {
      await writeRow(values);
      await client.query("RELEASE SAVEPOINT master_write");
      break;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT master_write");
      const code = pgCode(error);
      if (code === "23505") {
        throw new MergeConflict("unique_violation", `${config.table}: ${pgConstraint(error)}`);
      }
      if (code !== "23503") throw error;
      const constraint = pgConstraint(error);
      const optional = config.optionalRefs.find(
        (column) => values[column] !== null && values[column] !== undefined && constraint.includes(`_${column}_`),
      );
      if (!optional || attempt >= config.optionalRefs.length) throw new DependencyMissing(constraint);
      values[optional] = null;
    }
  }

  const locationId = await rowLocation(client, config, pk, change.locationId);
  const clocks = plan.clocks;
  await writeClocks(
    client,
    businessId,
    config,
    change,
    clocks,
    maxHlc(...Object.values(clocks)),
    false,
    // Nothing local survived the merge: the row is exactly the peer's, so it
    // need not be sent back to it. Otherwise this side now holds edits the
    // peer lacks, and the merged row must travel back.
    plan.incomingDominates ? incomingNode : localNode,
    locationId,
  );
  return "applied";
}

function derivedCast(name: string): string {
  return name.endsWith("_enc") ? "bytea" : "text";
}

async function addPartyDerivedColumns(
  client: PoolClient,
  fields: Record<string, unknown>,
  partyId: string,
  dek: Buffer | null,
): Promise<void> {
  const text = (value: unknown) => (typeof value === "string" ? value : value == null ? null : String(value));
  if ("phone" in fields) {
    const phone = text(fields.phone);
    const derived = phoneColumns(phone, dek);
    fields.phone_enc = derived.enc;
    fields.phone_bidx = derived.bidx;
    fields.phone_e164 = derived.e164;
    fields.phone_last4 = derived.last4;
    fields.phone_kind = derived.kind;
  }
  if ("address" in fields) fields.address_enc = dek ? encryptOptional(text(fields.address), dek) : null;
  if ("notes" in fields) fields.notes_enc = dek ? encryptOptional(text(fields.notes), dek) : null;
  if ("national_id" in fields || "economic_code" in fields) {
    let nationalId = text(fields.national_id);
    let economicCode = text(fields.economic_code);
    if (!("national_id" in fields) || !("economic_code" in fields)) {
      const { rows } = await client.query<{ national_id: string | null; economic_code: string | null }>(
        "SELECT national_id, economic_code FROM parties WHERE id = $1",
        [partyId],
      );
      if (!("national_id" in fields)) nationalId = rows[0]?.national_id ?? null;
      if (!("economic_code" in fields)) economicCode = rows[0]?.economic_code ?? null;
    }
    const identity = identityColumns(nationalId, economicCode, dek);
    fields.national_id_enc = identity.nationalIdEnc;
    fields.national_id_bidx = identity.nationalIdBidx;
    fields.economic_code_enc = identity.economicCodeEnc;
  }
}

async function rowLocation(
  client: PoolClient,
  config: MasterTableConfig,
  pk: Record<string, string>,
  fallback: string | null,
): Promise<string | null> {
  if (config.scope.kind === "business") return null;
  if (config.scope.kind === "location") {
    const { rows } = await client.query<{ location_id: string }>(
      `SELECT location_id::text FROM ${quoteIdent(config.table)} WHERE ${pkWhere(config, 1)}`,
      config.pk.map((column) => pk[column]),
    );
    return rows[0]?.location_id ?? fallback;
  }
  const { rows } = await client.query<{ location_id: string }>(
    `SELECT location_id::text FROM ${quoteIdent(config.scope.table)} WHERE id = $1::uuid`,
    [pk[config.scope.column]],
  );
  return rows[0]?.location_id ?? fallback;
}

async function writeClocks(
  client: PoolClient,
  businessId: string,
  config: MasterTableConfig,
  change: MasterFeedChange,
  clocks: Record<string, string>,
  rowHlc: string,
  deleted: boolean,
  writerNode: string,
  locationId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO sync_row_clocks (business_id, table_name, row_id, location_id, field_clocks, row_hlc, deleted, writer_node, txid)
     VALUES ($1, $2, $3, $4::uuid, $5::jsonb, $6, $7, $8, pg_current_xact_id())
     ON CONFLICT (business_id, table_name, row_id) DO UPDATE
       SET field_clocks = EXCLUDED.field_clocks, row_hlc = EXCLUDED.row_hlc, deleted = EXCLUDED.deleted,
           writer_node = EXCLUDED.writer_node, location_id = EXCLUDED.location_id, txid = EXCLUDED.txid`,
    [businessId, config.table, change.rowId, locationId, JSON.stringify(clocks), rowHlc || ZERO_HLC, deleted, writerNode],
  );
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface MasterConflictView {
  id: number;
  table: string;
  rowId: string;
  errorCode: string;
  attempts: number;
  lastSeenAt: string;
}

/** Open master conflicts; payloads are not returned, only what an owner needs to find the row. */
export async function listMasterConflicts(businessId: string, limit = 50): Promise<MasterConflictView[]> {
  const { rows } = await query<{
    id: string;
    table_name: string;
    row_id: string;
    error_code: string;
    attempts: number;
    last_seen_at: Date;
  }>(
    `SELECT id::text, table_name, row_id, error_code, attempts, last_seen_at
       FROM sync_master_conflicts
      WHERE business_id = $1 AND status = 'open'
      ORDER BY last_seen_at DESC LIMIT $2`,
    [businessId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    table: row.table_name,
    rowId: row.row_id,
    errorCode: row.error_code,
    attempts: row.attempts,
    lastSeenAt: row.last_seen_at.toISOString(),
  }));
}

/** A conflict that later applied cleanly is closed, so the panel shows only what is still stuck. */
export async function resolveAppliedMasterConflicts(
  businessId: string,
  changes: MasterFeedChange[],
  outcomes: MasterApplyOutcome[],
): Promise<void> {
  const settled = changes.filter((_, index) => outcomes[index] === "applied" || outcomes[index] === "noop");
  if (settled.length === 0) return;
  await query(
    `UPDATE sync_master_conflicts SET status = 'resolved'
      WHERE business_id = $1 AND status = 'open'
        AND (table_name, row_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
    [businessId, settled.map((change) => change.table), settled.map((change) => change.rowId)],
  );
}

/**
 * Where a reader may safely resume after applying a page: just before the
 * first change that must be retried, or the page's own end when everything
 * settled. Cursor positions are (txid, table, row), exactly as the feed orders
 * them.
 */
export function cursorAfterApply(
  start: MasterCursor,
  pageEnd: MasterCursor,
  changes: MasterFeedChange[],
  firstDeferred: number,
): MasterCursor {
  if (firstDeferred < 0) return pageEnd;
  if (firstDeferred === 0) return start;
  const previous = changes[firstDeferred - 1];
  return { txid: previous.txid, table: previous.table, rowId: previous.rowId };
}

/** This database's clock node id. */
export async function localSyncNode(): Promise<string> {
  const { rows } = await query<{ node: string }>("SELECT app_sync_node_id() AS node");
  return rows[0]?.node ?? "";
}
