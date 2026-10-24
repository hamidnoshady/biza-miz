/** Tenant boundary: never serialize the operator's storage configuration. */
import { ALLOWED_INTERVAL_HOURS, type BackupConfig } from "./backup";

export function tenantBackupSettings(config: BackupConfig) {
  return {
    enabled: config.enabled,
    intervalHours: config.intervalHours,
    anchorTime: config.anchorTime,
    localRetention: config.localRetention,
  };
}

/** Strict allow-list, including unknown nested fields: old clients must refresh. */
export function applyTenantBackupSettings(current: BackupConfig, input: unknown):
  | { ok: true; config: BackupConfig }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "bad_request" };
  }
  const body = input as Record<string, unknown>;
  const allowed = ["enabled", "intervalHours", "anchorTime"];
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
  return { ok: true, config: {
    ...current,
    enabled: body.enabled,
    intervalHours: body.intervalHours,
    anchorTime: body.anchorTime,
  } };
}

/** Internal errors may contain URLs, object keys, credentials or filesystem paths. */
export function tenantBackupError(error: string | null): string | null {
  return error ? "backup_operation_failed" : null;
}
