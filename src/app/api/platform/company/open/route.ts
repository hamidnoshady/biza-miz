import { NextRequest, NextResponse } from "next/server";
import { companyAppEnabled, createCompanyHandoff, withPlatformCompany } from "@/lib/platform-company";
import { withPlatformScope } from "@/lib/platform-auth";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { hostRoutingEnabled, preferredProto, rootDomain } from "@/lib/host";
import { platformCompanyLog } from "@/lib/platform-company";
import type { CompanyAppKey } from "@/lib/platform-company-types";

const TARGETS: Record<CompanyAppKey, { path: string; permission: Permission }> = {
  workspace: { path: "/workspace", permission: PERMISSIONS.workspaceView },
  accounting: { path: "/accounting", permission: PERMISSIONS.ledgerView },
  crm: { path: "/crm", permission: PERMISSIONS.crmView },
  growth: { path: "/growth", permission: PERMISSIONS.growthView },
  websites: { path: "/websites", permission: PERMISSIONS.websiteView },
};

/**
 * Mint the one-use staff handoff that opens a company app.
 *
 * Four checks in the documented order, all before a token exists:
 *   platform session → active platform identity → company membership →
 *   company permission → company entitlement.
 *
 * An entitlement that is switched off blocks the handoff; it also hides the
 * entry in the console's navigation, but the server check is the real one. The
 * destination path is chosen here from a fixed table, never taken from the
 * query string, so a `return_path` cannot become an open redirect.
 */
export const GET = withPlatformScope(async (request: NextRequest): Promise<NextResponse> => {
  const key = request.nextUrl.searchParams.get("app") ?? "";
  if (!key || !(key in TARGETS)) return NextResponse.json({ error: "invalid_app" }, { status: 400 });
  const target = TARGETS[key as CompanyAppKey];

  const result = await withPlatformCompany(target.permission, async (actor) => {
    const enabled = await companyAppEnabled(actor.businessId, key);
    if (!enabled) return null;
    return createCompanyHandoff(actor, target.path);
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (!result.value) {
    platformCompanyLog("handoff.denied", { app: key, reason: "company_app_disabled" });
    return NextResponse.json({ error: "company_app_disabled" }, { status: 403 });
  }

  const { token, subdomain } = result.value;
  if (!hostRoutingEnabled()) {
    return NextResponse.redirect(
      new URL(`/api/auth/company-handoff?token=${encodeURIComponent(token)}`, request.url),
    );
  }
  const proto = preferredProto(request.headers.get("x-forwarded-proto"), request.nextUrl.protocol);
  return NextResponse.redirect(
    `${proto}://${subdomain}.${rootDomain()}/api/auth/company-handoff?token=${encodeURIComponent(token)}`,
  );
});
