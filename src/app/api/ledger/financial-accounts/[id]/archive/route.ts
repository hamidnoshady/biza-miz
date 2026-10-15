import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { archiveFinancialAccount } from "@/lib/financial-accounts-service";
import { financialErrorResponse, MalformedBodyError, readJsonObjectBody } from "../../../financial/support";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Retire an account (بایگانی) — the only way to take one out of the register.
 *
 * The service refuses while the account holds money: a container with a non-zero
 * ledger balance that disappears from every list is money nobody is watching,
 * and the whole point of issue #862 is that balances come from the ledger and are
 * always visible. The refusal names what to do instead (move the balance out with
 * a transfer, or post the correcting entry).
 *
 * The optional `reason` is stored as the audit row's payload — a register of
 * archived containers with no record of *why* is a register nobody can review.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAccountsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "financial_account_not_found" }, { status: 404 });

  let body: { reason?: unknown; idempotencyKey?: unknown } = {};
  try {
    body = (await readJsonObjectBody(request)) as typeof body;
  } catch (err) {
    if (err instanceof MalformedBodyError) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    throw err;
  }
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await archiveFinancialAccount({
      businessId: session.businessId,
      accountId: id,
      actorId: session.sub,
      reason: (body.reason as string | undefined) ?? null,
    });
    return NextResponse.json(result);
  } catch (err) {
    return financialErrorResponse(err);
  }
});
