import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { promoteQuarantinedArtifact } from "@/lib/tenant-backup-transport";

/**
 * Issue #903 §3 — promote a quarantined upload.
 *
 * An uploaded artifact is registered in `verifying` and is not restorable. This
 * endpoint is the only exit: it re-reads the stored bytes, checks the digest and
 * signature and parses the archive, then (and only then) marks it `ready`.
 * Owner-only (`backup.restore`): promotion allows a restore.
 */
export const POST = withTenantScope(
  async (_request: NextRequest, ctx: { params: Promise<{ ref: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
    if (error) return error;
    const { ref } = await ctx.params;
    const outcome = await promoteQuarantinedArtifact(session.businessId, ref);
    if (!outcome.ok) {
      const status = outcome.error === "artifact_not_found" ? 404 : outcome.error === "not_an_upload" ? 400 : 422;
      return NextResponse.json({ error: outcome.error }, { status });
    }
    return NextResponse.json({ ok: true, state: "ready" }, { headers: { "Cache-Control": "no-store" } });
  },
);
