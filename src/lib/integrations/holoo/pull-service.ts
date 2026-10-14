/**
 * Phase 26 (issue #125) Wave 7 — companion-mode read-only mirror.
 *
 * Polling, not webhooks (Holoo is a desktop app and cannot call us back). The
 * tick enumerates active Holoo connections under the documented platform
 * bypass, then re-enters each business with `withTenant` — the same shape as
 * every other server.ts tick, with **no** new `withoutTenantScope` reason. Per
 * connection it pulls goods/persons/accounts through the same idempotent
 * `applyBaseImport` path Wave 3 uses, keyed on `holoo_sync_cursors` so a pull
 * resumes rather than re-reads.
 *
 * Gated on the `holoo_companion` flag: a business that never turns it on never
 * enters the pull path, and the tick skips it.
 */
import { query, withoutTenantScope, withTenant } from "../../db";
import { isFeatureEnabled } from "../../features";
import { getConnection } from "../connections-service";
import { getHolooSettingsRow, holooSqlConfigFor } from "./connection-service";
import { connectHolooSql, type HolooSqlClient } from "./client";
import { diagnoseProfile, type HolooSchemaFingerprint, type HolooSchemaProfile } from "./schema-profile";
import { probeHolooSchema } from "./schema-probe";
import { applyBaseImport, type BaseImportInput } from "./import-service";
import { mapAccount, mapGoods, mapOpeningInventory, mapPerson } from "./mappers";
import { writeIntegrationAudit } from "../audit";

export const HOLOO_SYNC_TICK_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 500;
/** Per-scope guard for synchronous, previewable provider migrations. */
export const MAX_HOLOO_MIGRATION_ROWS = 50_000;

type CursorEntity = "goods" | "persons" | "accounts" | "openingInventory";

/** Cursor value plus a stable remote-key tie-breaker. */
export interface HolooSyncCursor {
  cursor: string | null;
  id: string;
  /** Legacy scalar cursors must replay the whole boundary tie group once. */
  inclusive?: boolean;
}

/** Read both the new composite cursor and the legacy scalar cursor safely. */
export function decodeHolooSyncCursor(value: string | null): HolooSyncCursor | null {
  if (value === null) return null;
  try {
    const decoded = JSON.parse(value) as { cursor?: unknown; id?: unknown };
    if (
      decoded &&
      typeof decoded === "object" &&
      (typeof decoded.cursor === "string" || decoded.cursor === null) &&
      typeof decoded.id === "string"
    ) {
      return { cursor: decoded.cursor, id: decoded.id };
    }
  } catch {
    // Existing installations stored only the cursor value. Resume inclusively
    // at that value so tied rows are replayed idempotently instead of skipped.
  }
  return { cursor: value, id: "", inclusive: true };
}

async function readCursor(businessId: string, connectionId: string, entityType: string): Promise<HolooSyncCursor | null> {
  const { rows } = await query<{ last_key: string | null }>(
    `SELECT last_key FROM holoo_sync_cursors WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3`,
    [businessId, connectionId, entityType],
  );
  return decodeHolooSyncCursor(rows[0]?.last_key ?? null);
}

async function writeCursor(
  businessId: string,
  connectionId: string,
  entityType: string,
  cursor: HolooSyncCursor,
): Promise<void> {
  await query(
    `INSERT INTO holoo_sync_cursors (business_id, connection_id, entity_type, last_key, last_seen_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (connection_id, entity_type)
     DO UPDATE SET last_key = EXCLUDED.last_key, last_seen_at = now(), updated_at = now()`,
    [businessId, connectionId, entityType, JSON.stringify(cursor)],
  );
}

