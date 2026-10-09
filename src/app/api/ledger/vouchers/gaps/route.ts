import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse } from "@/lib/accounting-http";
import { numberingGapReport } from "@/lib/voucher-service";

/** Numbers the sequence issued for a fiscal year that no document now holds. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const yearRaw = request.nextUrl.searchParams.get("voucherYear") ?? "";
  try {
    return NextResponse.json(await numberingGapReport(session.businessId, Number(yearRaw)));
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
