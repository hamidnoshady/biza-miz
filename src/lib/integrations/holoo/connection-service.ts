/**
 * Phase 26 (issue #125) Wave 2 — Holoo connection lifecycle.
 *
 * DB-touching (not unit-tested directly, per repo convention; the pure crypto,
 * profile matching and money conversion it leans on are covered by their own
 * tests). A Holoo connection is an `integration_connections` row with
 * `provider = 'holoo'` plus one `holoo_connection_settings` row holding the
 * Holoo-specific facts — SQL Server and web-service credentials encrypted at
 * rest through secrets.ts (the one ciphertext store in the repo), the probed
 * version/profile, currency unit and write mode.
 *
 * Plaintext credentials are decrypted only inside the client builders and are
 * never returned to the UI; the safe shape exposes host/port/database/version/
 * profile/currency/write mode and whether credentials are present.
 */
import { getPool, query } from "../../db";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../secrets";
import { writeIntegrationAudit } from "../audit";
import { connectHolooSql, type HolooSqlServerConfig, type HolooWebServiceConfig } from "./client";
import { diagnoseProfile, profileAllowsDirectSql, type HolooProfileDiagnostic, type HolooSchemaFingerprint, type HolooSchemaProfile } from "./schema-profile";
import { probeHolooSchema } from "./schema-probe";
import type { HolooCurrencyUnit } from "./holoo-money";

export type HolooWriteMode = "none" | "web_service" | "direct_sql";

export interface HolooSettingsInput {
  host: string;
  port: number;
  database: string;
  sqlUser?: string;
  sqlPassword?: string;
  webServiceBaseUrl?: string | null;
  wsUser?: string;
  wsPassword?: string;
  currencyUnit: HolooCurrencyUnit;
  writeMode: HolooWriteMode;
  locationId?: string | null;
}

export interface HolooSettingsRow extends Record<string, unknown> {
  id: string;
  businessId: string;
  connectionId: string;
  host: string;
  port: number;
  database: string;
  sql_user_ciphertext: string | null;
  sql_password_ciphertext: string | null;
  web_service_base_url: string | null;
  ws_user_ciphertext: string | null;
  ws_password_ciphertext: string | null;
  holoo_version: string | null;
  schema_profile: string | null;
  currency_unit: HolooCurrencyUnit;
  write_mode: HolooWriteMode;
  direct_sql_armed_at: string | null;
  direct_sql_armed_by: string | null;
  direct_sql_profile_key: string | null;
  companion_activated_at: string | null;
}

/** The safe, secret-free shape returned to routes and the dashboard. */
export interface HolooSettings {
  host: string;
  port: number;
  database: string;
  webServiceBaseUrl: string | null;
  holooVersion: string | null;
  schemaProfile: string | null;
  currencyUnit: HolooCurrencyUnit;
  writeMode: HolooWriteMode;
  directSqlArmedAt: string | null;
  directSqlProfileKey: string | null;
  directSqlSupported: boolean;
  companionActivatedAt: string | null;
  hasSqlCredentials: boolean;
  hasWebServiceCredentials: boolean;
}

const SETTINGS_COLUMNS = `id, business_id, connection_id, host, port, database,
  sql_user_ciphertext, sql_password_ciphertext, web_service_base_url,
  ws_user_ciphertext, ws_password_ciphertext, holoo_version, schema_profile,
  currency_unit, write_mode, direct_sql_armed_at, direct_sql_armed_by,
  direct_sql_profile_key, companion_activated_at`;

function mapSettings(row: HolooSettingsRow): HolooSettings {
  return {
    host: row.host,
    port: row.port,
    database: row.database,
    webServiceBaseUrl: row.web_service_base_url,
    holooVersion: row.holoo_version,
    schemaProfile: row.schema_profile,
    currencyUnit: row.currency_unit,
    writeMode: row.write_mode,
    directSqlArmedAt: row.direct_sql_armed_at,
    directSqlProfileKey: row.direct_sql_profile_key,
    directSqlSupported: profileAllowsDirectSql(row.schema_profile),
    companionActivatedAt: row.companion_activated_at,
    hasSqlCredentials: Boolean(row.sql_user_ciphertext && row.sql_password_ciphertext),
    hasWebServiceCredentials: Boolean(row.ws_user_ciphertext && row.ws_password_ciphertext),
  };
}

