import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { syncWebsiteForBusiness } from "@/lib/website/sync-service";

/** «همگام‌سازی اکنون» — the same fill-then-drain the tick runs, on demand. */
export const POST = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;

  const result = await syncWebsiteForBusiness(session.businessId);
  return NextResponse.json(result);
});
