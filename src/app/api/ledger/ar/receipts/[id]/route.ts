import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getReceiptDetail } from "@/lib/ar-service";

/** One receipt voucher with its drill-down: party, settlement account, journal entry, reversal. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const { id } = await ctx.params;
  const receipt = await getReceiptDetail(session.businessId, id);
  if (!receipt) return NextResponse.json({ error: "receipt_not_found" }, { status: 404 });
  return NextResponse.json({ receipt });
});
