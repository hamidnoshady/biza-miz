import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { previewOpeningImport } from "@/lib/opening-balances-service";

/**
 * Import preview (issue #867: "import/preview"): the same validation the
 * create endpoint applies, answered as a preview — totals, per-account
 * grouping, the first problem found — with nothing persisted. The screen
 * shows it and only sends a real create when the accountant confirms.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  let body: { fiscalYearLabel?: string; effectiveDate?: string | null; lines?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  return NextResponse.json(
    await previewOpeningImport({
      businessId: session.businessId,
      fiscalYearLabel: body.fiscalYearLabel ?? "",
      effectiveDate: body.effectiveDate,
      lines: body.lines,
    }),
  );
});
