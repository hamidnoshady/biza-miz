import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { commissionErrorResponse } from "@/lib/commission-settlement-http";
import { getCommissionRun } from "@/lib/commission-settlement-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One run: its totals, the members it pays, its payouts, its audit trail and the
 * actions this person may take on it now (`actions`, computed from the run's
 * status and their own permissions). Gated on `commission.view`.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.commissionView);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    return NextResponse.json({ run: await getCommissionRun(session.businessId, id, membership.permissions) });
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
