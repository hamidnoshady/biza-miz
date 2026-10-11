import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPayrollSettings, savePayrollSettings } from "@/lib/payroll-service";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

/**
 * The business's own payroll rates (audit F11): insurance shares, the
 * insurance ceiling, the monthly income-tax brackets and the exempt threshold.
 * Nothing statutory is assumed — an empty document applies no deduction.
 * Reading is `payroll.view`, saving `payroll.manage`, the same split as the
 * rest of payroll.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;

  const settings = await getPayrollSettings(session.businessId);
  return NextResponse.json({ settings });
});

/**
 * Saves the settings document. The body must be a JSON object — a body of `null`
 * used to parse as «nothing entered» and silently wiped every rate the business
 * had set.
 */
export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  const body = await readJsonObject(request);
  if (!body) return badRequest();

  try {
    const settings = await savePayrollSettings(session.businessId, body);
    return NextResponse.json({ settings });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
