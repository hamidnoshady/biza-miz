import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidIsoDate } from "@/lib/iso-date";
import { getArAging } from "@/lib/ar-service";

/**
 * A date parameter the report can actually use: `YYYY-MM-DD` and a real
 * calendar date. Anything else is a client bug, and answering it with an empty
 * report (the string compare in `getArAging` filters every line out) would look
 * like «هیچ بدهی بازی وجود ندارد» — a claim, not an error.
 *
 * The rule is `iso-date.ts`'s `isValidIsoDate`, shared with the other aging
 * route, bank reconciliation and «دفتر روزنامه» — the local copy this file
 * used to carry leaned on `Date.parse`, which reads `2026-02-31` as March.
 */

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
