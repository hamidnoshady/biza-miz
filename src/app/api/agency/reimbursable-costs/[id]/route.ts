import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  deleteAgencyReimbursableCost,
  loadAgencyReimbursableCost,
  updateAgencyReimbursableCost,
} from "@/lib/agency-reimbursable-cost-service";
import { handleAgencyError } from "../../guard";
import { costActor, costErrorResponse, readCostBody } from "../../reimbursable-cost-guard";

/**
 * One reimbursable client cost (issue #1128 §D).
 *
 * `GET` on `ledger.view`, `PATCH` and `DELETE` on `finance.expenses_manage` — see the
 * list route for why these are an expense's permissions rather than a workspace
 * document's.
 *
 * A posted row is frozen except for its note, and that is 0280's rule rather than this
 * route's: the amount, the presentation and the settlement decided which two accounts
 * the entry landed in, so editing one would leave the register stating something the
 * ledger contradicts. What a member learned afterwards desyncs nothing, so the note
 * stays open — and `PATCH` answers `cost_posted` (a 409) for everything else, which
 * tells the member the correction is a reversal and a new record.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "cost_not_found" }, { status: 404 });

    try {
      const cost = await loadAgencyReimbursableCost(session.businessId, id);
      if (!cost) return NextResponse.json({ error: "cost_not_found" }, { status: 404 });
      return NextResponse.json({ cost });
    } catch (err) {
      const response = costErrorResponse(err);
      if (response) return response;
      return handleAgencyError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.financeExpensesManage);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "cost_not_found" }, { status: 404 });

    const body = await readCostBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    try {
      const cost = await updateAgencyReimbursableCost(
        session.businessId,
        id,
        costActor(session),
        body,
      );
      return NextResponse.json({ cost });
    } catch (err) {
      const response = costErrorResponse(err);
      if (response) return response;
      return handleAgencyError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.financeExpensesManage);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "cost_not_found" }, { status: 404 });

    try {
      await deleteAgencyReimbursableCost(session.businessId, id);
      return NextResponse.json({ result: "deleted" });
    } catch (err) {
      const response = costErrorResponse(err);
      if (response) return response;
      return handleAgencyError(err);
    }
  },
);