function ident(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

function literal(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function cursorExpr(column: string | undefined, fallback: string): string {
  return ident(column ?? fallback);
}

export function buildHolooBaseSelectSql(
  profile: HolooSchemaProfile,
  entity: CursorEntity,
  columns: Record<string, string | undefined>,
  cursorColumn: string | undefined,
  fallbackCursorColumn: string,
  lastKey: HolooSyncCursor | null,
  limit = BATCH_SIZE,
): string {
  const table =
    entity === "goods"
      ? profile.tables.goods
      : entity === "persons"
        ? profile.tables.persons
        : entity === "accounts"
          ? profile.tables.accounts
          : profile.tables.stock_movements;
  const schema = profile.supportedSchemas[0];
  if (!schema) throw new Error("holoo_profile_schema_missing");
  const cursor = cursorExpr(cursorColumn, fallbackCursorColumn);
  const cursorText = `CONVERT(nvarchar(4000), ${cursor}, 126)`;
  const cursorNullRank = `CASE WHEN ${cursor} IS NULL THEN 0 ELSE 1 END`;
  const cursorValue = `COALESCE(${cursorText}, N'')`;
  const remoteKey = ident(fallbackCursorColumn);
  const remoteText = `COALESCE(CONVERT(nvarchar(4000), ${remoteKey}, 126), N'')`;
  const projection = Object.entries(columns)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([alias, column]) => `${ident(column)} AS ${ident(alias)}`);
  projection.push(`${cursorText} AS ${ident("cursor_key")}`);
  projection.push(`${remoteText} AS ${ident("remote_key")}`);

  let where = "";
  if (lastKey) {
    const cursorRank = lastKey.cursor === null ? 0 : 1;
    const cursorLiteral = literal(lastKey.cursor ?? "");
    const remoteLiteral = literal(lastKey.id);
    const remoteComparison = lastKey.inclusive ? ">=" : ">";
    where = `WHERE (
      ${cursorNullRank} > ${cursorRank}
      OR (
        ${cursorNullRank} = ${cursorRank}
        AND (
          ${cursorValue} COLLATE DATABASE_DEFAULT > ${cursorLiteral} COLLATE DATABASE_DEFAULT
          OR (
            ${cursorValue} COLLATE DATABASE_DEFAULT = ${cursorLiteral} COLLATE DATABASE_DEFAULT
            AND ${remoteText} COLLATE DATABASE_DEFAULT ${remoteComparison} ${remoteLiteral} COLLATE DATABASE_DEFAULT
          )
        )
      )
    )`;
  }
  return `SELECT TOP (${limit}) ${projection.join(", ")} FROM ${ident(schema)}.${ident(table)} ${where}
          ORDER BY ${cursorNullRank}, ${cursorValue} COLLATE DATABASE_DEFAULT, ${remoteText} COLLATE DATABASE_DEFAULT`;
}

function asString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "supplier" || text === "تأمین‌کننده";
}

