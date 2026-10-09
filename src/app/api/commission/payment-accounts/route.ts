import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { commissionErrorResponse } from "@/lib/commission-settlement-http";
import { listCommissionPaymentAccounts } from "@/lib/commission-settlement-service";

/**
 * The accounts a payout may leave: the business's cash, bank and petty-cash accounts. Gated on
 * `commission.payout`, the only permission that uses them.
 */
export const GET = withTenantScope(async (_request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.commissionPayout);
  if (error) return error;

  try {
    return NextResponse.json({ accounts: await listCommissionPaymentAccounts(session.businessId) });
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
