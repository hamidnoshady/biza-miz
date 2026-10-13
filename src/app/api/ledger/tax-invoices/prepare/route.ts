import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prepareSales } from "@/lib/tax-invoice-service";
import { readJsonBody, stringArray, taxErrorResponse } from "@/lib/tax-invoice-http";

/**
 * Batch preparation: turn completed sales into prepared records. Nothing leaves
 * the building here; each result says prepared, already prepared, or the reasons
 * it cannot be (a missing item code, an unset memory id, a disabled profile).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxPrepare);
  if (error) return error;
  const body = await readJsonBody<{ orderIds?: unknown }>(request);
  const orderIds = stringArray(body?.orderIds, 50);
  if (!orderIds) return NextResponse.json({ error: "order_ids_required" }, { status: 400 });
  try {
    const results = await prepareSales({ businessId: session.businessId, userId: session.sub }, orderIds);
    return NextResponse.json({ results });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
