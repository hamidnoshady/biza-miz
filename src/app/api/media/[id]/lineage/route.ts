import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getMediaAsset, getMediaAssetLineage } from "@/lib/media-service";

/**
 * "What is this asset's version history?" — the ancestor chain a deterministic
 * transform or an AI edit produced it through (original → crop → enhance →
 * upscale, …), plus the assets made directly from it. A small, separate read
 * the drawer fetches lazily once an asset is open, the same shape as
 * `/api/media/[id]/usage` next to it — never bundled into the grid payload
 * every card would otherwise pay for.
 *
 * `media.view` only: walking a library asset's own edit history is a
 * Media Library action, not something any other app's usage-based exception
 * (Section O.1 of the report) extends to.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaView);
  if (error) return error;
  const { id } = await context.params;

  const asset = await getMediaAsset(session.businessId, id);
  if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  const lineage = await getMediaAssetLineage(session.businessId, id);
  return NextResponse.json({ lineage });
});

