import { createReadStream } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { getBackupConfig } from "@/lib/backup-service";
import { planArtifactDownload } from "@/lib/tenant-backup-transport";
import { deleteBusinessArtifact } from "@/lib/platform-tenant-backup-ops";

/**
 * Issue #903 §3 — the high-privilege download and the retention delete, for one
 * artifact of one business.
 *
 * **GET** streams (local destination) or redirects to a time-limited provider URL
 * (cloud). The console never receives an object key or a credential: the only
 * thing a caller supplies is an opaque, business-scoped reference, and the only
 * thing it gets back is bytes or a short-lived redirect. Capability
 * `tenant_backup.download` is owner-level, deliberately narrower than the
 * engineer's `verify`, and every download is audited.
 *
 * **DELETE** is retention, not destruction: `deleteBusinessArtifact` refuses to
 * cross the platform's protected-copy floor, removes the stored bytes and marks
 * the row `expired` so the history stays honest. Capability
 * `tenant_backup.policy` — the same owner-level capability that edits policy.
 */
export const GET = withPlatformScope(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string; ref: string }> }) => {
    const { session, error } = await requirePlatformCapability("tenant_backup.download");
    if (error) return error;
    const { id, ref } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const profile = (await readDeploymentProfile(id)).profile;
    const role = deploymentRole();
    const config = await getBackupConfig(id);

    // The caller names a reference, not a destination: try the one that holds it.
    for (const destination of ["local", "cloud"] as const) {
      const plan = await planArtifactDownload({
        businessId: id,
        ref,
        destination,
        profile,
        role,
        directory: config.directory,
      });
      if (plan.kind === "error") continue;
      await platformAudit({
        adminId: session.padmin,
        businessId: id,
        action: "tenant_backup.artifact.download",
        entity: "tenant_backup_artifacts",
        payload: { ref, destination },
      }).catch(() => undefined);

      if (plan.kind === "redirect") {
        return NextResponse.redirect(plan.url, {
          status: 302,
          headers: { "Cache-Control": "no-store" },
        });
      }
      const stream = createReadStream(plan.path);
      return new NextResponse(stream as unknown as ReadableStream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(plan.sizeBytes),
          "Content-Disposition": `attachment; filename="${ref.replace(/[^A-Za-z0-9._-]/g, "")}.enc"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  },
);

export const DELETE = withPlatformScope(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string; ref: string }> }) => {
    const { session, error } = await requirePlatformCapability("tenant_backup.policy");
    if (error) return error;
    const { id, ref } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const result = await deleteBusinessArtifact(id, ref);
    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "tenant_backup.artifact.delete",
      entity: "tenant_backup_artifacts",
      payload: { ref, ok: result.ok, error: result.ok ? null : result.error },
    }).catch(() => undefined);

    if (!result.ok) {
      const status =
        result.error === "artifact_not_found"
          ? 404
          : result.error === "protected_copies"
            ? 409
            : 502;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json(
      { ok: true, state: result.state, deletedBytes: result.deletedBytes },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);
