import { NextRequest, NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { touchOptions } from "@/lib/marketing-touchpoints-service";
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermissions(PERMISSIONS.marketingAttributionManage, PERMISSIONS.crmView, PERMISSIONS.crmManage, PERMISSIONS.marketingAssignmentsView);
  if (error) return error;
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || q.length > 150) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json(await touchOptions(session.businessId, await actionableLocationIds(membership), q, page));
});
