import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getEngineRun, listPayslips, updateEngineRunInputs } from "@/lib/payroll-engine-runs";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One run with its payslips. `payroll.view`. */
export const GET = withTenantScope(async (_request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  const { id } = await ctx.params;
  const run = await getEngineRun(session.businessId, id);
  if (!run) return NextResponse.json({ error: "run_not_found" }, { status: 404 });
  return NextResponse.json({ run, payslips: await listPayslips(session.businessId, id) });
});

/** Replaces a not-yet-approved run's inputs; it returns to draft. `payroll.manage`. */
export const PATCH = withTenantScope(async (request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  const { id } = await ctx.params;
  try {
    const run = await updateEngineRunInputs({ businessId: session.businessId, runId: id, inputs: body.inputs, includeCommission: body.includeCommission, note: body.note });
    return NextResponse.json({ run });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
