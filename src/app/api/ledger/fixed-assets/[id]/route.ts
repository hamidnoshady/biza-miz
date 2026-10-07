import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  FixedAssetError,
  deleteFixedAsset,
  getFixedAssetWithDepreciation,
  setFixedAssetAcquisition,
} from "@/lib/fixed-assets-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Returns the asset and its full depreciation entry history. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    const data = await getFixedAssetWithDepreciation(session.businessId, id);
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
  let body: { acquisitionSource?: string; acquisitionEntryId?: string | null };
  try {
    body = await request.json();
  } catch {
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
