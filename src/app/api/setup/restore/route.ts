import { NextRequest, NextResponse } from "next/server";
import { freshInstallRestoreAvailable, restoreFreshInstall } from "@/lib/backup-service";
import { isRestoreUploadId } from "@/lib/restore-upload";

/**
 * First-run restore: bring a reinstalled desktop's old database back from the
 * backup file it wrote before (uploaded through ./upload). `apply: false`
 * verifies into a scratch database; `apply: true` replaces the empty database
 * with it after the same verification.
 *
 * Available only while this is a site install with no business and no user —
 * see freshInstallRestoreAvailable(). Afterwards the Owner signs in with the
 * accounts inside the backup, and cloud sync is re-attached from «اتصال‌ها ←
 * برنامهٔ دسکتاپ ← ترمیم / اتصال دوباره».
 */
export async function GET() {
  return NextResponse.json({ available: await freshInstallRestoreAvailable() });
}

export async function POST(request: NextRequest) {
  let body: { uploadId?: unknown; fileName?: unknown; passphrase?: unknown; apply?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isRestoreUploadId(body.uploadId)) {
    return NextResponse.json({ error: "missing_artifact" }, { status: 400 });
  }
  if (!(await freshInstallRestoreAvailable())) {
    return NextResponse.json({ error: "restore_not_available" }, { status: 403 });
  }
  const outcome = await restoreFreshInstall({
    uploadId: body.uploadId,
    fileName: typeof body.fileName === "string" ? body.fileName : undefined,
    passphrase: typeof body.passphrase === "string" ? body.passphrase : undefined,
    apply: body.apply === true,
  });
  if (outcome.status === "failed") {
    return NextResponse.json({ error: outcome.error }, { status: 400 });
  }
  return NextResponse.json(outcome);
}
