import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { restoreAvailable } from "@/lib/backup-service";
import { handleRestoreChunk, handleRestoreDiscard } from "@/lib/restore-upload-route";

/**
 * Upload a backup file, piece by piece, so it can be restored from — the
 * counterpart of the artifact list for a file this install never wrote (a
 * reinstalled desktop, a dump on a USB stick). The verify/apply itself is
 * `POST /api/backup/restore` with `source: "upload"`. Same gate as that route:
 * Owner-only, and only on a single-business install.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
  if (error) return error;
  if (!(await restoreAvailable())) {
    return NextResponse.json({ error: "restore_not_available" }, { status: 403 });
  }
  return handleRestoreChunk(request, session.businessId);
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
  if (error) return error;
  return handleRestoreDiscard(request, session.businessId);
});
