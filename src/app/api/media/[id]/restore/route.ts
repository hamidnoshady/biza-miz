import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { restoreMediaAsset } from "@/lib/media-service";

/**
 * Undo a trash — clears `deleted_at` so the asset is a normal library item
 * again, up until the retention sweep purges it for good
 * (`runMediaTrashPurgeTick`, src/lib/media-service.ts).
 */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;
  const { id } = await context.params;

  const restored = await restoreMediaAsset(session.businessId, id);
  if (!restored) return NextResponse.json({ error: "not_in_trash" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
