import { NextResponse } from "next/server";
import { ensurePlatformCompany } from "@/lib/platform-company";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { deploymentRole } from "@/lib/deployment-role";

/** Idempotent explicit initializer. Central cloud only; never runs on local/hybrid nodes. */
export const POST = withPlatformScope(async () => {
  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "central_cloud_only" }, { status: 404 });
  }
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;
  const company = await ensurePlatformCompany(session);
  await platformAudit({
    adminId: session.padmin,
    businessId: company.business_id,
    action: "platform_company.ensure",
    entity: "business",
    entityId: company.business_id,
    payload: { idempotent: true },
  });
  return NextResponse.json({ company });
});
