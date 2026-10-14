import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { attachVehicleMedia, detachVehicleMedia, listVehicleMedia } from "@/lib/automotive-service";
import { VEHICLE_MEDIA_CATEGORIES, type VehicleMediaCategory } from "@/lib/automotive";
import { handleAutomotiveError, holdsPermission, readBody, vehicleBranchContext } from "../../../guard";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function requireMediaAccess(session: Parameters<typeof holdsPermission>[0]): Promise<NextResponse | null> {
  return (await holdsPermission(session, PERMISSIONS.mediaView))
    ? null
    : NextResponse.json({ error: "forbidden" }, { status: 403 });
}

/** Vehicle-specific labels over the canonical tenant media library. */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const { id } = await context.params;
  const { access, response } = await vehicleBranchContext(session, id);
  if (response) return response;

  try {
    const attachments = await listVehicleMedia(session.businessId, id, undefined, {
      locationIds: access.allowedLocationIds,
    });
    const canViewDocuments = await holdsPermission(session, PERMISSIONS.mediaView);
    return NextResponse.json({
      attachments: canViewDocuments ? attachments : attachments.filter((attachment) => attachment.mediaKind !== "document"),
    });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});

/** Links an existing, live asset in this tenant's Media Library. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesEdit);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const mediaError = await requireMediaAccess(session);
  if (mediaError) return mediaError;
  const { id } = await context.params;
  const { access, response } = await vehicleBranchContext(session, id, { mutation: true });
  if (response) return response;
  const body = await readBody(request);
  const mediaAssetId = typeof body.mediaAssetId === "string" ? body.mediaAssetId : "";
  const category = typeof body.category === "string" ? body.category : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!UUID.test(mediaAssetId)) return NextResponse.json({ error: "invalid_media_id" }, { status: 400 });
  if (!VEHICLE_MEDIA_CATEGORIES.includes(category as VehicleMediaCategory)) {
    return NextResponse.json({ error: "invalid_media_category" }, { status: 400 });
  }
  if (!title || title.length > 200) return NextResponse.json({ error: "invalid_vehicle_media" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const attachment = await attachVehicleMedia(client, {
      businessId: session.businessId,
      locationId: access.activeLocationId!,
      serialId: id,
      mediaAssetId,
      category: category as VehicleMediaCategory,
      title,
      description: typeof body.description === "string" ? body.description : null,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, attachment }, { status: 201 });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});

/** Detaches the relationship only; the canonical library asset is untouched. */
export const DELETE = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesEdit);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;
  const mediaError = await requireMediaAccess(session);
  if (mediaError) return mediaError;
  const { id } = await context.params;
  const { access, response } = await vehicleBranchContext(session, id, { mutation: true });
  if (response) return response;
  const mediaAssetId = new URL(request.url).searchParams.get("mediaAssetId") ?? "";
  if (!UUID.test(mediaAssetId)) return NextResponse.json({ error: "invalid_media_id" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const detached = await detachVehicleMedia(client, {
      businessId: session.businessId,
      locationId: access.activeLocationId!,
      serialId: id,
      mediaAssetId,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, detached });
  } catch (err) {
    await client.query("ROLLBACK");
    return handleAutomotiveError(err);
  } finally {
    client.release();
  }
});
