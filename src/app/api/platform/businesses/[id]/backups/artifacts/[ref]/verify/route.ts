import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { verifyBusinessArtifact } from "@/lib/platform-tenant-backup-ops";

/**
 * Issue #903 §3 — "verify" one artifact from its stored bytes.
 *
 * Re-reads the artifact (local file, or a fresh staging copy of the cloud
 * object), checks the checksum, the manifest signature and — for a logical
 * payload — that it parses as a tenant archive, then moves the row to `ready`
 * or `failed`. This is the operator's route back for an artifact a failed run
 * left unusable, and the reason the console can say "restorable" at all.
 *
 * Capability: `tenant_backup.verify`. The reference is resolved against the
 * business in the path, so a reference from another tenant is simply not found.
 */
export const POST = withPlatformScope(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string; ref: string }> }) => {
    const { session, error } = await requirePlatformCapability("tenant_backup.verify");
    if (error) return error;
    const { id, ref } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const result = await verifyBusinessArtifact(id, ref);
    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "tenant_backup.artifact.verify",
      entity: "tenant_backup_artifacts",
      // The reference is opaque and business-scoped; the outcome is not a secret.
      payload: { ref, ok: result.ok, error: result.ok ? null : result.error },
    }).catch(() => undefined);

    if (!result.ok) {
      const status =
        result.error === "artifact_not_found"
          ? 404
          : result.error === "artifact_missing" || result.error === "storage_unavailable"
            ? 409
            : 422;
      return NextResponse.json({ error: result.error, state: "failed" }, { status });
    }
    return NextResponse.json(
      { ok: true, state: result.state, tables: result.tables },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);
