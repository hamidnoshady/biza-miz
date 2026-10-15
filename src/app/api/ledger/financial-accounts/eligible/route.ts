import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isFinancialAccountKind } from "@/lib/financial-accounts";
import { eligibleGlAccounts } from "@/lib/financial-accounts-service";
import { financialErrorResponse } from "../../financial/support";

/**
 * The chart accounts a financial account of this kind may be linked to.
 *
 * The rule is not "any asset": a bank account must be a bank-role GL account, a
 * cash box a cash one, a petty-cash box a petty-cash one, and a POS/PSP container
 * either a card-clearing account («وجوه در راه») or a bank. Candidates are also
 * postable (no children) and not already linked to another financial account —
 * which is the issue's "two financial accounts must never show the same shared
 * GL balance", enforced by *not offering* the second row rather than by refusing
 * it after the fact.
 *
 * `excludeId` is the account being edited, so a rename does not make its own GL
 * account disappear from its own picker.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAccountsManage);
  if (error) return error;

  const search = new URL(request.url).searchParams;
  const kind = search.get("kind");
  if (!kind || !isFinancialAccountKind(kind)) {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }

  try {
    const accounts = await eligibleGlAccounts(session.businessId, kind, {
      excludeAccountId: search.get("excludeId"),
    });
    return NextResponse.json({ accounts });
  } catch (err) {
    return financialErrorResponse(err);
  }
});