async function pullBaseRows(
  client: HolooSqlClient,
  profile: HolooSchemaProfile,
  settings: NonNullable<Awaited<ReturnType<typeof getHolooSettingsRow>>>,
  cursors: Record<CursorEntity, HolooSyncCursor | null>,
  limit = BATCH_SIZE,
  scopes: readonly CursorEntity[] = ["goods", "persons", "accounts", "openingInventory"],
): Promise<{
  input: BaseImportInput;
  nextCursors: Partial<Record<CursorEntity, HolooSyncCursor>>;
  rowsRead: Record<CursorEntity, number>;
}> {
  const goodsColumns = profile.columns.goods;
  const personColumns = profile.columns.persons;
  const accountColumns = profile.columns.accounts;
  const stockColumns = profile.columns.stockMovements;

  const selected = new Set(scopes);
  const readScope = (scope: CursorEntity, sql: string) =>
    selected.has(scope) ? client.query<Record<string, unknown>>(sql) : Promise.resolve([] as Record<string, unknown>[]);
  const [goodsRows, personRows, accountRows, stockRows] = await Promise.all([
    readScope("goods", buildHolooBaseSelectSql(profile, "goods", goodsColumns, goodsColumns.updatedAt, goodsColumns.id, cursors.goods, limit)),
    readScope("persons", buildHolooBaseSelectSql(profile, "persons", personColumns, personColumns.updatedAt, personColumns.id, cursors.persons, limit)),
    readScope("accounts", buildHolooBaseSelectSql(profile, "accounts", accountColumns, accountColumns.updatedAt, accountColumns.id, cursors.accounts, limit)),
    readScope(
      "openingInventory",
      buildHolooBaseSelectSql(
        profile,
        "openingInventory",
        {
          id: stockColumns.id,
          goodsId: stockColumns.goodsId,
          quantity: stockColumns.quantity,
          unitCost: stockColumns.unitCost,
          date: stockColumns.date,
        },
        stockColumns.updatedAt ?? stockColumns.date,
        stockColumns.id,
        cursors.openingInventory,
        limit,
      ),
    ),
  ]);
  if (
    limit > MAX_HOLOO_MIGRATION_ROWS &&
    [goodsRows, personRows, accountRows, stockRows].some((rows) => rows.length > MAX_HOLOO_MIGRATION_ROWS)
  ) {
    throw new HolooProfileError("holoo_source_too_large");
  }

  const goodsNameById = new Map(goodsRows.map((row) => [asString(row.id), asString(row.name)]));
  const goodsUnitById = new Map(goodsRows.map((row) => [asString(row.id), asString(row.unit)]));
  const nextCursors: Partial<Record<CursorEntity, HolooSyncCursor>> = {};
  const remember = (entity: CursorEntity, rows: Record<string, unknown>[]) => {
    if (rows.length === 0) return;
    const last = rows[rows.length - 1];
    nextCursors[entity] = {
      cursor: last.cursor_key == null ? null : asString(last.cursor_key),
      id: asString(last.remote_key),
    };
  };
  remember("goods", goodsRows);
  remember("persons", personRows);
  remember("accounts", accountRows);
  remember("openingInventory", stockRows);

  return {
    input: {
      goods: goodsRows.map((row) =>
        mapGoods(
          {
            id: asString(row.id),
            name: asString(row.name),
            sku: row.sku == null ? null : asString(row.sku),
            price: row.price as string | number | null | undefined,
            unit: row.unit == null ? null : asString(row.unit),
          },
          settings.currency_unit,
        ),
      ),
      persons: personRows.map((row) =>
        mapPerson({
          id: asString(row.id),
          name: asString(row.name),
          phone: row.phone == null ? null : asString(row.phone),
          address: row.address == null ? null : asString(row.address),
          isSupplier: asBoolean(row.isSupplier),
        }),
      ),
      accounts: accountRows.map((row) =>
        mapAccount({
          id: asString(row.id),
          code: asString(row.code),
          name: asString(row.name),
          nature: row.nature == null ? null : asString(row.nature),
          parentCode: row.parentCode == null ? null : asString(row.parentCode),
        }),
      ),
      openingInventory: stockRows
        .filter((row) => Number(row.quantity ?? 0) > 0)
        .map((row) => {
          const goodsId = row.goodsId == null ? null : asString(row.goodsId);
          return mapOpeningInventory(
            {
              id: asString(row.id),
              goodsId,
              name: goodsId ? (goodsNameById.get(goodsId) ?? goodsId) : asString(row.id),
              unit: goodsId ? (goodsUnitById.get(goodsId) ?? null) : null,
              quantity: row.quantity as string | number,
              unitCost: row.unitCost as string | number | null | undefined,
            },
            settings.currency_unit,
          );
        }),
    },
    nextCursors,
    rowsRead: {
      goods: goodsRows.length,
      persons: personRows.length,
      accounts: accountRows.length,
      openingInventory: stockRows.length,
    },
  };
}

export class HolooProfileError extends Error {
  constructor(
    readonly code: "holoo_schema_unsupported" | "holoo_profile_not_verified" | "holoo_source_too_large",
    readonly diagnostics: ReturnType<typeof diagnoseProfile>["diagnostics"] = [],
  ) {
    super(code);
    this.name = "HolooProfileError";
  }
}

interface FetchedHolooBase {
  input: BaseImportInput;
  nextCursors: Partial<Record<CursorEntity, HolooSyncCursor>>;
  profile: HolooSchemaProfile;
  fingerprint: HolooSchemaFingerprint;
}

