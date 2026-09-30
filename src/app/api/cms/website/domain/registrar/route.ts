import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { cmsRegistrarDomains } from "@/lib/cms/website-service";

/**
 * `GET /api/cms/website/domain/registrar` — the domains the platform's
 * registrar holds for the connected site, with the timeline of registration,
 * transfer and renewal requests. Read-only; renewing is
 * `POST /api/cms/website/domain/order` with `operation: "renew"`, which is
 * priced, wallet-checked, ordered and billed like any other domain order.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;
  const result = await cmsRegistrarDomains(session.businessId);
  if (!result.ok) {
    const status = result.error === "not_connected" ? 409 : result.error === "cms_unreachable" ? 502 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  const response = NextResponse.json(result.data);
  response.headers.set("Cache-Control", "no-store");
  return response;
});
