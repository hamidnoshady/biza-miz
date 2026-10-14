import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { VOUCHER_DOCUMENT_TYPES } from "@/lib/voucher-numbering";
import { VoucherError, voucherGapReport } from "@/lib/voucher-numbering-service";

/**
 * The numbering gap report (issue #867 report "numbering gap report"): per
 * book and fiscal year, which sequence numbers were never used — a rolled-back
 * posting or a deliberate renumber, named, in order, against the counter's
 * own maximum.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const fiscalYearLabel = params.get("fiscalYearLabel") ?? "";
  const documentType = params.get("documentType") ?? "";
  if (!VOUCHER_DOCUMENT_TYPES.includes(documentType as never)) {
    return NextResponse.json({ error: "unknown_document_type" }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await voucherGapReport(session.businessId, {
        fiscalYearLabel,
        documentType: documentType as (typeof VOUCHER_DOCUMENT_TYPES)[number],
      }),
    );
  } catch (err) {
    if (err instanceof VoucherError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
