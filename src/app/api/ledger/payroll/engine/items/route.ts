import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { addItem, listItems } from "@/lib/payroll-engine-setup";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

/** Issue #865 — recurring allowances / deductions / benefits (`?userId=` to filter). `payroll.view`. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  return NextResponse.json({ items: await listItems(session.businessId, request.nextUrl.searchParams.get("userId") ?? undefined) });
});

/** Adds a recurring item (`userId`, `componentId`, `amount`, `effectiveFrom`, `effectiveTo?`, `note?`). `payroll.manage`. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  try {
    return NextResponse.json({ item: await addItem({ businessId: session.businessId, actorId: session.sub, body }) }, { status: 201 });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
