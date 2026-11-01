import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { recoveryManifestFor } from "@/lib/tenant-backup-import";

/**
 * Issue #903 §2 item 4 / §6 — the second half of a portable recovery file.
 *
 * Downloading a backup gives the Owner the encrypted payload; this gives them
 * the signed manifest that names what the payload contains, which business it
 * belongs to and what its checksum is. Both are needed to import the file again
 * (`POST /api/backup/restores/import`), and saying so plainly is the honest
 * version of the promise: the platform's custody model means the payload alone
 * is not enough, and a file that cannot be restored is not a backup.
 *
 * It carries no secret — components, sizes, checksums, capture time, the key
 * generation — and no provider detail. Owner-only (`backup.export`), because a
 * manifest describes the whole business's contents.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ ref: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupExport);
  if (error) return error;
  const { ref } = await ctx.params;

  const result = await recoveryManifestFor(session.businessId, ref);
  if (!result.ok) {
    const status = result.error === "artifact_not_found" ? 404 : 409;
    // A reference that is not this business's is indistinguishable from a
    // missing one, exactly like the rest of the artifact surface.
    return NextResponse.json(
      { error: result.error === "artifact_not_found" ? "artifact_not_found" : result.error },
      { status },
    );
  }

  return new NextResponse(result.text, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "Cache-Control": "no-store",
    },
  });
});
