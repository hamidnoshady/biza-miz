/** Tenant boundary: central tenants never serialize or mutate operator storage. */
import { ALLOWED_INTERVAL_HOURS, validateBackupConfig, type BackupConfig } from "./backup";

export function tenantBackupSettings(
  config: BackupConfig,
  options: { includeSiteInfrastructure?: boolean } = {},
) {
  return {
    enabled: config.enabled,
    intervalHours: config.intervalHours,
    anchorTime: config.anchorTime,
    localRetention: config.localRetention,
    ...(options.includeSiteInfrastructure
      ? {
          directory: config.directory,
          secondaryDirectory: config.secondaryDirectory ?? "",
        }
      : {}),
  };
}

/**
 * Strict allow-list, including unknown nested fields: old clients must refresh.
 * A single-business site Owner may choose local destinations; a central tenant
 * is still restricted to its schedule and cannot influence shared infrastructure.
 */
export function applyTenantBackupSettings(
  current: BackupConfig,
  input: unknown,
  options: { allowSiteInfrastructure?: boolean } = {},
): { ok: true; config: BackupConfig } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "bad_request" };
  }
  const body = input as Record<string, unknown>;
  const allowed = [
    "enabled",
    "intervalHours",
    "anchorTime",
    ...(options.allowSiteInfrastructure
      ? ["localRetention", "directory", "secondaryDirectory"]
      : []),
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    return { ok: false, error: "managed_backup_settings_only" };
  }
  if (typeof body.enabled !== "boolean" ||
      typeof body.intervalHours !== "number" ||
      !(ALLOWED_INTERVAL_HOURS as readonly number[]).includes(body.intervalHours) ||
      typeof body.anchorTime !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.anchorTime)) {
    return { ok: false, error: "invalid_backup_schedule" };
  }

  const validated = validateBackupConfig({ ...current, ...body });
  if (!validated.ok) return validated;
  // Spread the validated normalized value over nothing: this deliberately
  // retains current secrets/cloud settings, which were not accepted in input.
  return { ok: true, config: validated.config };
}

/** Internal errors may contain URLs, object keys, credentials or filesystem paths. */
export function tenantBackupError(error: string | null): string | null {
  return error ? "backup_operation_failed" : null;
}
