import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPayrollSettings, PayrollError, savePayrollSettings } from "@/lib/payroll-service";

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

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const settings = await savePayrollSettings(session.businessId, body);
    return NextResponse.json({ settings });
  } catch (err) {
    if (err instanceof PayrollError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: err.status });
    }
    throw err;
  }
});
