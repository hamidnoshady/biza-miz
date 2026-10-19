import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getLedgerOverview } from "@/lib/ledger-reports-service";

/**
 * The Accounting app's dashboard, in one call.
 *
 * Read-only, like the trial balance it reports beside, and reading the same
 * `journal_lines` through the same helper (`ledger-reports-service.ts`), so the
 * dashboard cannot disagree with the books or with the trial balance.
 *
 * Owner/manager/accountant only: it is the ledger's own door.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const asOf = new URL(request.url).searchParams.get("asOf") ?? undefined;
  return NextResponse.json({ overview: await getLedgerOverview(session.businessId, { asOfDate: asOf }) });
});
