import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { completeTenantUpload } from "@/lib/tenant-backup-transport";

/**
 * Issue #903 §3 — finish an upload into quarantine.
 *
 * Success means "the bytes arrived and are recorded", **not** "this is a
 * backup". The artifact is in `verifying`; `POST
 * /api/backup/artifacts/<ref>/verify` is what makes it restorable.
 */
export const POST = withTenantScope(
  async (request: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
    if (error) return error;
    const { token } = await ctx.params;

    const body = await request.json().catch(() => ({}));
    const artifactName = typeof (body as { artifactName?: unknown }).artifactName === "string"
      ? ((body as { artifactName: string }).artifactName)
      : null;

    const done = await completeTenantUpload({
      businessId: session.businessId,
      token,
      artifactName,
      createdBy: session.sub,
    });
    if (!done.ok) {
      const status = done.error === "upload_not_found" ? 404 : done.error === "upload_not_open" ? 409 : 422;
      return NextResponse.json({ error: done.error }, { status });
    }
    return NextResponse.json(
      { ok: true, ref: done.ref, state: "verifying" },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);
