import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getSummaryVoucher } from "@/lib/voucher-numbering-service";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One summary voucher with its source list (issue #867 report "summary
 * voucher detail"): the scope, the totals, and every source entry with its
 * own number and totals at generation time — the trace back to the
 * underlying journals the voucher aggregates.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "summary_voucher_not_found" }, { status: 404 });
  const result = await getSummaryVoucher(session.businessId, id);
  if (!result) return NextResponse.json({ error: "summary_voucher_not_found" }, { status: 404 });
  return NextResponse.json(result);
});
