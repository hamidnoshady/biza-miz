import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listComponents, saveComponent } from "@/lib/payroll-engine-setup";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

/** Issue #865 — the payroll component catalogue (seeded with the defaults on first read). `payroll.view`. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  return NextResponse.json({ components: await listComponents(session.businessId) });
});

/** Adds a business-defined earning or deduction component. `payroll.manage`. */
export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  try {
    return NextResponse.json({ component: await saveComponent({ businessId: session.businessId, actorId: session.sub, body }) }, { status: 201 });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
