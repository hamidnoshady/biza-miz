import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidIsoDate } from "@/lib/iso-date";
import { getArAging } from "@/lib/ar-service";

/**
 * Standard 30/60/90-day AR aging as of ?asOfDate= (defaults to today).
 *
 * The date check is `isValidIsoDate` — the repo's one calendar-aware validator
 * — rather than a local regex. A shape-only test plus `Date.parse` accepted
 * «2026-02-30» (JS normalises it to March 2nd), so the report was computed for
 * a day nobody asked for while `getArAging` compared strings against the date
 * it was handed. Both layers now use the same helper, so the route and the
 * service cannot disagree about what a usable date is.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const asOfParam = request.nextUrl.searchParams.get("asOfDate");
  if (asOfParam !== null && asOfParam !== "" && !isValidIsoDate(asOfParam)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  return NextResponse.json(await getArAging(session.businessId, asOfParam || undefined));
});
