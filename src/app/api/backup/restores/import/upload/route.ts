import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { recoveryImportAvailable } from "@/lib/tenant-backup-import";
import { handleRestoreChunk, handleRestoreDiscard } from "@/lib/restore-upload-route";

/**
 * Issue #903 §2 item 4 — upload a backup file *for recovery*.
 *
 * Same chunked protocol as the site restore upload (Next's middleware truncates
 * bodies past 10 MB, so a large backup is sent in ≈4 MB pieces), but this one
 * serves the managed profiles: a Cloud or Hybrid business bringing back a file
 * it downloaded earlier, which no inventory row names. The bytes are only ever
 * staged for the import step — `POST /api/backup/restores/import` decides whether
 * they are really this business's backup before anything is registered.
 *
 * It is not a backup *management* control (issue #903 §2): nothing here creates,
 * schedules, uploads-as-inventory or deletes a backup of record. A Local install
 * is refused outright — its restores go through the single-business physical
 * path (issue #807), which has its own scratch verification.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
  if (error) return error;
  const profile = (await readDeploymentProfile(session.businessId)).profile;
  if (!recoveryImportAvailable(profile)) {
    return NextResponse.json({ error: "recovery_import_unavailable" }, { status: 403 });
  }
  return handleRestoreChunk(request, `import-${session.businessId}`);
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
  if (error) return error;
  return handleRestoreDiscard(request, `import-${session.businessId}`);
});
