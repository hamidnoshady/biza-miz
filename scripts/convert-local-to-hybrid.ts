#!/usr/bin/env tsx
/**
 * Safe operator-assisted Local -> Hybrid conversion.
 *
 * Bootstrap and activation are deliberately separate invocations. Bootstrap
 * exports the existing tenant, dry-runs the entire import against the migrated
 * Cloud database, refuses any pre-existing Cloud business (no merge), commits,
 * provisions a site credential, and leaves synchronization disabled. Activation
 * re-verifies schema, Cloud identity and credential before changing the local
 * profile to Hybrid. No reinstall and no local reset are involved.
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { exportTenantData, tenantDataToSql, type TenantExportTable } from "../src/lib/tenant-export";
import { getPool } from "../src/lib/db";
import { generateSyncToken } from "../src/lib/sync-token";
import { restoreTenantExport } from "./restore-tenant";

const DEVICE_LOCAL_TABLES = new Set([
  "printers", "backup_runs", "cloud_exception_outbox", "cloud_exception_response_receipts",
  // Authentication material remains on the site where it was enrolled. Cloud
  // receives membership metadata only and never Local secrets or sessions.
  "employee_credentials", "employee_sessions", "login_attempts",
  // Wrapped under the Local install's KEK and unusable on Cloud. Plaintext
  // export columns are restored, then Cloud mints/backfills its own DEK.
  "business_encryption_keys",
]);
const DEVICE_LOCAL_SETTING_KEYS = new Set([
  "backup.config", "rollup.config", "rollup.sync_state", "server_sync.config",
  "server_sync.state", "app_update.status", "deployment.profile", "deployment.mode",
]);

export function conversionExport(tables: TenantExportTable[]): TenantExportTable[] {
  return tables.flatMap((table) => {
    if (DEVICE_LOCAL_TABLES.has(table.name)) return [];
    if (table.name === "users") return [{
      ...table,
      rows: table.rows.map((row) => ({ ...row, pin_hash: null, password_hash: null })),
    }];
    if (table.name !== "settings") return [table];
    return [{ ...table, rows: table.rows.filter((row) => !DEVICE_LOCAL_SETTING_KEYS.has(String(row.key))) }];
  });
}

export type IdentityMap = Record<string, string>;

/** Apply an operator-confirmed Local membership -> existing Cloud identity map. */
export function applyIdentityMap(tables: TenantExportTable[], identityMap: IdentityMap): TenantExportTable[] {
  return tables.map((table) => table.name !== "users" ? table : ({
    ...table,
    rows: table.rows.map((row) => {
      const mappedIdentity = identityMap[String(row.id)] ?? null;
      return {
        ...row,
        platform_user_id: mappedIdentity,
        // Unmapped Local identities are retained for audit/history but cannot
        // authenticate after Cloud becomes authoritative.
        is_active: mappedIdentity ? row.is_active : false,
        membership_status: mappedIdentity ? (row.membership_status ?? "active") : "offboarded",
        pin_hash: null,
        password_hash: null,
      };
    }),
  }));
}

export interface LocalToHybridConversionArgs { businessId: string; centralUrl: string; remoteUrl: string; activate: boolean; yes: boolean; preview?: boolean; identityMapPath?: string }
type Args = LocalToHybridConversionArgs;
function argsOf(argv: string[]): Args {
  const args: Args = { businessId: "", centralUrl: "", remoteUrl: "", activate: false, yes: false, preview: false, identityMapPath: "" };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--business-id") args.businessId = argv[++i] ?? "";
    else if (value === "--central-database-url") args.centralUrl = argv[++i] ?? "";
    else if (value === "--remote-url") args.remoteUrl = (argv[++i] ?? "").replace(/\/+$/, "");
    else if (value === "--identity-map") args.identityMapPath = argv[++i] ?? "";
    else if (value === "--preview") args.preview = true;
    else if (value === "--activate") args.activate = true;
    else if (value === "--yes") args.yes = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.businessId || !args.centralUrl || !args.remoteUrl) throw new Error("--business-id, --central-database-url and --remote-url are required");
  if (!args.activate && !args.identityMapPath) throw new Error("--identity-map is required for conversion preview and bootstrap");
  if (!args.preview && !args.yes) throw new Error("conversion changes Cloud data; run --preview first, then pass --yes");
  return args;
}

