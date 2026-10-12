import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidIsoDate } from "@/lib/iso-date";
import { getApAging } from "@/lib/ap-service";

/**
 * Standard 30/60/90-day AP aging as of ?asOfDate= (defaults to today) — the
 * mirror of the A/R aging route, through the same calendar-aware validator:
 * the local regex + `Date.parse` pair it used to carry accepted «2026-02-30»,
 * which JavaScript normalises to March 2nd.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const asOfParam = request.nextUrl.searchParams.get("asOfDate");
  if (asOfParam !== null && asOfParam !== "" && !isValidIsoDate(asOfParam)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  return NextResponse.json(await getApAging(session.businessId, asOfParam || undefined));
});