/** Read base data using a freshly verified structural profile. */
async function fetchHolooBase(
  businessId: string,
  connectionId: string,
  settings: NonNullable<Awaited<ReturnType<typeof getHolooSettingsRow>>>,
  fullSnapshot = false,
  scopes: readonly CursorEntity[] = ["goods", "persons", "accounts", "openingInventory"],
): Promise<FetchedHolooBase> {
  const client = await connectHolooSql(holooSqlConfigFor(settings));
  try {
    const snapshot = await probeHolooSchema(client);
    const { profile, diagnostics } = diagnoseProfile(snapshot);
    if (!profile) {
      await writeIntegrationAudit({
        businessId,
        connectionId,
        action: "pull.unknown_profile",
        payload: { diagnostics },
      });
      throw new HolooProfileError("holoo_schema_unsupported", diagnostics);
    }
    // Do not let a stale/legacy profile key authorize a read after the remote
    // structure has changed. The connection must be tested and pinned again.
    if (settings.schema_profile !== profile.key) {
      throw new HolooProfileError("holoo_profile_not_verified");
    }

    const cursors: Record<CursorEntity, HolooSyncCursor | null> = fullSnapshot
      ? { goods: null, persons: null, accounts: null, openingInventory: null }
      : {
          goods: await readCursor(businessId, connectionId, "goods"),
          persons: await readCursor(businessId, connectionId, "persons"),
          accounts: await readCursor(businessId, connectionId, "accounts"),
          openingInventory: await readCursor(businessId, connectionId, "openingInventory"),
        };
    const pulled = await pullBaseRows(
      client,
      profile,
      settings,
      cursors,
      fullSnapshot ? MAX_HOLOO_MIGRATION_ROWS + 1 : BATCH_SIZE,
      scopes,
    );
    if (fullSnapshot && Object.values(pulled.rowsRead).some((count) => count > MAX_HOLOO_MIGRATION_ROWS)) {
      throw new HolooProfileError("holoo_source_too_large");
    }
    return {
      input: pulled.input,
      nextCursors: fullSnapshot
        ? {}
        : {
            ...Object.fromEntries(Object.entries(cursors).filter((entry): entry is [CursorEntity, HolooSyncCursor] => entry[1] !== null)),
            ...pulled.nextCursors,
          },
      profile,
      fingerprint: snapshot.fingerprint,
    };
  } finally {
    await client.close();
  }
}

/**
 * A Data Transfer import reads a bounded full snapshot (rather than the
 * companion cursor) and returns only the mapped domain records required by the
 * existing Holoo services. Credentials never leave this module.
 */
export async function readHolooBaseForMigration(
  businessId: string,
  connectionId: string,
  scopes: readonly CursorEntity[] = ["goods", "persons", "accounts", "openingInventory"],
): Promise<FetchedHolooBase> {
  const settings = await getHolooSettingsRow(businessId, connectionId);
  if (!settings) throw new Error("holoo_connection_not_found");
  return fetchHolooBase(businessId, connectionId, settings, true, scopes);
}

/** Mirror one connection's base data. Returns a summary for the audit log. */
export async function pullConnection(businessId: string, connectionId: string): Promise<{ goods: number; persons: number; accounts: number; openingInventory: number }> {
  if (!(await isFeatureEnabled(businessId, "holoo_companion"))) return { goods: 0, persons: 0, accounts: 0, openingInventory: 0 };
  const settings = await getHolooSettingsRow(businessId, connectionId);
  if (!settings || !settings.companion_activated_at) return { goods: 0, persons: 0, accounts: 0, openingInventory: 0 };

  const { input, nextCursors } = await fetchHolooBase(businessId, connectionId, settings);
  const summary = await applyBaseImport(businessId, connectionId, input);
  for (const [entityType, cursor] of Object.entries(nextCursors)) {
    if (cursor) await writeCursor(businessId, connectionId, entityType, cursor);
  }
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "pull.completed",
    payload: summary,
  });
  return {
    goods: summary.created.goods,
    persons: summary.created.persons,
    accounts: summary.created.accounts,
    openingInventory: summary.created.openingInventory,
  };
}

export async function runHolooSyncTick(): Promise<void> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string; id: string }>(
      `SELECT id, business_id FROM integration_connections WHERE status = 'active' AND provider = 'holoo'`,
    ),
  );
  for (const { business_id, id } of rows) {
    await withTenant(business_id, async () => {
      try {
        const connection = await getConnection(business_id, id);
        if (!connection || connection.status !== "active") return;
        await pullConnection(business_id, id);
      } catch (err) {
        console.error(`holoo sync tick failed for connection ${id}:`, (err as Error).message);
      }
    });
  }
}
