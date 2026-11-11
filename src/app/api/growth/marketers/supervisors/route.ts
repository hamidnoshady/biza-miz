import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { listSupervisorCandidates } from "@/lib/marketing-roster-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketersManage);
  if (error) return error;
  const params = request.nextUrl.searchParams;
  const locationId = params.get("locationId"); const search = (params.get("q") ?? "").trim();
  const page = Number(params.get("page") ?? 1);
  if (!isUuid(locationId) || search.length > 150 || !Number.isSafeInteger(page) || page < 1 || page > 10000) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json(await listSupervisorCandidates(session.businessId, await actionableLocationIds(membership), locationId, search, page));
});
