import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireSiteCredential } from "@/lib/server-sync-auth";
import { buildSiteProfile } from "@/lib/site-profile-service";

/**
 * Phase 45: a paired desktop's branch settings and switches, read on every
 * sync tick. Bearer-authenticated with the site device credential, which —
 * never a parameter — names the business and the branch.
 */
export async function GET(request: NextRequest) {
  const auth = await requireSiteCredential(request);
  if ("response" in auth) return auth.response;
  const { identity } = auth;
  const profile = await withTenant(
    identity.businessId,
    () => buildSiteProfile(identity.businessId, identity.locationId),
    { locationId: identity.locationId },
  );
  if (!profile) return NextResponse.json({ error: "location_not_found" }, { status: 404 });
  return NextResponse.json(profile);
}
