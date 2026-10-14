import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  FixedAssetError,
  deleteFixedAsset,
  getFixedAssetWithDepreciation,
  setFixedAssetAcquisition,
} from "@/lib/fixed-assets-service";

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

/** Records where the asset's cost sits in the books (a posted entry, the opening balance, or not yet known). Posts nothing. */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "fixed_asset_not_found" }, { status: 404 });
  let body: { acquisitionSource?: string; acquisitionEntryId?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  try {
    const fixedAsset = await setFixedAssetAcquisition({
      businessId: session.businessId,
      fixedAssetId: id,
      acquisitionSource: String(body.acquisitionSource ?? ""),
      acquisitionEntryId: body.acquisitionEntryId ?? null,
    });
    return NextResponse.json({ fixedAsset });
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
