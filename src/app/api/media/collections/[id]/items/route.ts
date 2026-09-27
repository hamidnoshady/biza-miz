import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { addAssetToCollection } from "@/lib/media-service";

/** Add an asset to a collection. Idempotent — adding twice is a no-op. */
export const POST = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;
  const { id } = await context.params;

  let body: { assetId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const assetId = typeof body.assetId === "string" ? body.assetId : "";
  if (!assetId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const ok = await addAssetToCollection(session.businessId, id, assetId, session.sub);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