function validate(input: HolooSettingsInput): string | null {
  if (!input.host?.trim() || input.host.trim().length > 255) return "invalid_host";
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return "invalid_port";
  if (!input.database?.trim() || input.database.trim().length > 255) return "invalid_database";
  if (input.currencyUnit !== "rial" && input.currencyUnit !== "toman") return "invalid_currency_unit";
  if (input.writeMode !== "none" && input.writeMode !== "web_service" && input.writeMode !== "direct_sql") {
    return "invalid_write_mode";
  }
  if (input.writeMode === "web_service") {
    if (!input.webServiceBaseUrl?.trim() || !input.wsUser?.trim() || !input.wsPassword?.trim()) return "missing_web_service_credentials";
  }
  if (input.webServiceBaseUrl?.trim() && !/^https?:\/\/[^\s]+$/i.test(input.webServiceBaseUrl.trim())) {
    return "invalid_web_service_url";
  }
  return null;
}

/**
 * Create a Holoo connection: one `integration_connections` row (provider =
 * 'holoo', no WooCommerce columns) plus its settings row, in one transaction so
 * a partial failure cannot orphan either half.
 */
export async function createHolooConnection(
  businessId: string,
  createdBy: string,
  name: string,
  input: HolooSettingsInput,
): Promise<{ ok: true; connectionId: string } | { ok: false; error: string }> {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > 120) return { ok: false, error: "invalid_name" };
  const validation = validate(input);
  if (validation) return { ok: false, error: validation };
  if (input.writeMode === "direct_sql") return { ok: false, error: "direct_sql_not_supported" };

  const key = resolveEncryptionKey(process.env);
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO integration_connections
         (business_id, location_id, name, provider, base_url, link_mode, currency_unit, created_by)
       VALUES ($1, $2, $3, 'holoo', NULL, 'rest_api', $4, $5)
       RETURNING id`,
      [businessId, input.locationId ?? null, trimmedName, input.currencyUnit, createdBy],
    );
    const connectionId = rows[0].id;
    await db.query(
      `INSERT INTO holoo_connection_settings
         (business_id, connection_id, host, port, database,
          sql_user_ciphertext, sql_password_ciphertext, web_service_base_url,
          ws_user_ciphertext, ws_password_ciphertext, currency_unit, write_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        businessId,
        connectionId,
        input.host.trim(),
        input.port,
        input.database.trim(),
        input.sqlUser?.trim() ? encryptSecret(input.sqlUser.trim(), key) : null,
        input.sqlPassword?.trim() ? encryptSecret(input.sqlPassword.trim(), key) : null,
        input.webServiceBaseUrl?.trim() || null,
        input.wsUser?.trim() ? encryptSecret(input.wsUser.trim(), key) : null,
        input.wsPassword?.trim() ? encryptSecret(input.wsPassword.trim(), key) : null,
        input.currencyUnit,
        input.writeMode,
      ],
    );
    await db.query("COMMIT");
    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "connection.created",
      payload: { provider: "holoo", host: input.host, database: input.database, currencyUnit: input.currencyUnit, writeMode: input.writeMode },
    });
    return { ok: true, connectionId };
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

export async function getHolooSettingsRow(businessId: string, connectionId: string): Promise<HolooSettingsRow | null> {
  const { rows } = await query<HolooSettingsRow>(
    `SELECT ${SETTINGS_COLUMNS} FROM holoo_connection_settings
      WHERE business_id = $1 AND connection_id = $2`,
    [businessId, connectionId],
  );
  return rows[0] ?? null;
}

