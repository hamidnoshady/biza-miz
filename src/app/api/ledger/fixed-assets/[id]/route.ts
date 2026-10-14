import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  FixedAssetError,
  deleteFixedAsset,
  getFixedAssetWithDepreciation,
  updateFixedAsset,
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
 * Atomic metadata patch (issue #868). Both `acquisitionSource`/`acquisitionEntryId`
 * and `dimensions` are metadata and neither rewrites posted history; they apply
 * under one lock and one transaction so a request that sets both cannot leave
 * the asset half-updated on a failure. Dimension defaults apply prospectively —
 * future depreciation/disposal months carry them; already-posted rows are not
 * rewritten.
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "fixed_asset_not_found" }, { status: 404 });
  let body: {
    acquisitionSource?: unknown;
    acquisitionEntryId?: unknown;
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
  const setDimensions = "dimensions" in body;
  const setAcquisition = "acquisitionSource" in body || "acquisitionEntryId" in body;
  if (!setDimensions && !setAcquisition) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  let parsedDims: ReturnType<typeof parseLineDimensions> | null = null;
  if (setDimensions) {
    parsedDims = parseLineDimensions(body.dimensions);
    if (!parsedDims.ok) return NextResponse.json({ error: "invalid_dimension" }, { status: 400 });
  }
  try {
    const fixedAsset = await updateFixedAsset({
      businessId: session.businessId,
      fixedAssetId: id,
      setDimensions,
      dimensions: parsedDims?.value ?? {},
      setAcquisition,
      acquisitionSource: typeof body.acquisitionSource === "string" ? body.acquisitionSource : "",
      acquisitionEntryId: typeof body.acquisitionEntryId === "string" ? body.acquisitionEntryId : null,
    });
    return NextResponse.json({ fixedAsset });
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof AccountingDimensionError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
});
