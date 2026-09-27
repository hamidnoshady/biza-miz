import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getOwnerThemeSettings, saveOwnerThemeSettings } from "@/lib/cms/owner-bridge";

function statusFor(error: string): number {
  if (error === "not_connected") return 409;
  if (error === "cms_not_configured") return 503;
  return 400;
}

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;
  const result = await getOwnerThemeSettings(session.businessId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ settings: result.data });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;
  let body: { values?: Record<string, string>; clear?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await saveOwnerThemeSettings(session.businessId, {
    values: body.values && typeof body.values === "object" ? body.values : undefined,
    clear: Array.isArray(body.clear) ? body.clear.filter((v) => typeof v === "string") : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ settings: result.data });
});
