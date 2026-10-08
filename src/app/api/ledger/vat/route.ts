import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getVatReport } from "@/lib/reports-service";

/**
 * Output vs input VAT and the net payable position for a period. Output VAT
 * reads vatPayable (auto-posted on every order); input VAT reads
 * vatReceivable, which a received purchase debits with its supplier invoice's
 * VAT (audit F11) and a manual journal entry may also post to (see
 * getVatReport's doc comment in reports-service.ts).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("dateFrom") ?? undefined;
  const dateTo = searchParams.get("dateTo") ?? undefined;

  const report = await getVatReport(session.businessId, { dateFrom, dateTo });
  return NextResponse.json({ report });
});
