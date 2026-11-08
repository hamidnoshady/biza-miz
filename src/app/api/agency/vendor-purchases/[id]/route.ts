import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { bookVendorPurchase, submitVendorPurchase } from "@/lib/agency-vendor-purchase-service";
import { PERMISSIONS, agencyOwner, handleAgencyError, readBody } from "../../guard";
import { vendorPurchaseErrorResponse } from "../../vendor-purchase-guard";

/** Approval happens only in the shared queue, never through a purchase action. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { owner, error } = await agencyOwner(PERMISSIONS.workspaceManage, request);
  if (error) return error;
  const { id } = await context.params;
  try {
    const body = await readBody(request);
    if (body.action === "submit") {
      await submitVendorPurchase(owner, id);
      return NextResponse.json({ submitted: true });
    }
    if (body.action === "book") {
      const finance = await requirePermission(PERMISSIONS.financeExpensesManage);
      if (finance.error) return finance.error;
      return NextResponse.json(await bookVendorPurchase(owner, id, body.spentOn));
    }
    return NextResponse.json({ error: "invalid_purchase" }, { status: 400 });
  } catch (err) { return vendorPurchaseErrorResponse(err) ?? handleAgencyError(err); }
});
