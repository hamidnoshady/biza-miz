import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBackupHealth } from "@/lib/backup-service";

/** Lightweight persistent-chrome poll; run history stays on /api/backup/status. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.backupManage);
  if (error) return error;
  return NextResponse.json(
    { health: await getBackupHealth(session.businessId) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
