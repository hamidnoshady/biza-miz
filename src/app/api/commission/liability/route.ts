import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { commissionErrorResponse } from "@/lib/commission-settlement-http";
import { getCommissionLiability } from "@/lib/commission-settlement-service";

/**
 * The 2300 tie-out for commission: the ledger balance against what is still owed, and the accrual sub-ledger
 * against the paid and unpaid positions. Both differences are zero on a healthy business. Gated on `commission.view`.
 */
export const GET = withTenantScope(async (_request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.commissionView);
  if (error) return error;

  try {
    return NextResponse.json({ tieOut: await getCommissionLiability(session.businessId) });
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
