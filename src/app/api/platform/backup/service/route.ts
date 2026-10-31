import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  readTenantBackupService,
  serviceConfigView,
  updateTenantBackupService,
} from "@/lib/tenant-backup-storage";

/**
 * Issue #903 §6/§10 — the platform's managed-tenant-backup service.
 *
 * This is the single place the fleet's backup destination, the sealing custody
 * and the plan-shaped defaults are set. It is deliberately *platform-only*: no
 * tenant route can reach it, and every response is a view
 * (`serviceConfigView`) that reports whether a secret exists without ever
 * returning it.
 *
 * `tenant_backup.read` reads the view; `tenant_backup.policy` changes it — an
 * owner-only capability, because enabling managed cloud is enabling a
 * platform-wide outbound data flow billed to every tenant.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("tenant_backup.read");
  if (error) return error;
  const config = await readTenantBackupService();
  return NextResponse.json(
    { service: serviceConfigView(config) },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("tenant_backup.policy");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const outcome = await updateTenantBackupService({ ...body, updatedBy: session.padmin });
  if (!outcome.ok) {
    const status = outcome.error === "key_encryption_unconfigured" ? 503 : 400;
    return NextResponse.json({ error: outcome.error }, { status });
  }

  // The audit entry names what changed, never a secret.
  await platformAudit({
    adminId: session.padmin,
    action: "tenant_backup.service.update",
    entity: "platform_tenant_backup_service",
    payload: {
      managedCloud: outcome.config.managedCloud,
      hybridEnabled: outcome.config.hybridEnabled,
      configured: outcome.config.cloudEnabled,
      defaultIntervalHours: outcome.config.defaultIntervalHours,
      defaultRetentionDays: outcome.config.defaultRetentionDays,
    },
  }).catch(() => undefined);

  return NextResponse.json(
    { service: serviceConfigView(outcome.config) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
