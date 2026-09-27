import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listCollectionsForAsset } from "@/lib/media-service";

/** The collections a given asset currently belongs to — for the asset drawer. */
export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaView);
  if (error) return error;
  const { id } = await context.params;

  const collections = await listCollectionsForAsset(session.businessId, id);
  return NextResponse.json({ collections });
});
