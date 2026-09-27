import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { removeAssetFromCollection } from "@/lib/media-service";

/** Remove an asset from a collection — the asset itself is untouched. */
export const DELETE = withTenantScope(
  async (_request: Request, context: { params: Promise<{ id: string; assetId: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
    if (error) return error;
    const { id, assetId } = await context.params;

    const removed = await removeAssetFromCollection(session.businessId, id, assetId);
    if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
