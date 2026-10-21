import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermissions } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { canActInLocation } from "@/lib/authorize";
import { isUuid } from "@/lib/uuid";

type Context = { params: Promise<{ id: string }> };

async function scopedReturn(businessId: string, returnId: string) {
  const { rows } = await query<{ location_id: string }>(
    "SELECT location_id FROM item_supplier_returns WHERE id = $2 AND business_id = $1",
    [businessId, returnId],
  );
  return rows[0] ?? null;
}

/** Attach an existing (or newly uploaded) document from the Media Library. */
export const POST = withTenantScope(async (request: NextRequest, context: Context) => {
  const { session, membership, error } = await requirePermissions(
    PERMISSIONS.inventoryAdjust,
    PERMISSIONS.mediaManage,
  );
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "return_not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const mediaAssetId = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).mediaAssetId
    : null;
  if (typeof mediaAssetId !== "string" || !isUuid(mediaAssetId)) {
    return NextResponse.json({ error: "bad_request", field: "mediaAssetId" }, { status: 400 });
  }

  const document = await scopedReturn(session.businessId, id);
  if (!document || !(await canActInLocation(membership, document.location_id))) {
    return NextResponse.json({ error: "return_not_found" }, { status: 404 });
  }
  const { rows: assets } = await query<{ id: string }>(
    `SELECT id FROM media_assets
      WHERE id = $2 AND business_id = $1 AND kind = 'document' AND deleted_at IS NULL`,
    [session.businessId, mediaAssetId],
  );
  if (!assets[0]) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  const { rows } = await query<{ media_asset_id: string }>(
    `INSERT INTO item_supplier_return_attachments
       (business_id, return_id, media_asset_id, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, return_id, media_asset_id) DO NOTHING
     RETURNING media_asset_id`,
    [session.businessId, id, mediaAssetId, session.sub],
  );
  return NextResponse.json({ ok: true, duplicate: rows.length === 0 }, { status: rows.length ? 201 : 200 });
});

/** Remove the link only; the canonical Media Library asset is left untouched. */
export const DELETE = withTenantScope(async (request: NextRequest, context: Context) => {
  const { session, membership, error } = await requirePermissions(
    PERMISSIONS.inventoryAdjust,
    PERMISSIONS.mediaManage,
  );
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "return_not_found" }, { status: 404 });
  const mediaAssetId = new URL(request.url).searchParams.get("mediaAssetId") ?? "";
  if (!isUuid(mediaAssetId)) return NextResponse.json({ error: "bad_request", field: "mediaAssetId" }, { status: 400 });

  const document = await scopedReturn(session.businessId, id);
  if (!document || !(await canActInLocation(membership, document.location_id))) {
    return NextResponse.json({ error: "return_not_found" }, { status: 404 });
  }
  const { rows } = await query<{ media_asset_id: string }>(
    `DELETE FROM item_supplier_return_attachments
      WHERE business_id = $1 AND return_id = $2 AND media_asset_id = $3
      RETURNING media_asset_id`,
    [session.businessId, id, mediaAssetId],
  );
  if (!rows[0]) return NextResponse.json({ error: "attachment_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
