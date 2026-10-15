import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { shareholderActorOf, shareholderErrorResponse } from "@/lib/shareholder-http";
import { getShareholderDistributionDetail } from "@/lib/shareholder-read-service";

/** Independently authorized, tenant-scoped reader for any explicitly selected distribution. */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ distributionId: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.shareholdersView);
  if (error) return error;
  try {
    const { distributionId } = await context.params;
    const detail = await getShareholderDistributionDetail(
      session.businessId,
      shareholderActorOf(session, membership),
      distributionId,
    );
    if (!detail) return NextResponse.json({ error: "distribution_not_found" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (caught) {
    const response = shareholderErrorResponse(caught);
    if (response) return response;
    throw caught;
  }
});
