import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireSiteCredential } from "@/lib/server-sync-auth";
import { buildAutomotiveStockProjection } from "@/lib/automotive-stock-service";

/**
 * Issue #839 §19 — a paired dealership desktop's read-only view of its branch's
 * vehicle stock, read on the ordinary sync tick. The counterpart of
 * `/api/server-sync/site-profile` (Phase 45), with the same three properties:
 *
 *  * bearer-authenticated with the *site device* credential, which — never a
 *    parameter — names both the business and the branch, so a credential cannot
 *    ask for another branch's stock;
 *  * served under `withTenant`, so PostgreSQL's own tenant policy is the second
 *    lock and a bug in the query cannot widen it;
 *  * a whole snapshot of the board, deliberately without acquisition cost,
 *    capitalized costs or minimum price: the mirror exists to be *read*.
 *
 * A branch that is not this business's, and a business that is not the
 * automotive trade, both answer 404 rather than an empty board, so a paired
 * café is never told to start mirroring one (its tick treats 404 as "not
 * applicable" and does no further work).
 */
export async function GET(request: NextRequest) {
  const auth = await requireSiteCredential(request);
  if ("response" in auth) return auth.response;
  const { identity } = auth;

  const projection = await withTenant(
    identity.businessId,
    () => buildAutomotiveStockProjection(identity.businessId, identity.locationId),
    { locationId: identity.locationId },
  );
  if (!projection) return NextResponse.json({ error: "location_not_found" }, { status: 404 });
  return NextResponse.json(projection);
}
