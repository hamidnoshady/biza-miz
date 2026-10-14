import { NextRequest, NextResponse } from "next/server";
import { ensurePlatformCompany } from "@/lib/platform-company";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { deploymentRole } from "@/lib/deployment-role";
import { platformCompanyLog } from "@/lib/platform-company";

/**
 * Idempotent explicit initializer and repairer.
 *
 * Central cloud only, and only for an identity that holds `business.provision`
 * — provisioning a protected internal business is an infrastructure act, not a
 * company-operating one. A company member with no such capability never sees
 * this control.
 *
 * Re-running it is safe: the company is a singleton, the chart of accounts is
 * only seeded on first provision, and an existing member is left exactly as it
 * is. `repairMembership` reactivates a deactivated membership, and is only
 * honoured from this explicitly-guarded endpoint.
 */
export const POST = withPlatformScope(async (request: NextRequest): Promise<NextResponse> => {
  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "central_cloud_only" }, { status: 404 });
  }
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;
  let repairMembership = false;
  try {
    const body = (await request.json().catch(() => null)) as { repairMembership?: boolean } | null;
    repairMembership = body?.repairMembership === true;
  } catch {
    repairMembership = false;
  }
  try {
    const company = await ensurePlatformCompany(session, { repairInactiveMembership: repairMembership });
    await platformAudit({
      adminId: session.padmin,
      businessId: company?.business_id ?? null,
      action: "platform_company.ensure",
      entity: "business",
      entityId: company?.business_id ?? null,
      payload: { idempotent: true, repairMembership },
    });
    return NextResponse.json({ company });
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "setup_failed";
    const status =
      code === "forbidden" ? 403 : code === "central_cloud_only" ? 404 : code === "platform_admin_not_active" ? 401 : 500;
    platformCompanyLog("setup.failed", { platformAdminId: session.padmin, error: code });
    return NextResponse.json({ error: code }, { status });
  }
});
