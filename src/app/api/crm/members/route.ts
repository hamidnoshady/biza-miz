import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listAssignableMembers } from "@/lib/crm-ownership";

/**
 * The members a CRM row may be assigned to.
 *
 * ## Why this is not `GET /api/team`
 *
 * The team screen's endpoint requires `team.view`/`team.manage`, which a sales
 * manager working the pipeline need not hold — and it returns permissions,
 * branch assignments and contact details, none of which an assignee picker
 * needs. A picker that asked for the wider key would either refuse the people
 * who use the pipeline most, or hand them a second, weaker copy of the team
 * screen. So the CRM has its own read, under `crm.view`, returning id, name,
 * role and activity state.
 *
 * Inactive members are **included** on purpose: reassignment begins by seeing
 * who holds what, and a picker that hid a departed colleague's name would leave
 * their customers looking unowned rather than mis-owned.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  return NextResponse.json({ members: await listAssignableMembers(session.businessId) });
});
