import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  createAgencyReimbursableCost,
  listAgencyReimbursableCosts,
  type AgencyReimbursableCostFilters,
} from "@/lib/agency-reimbursable-cost-service";
import { handleAgencyError } from "../guard";
import { costActor, costErrorResponse, readCostBody } from "../reimbursable-cost-guard";

/**
 * Money an agency spent on a client's behalf (issue #1128 §D).
 *
 * ## The permissions are an expense's, not a workspace document's
 *
 * Reading is `ledger.view` and writing is `finance.expenses_manage` — the same pair
 * `POST /api/ledger/expenses` uses, and the reason is that this *is* an expense in
 * every respect but the account it lands in: it posts a balanced entry through the
 * same engine, and the difference between it and an ordinary expense is whether the
 * debit reaches 5197 (the agency's own cost of sale) or 1270 (a claim on a client).
 * That is an accounting distinction, so it rides an accounting permission.
 *
 * The sibling agency registers ride `workspace.view` / `workspace.manage` instead,
 * and deliberately so: a milestone is a schedule a project member writes. Routing
 * this one through `agencyOwner` would have added the workspace's service-activation
 * gate, and the member who records what a client's media buy cost is the office's
 * accountant as often as it is the project lead — gating them behind workspace
 * activation would hand a 403 to the one person whose job it is.
 *
 * The industry gate is separate and lives in the service: `assertAgency` refuses
 * another trade rather than defaulting it, because a café has no reimbursable client
 * cost and must not be served a register that silently means something else.
 *
 * Nothing here chooses the presentation. `presentation` arrives in the body and is
 * stored as given — §D's rule is that gross-versus-net "must not be inferred solely
 * from spend", and a route that guessed it from the size of a line or the presence of
 * a vendor name would be exactly the inference the issue forbids.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const partyId = search.get("partyId");
  const projectId = search.get("projectId");
  const posted = search.get("posted");
  const limitRaw = Number(search.get("limit") ?? "");
  const filters: AgencyReimbursableCostFilters = {
    q: search.get("q") ?? undefined,
    partyId: partyId && isUuid(partyId) ? partyId : null,
    projectId: projectId && isUuid(projectId) ? projectId : null,
    presentation: search.get("presentation"),
    // The queue a member works through: costs recorded while the ledger was locked
    // and routed to approval, which are the ones with no entry yet.
    posted: posted === null ? null : posted === "1" || posted === "true",
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
  };

  try {
    return NextResponse.json({
      costs: await listAgencyReimbursableCosts(session.businessId, filters),
    });
  } catch (err) {
    const response = costErrorResponse(err);
    if (response) return response;
    return handleAgencyError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeExpensesManage);
  if (error) return error;

  const body = await readCostBody(request);
  if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const cost = await createAgencyReimbursableCost(
      session.businessId,
      costActor(session),
      body,
    );
    return NextResponse.json({ cost }, { status: 201 });
  } catch (err) {
    const response = costErrorResponse(err);
    if (response) return response;
    return handleAgencyError(err);
  }
});
