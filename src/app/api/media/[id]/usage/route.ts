import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { workspaceAccessFlags } from "@/lib/workspace-shared";
import { getMediaAsset, getMediaAssetUsage } from "@/lib/media-service";

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.mediaView);
  if (error) return error;
  const { id } = await context.params;

  const asset = await getMediaAsset(session.businessId, id);
  if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  const viewerOverride = Boolean(workspaceAccessFlags(membership.permissions).override);

  const usage = await getMediaAssetUsage(id, {
    viewerUserId: session.sub,
    viewerOverride,
  });
  return NextResponse.json({ usage });
});
