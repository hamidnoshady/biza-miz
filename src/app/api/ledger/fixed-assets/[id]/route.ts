import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  FixedAssetError,
  deleteFixedAsset,
  getFixedAssetWithDepreciation,
  setFixedAssetAcquisition,
  updateFixedAssetDimensions,
} from "@/lib/fixed-assets-service";
import { parseLineDimensions } from "@/lib/accounting-dimensions";
import { AccountingDimensionError } from "@/lib/accounting-dimensions-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Returns the asset and its history — depreciation entries cursor-paginated
 * (`depreciationLimit`, `depreciationCursor` for «load more»), transfers and
 * estimate changes complete. A malformed id is the same 404 as an unknown
 * one, never a raw database error.
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "fixed_asset_not_found" }, { status: 404 });
  const limitParam = Number(request.nextUrl.searchParams.get("depreciationLimit"));
  try {
    const data = await getFixedAssetWithDepreciation(session.businessId, id, {
      depreciationCursor: request.nextUrl.searchParams.get("depreciationCursor"),
      depreciationLimit: Number.isInteger(limitParam) && limitParam > 0 ? limitParam : null,
    });
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

/** Hard delete — only ever succeeds for an asset with no depreciation posted yet. */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "fixed_asset_not_found" }, { status: 404 });
  try {
    await deleteFixedAsset(session.businessId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

/**
 * Updates an asset. Two distinct patches, both of which are post-hoc metadata
 * and neither of which rewrites posted history:
 *
 *   - `acquisitionSource` / `acquisitionEntryId` ties the asset to a posted
 *     purchase entry (existing behaviour).
 *   - `dimensions` changes the DEFAULT attribution future automatic postings
 *     (depreciation, disposal) will carry. Prospective only: already-posted
 *     entries are not rewritten.
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "fixed_asset_not_found" }, { status: 404 });
  let body: {
    acquisitionSource?: string;
    acquisitionEntryId?: string | null;
    /** Default dimensions forward — `null` or `{}` clears them. */
    dimensions?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  try {
    // If the caller sent `dimensions`, update defaults; acquisition-link fields
    // may be sent alongside. Both are metadata; neither posts anything.
    if ("dimensions" in body) {
      const parsed = parseLineDimensions(body.dimensions);
      if (!parsed.ok) return NextResponse.json({ error: "invalid_dimension" }, { status: 400 });
      await updateFixedAssetDimensions({
        businessId: session.businessId,
        fixedAssetId: id,
        dimensions: parsed.value,
      });
    }
    if ("acquisitionSource" in body || "acquisitionEntryId" in body) {
      await setFixedAssetAcquisition({
        businessId: session.businessId,
        fixedAssetId: id,
        acquisitionSource: String(body.acquisitionSource ?? ""),
        acquisitionEntryId: body.acquisitionEntryId ?? null,
      });
    }
    const data = await getFixedAssetWithDepreciation(session.businessId, id);
    return NextResponse.json({ fixedAsset: data.fixedAsset });
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof AccountingDimensionError) return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    throw err;
  }
});
