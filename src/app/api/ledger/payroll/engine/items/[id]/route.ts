import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { endItem, listItemChanges } from "@/lib/payroll-engine-setup";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** A recurring item's actor/time-stamped before/after history. `payroll.view`. */
export const GET = withTenantScope(async (_request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  const { id } = await ctx.params;
  return NextResponse.json({ changes: await listItemChanges(session.businessId, id) });
});

/** Ends a recurring item on `effectiveTo`; the row is kept as history. `payroll.manage`. */
export const PATCH = withTenantScope(async (request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ item: await endItem({ businessId: session.businessId, actorId: session.sub, itemId: id, effectiveTo: body.effectiveTo }) });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
