import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listThemePackages, mapDeploymentError } from "@/lib/cms/platform-deployments-client";
import { ownerPlatformContext } from "@/lib/cms/owner-api-context";
import { websiteManagersState } from "@/lib/website/managers-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;
  const ctx = await ownerPlatformContext(session.businessId);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.error === "not_connected" ? 409 : 503 });
  const siteType =
    request.nextUrl.searchParams.get("siteType") ??
    (await websiteManagersState(session.businessId)).cms.siteType ??
    "business";
  try {
    const { packages } = await listThemePackages(ctx.config, { siteType });
    return NextResponse.json({ packages });
  } catch (err) {
    return NextResponse.json({ error: mapDeploymentError(err) }, { status: 503 });
  }
});
