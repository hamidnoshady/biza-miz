import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  FixedAssetError,
  createFixedAsset,
  getFixedAssetReconciliation,
  listFixedAssets,
  type FixedAssetAcquisitionSource,
} from "@/lib/fixed-assets-service";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const [fixedAssets, reconciliation] = await Promise.all([
    listFixedAssets(session.businessId),
    getFixedAssetReconciliation(session.businessId),
  ]);
  return NextResponse.json({ fixedAssets, reconciliation });
});

/** Registers a fixed asset — no posting yet; depreciation is posted separately, per period, via .../[id]/depreciate. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  let body: {
    name?: string;
    acquisitionDate?: string;
    inServiceDate?: string | null;
    acquisitionSource?: string;
    acquisitionEntryId?: string | null;
    cost?: number;
    salvageValue?: number;
    usefulLifeMonths?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const fixedAsset = await createFixedAsset({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      name: String(body.name ?? ""),
      acquisitionDate: String(body.acquisitionDate ?? ""),
      inServiceDate: typeof body.inServiceDate === "string" ? body.inServiceDate : null,
      acquisitionSource: body.acquisitionSource as FixedAssetAcquisitionSource | undefined,
      acquisitionEntryId: typeof body.acquisitionEntryId === "string" ? body.acquisitionEntryId : null,
      cost: Number(body.cost),
      salvageValue: Number(body.salvageValue ?? 0),
      usefulLifeMonths: Number(body.usefulLifeMonths),
      createdBy: session.sub,
    });
    return NextResponse.json({ fixedAsset }, { status: 201 });
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
