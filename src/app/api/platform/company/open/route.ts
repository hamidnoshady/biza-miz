import { NextRequest, NextResponse } from "next/server";
import {
  companyAppEnabled,
  companyHandoffSubdomain,
  createCompanyHandoff,
  platformCompanyLog,
  withPlatformCompany,
} from "@/lib/platform-company";
import { withPlatformScope } from "@/lib/platform-auth";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { hostRoutingEnabled } from "@/lib/host";
import {
  handoffOriginContext,
  resolveHandoffOrigin,
  withHandoffHeaders,
  type HandoffOriginFailure,
} from "@/lib/public-origin";
import type { CompanyAppKey } from "@/lib/platform-company-types";

const TARGETS: Record<CompanyAppKey, { path: string; permission: Permission }> = {
  workspace: { path: "/workspace", permission: PERMISSIONS.workspaceView },
  accounting: { path: "/accounting", permission: PERMISSIONS.ledgerView },
  crm: { path: "/crm", permission: PERMISSIONS.crmView },
  growth: { path: "/growth", permission: PERMISSIONS.growthView },
  websites: { path: "/websites", permission: PERMISSIONS.websiteView },
};

/** What the permission/entitlement gate and the origin policy decided. */
type OpenOutcome =
  | { kind: "app_disabled" }
  | { kind: "unavailable" }
  | { kind: "origin_error"; code: HandoffOriginFailure }
  | { kind: "minted"; token: string; origin: string };

/**
 * Mint the one-use staff handoff that opens a company app.
 *
 * Six checks in the documented order, all before a token exists:
 *   platform session → active platform identity → company membership →
 *   company permission → company entitlement → **destination origin**.
 *
 * An entitlement that is switched off blocks the handoff; it also hides the
 * entry in the console's navigation, but the server check is the real one. The
 * destination path is chosen here from a fixed table, never taken from the
 * query string, so a `return_path` cannot become an open redirect.
 *
 * The destination *origin* is decided by `resolveHandoffOrigin` — the one
 * browser-reachable canonical origin policy (issue #1062). This handler used
 * to build the receiver URL from `request.url`, which inside a route handler
 * is the container's internal origin behind a proxy (`http://localhost:3000`),
 * and the browser followed a redirect it could not open. The policy derives
 * the origin from the validated request host under the TRUST_FORWARDED_HOST
 * contract, the configured root domain, or the operator's PUBLIC_ORIGIN pin —
 * and when none of those proves a reachable origin it fails closed with an
 * actionable code **before** minting the two-minute credential. No loopback,
 * container-internal name, or wrong scheme/port ever reaches a production
 * browser; localhost survives only in explicitly local scenarios.
 */
export const GET = withPlatformScope(async (request: NextRequest): Promise<NextResponse> => {
  const key = request.nextUrl.searchParams.get("app") ?? "";
  if (!key || !(key in TARGETS)) {
    return withHandoffHeaders(NextResponse.json({ error: "invalid_app" }, { status: 400 }));
  }
  const target = TARGETS[key as CompanyAppKey];

  const result = await withPlatformCompany(target.permission, async (actor): Promise<OpenOutcome> => {
    const enabled = await companyAppEnabled(actor.businessId, key);
    if (!enabled) return { kind: "app_disabled" };

    // The origin is resolved BEFORE the credential is minted, so a broken
    // deployment shape leaves no live token to leak, expire, or redeem later.
    const tenantSubdomain = hostRoutingEnabled()
      ? await companyHandoffSubdomain(actor.businessId)
      : null;
    if (hostRoutingEnabled() && !tenantSubdomain) return { kind: "unavailable" };
    const origin = resolveHandoffOrigin(handoffOriginContext(request, tenantSubdomain));
    if (!origin.ok) {
      platformCompanyLog("handoff.origin_rejected", { app: key, code: origin.code });
      return { kind: "origin_error", code: origin.code };
    }

    const handoff = await createCompanyHandoff(actor, target.path);
    return { kind: "minted", token: handoff.token, origin: origin.origin };
  });
  if (!result.ok || !result.value) {
    return withHandoffHeaders(
      NextResponse.json(
        { error: result.error ?? "handoff_unavailable" },
        { status: result.ok ? 500 : result.status },
      ),
    );
  }

  const outcome = result.value;
  if (outcome.kind === "app_disabled") {
    platformCompanyLog("handoff.denied", { app: key, reason: "company_app_disabled" });
    return withHandoffHeaders(NextResponse.json({ error: "company_app_disabled" }, { status: 403 }));
  }
  if (outcome.kind === "unavailable") {
    return withHandoffHeaders(
      NextResponse.json(
        { error: "platform_company_not_provisioned_or_not_member" },
        { status: 404 },
      ),
    );
  }
  if (outcome.kind === "origin_error") {
    // The click is a top-level navigation; land the operator back on the
    // company console with an explanation instead of a JSON blob — or, worse,
    // a browser network error at a loopback host. The Location is RELATIVE on
    // purpose: the console page the user is on is by definition the origin
    // their browser can reach, so the error page cannot itself become the
    // #1062 bug. No credential was minted.
    const back = `/platform/company?handoff_error=${encodeURIComponent(outcome.code)}&app=${encodeURIComponent(key)}`;
    return withHandoffHeaders(new NextResponse(null, { status: 303, headers: { Location: back } }));
  }

  // Absolute, to the validated canonical origin: under host tenancy the
  // receiver lives on the company's own tenant origin, a different host from
  // this console request. Both response headers matter — `no-store` because
  // the Location carries the one-use token, `no-referrer` so the token-bearing
  // receiver URL is not echoed as a Referer on the next hop.
  return withHandoffHeaders(
    NextResponse.redirect(
      `${outcome.origin}/api/auth/company-handoff?token=${encodeURIComponent(outcome.token)}`,
    ),
  );
});
