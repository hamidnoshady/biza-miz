import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listComponentChanges, saveComponent } from "@/lib/payroll-engine-setup";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** A component's audit history (before/after of every change). `payroll.view`. */
export const GET = withTenantScope(async (_request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  const { id } = await ctx.params;
  return NextResponse.json({ changes: await listComponentChanges(session.businessId, id) });
});

/** Edits a component (name, taxable/insurable flags, accounts, effective window). Audited. `payroll.manage`. */
export const PATCH = withTenantScope(async (request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ component: await saveComponent({ businessId: session.businessId, actorId: session.sub, id, body }) });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
