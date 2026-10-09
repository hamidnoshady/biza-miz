import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse } from "@/lib/accounting-http";
import { voucherAuditTrail } from "@/lib/voucher-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Every renumbering and reference change made to one document, oldest first. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ audit: await voucherAuditTrail(session.businessId, id) });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
