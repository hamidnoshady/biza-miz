import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { assignmentOptions } from "@/lib/marketing-operations-service";
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketingAssignmentsManage);
  if (error) return error;
  return NextResponse.json(await assignmentOptions(session.businessId, await actionableLocationIds(membership), request.nextUrl.searchParams.get("location")));
});
