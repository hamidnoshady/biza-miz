import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { actorOf, commissionErrorResponse } from "@/lib/commission-settlement-http";
import { badRequest, readJsonObject } from "@/lib/payroll-http";
import { parseVoidBody } from "@/lib/commission-settlement-input";
import { voidCommissionRun } from "@/lib/commission-settlement-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Void a run before any money has left. A reason is required and kept on the record. Its accruals and
 * carry-forwards are released. A draft or calculated run needs `commission.calculate`; a later one needs
 * `commission.approve` (the service decides which, by status).
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, membership, error } = await requireAnyPermission(PERMISSIONS.commissionCalculate, PERMISSIONS.commissionApprove);
  if (error) return error;

  const { id } = await ctx.params;
  const body = await readJsonObject(request, { emptyIsObject: true });
  if (!body) return badRequest();

  try {
    const run = await voidCommissionRun(session.businessId, actorOf(session, membership), id, parseVoidBody(body));
    return NextResponse.json({ run });
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
