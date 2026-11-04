import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { targetLocations } from "@/lib/marketing-operations-service";
export const GET = withTenantScope(async () => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketingTargetsManage);
  if (error) return error;
  return NextResponse.json({ locations: await targetLocations(session.businessId, await actionableLocationIds(membership)) });
});
