import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getArAging } from "@/lib/ar-service";
import { isValidIsoDate } from "@/lib/iso-date";

/** Standard 30/60/90-day AR aging as of ?asOfDate= (defaults to today). */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const asOfParam = request.nextUrl.searchParams.get("asOfDate");
  if (asOfParam !== null && asOfParam !== "" && !isValidIsoDate(asOfParam)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  return NextResponse.json(await getArAging(session.businessId, asOfParam || undefined));
});
