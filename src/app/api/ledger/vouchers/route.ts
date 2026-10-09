import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { accountingErrorResponse } from "@/lib/accounting-http";
import { listVoucherRegister } from "@/lib/voucher-service";

/**
 * The voucher register: every document by its number, date and source.
 * Filters: `voucherYear`, `dateFrom`/`dateTo` (ISO), `sourceType`, `q`, `limit`.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const sp = request.nextUrl.searchParams;
  const yearRaw = sp.get("voucherYear");
  const limitRaw = sp.get("limit");
  try {
    const vouchers = await listVoucherRegister(session.businessId, {
      voucherYear: yearRaw === null || yearRaw === "" ? null : Number(yearRaw),
      dateFrom: sp.get("dateFrom"),
      dateTo: sp.get("dateTo"),
      sourceType: sp.get("sourceType"),
      q: sp.get("q"),
      limit: limitRaw === null || limitRaw === "" ? null : Number(limitRaw),
    });
    return NextResponse.json({ vouchers });
  } catch (err) {
    const response = accountingErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
