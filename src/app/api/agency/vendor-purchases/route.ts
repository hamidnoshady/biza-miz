import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { createVendorPurchase, listVendorPurchases } from "@/lib/agency-vendor-purchase-service";
import { PERMISSIONS, agencyOwner, handleAgencyError, readBody } from "../guard";
import { vendorPurchaseErrorResponse } from "../vendor-purchase-guard";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await agencyOwner(PERMISSIONS.workspaceView, request);
  if (error) return error;
  try {
    return NextResponse.json({ purchases: await listVendorPurchases(owner, request.nextUrl.searchParams.get("projectId") ?? "") });
  } catch (err) { return vendorPurchaseErrorResponse(err) ?? handleAgencyError(err); }
});
export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await agencyOwner(PERMISSIONS.workspaceManage, request);
  if (error) return error;
  const directory = await requirePermission(PERMISSIONS.partiesView);
  if (directory.error) return directory.error;
  try {
    return NextResponse.json({ purchase: await createVendorPurchase(owner, await readBody(request)) }, { status: 201 });
  } catch (err) { return vendorPurchaseErrorResponse(err) ?? handleAgencyError(err); }
});
