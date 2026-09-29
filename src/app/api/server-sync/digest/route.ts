import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireSiteCredential } from "@/lib/server-sync-auth";
import { compareWithSiteDigest } from "@/lib/sync-health-service";
import { isDayDigest } from "@/lib/sync-health";

/**
 * Drift check (migration 0190): a paired desktop posts its settled figures per
 * business day for its branch; this server computes its own for the same days
 * and answers with the days that differ. Bearer-authenticated with the site
 * device credential, which — never the body — names the branch.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSiteCredential(request);
  if ("response" in auth) return auth.response;
  const { identity } = auth;
  let body: { days?: unknown; digests?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const days = body.days;
  const digests = body.digests;
  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    days.length > 31 ||
    !days.every((day) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)) ||
    !Array.isArray(digests) ||
    !digests.every(isDayDigest)
  ) {
    return NextResponse.json({ error: "invalid_digest" }, { status: 400 });
  }
  const result = await withTenant(
    identity.businessId,
    () => compareWithSiteDigest(identity.locationId, days as string[], digests),
    { locationId: identity.locationId },
  );
  return NextResponse.json(result);
}
