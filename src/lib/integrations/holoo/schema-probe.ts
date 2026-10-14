/**
 * Read-only SQL Server schema inspection shared by connection diagnostics,
 * companion reads, and guarded write preflights. This module issues metadata
 * SELECTs only; it never reads credential fields or user data beyond three
 * ISO-formatted samples from native date columns.
 */
import type { HolooSqlClient } from "./client";
import {
  HOLOO_PROFILES,
  isHolooNativeDateType,
  type HolooSchemaColumn,
  type HolooDateSample,
  type HolooSchemaFingerprint,
  type HolooSchemaSnapshot,
  type HolooSchemaTable,
} from "./schema-profile";

interface RawTable extends Record<string, unknown> {
  schemaName: string;
  tableName: string;
}

interface RawColumn extends Record<string, unknown> {
  schemaName: string;
  tableName: string;
  columnName: string;
  dataType: string;
  isNullable: string;
  maxLength: number | string | null;
  numericPrecision: number | string | null;
  numericScale: number | string | null;
  collationName: string | null;
}

interface RawPrimaryKey extends Record<string, unknown> {
  schemaName: string;
  tableName: string;
  columnName: string;
  keyOrdinal: number | string;
}

function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function quoteIdentifier(value: string): string {
  return `[${value.replace(/]/g, "]]")}]`;
}

/**
 * Capture a structural snapshot without granting the installation a migration
 * profile. `diagnoseProfile()` is the separate, pure decision boundary.
 */
export async function probeHolooSchema(client: HolooSqlClient): Promise<HolooSchemaSnapshot> {
  const [fingerprints, tableRows, columnRows, primaryKeyRows] = await Promise.all([
    client.query<Record<string, unknown>>(
      `SELECT
         CONVERT(nvarchar(4000), @@VERSION) AS serverVersion,
         CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS productVersion,
         CONVERT(nvarchar(128), SERVERPROPERTY('ProductLevel')) AS productLevel,
         CONVERT(nvarchar(256), SERVERPROPERTY('Edition')) AS edition,
         CONVERT(nvarchar(128), DATABASEPROPERTYEX(DB_NAME(), 'Collation')) AS databaseCollation`,
    ),
    client.query<RawTable>(
      `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'`,
    ),
    client.query<RawColumn>(
      `SELECT TABLE_SCHEMA AS schemaName,
              TABLE_NAME AS tableName,
              COLUMN_NAME AS columnName,
              LOWER(DATA_TYPE) AS dataType,
              IS_NULLABLE AS isNullable,
              CHARACTER_MAXIMUM_LENGTH AS maxLength,
              NUMERIC_PRECISION AS numericPrecision,
              NUMERIC_SCALE AS numericScale,
              COLLATION_NAME AS collationName
         FROM INFORMATION_SCHEMA.COLUMNS
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
    ),
    client.query<RawPrimaryKey>(
      `SELECT s.name AS schemaName,
              t.name AS tableName,
              c.name AS columnName,
              ic.key_ordinal AS keyOrdinal
         FROM sys.indexes i
         JOIN sys.tables t ON t.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.is_primary_key = 1
        ORDER BY s.name, t.name, ic.key_ordinal`,
    ),
  ]);

  const rawFingerprint = fingerprints[0] ?? {};
  const fingerprint: HolooSchemaFingerprint = {
    serverVersion: String(rawFingerprint.serverVersion ?? ""),
    productVersion: String(rawFingerprint.productVersion ?? ""),
    productLevel: String(rawFingerprint.productLevel ?? ""),
    edition: String(rawFingerprint.edition ?? ""),
    databaseCollation:
      rawFingerprint.databaseCollation == null ? null : String(rawFingerprint.databaseCollation),
  };

  const keysForTable = new Map<string, RawPrimaryKey[]>();
  for (const row of primaryKeyRows) {
    const key = `${row.schemaName.toLowerCase()}.${row.tableName.toLowerCase()}`;
    keysForTable.set(key, [...(keysForTable.get(key) ?? []), row]);
  }

  const tableMap = new Map<string, { schema: string; name: string; columns: HolooSchemaColumn[] }>();
  for (const table of tableRows) {
    const key = `${table.schemaName.toLowerCase()}.${table.tableName.toLowerCase()}`;
    tableMap.set(key, { schema: table.schemaName, name: table.tableName, columns: [] });
  }
  for (const raw of columnRows) {
    const key = `${raw.schemaName.toLowerCase()}.${raw.tableName.toLowerCase()}`;
    const table = tableMap.get(key);
    if (!table) continue;
    table.columns.push({
      name: raw.columnName,
      dataType: String(raw.dataType).toLowerCase(),
      nullable: String(raw.isNullable).toUpperCase() === "YES",
      maxLength: toNumberOrNull(raw.maxLength),
      precision: toNumberOrNull(raw.numericPrecision),
      scale: toNumberOrNull(raw.numericScale),
      collation: raw.collationName ?? null,
    });
  }

  const tables: HolooSchemaTable[] = [...tableMap.entries()].map(([key, table]) => ({
    ...table,
    primaryKey: (keysForTable.get(key) ?? [])
      .sort((a, b) => Number(a.keyOrdinal) - Number(b.keyOrdinal))
      .map((column) => column.columnName),
  }));

  const dateSamples: HolooDateSample[] = [];
  const sampled = new Set<string>();
  for (const profile of HOLOO_PROFILES) {
    for (const requirement of Object.values(profile.requirements)) {
      const matchingTables = tables.filter(
        (table) => table.name.toLowerCase() === requirement.name.toLowerCase(),
      );
      for (const table of matchingTables) {
        for (const requiredColumn of requirement.requiredColumns.filter((column) => column.semantic === "date")) {
          const column = table.columns.find((candidate) => candidate.name.toLowerCase() === requiredColumn.name.toLowerCase());
          if (!column || !isHolooNativeDateType(column.dataType)) continue;
          const sampleKey = `${table.schema.toLowerCase()}.${table.name.toLowerCase()}.${column.name.toLowerCase()}`;
          if (sampled.has(sampleKey)) continue;
          sampled.add(sampleKey);
          const sql =
            `SELECT TOP (3) CONVERT(nvarchar(50), ${quoteIdentifier(column.name)}, 126) AS sample ` +
            `FROM ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)} ` +
            `WHERE ${quoteIdentifier(column.name)} IS NOT NULL`;
          const values = await client.query<{ sample: string | null }>(sql);
          dateSamples.push({
            schema: table.schema,
            table: table.name,
            column: column.name,
            values: values.map((row) => String(row.sample ?? "")).filter(Boolean),
          });
        }
      }
    }
  }

  return { fingerprint, tables, dateSamples };
}
