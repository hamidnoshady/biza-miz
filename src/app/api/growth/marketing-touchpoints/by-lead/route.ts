import { NextRequest, NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { listMarketingTouchesForLead } from "@/lib/marketing-touchpoints-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermissions(PERMISSIONS.marketingAttributionView, PERMISSIONS.crmView, PERMISSIONS.crmManage);
  if (error) return error;
  const leadId = request.nextUrl.searchParams.get("leadId");
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  if (!isUuid(leadId) || !Number.isSafeInteger(page) || page < 1 || page > 10000) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json(await listMarketingTouchesForLead(session.businessId, await actionableLocationIds(membership), leadId, page));
});
