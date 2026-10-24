import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { withTenantTransaction } from "@/lib/db";
import { createSession } from "@/lib/employee-service";
import { platformCompanyLog, redeemCompanyHandoff } from "@/lib/platform-company";
import { platformAudit } from "@/lib/platform-auth";
import { hostRoutingEnabled, parseHost, requestHost, rootDomain } from "@/lib/host";
import {
  handoffOriginContext,
  resolveHandoffOrigin,
  withHandoffHeaders,
} from "@/lib/public-origin";

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
 *
 * The session is the staff member's own, revocable like any other (#854
 * follow-up, third pass): an `employee_sessions` row in the company with
 * `login_method = 'company_handoff'`, named by the cookie, so signing out
 * ends it on the server and the company's security center can end it. If the
 * row cannot be opened no cookie is issued (`503 session_unavailable`); the
 * redeemed token stays spent, and a fresh hand-off from the console is the
 * retry.
 *
 * The session row, its `employee.session_created` audit and the platform's
 * `platform_company.handoff.redeemed` audit are ONE transaction. The platform
 * audit used to be written after the session had committed, so a failure there
 * answered 500 and left an active session in the company that no cookie named
 * and no platform record explained. `platform_audit_log` is platform-owned and
 * remains omitted from tenant exports, but its `business_id` attribution is
 * protected by migration 0228's standard FORCE RLS policy. This transaction
 * writes the row for its current business; cross-business console access uses
 * the documented platform bypass. The three rows commit or roll back together.
 *
 * The post-redemption Location is built from `resolveHandoffOrigin` — the same
 * validated destination-origin policy the minting side uses (issue #1062) —
 * never from a raw `X-Forwarded-Host`. A client-supplied header must not decide
 * where a freshly-minted tenant session is sent, and the cookie is scoped to
 * exactly the origin the policy validated. The origin is resolved BEFORE the
 * token is redeemed, so a spoofed or misconfigured request fails without
 * burning the credential.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return withHandoffHeaders(NextResponse.json({ error: "missing_token" }, { status: 400 }));
  }
  const parsed = hostRoutingEnabled() ? parseHost(requestHost(request.headers), rootDomain()) : null;
  if (parsed && parsed.kind !== "business") {
    return withHandoffHeaders(NextResponse.json({ error: "wrong_origin" }, { status: 400 }));
  }

  // Same policy, same order as the minting side: no redeem until the
  // destination origin is proven browser-reachable. Under host tenancy the
  // destination is the company's own subdomain (which redeemCompanyHandoff
  // then re-checks against the token's row); single-host deployments use the
  // validated request origin itself.
  const origin = resolveHandoffOrigin(
    handoffOriginContext(request, parsed ? parsed.label : null),
  );
  if (!origin.ok) {
    platformCompanyLog("handoff.origin_rejected", { code: origin.code });
    return withHandoffHeaders(
      NextResponse.json({ error: "origin_unreachable", reason: origin.code }, { status: 400 }),
    );
  }

  const result = await redeemCompanyHandoff(token, parsed?.kind === "business" ? parsed.label : null);
  if (!result) {
    return withHandoffHeaders(
      NextResponse.json({ error: "invalid_or_expired" }, { status: 400 }),
    );
  }

  const userAgent = request.headers.get("user-agent");
  const opened = await withTenantTransaction(result.businessId, async () => {
    // Joins this transaction (createSession sees it is pinned).
    const created = await createSession(result.userId, result.businessId, {
      locationId: result.locationId,
      loginMethod: "company_handoff",
      deviceLabel: userAgent?.slice(0, 120) ?? null,
      userAgent,
    });
    await platformAudit({
      adminId: result.platformAdminId,
      businessId: result.businessId,
      action: "platform_company.handoff.redeemed",
      entity: "platform_company_handoff",
      entityId: result.handoffId,
      // The return path, the preset and the session it opened — never the
      // token or its hash.
      payload: { returnPath: result.returnPath, preset: result.preset, sessionId: created.session.id },
    });
    return created;
  }).catch((err: unknown) => {
    console.error(
      "company hand-off could not open a session:",
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  });
  if (!opened) {
    return withHandoffHeaders(
      NextResponse.json({ error: "session_unavailable" }, { status: 503 }),
    );
  }

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
    employeeSessionId: opened.session.id,
  });
  platformCompanyLog("handoff.redeemed", {
    businessId: result.businessId,
    platformAdminId: result.platformAdminId,
    returnPath: result.returnPath,
  });

  // The validated origin above, not `x-forwarded-host`: the redirect must land
  // on the origin the cookie is scoped to, and no header a caller controls may
  // turn this into an open redirect. `returnPath` is re-validated by
  // redeemCompanyHandoff as a single-segment app root, so the Location stays a
  // path on the company's own origin.
  const response = NextResponse.redirect(`${origin.origin}${result.returnPath}`);
  response.cookies.set(SESSION_COOKIE, session, sessionCookieOptions());
  return withHandoffHeaders(response);
}
