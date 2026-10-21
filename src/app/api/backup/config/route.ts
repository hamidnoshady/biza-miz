import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { applyTenantBackupSettings, tenantBackupSettings } from "@/lib/tenant-backup-contract";
import { getBackupConfig, setBackupConfig } from "@/lib/backup-service";
import { isLocalOnly } from "@/lib/deployment-mode";

/** Tenant schedule only. Infrastructure, encryption and retention are operator-owned. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.backupConfigure);
  if (error) return error;

  return NextResponse.json({
    config: tenantBackupSettings(await getBackupConfig(session.businessId)),
    // A local-only install has no cloud story: the client hides the whole
    // S3 section, and the PUT below refuses to enable it.
    localOnly: await isLocalOnly(session.businessId),
  }, { headers: { "Cache-Control": "no-store" } });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupConfigure);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const current = await getBackupConfig(session.businessId);
  const validated = applyTenantBackupSettings(current, body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  await setBackupConfig(session.businessId, validated.config);
  return NextResponse.json({ ok: true });
});
