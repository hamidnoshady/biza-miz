import { NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { checkTenantBackupService, readTenantBackupService, serviceConfigView } from "@/lib/tenant-backup-storage";

/**
 * Issue #903 §6 — "test the destination", the operator's only honest answer to
 * "is managed storage actually working?".
 *
 * It performs one signed request against the configured bucket (a one-key list,
 * which needs no write permission), records the outcome on the config row and
 * reports a provider-neutral code. It never returns the provider's message: those
 * carry endpoints, buckets and sometimes credentials fragments.
 */
export const POST = withPlatformScope(async () => {
  const { session, error } = await requirePlatformCapability("tenant_backup.policy");
  if (error) return error;

  const check = await checkTenantBackupService();
  await platformAudit({
    adminId: session.padmin,
    action: "tenant_backup.service.check",
    entity: "platform_tenant_backup_service",
    payload: { code: check.code },
  }).catch(() => undefined);

  const config = await readTenantBackupService();
  return NextResponse.json(
    { code: check.code, ok: check.ok, service: serviceConfigView(config) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
