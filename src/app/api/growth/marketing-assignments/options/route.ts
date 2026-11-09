import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { assignmentOptions } from "@/lib/marketing-operations-service";
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketingAssignmentsManage);
  if (error) return error;
  const params = request.nextUrl.searchParams;
  const location = params.get("location") || null;
  const targetSearch = (params.get("targetQ") ?? "").trim(), agentSearch = (params.get("agentQ") ?? "").trim();
  const targetPage = Number(params.get("targetPage") ?? 1), agentPage = Number(params.get("agentPage") ?? 1);
  if ((location && !isUuid(location)) || targetSearch.length > 150 || agentSearch.length > 150 || !Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > 10000 || !Number.isSafeInteger(agentPage) || agentPage < 1 || agentPage > 10000) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json(await assignmentOptions(session.businessId, await actionableLocationIds(membership), location, targetSearch, targetPage, agentSearch, agentPage));
});