async function migrationVersions(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename");
  return rows.map((row) => row.filename);
}
function sameVersions(a: string[], b: string[]): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }

async function setJsonSetting(client: Client, businessId: string, key: string, value: unknown): Promise<void> {
  await client.query(
    `INSERT INTO settings (business_id,location_id,key,value) VALUES($1,NULL,$2,$3)
     ON CONFLICT (business_id,location_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
    [businessId, key, JSON.stringify(value)],
  );
}

export async function runLocalToHybridConversion(args: LocalToHybridConversionArgs) {
  const localUrl = process.env.DATABASE_URL;
  if (!localUrl) throw new Error("DATABASE_URL must point at the Local installation");
  const local = new Client({ connectionString: localUrl });
  const central = new Client({ connectionString: args.centralUrl });
  await Promise.all([local.connect(), central.connect()]);
  try {
    // The Local production role is normally RLS-constrained. Scope this
    // dedicated operator connection before even reading the business row.
    await local.query("SELECT set_config('app.business_id',$1,false)", [args.businessId]);
    const [localVersions, centralVersions] = await Promise.all([migrationVersions(local), migrationVersions(central)]);
    if (!sameVersions(localVersions, centralVersions)) throw new Error("schema_version_mismatch: migrate both installations before conversion");
    const localBusiness = await local.query<{ profile: string }>(
      `SELECT COALESCE((SELECT value->>'profile' FROM settings WHERE business_id=b.id AND key='deployment.profile'),'local') profile
         FROM businesses b WHERE b.id=$1`, [args.businessId],
    );
    if (!localBusiness.rows[0]) throw new Error("local_business_not_found");

    if (args.activate) {
      const pending = await local.query<{ value: { token?: string; siteDeviceId?: string; locationId?: string; remoteUrl?: string; requiresEncryptionBackfill?: boolean } }>(
        "SELECT value FROM settings WHERE business_id=$1 AND key='server_sync.config'", [args.businessId],
      );
      const config = pending.rows[0]?.value;
      if (!config?.token || !config.siteDeviceId || config.remoteUrl !== args.remoteUrl) throw new Error("verified_bootstrap_not_found");
      const hash = createHash("sha256").update(config.token).digest("hex");
      const verified = await central.query(
        `SELECT 1 FROM site_sync_credentials c JOIN site_devices d ON d.id=c.site_device_id
          WHERE c.business_id=$1 AND c.site_device_id=$2 AND c.token_hash=$3 AND d.location_id=$4`,
        [args.businessId, config.siteDeviceId, hash, config.locationId],
      );
      if (verified.rowCount !== 1) throw new Error("cloud_bootstrap_verification_failed");
      if (config.requiresEncryptionBackfill) {
        const key = await central.query(
          "SELECT 1 FROM business_encryption_keys WHERE business_id=$1 AND retired_at IS NULL AND octet_length(wrapped_dek)>0",
          [args.businessId],
        );
        if (key.rowCount !== 1) throw new Error("cloud_encryption_backfill_required: run db:encrypt-fields on Cloud before activation");
      }
      await local.query("BEGIN");
      try {
        await setJsonSetting(local, args.businessId, "server_sync.config", { ...config, enabled: true });
        await setJsonSetting(local, args.businessId, "deployment.profile", { profile: "hybrid", pairedAt: new Date().toISOString() });
        await local.query("COMMIT");
      } catch (error) { await local.query("ROLLBACK"); throw error; }
      console.log("Hybrid activated after bootstrap verification. Local remains operational authority.");
      return;
    }

    if (localBusiness.rows[0].profile !== "local") throw new Error("business_is_not_local_profile");
    const exists = await central.query("SELECT 1 FROM businesses WHERE id=$1", [args.businessId]);
    if (exists.rowCount) throw new Error("cloud_business_already_exists: automatic merge is intentionally refused");

    const localEncryption = await local.query(
      "SELECT 1 FROM business_encryption_keys WHERE business_id=$1 AND retired_at IS NULL AND octet_length(wrapped_dek)>0",
      [args.businessId],
    );
    const rawMap = JSON.parse(await readFile(args.identityMapPath!, "utf8")) as unknown;
    if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) throw new Error("identity_map_must_be_an_object");
    const identityMap = rawMap as IdentityMap;
    const mappedIdentityIds = [...new Set(Object.values(identityMap))];
    if (mappedIdentityIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error("identity_map_contains_invalid_cloud_id");
    const cloudIdentities = mappedIdentityIds.length ? await central.query<{ id: string }>(
      "SELECT id FROM platform_users WHERE id=ANY($1::uuid[]) AND is_active",
      [mappedIdentityIds],
    ) : { rows: [] as Array<{ id: string }> };
    const validCloudIds = new Set(cloudIdentities.rows.map((row) => row.id));
    if (mappedIdentityIds.some((id) => !validCloudIds.has(id))) throw new Error("identity_map_references_missing_or_inactive_cloud_identity");

    const localMembers = await local.query<{ id: string; role: string; is_active: boolean }>(
      "SELECT id,role,is_active FROM users WHERE business_id=$1 ORDER BY id",
      [args.businessId],
    );
    const memberIds = new Set(localMembers.rows.map((row) => row.id));
    if (Object.keys(identityMap).some((id) => !memberIds.has(id))) throw new Error("identity_map_contains_unknown_local_membership");
    if (!localMembers.rows.some((member) => member.role === "owner" && member.is_active && identityMap[member.id])) {
      throw new Error("mapped_active_owner_required");
    }

    const exported = applyIdentityMap(
      conversionExport(await exportTenantData(args.businessId))
        .filter((table) => table.name !== "platform_users"),
      identityMap,
    );
    const sql = tenantDataToSql(exported);
    await restoreTenantExport(central, sql, { apply: false }); // mandatory full dry run
    const mappedCount = localMembers.rows.filter((member) => identityMap[member.id]).length;
    console.log(JSON.stringify({ businessId: args.businessId, members: localMembers.rows.length, mapped: mappedCount, disabled: localMembers.rows.length - mappedCount, credentialSecretsCopied: false }, null, 2));
    if (args.preview) {
      console.log("Preview complete. No Cloud or Local data was changed.");
      return;
    }
    await restoreTenantExport(central, sql, { apply: true });

    const location = await local.query<{ id: string }>("SELECT id FROM locations WHERE business_id=$1 ORDER BY created_at,id LIMIT 1", [args.businessId]);
    if (!location.rows[0]) throw new Error("local_location_not_found");
    const siteDeviceId = randomUUID();
    const siteDevicePublicId = randomUUID();
    const token = generateSyncToken();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await central.query("BEGIN");
    try {
      await central.query(
        `INSERT INTO site_devices(id,business_id,location_id,public_id,display_name) VALUES($1,$2,$3,$4,$5)`,
        [siteDeviceId, args.businessId, location.rows[0].id, siteDevicePublicId, "Local conversion site"],
      );
      await central.query(
        "INSERT INTO site_sync_credentials(site_device_id,business_id,token_hash) VALUES($1,$2,$3)",
        [siteDeviceId, args.businessId, tokenHash],
      );
      await setJsonSetting(central, args.businessId, "deployment.profile", { profile: "cloud", pairedAt: null });
      await central.query("COMMIT");
    } catch (error) { await central.query("ROLLBACK"); throw error; }

    await local.query("BEGIN");
    try {
      await setJsonSetting(local, args.businessId, "server_sync.config", {
        remoteUrl: args.remoteUrl, token, enabled: false, batchSize: 100,
        siteDeviceId, siteDevicePublicId, locationId: location.rows[0].id,
        requiresEncryptionBackfill: localEncryption.rowCount === 1,
      });
      await local.query("COMMIT");
    } catch (error) { await local.query("ROLLBACK"); throw error; }
    console.log("Bootstrap copied and verified with sync DISABLED. Re-run the same command with --activate --yes after operator review.");
  } finally {
    await Promise.allSettled([local.end(), central.end(), getPool().end()]);
  }
}

if (process.argv[1]?.endsWith("convert-local-to-hybrid.ts")) {
  runLocalToHybridConversion(argsOf(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
