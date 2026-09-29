import { NextRequest, NextResponse } from "next/server";
import { freshInstallRestoreAvailable, SETUP_RESTORE_SCOPE } from "@/lib/backup-service";
import { handleRestoreChunk } from "@/lib/restore-upload-route";

/**
 * First-run upload of the backup a reinstalled desktop is restoring from. Open
 * without a session for exactly as long as /api/setup/bootstrap is: on a site
 * install whose database has no business and no user yet.
 */
export async function POST(request: NextRequest) {
  if (!(await freshInstallRestoreAvailable())) {
    return NextResponse.json({ error: "restore_not_available" }, { status: 403 });
  }
  return handleRestoreChunk(request, SETUP_RESTORE_SCOPE);
}
