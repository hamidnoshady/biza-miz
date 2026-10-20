import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { workspaceAccessFlags } from "@/lib/workspace-shared";
import { getMediaAsset, getMediaAssetUsage } from "@/lib/media-service";

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const permResult = await requirePermission(PERMISSIONS.mediaView);
  const { session, error } = permResult;
  if (error) return error;
  const { id } = await context.params;

  const asset = await getMediaAsset(session.businessId, id);
  if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  const viewerOverride = permResult.membership
    ? Boolean(workspaceAccessFlags(permResult.membership.permissions).override)
    : session.role === "owner";

  const usage = await getMediaAssetUsage(id, {
    viewerUserId: session.sub,
    viewerOverride,
  });
  return NextResponse.json({ usage });
});
