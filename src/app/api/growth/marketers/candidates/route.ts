import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { actionableLocationIds } from "@/lib/authorize";
import { listRosterCandidates } from "@/lib/marketing-roster-service";

export const GET = withTenantScope(async () => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketersManage);
  if (error) return error;
  const locations = await actionableLocationIds(membership);
  return NextResponse.json(await listRosterCandidates(session.businessId, locations));
});
