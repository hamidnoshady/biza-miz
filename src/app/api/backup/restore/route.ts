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

  const [allowed, artifacts] = await Promise.all([
    restoreAvailable(),
    listRestorableArtifacts(session.businessId),
  ]);
  return NextResponse.json({ allowed, ...artifacts });
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
    outcome = await restoreFromArtifact(session.businessId, { source, artifact, apply });
  }
  if (outcome.status === "failed") {
    return NextResponse.json({ error: outcome.error }, { status: 400 });
  }
  return NextResponse.json(outcome);
});
