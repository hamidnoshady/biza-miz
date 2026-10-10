import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listStaffWages } from "@/lib/payroll-service";

/**
 * Wages are compensation data. Reading them needs `payroll.view` — a capability
 * of its own, deliberately not borrowed from the ledger keys a manager holds, so
 * a member without it neither sees nor sets what a colleague earns. (The owner
 * and the admin preset hold it by default, as does the accountant preset; any
 * member can be granted or refused it individually.) Amounts are integer Rial
 * as text.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;

  const staff = await listStaffWages(session.businessId);
  return NextResponse.json({ staff });
});
