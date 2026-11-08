import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/menu-validation";
import { syncWebsiteForBusiness } from "@/lib/website/sync-service";

/** «همگام‌سازی اکنون» — the same fill-then-drain the tick runs, on demand. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;

  const connectionId = request.nextUrl.searchParams.get("connectionId");
  if (connectionId && !isUuid(connectionId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await syncWebsiteForBusiness(session.businessId, undefined, connectionId ?? undefined);
  return NextResponse.json(result);
});
