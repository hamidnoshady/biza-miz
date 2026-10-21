import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse, actionableLocationIds } from "@/lib/authorize";
import { listWarehouseDocumentCreators } from "@/lib/warehouse-document-register";

/**
 * Who has posted a document in the branches this member may read — the
 * register's creator filter options (#923 P2).
 *
 * Same branch rule as the register itself: with no `locationId` the options
 * come from the permitted set, and a named branch is authorized before its
 * actors are listed (a forbidden branch must not leak that it has any).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const { session, membership } = guard;

  const locationId = new URL(request.url).searchParams.get("locationId");
  let locationIds: string[];
  if (locationId !== null && locationId !== "") {
    if (!isUuid(locationId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const decision = await authorize(session, { locationId });
    if (!decision.ok) return denialResponse(decision);
    locationIds = [locationId];
  } else {
    locationIds = await actionableLocationIds(membership);
  }

  const creators = await listWarehouseDocumentCreators(session.businessId, locationIds, "retail");
  return NextResponse.json({ creators });
});
