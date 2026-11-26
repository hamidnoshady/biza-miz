import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { productionReport } from "@/lib/fashion-production-service";
import { productionFailure, productionScope } from "@/lib/fashion-production-http";

/** GH #1567 6B — production summary (units, scrap, unit cost, WIP) and the WIP subledger ↔ GL 1310 reconciliation. */
export const GET = withTenantScope(async () => {
  const scope = await productionScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  try {
    return NextResponse.json({ report: await productionReport(scope.actor, scope.locationId) });
  } catch (error) {
    return productionFailure(error);
  }
});
