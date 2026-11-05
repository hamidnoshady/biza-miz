import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { discardRestoreUpload, isRestoreUploadId, readRestoreUploadPath } from "@/lib/restore-upload";
import {
  importRecoveryFile,
  mapImportError,
  recoveryImportAvailable,
} from "@/lib/tenant-backup-import";

/**
 * Issue #903 §2 item 4 / §6 — import a backup **file** as a restore source.
 *
 * The request carries the id of the staged upload (see `./upload`), the
 * `.manifest.json` the Owner saved beside the payload, and — only for a legacy
 * passphrase artifact — that one-time passphrase. Nothing else is believed: the
 * manifest is verified against the platform key, the payload against the
 * checksum the manifest signed, and the business against the manifest's own
 * scope. Success answers with an opaque reference, which the *existing* preview
 * and apply routes then treat exactly like a cloud artifact — the import path
 * adds no new way to write a business's rows.
 *
 * Owner-only (`backup.restore`), and refused outright on a Local install.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
  if (error) return error;

  let body: {
    uploadId?: unknown;
    manifest?: unknown;
    passphrase?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const uploadId = body.uploadId;
  if (!isRestoreUploadId(uploadId)) {
    return NextResponse.json({ error: "recovery_file_missing" }, { status: 400 });
  }
  // The manifest file is small JSON; anything larger is not one.
  const manifest = typeof body.manifest === "string" ? body.manifest : "";
  if (manifest.length === 0 || manifest.length > 256 * 1024) {
    return NextResponse.json({ error: "recovery_manifest_unreadable" }, { status: 400 });
  }
  const passphrase = typeof body.passphrase === "string" ? body.passphrase.slice(0, 512) : "";

  const profile = (await readDeploymentProfile(session.businessId)).profile;
  if (!recoveryImportAvailable(profile)) {
    return NextResponse.json({ error: "recovery_import_unavailable" }, { status: 403 });
  }

  const uploadPath = await readRestoreUploadPath(`import-${session.businessId}`, uploadId);
  const imported = await importRecoveryFile({
    businessId: session.businessId,
    uploadPath,
    manifestText: manifest,
    legacyPassphrase: passphrase || undefined,
    createdBy: session.sub,
  });

  // The staged copy has served its purpose either way: on success the artifact
  // now lives in the tenant's backup directory, on failure it is not a backup.
  await discardRestoreUpload(`import-${session.businessId}`, uploadId);

  if (!imported.ok) {
    const code = mapImportError(imported.error);
    const status =
      code === "recovery_manifest_signature_invalid" || code === "recovery_file_not_owned_by_business"
        ? 403
        : code === "recovery_file_missing"
          ? 404
          : code === "recovery_checksum_mismatch" ||
              code === "recovery_file_unreadable" ||
              code === "recovery_manifest_unreadable" ||
              code === "recovery_file_not_importable" ||
              code === "recovery_file_schema_too_new" ||
              code === "recovery_passphrase_required"
            ? 422
            : 503;
    return NextResponse.json({ error: code }, { status });
  }

  return NextResponse.json(
    {
      ref: imported.ref,
      capturedAt: imported.capturedAt,
      payloadBytes: imported.payloadBytes,
      // The next step is the ordinary preview: an import registers a restore
      // source, it does not restore anything.
      nextStep: "/api/backup/restores/preview",
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
});
