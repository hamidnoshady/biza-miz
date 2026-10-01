import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { staffCommissionReport } from "@/lib/commission-service";

/** A UI date-picker value is always YYYY-MM-DD; anything else is a malformed query string, not a filter. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The per-staff commission leaderboard — Σ signed accruals per employee. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.commissionView);
  if (error) return error;

  const from = request.nextUrl.searchParams.get("from");
  const to = request.nextUrl.searchParams.get("to");
  // An invalid date would otherwise reach Postgres as a $::date cast and
  // surface as a bare 500 instead of a readable 400.
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (from && to && from > to) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }

  return NextResponse.json({
    report: await staffCommissionReport(session.businessId, { from: from || null, to: to || null }),
  });
});
