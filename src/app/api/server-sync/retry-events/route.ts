import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireSiteCredential } from "@/lib/server-sync-auth";
import { requestSyncEventRetry } from "@/lib/sync-events";

/**
 * Allow one re-application of an event this central server failed to apply
 * (issue #1446). Called by a paired site with its own device credential, after
 * the owner pressed «تلاش دوباره» on a dead letter — the site cannot change
 * central rows itself, and the cached error used to be permanent.
 *
 * Deliberately narrow: the credential names the business *and* branch, so a
 * site can only touch its own location's inbox rows; only an event that never
 * applied (`applied_at IS NULL`) can be selected, so an already-applied
 * financial or operational effect can never be re-run; and the request only
 * sets a marker that the apply path claims atomically. This does not clear an
 * error, mark anything delivered, or write business data.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSiteCredential(request);
  if ("response" in auth) return auth.response;
  const { identity } = auth;

  let body: { clientEventIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const raw = body.clientEventIds;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > 200 ||
    !raw.every((id) => typeof id === "string")
  ) {
    return NextResponse.json({ error: "invalid_client_event_ids" }, { status: 400 });
  }

  const result = await withTenant(
    identity.businessId,
    () =>
      requestSyncEventRetry({
        businessId: identity.businessId,
        locationId: identity.locationId,
        clientEventIds: raw as string[],
      }),
    { locationId: identity.locationId },
  );
  return NextResponse.json({ ok: true, requested: result.requested });
}
