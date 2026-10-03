import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { withoutTenantScope } from "@/lib/db";
import { platformCompanyLog, redeemCompanyHandoff } from "@/lib/platform-company";
import { platformAudit } from "@/lib/platform-auth";
import { hostRoutingEnabled, parseHost, preferredProto, requestHost, rootDomain } from "@/lib/host";

/**
 * Redeem permanent company-staff access on the tenant origin. Not impersonation.
 *
 * The token is a one-use, two-minute credential that maps an already-verified
 * platform identity onto its OWN real tenant membership inside the internal
 * company. Every condition is re-checked at redeem time, from the database:
 *
 *   membership active · admin active · business active and internal ·
 *   user active · token unused · token unexpired · origin is the company's own
 *
 * No impersonation grant is created and no customer's session is touched. The
 * redeem itself lives in `src/lib/platform-company.ts` so the route and the
 * integration tests exercise exactly the same code.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });
  const parsed = hostRoutingEnabled() ? parseHost(requestHost(request.headers), rootDomain()) : null;
  if (parsed && parsed.kind !== "business") return NextResponse.json({ error: "wrong_origin" }, { status: 400 });

  const result = await redeemCompanyHandoff(token, parsed?.kind === "business" ? parsed.label : null);
  if (!result) return NextResponse.json({ error: "invalid_or_expired" }, { status: 400 });

  const session = await signSession({
    sub: result.userId,
    role: result.role as Role,
    businessId: result.businessId,
    businessSlug: result.slug,
    businessSubdomain: result.subdomain,
    locationId: result.locationId,
    fullName: result.fullName,
    platformUserId: result.platformUserId,
    tokenVersion: result.tokenVersion ?? undefined,
  });
  await withoutTenantScope("platform", () =>
    platformAudit({
      adminId: result.platformAdminId,
      businessId: result.businessId,
      action: "platform_company.handoff.redeemed",
      entity: "platform_company_handoff",
      entityId: result.handoffId,
      // The return path and the preset only — never the token or its hash.
      payload: { returnPath: result.returnPath, preset: result.preset },
    }),
  );
  platformCompanyLog("handoff.redeemed", {
    businessId: result.businessId,
    platformAdminId: result.platformAdminId,
    returnPath: result.returnPath,
  });

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = preferredProto(request.headers.get("x-forwarded-proto"), request.nextUrl.protocol);
  const response = NextResponse.redirect(`${proto}://${host}${result.returnPath}`);
  response.cookies.set(SESSION_COOKIE, session, sessionCookieOptions());
  return response;
}
