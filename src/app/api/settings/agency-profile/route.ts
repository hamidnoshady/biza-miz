import { NextRequest, NextResponse } from "next/server";
import {
  AgencyProfileError,
  loadBusinessAgencyProfile,
  saveBusinessAgencyProfile,
  type AgencyProfileErrorCode,
} from "@/lib/agency-service";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Issue #1128 — the operating profile of an advertising agency: which of the
 * eight shapes in `agency.ts` this business works as.
 *
 * GET returns what is stored, or the default preset with `stored: false` while
 * the business has not chosen. PUT replaces the choice. The picker's labels and
 * descriptions are *not* in the payload: they are pure data in `@/lib/agency`,
 * which the form imports directly, the same split `AecProfileForm` uses — the
 * API carries what is stored and nothing a client could get from code.
 *
 * Both run on `settings.manage`, because this is business-wide configuration
 * rather than a per-project write: it reorders the blueprint list every member
 * of the business is offered first. A business of another industry is refused
 * with `industry_mismatch` (403) — the profile means nothing outside
 * `advertising_agency`, and answering a café with the agency default would let
 * it read configuration it can never use.
 *
 * What this route does *not* do is authorize anything. The stored profile
 * carries no permission, no module and no role: an agency's presets steer
 * starter blueprints, and who may open a screen is still the member's role and
 * the platform permission (issue #1128: presets "never replace role
 * authorization").
 */
export const dynamic = "force-dynamic";

const STATUS_BY_CODE: Record<AgencyProfileErrorCode, number> = {
  industry_mismatch: 403,
  invalid_profile: 400,
};

function handleAgencyProfileError(err: unknown): NextResponse {
  if (err instanceof AgencyProfileError) {
    return NextResponse.json({ error: err.code }, { status: STATUS_BY_CODE[err.code] });
  }
  console.error("agency operating profile failed:", err);
  return NextResponse.json({ error: "agency_profile_failed" }, { status: 500 });
}

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  try {
    return NextResponse.json({ profile: await loadBusinessAgencyProfile(session.businessId) });
  } catch (err) {
    return handleAgencyProfileError(err);
  }
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_profile" }, { status: 400 });
  }
  try {
    const profile = await saveBusinessAgencyProfile(
      { businessId: session.businessId, locationId: session.locationId, userId: session.sub },
      body,
    );
    return NextResponse.json({ profile });
  } catch (err) {
    return handleAgencyProfileError(err);
  }
});
