import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { rechargeAgencyCosts } from "@/lib/agency-reimbursable-cost-service";
import { handleAgencyError } from "../../guard";
import { costActor, costErrorResponse, readRechargeBody } from "../../reimbursable-cost-guard";

/**
 * POST /api/agency/reimbursable-costs/recharge — bill a client back for money the
 * agency spent on their behalf (issue #1128 §D).
 *
 * **This route asks for two permissions, and both are load-bearing.** It creates a
 * sales invoice, so `ordersCreate` is the act it performs; it draws down the
 * reimbursable-cost register, so `financeExpensesManage` is where the money came from.
 * Either alone would be wrong: a member who can invoice but cannot see costs would
 * bill a client from a register they cannot read, and a member who can record costs
 * but cannot invoice would be able to raise a document. Two `requirePermission` calls
 * rather than one, because the house helper is a single-permission door and a
 * composite permission does not exist — inventing one here would have meant a second
 * way to ask for authority.
 *
 * It is a verb on the collection rather than a sub-resource, because a recharge is an
 * act across *several* costs that produces one invoice: there is no id to hang it on
 * and no per-cost resource to address.
 *
 * The response carries the invoice's id and number rather than the cost rows, because
 * the thing the member now needs is the document — where to print it, and what to send
 * the client.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;

  // Checked after, and separately, so a member who lacks the invoice permission is
  // told that first: it is the act this route performs, and naming the missing
  // authority that matters most is more useful than whichever check ran first.
  const expenses = await requirePermission(PERMISSIONS.financeExpensesManage);
  if (expenses.error) return expenses.error;

  const parsed = await readRechargeBody(request);
  if (!parsed) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    const recharge = await rechargeAgencyCosts(session.businessId, costActor(session), {
      costIds: parsed.costIds,
      tenders: Array.isArray(parsed.tenders) ? parsed.tenders : undefined,
      locationId: parsed.locationId,
      note: parsed.note,
    });
    return NextResponse.json({ recharge }, { status: 201 });
  } catch (err) {
    // The cost guard answers for its own codes and for the SQL states the recharge
    // triggers raise, then falls through to the shared agency guard — which is what
    // knows that a missing ledger account is a 409 rather than a crash. The order is
    // load-bearing: `handleAgencyError` is the wider net and would swallow the more
    // specific answer.
    const handled = costErrorResponse(err);
    if (handled) return handled;
    return handleAgencyError(err);
  }
});
