import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { isAssignmentPriority, parseAssignmentPlanFilter } from "@/lib/marketing-operations";
import { listOwnAssignments } from "@/lib/marketing-operations-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketingAssignmentsSelf);
  if (error) return error;
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  const priority = request.nextUrl.searchParams.get("priority");
  const plan = parseAssignmentPlanFilter(request.nextUrl.searchParams);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || q.length > 150 || (priority !== null && !isAssignmentPriority(priority)) || !plan) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json(await listOwnAssignments(session.businessId, session.sub, await actionableLocationIds(membership), q, page, priority, plan));
});
