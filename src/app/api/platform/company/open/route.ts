import { NextRequest, NextResponse } from "next/server";
import { createCompanyHandoff, withPlatformCompany } from "@/lib/platform-company";
import { withPlatformScope } from "@/lib/platform-auth";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { hostRoutingEnabled, preferredProto, rootDomain } from "@/lib/host";

const TARGETS: Record<string, { path: string; permission: Permission }> = {
  workspace: { path: "/workspace", permission: PERMISSIONS.workspaceView },
  accounting: { path: "/accounting", permission: PERMISSIONS.ledgerView },
  crm: { path: "/crm", permission: PERMISSIONS.crmView },
  growth: { path: "/growth", permission: PERMISSIONS.growthView },
  websites: { path: "/websites", permission: PERMISSIONS.websiteView },
};

export const GET = withPlatformScope(async (request: NextRequest) => {
  const key = request.nextUrl.searchParams.get("app") ?? "";
  const target = TARGETS[key];
  if (!target) return NextResponse.json({ error: "invalid_app" }, { status: 400 });
  const result = await withPlatformCompany(target.permission, (actor) => createCompanyHandoff(actor, target.path));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  const { token, subdomain } = result.value;
  if (!hostRoutingEnabled()) {
    return NextResponse.redirect(new URL(`/api/auth/company-handoff?token=${encodeURIComponent(token)}`, request.url));
  }
  const proto = preferredProto(request.headers.get("x-forwarded-proto"), request.nextUrl.protocol);
  return NextResponse.redirect(`${proto}://${subdomain}.${rootDomain()}/api/auth/company-handoff?token=${encodeURIComponent(token)}`);
});