export async function getHolooSettings(businessId: string, connectionId: string): Promise<HolooSettings | null> {
  const row = await getHolooSettingsRow(businessId, connectionId);
  return row ? mapSettings(row) : null;
}

export async function updateHolooSettings(
  businessId: string,
  connectionId: string,
  input: Partial<HolooSettingsInput> & { writeMode?: HolooWriteMode },
): Promise<{ ok: true; settings: HolooSettings } | { ok: false; error: string }> {
  const existing = await getHolooSettingsRow(businessId, connectionId);
  if (!existing) return { ok: false, error: "not_found" };
  if (input.writeMode === "direct_sql" && !profileAllowsDirectSql(existing.schema_profile)) {
    return { ok: false, error: "direct_sql_not_supported" };
  }

  const key = resolveEncryptionKey(process.env);
  const sets: string[] = [];
  const params: unknown[] = [businessId, connectionId];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (input.host !== undefined) add("host", input.host.trim());
  if (input.port !== undefined) add("port", input.port);
  if (input.database !== undefined) add("database", input.database.trim());
  if (input.webServiceBaseUrl !== undefined) add("web_service_base_url", input.webServiceBaseUrl);
  if (input.sqlUser !== undefined) add("sql_user_ciphertext", input.sqlUser.trim() ? encryptSecret(input.sqlUser.trim(), key) : null);
  if (input.sqlPassword !== undefined) add("sql_password_ciphertext", input.sqlPassword.trim() ? encryptSecret(input.sqlPassword.trim(), key) : null);
  if (input.wsUser !== undefined) add("ws_user_ciphertext", input.wsUser.trim() ? encryptSecret(input.wsUser.trim(), key) : null);
  if (input.wsPassword !== undefined) add("ws_password_ciphertext", input.wsPassword.trim() ? encryptSecret(input.wsPassword.trim(), key) : null);
  if (input.currencyUnit !== undefined) add("currency_unit", input.currencyUnit);
  if (input.writeMode !== undefined) add("write_mode", input.writeMode);

  if (sets.length === 0) return { ok: true, settings: mapSettings(existing) };

  const { rows } = await query<HolooSettingsRow>(
    `UPDATE holoo_connection_settings SET ${sets.join(", ")}, updated_at = now()
      WHERE business_id = $1 AND connection_id = $2
      RETURNING ${SETTINGS_COLUMNS}`,
    params,
  );
  await writeIntegrationAudit({ businessId, connectionId, action: "connection.holoo_updated", payload: input });
  return { ok: true, settings: mapSettings(rows[0]) };
}

/** Decrypt and return a ready-to-use SQL Server config for this connection. */
export function holooSqlConfigFor(row: HolooSettingsRow): HolooSqlServerConfig {
  if (!row.sql_user_ciphertext || !row.sql_password_ciphertext) throw new Error("no_sql_credentials");
  const key = resolveEncryptionKey(process.env);
  return {
    host: row.host,
    port: row.port,
    database: row.database,
    user: decryptSecret(row.sql_user_ciphertext, key),
    password: decryptSecret(row.sql_password_ciphertext, key),
  };
}

/** Decrypt and return the official Holoo web-service config for writes. */
export function holooWebServiceConfigFor(row: HolooSettingsRow): HolooWebServiceConfig {
  if (!row.web_service_base_url || !row.ws_user_ciphertext || !row.ws_password_ciphertext) {
    throw new Error("no_web_service_credentials");
  }
  const key = resolveEncryptionKey(process.env);
  return {
    baseUrl: row.web_service_base_url,
    database: row.database,
    user: decryptSecret(row.ws_user_ciphertext, key),
    password: decryptSecret(row.ws_password_ciphertext, key),
  };
}

