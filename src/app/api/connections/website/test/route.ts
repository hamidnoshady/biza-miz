import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { testWebsiteConnection } from "@/lib/website/connection-service";

/** Re-run the connection test on the stored credential; records last_checked_at / last_error. */
export const POST = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;

  const result = await testWebsiteConnection(session.businessId);
  if (!result.ok) {
    const status = result.error === "not_connected" ? 409 : result.error === "unreachable" ? 503 : 400;
    return NextResponse.json({ ok: false, error: result.error ?? "connection_failed" }, { status });
  }
  return NextResponse.json({ ok: true, siteName: result.siteName ?? null });
});
