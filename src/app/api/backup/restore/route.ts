import { tenantBackupArtifactRef, tenantRestoreError } from "@/lib/tenant-backup-artifact-ref";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  listRestorableArtifacts,
  restoreAvailable,
  restoreFromArtifact,
} from "@/lib/backup-service";
import { isRestoreUploadId } from "@/lib/restore-upload";

/**
 * Restore (whole database) — Owner-only, and only on an install whose database
 * holds exactly one business (the desktop/single-tenant case). POST with
 * `apply: false` verifies the artifact into a scratch database and reports the
 * validation summary; `apply: true` replaces the production database with the
 * same already-verified artifact. Both are destructive enough that they never
 * reach a Manager, let alone a floor role.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
  if (error) return error;

  const allowed = await restoreAvailable();
  // Do not even query artifact storage on central or multi-business installations.
  if (!allowed) return NextResponse.json({ allowed: false, local: [], cloud: [] });
  const artifacts = await listRestorableArtifacts(session.businessId);
  const publicArtifact = (artifact: (typeof artifacts.local)[number]) => ({
    ...artifact,
    key: tenantBackupArtifactRef(session.businessId, artifact.kind, artifact.key),
  });
  return NextResponse.json({ allowed, local: artifacts.local.map(publicArtifact), cloud: artifacts.cloud.map(publicArtifact) },
    { headers: { "Cache-Control": "no-store" } });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
  if (error) return error;

  let body: {
    source?: unknown;
    artifact?: unknown;
    uploadId?: unknown;
    fileName?: unknown;
    passphrase?: unknown;
    apply?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!(await restoreAvailable())) {
    return NextResponse.json({ error: "restore_not_available" }, { status: 403 });
  }

  const apply = Boolean(body.apply);
  let outcome;
  if (body.source === "upload") {
    // A file uploaded through ./upload — the only way to restore a backup this
    // install never recorded (a reinstalled desktop, a dump on a USB stick).
    if (!isRestoreUploadId(body.uploadId)) {
      return NextResponse.json({ error: "missing_artifact" }, { status: 400 });
    }
    outcome = await restoreFromArtifact(session.businessId, {
      source: "upload",
      uploadId: body.uploadId,
      fileName: typeof body.fileName === "string" ? body.fileName : undefined,
      passphrase: typeof body.passphrase === "string" ? body.passphrase : undefined,
      apply,
    });
  } else {
    const source = body.source === "cloud" ? "cloud" : "local";
    const artifact = typeof body.artifact === "string" ? body.artifact.trim() : "";
    if (!artifact) {
      return NextResponse.json({ error: "missing_artifact" }, { status: 400 });
    }
    // A browser reference is never a filesystem path or supplier object key.
    // Resolve it afresh against this business's inventory on every verify/apply.
    const inventory = await listRestorableArtifacts(session.businessId);
    const owned = inventory[source].find((item) => item.exists &&
      tenantBackupArtifactRef(session.businessId, source, item.key) === artifact);
    if (!owned) return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
    outcome = await restoreFromArtifact(session.businessId, { source, artifact: owned.key, apply });
  }
  if (outcome.status === "failed") {
    return NextResponse.json({ error: tenantRestoreError(outcome.error) }, { status: 400 });
  }
  return NextResponse.json(outcome);
});