export async function activateHolooCompanion(
  businessId: string,
  connectionId: string,
  activatedBy: string,
): Promise<{ ok: true; companionActivatedAt: string } | { ok: false; error: "not_found" }> {
  const { rows } = await query<{ companion_activated_at: string }>(
    `UPDATE holoo_connection_settings
        SET companion_activated_at = COALESCE(companion_activated_at, now()), updated_at = now()
      WHERE business_id = $1 AND connection_id = $2
      RETURNING companion_activated_at::text`,
    [businessId, connectionId],
  );
  if (!rows[0]) return { ok: false, error: "not_found" };
  await query(
    `UPDATE integration_connections SET status = 'active', updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, connectionId],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "holoo.companion_activated",
    payload: { activatedBy },
  });
  return { ok: true, companionActivatedAt: rows[0].companion_activated_at };
}

export async function deactivateHolooCompanion(
  businessId: string,
  connectionId: string,
  deactivatedBy: string,
): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  const { rowCount } = await query(
    `UPDATE holoo_connection_settings SET companion_activated_at = NULL, updated_at = now()
      WHERE business_id = $1 AND connection_id = $2`,
    [businessId, connectionId],
  );
  if (rowCount !== 1) return { ok: false, error: "not_found" };
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "holoo.companion_deactivated",
    payload: { deactivatedBy },
  });
  return { ok: true };
}

export async function hasActiveHolooCompanion(businessId: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM holoo_connection_settings h
       JOIN integration_connections c ON c.id = h.connection_id AND c.business_id = h.business_id
       WHERE h.business_id = $1 AND h.companion_activated_at IS NOT NULL AND c.status = 'active'
     ) AS exists`,
    [businessId],
  );
  return Boolean(rows[0]?.exists);
}

export interface HolooTestResult {
  ok: boolean;
  /** SQL Server version string (not represented as Holoo's own product version). */
  version?: string;
  fingerprint?: HolooSchemaFingerprint;
  profile?: HolooSchemaProfile | null;
  diagnostics?: HolooProfileDiagnostic[];
  error?: string;
}

/**
 * Test connectivity and inspect the full structural fingerprint using a
 * read-only SQL client. Network health and migration-profile recognition are
 * separate outcomes: an unknown schema may be diagnosed, but never migrated
 * through this adapter or armed for direct SQL.
 */
export async function testHolooConnection(businessId: string, connectionId: string): Promise<HolooTestResult> {
  const row = await getHolooSettingsRow(businessId, connectionId);
  if (!row) return { ok: false, error: "not_found" };

  let client;
  try {
    client = await connectHolooSql(holooSqlConfigFor(row));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  try {
    const snapshot = await probeHolooSchema(client);
    const { profile, diagnostics } = diagnoseProfile(snapshot);
    const version = snapshot.fingerprint.productVersion || snapshot.fingerprint.serverVersion;

    await query(
      `UPDATE holoo_connection_settings SET holoo_version = $3, schema_profile = $4, updated_at = now()
        WHERE business_id = $1 AND connection_id = $2`,
      [businessId, connectionId, version || null, profile?.key ?? null],
    );
    // A reachable but unsupported SQL schema is still a healthy connection.
    // Migration and direct-write callers independently fail closed on profile.
    await query(
      `UPDATE integration_connections SET status = 'active', last_sync_at = now(), last_error = NULL, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, connectionId],
    );
    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: profile ? "connection.test_ok" : "connection.test_ok_unknown_profile",
      payload: {
        version,
        productLevel: snapshot.fingerprint.productLevel,
        edition: snapshot.fingerprint.edition,
        databaseCollation: snapshot.fingerprint.databaseCollation,
        profile: profile?.key ?? null,
        diagnostics,
      },
    });
    return { ok: true, version, fingerprint: snapshot.fingerprint, profile, diagnostics };
  } catch (err) {
    const message = (err as Error).message;
    await query(
      `UPDATE integration_connections SET status = 'error', last_error = $3, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, connectionId, message],
    );
    await writeIntegrationAudit({ businessId, connectionId, action: "connection.test_failed", error: message });
    return { ok: false, error: message };
  } finally {
    await client.close();
  }
}
