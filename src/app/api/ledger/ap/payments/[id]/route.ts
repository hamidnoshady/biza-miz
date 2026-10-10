import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPaymentDetail } from "@/lib/ap-service";

/** One payment voucher with its drill-down: supplier, settlement account, journal entry, reversal. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const { id } = await ctx.params;
  const payment = await getPaymentDetail(session.businessId, id);
  if (!payment) return NextResponse.json({ error: "payment_not_found" }, { status: 404 });
  return NextResponse.json({ payment });
});
