import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getMediaAsset, getMediaAssetUsage } from "@/lib/media-service";

/**
 * "Where is this used?" (section 35/77 of the media architecture) — a small,
 * separate read the lightbox fetches lazily once an asset is open, never
 * bundled into the grid payload every card would otherwise pay for.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaView);
  if (error) return error;
  const { id } = await context.params;

  const asset = await getMediaAsset(session.businessId, id);
  if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  const usage = await getMediaAssetUsage(id);
  return NextResponse.json({ usage });
});
