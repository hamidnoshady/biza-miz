import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import {
  businessCustodySummary,
  tenantBackupInventory,
} from "@/lib/tenant-backup-artifacts-service";
import {
  ARTIFACT_COMPLETENESS_LABELS,
  ARTIFACT_FORMAT_LABELS,
  ARTIFACT_ORIGIN_LABELS,
  ARTIFACT_STATE_LABELS,
} from "@/lib/tenant-backup-inventory";

/**
 * Issue #903 §8 — the Superadmin per-business backing-up panel, artifact half.
 *
 * Deliberately separate from `/api/platform/backup/*`, which serves the
 * deployment-wide whole-platform disaster-recovery system. This route reads only
 * the business named in the path, only its own inventory, and never returns a
 * platform archive. It also reports encryption custody — which the tenant never
 * sees — because key generation, rotation and legacy artifacts are operator
 * business.
 *
 * Capability: `tenant_backup.read`, the metadata-read capability admin presets
 * already hold. Mutating operations (trigger, verify, download, policy edit and
 * tenant restore) need their own scoped capabilities and are not exposed here;
 * the tenant restore preview lives behind the Owner's `backup.restore` on the
 * tenant route.
 */
export const GET = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformCapability("tenant_backup.read");
    if (error) return error;
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const params = request.nextUrl.searchParams;
    const deployment = await readDeploymentProfile(id);
    const inventory = await tenantBackupInventory(id, {
      profile: deployment.profile,
      connectivity: deployment.profile === "cloud" ? "online" : "unknown",
      query: {
        search: params.get("search") ?? undefined,
        page: Number(params.get("page") ?? 1),
        pageSize: Number(params.get("pageSize") ?? 20),
        sort: params.get("sort") === "oldest" ? "oldest" : "newest",
      },
    });
    const custody = await businessCustodySummary(id, {
      legacyArtifacts: inventory.items.some((item) => item.encryption === "legacy_passphrase"),
    });

    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "tenant_backup.artifacts_viewed",
      entity: "business",
      entityId: id,
      payload: { profile: deployment.profile, items: inventory.total },
    });

    return NextResponse.json(
      {
        profile: deployment.profile,
        inventory,
        custody,
        labels: {
          state: ARTIFACT_STATE_LABELS,
          format: ARTIFACT_FORMAT_LABELS,
          origin: ARTIFACT_ORIGIN_LABELS,
          completeness: ARTIFACT_COMPLETENESS_LABELS,
        },
        // Generation success is still not proof of restorability: a Superadmin
        // must not read this panel as "verified recovery".
        metadataOnly: true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);
