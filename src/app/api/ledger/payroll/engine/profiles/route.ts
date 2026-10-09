import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listProfiles } from "@/lib/payroll-engine-setup";

/** Issue #865 — every active team member with their payroll profile (defaults when none is set). `payroll.view`. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  return NextResponse.json({ profiles: await listProfiles(session.businessId) });
});
