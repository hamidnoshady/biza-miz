import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  approveEngineRun,
  calculateEngineRun,
  cancelEngineRun,
  closeEngineRun,
  payEngineRun,
  postEngineRun,
  reviewEngineRun,
} from "@/lib/payroll-engine-runs";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ id: string; action: string }>;
}

const SIMPLE = {
  calculate: calculateEngineRun,
  review: reviewEngineRun,
  approve: approveEngineRun,
  post: postEngineRun,
  close: closeEngineRun,
  cancel: cancelEngineRun,
} as const;

/**
 * Moves a run along draft → calculate → review → approve → post → pay → close
 * (or cancels it before approval). `pay` takes `paidDate?`, `method?`
 * (`cash` | `bank`) and `paymentAccountId?`. `payroll.manage`.
 */
export const POST = withTenantScope(async (request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;
  const { id, action } = await ctx.params;
  try {
    if (action === "pay") {
      const body = await readJsonObject(request, { emptyIsObject: true });
      if (!body) return badRequest();
      const run = await payEngineRun({
        businessId: session.businessId,
        runId: id,
        actorId: session.sub,
        paidDate: body.paidDate,
        method: body.method,
        paymentAccountId: body.paymentAccountId,
      });
      return NextResponse.json({ run });
    }
    if (!(action in SIMPLE)) return NextResponse.json({ error: "unknown_action" }, { status: 404 });
    const run = await SIMPLE[action as keyof typeof SIMPLE]({ businessId: session.businessId, runId: id, actorId: session.sub });
    return NextResponse.json({ run });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
