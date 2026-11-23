import { NextRequest, NextResponse } from "next/server";
import { withTenantTransaction } from "@/lib/db";
import { leaseOrderNumberBlock } from "@/lib/order-number-service";
import { requireSiteCredential } from "@/lib/server-sync-auth";

/**
 * The cloud's order-number allocator (migration 0318).
 *
 * A paired till calls this when its current block reaches the low watermark.
 * The site device credential — never the request body — names the business,
 * the branch and the install, so one install can only ever reserve blocks for
 * its own branch. `highestLocalOrderNumber` is the site's own high-water mark;
 * the block starts above it, which keeps a sale made while its last push was in
 * flight from being shadowed.
 *
 * The call is deliberately rare (once per 200 bills, plus pairing), so it is in
 * the shared sync-token rate bucket rather than on its own budget.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSiteCredential(request);
  if ("response" in auth) return auth.response;
  const { identity } = auth;

  let highestLocalOrderNumber: number | null = null;
  try {
    const body = (await request.json()) as { highestLocalOrderNumber?: unknown };
    if (
      typeof body.highestLocalOrderNumber === "number" &&
      Number.isSafeInteger(body.highestLocalOrderNumber) &&
      body.highestLocalOrderNumber >= 0
    ) {
      highestLocalOrderNumber = body.highestLocalOrderNumber;
    }
  } catch {
    // An empty body is allowed: a paired till that has never sold anything has
    // no high-water mark to report.
  }

  try {
    const lease = await withTenantTransaction(
      identity.businessId,
      (client) =>
        leaseOrderNumberBlock(client, {
          locationId: identity.locationId,
          siteDeviceId: identity.siteDeviceId,
          highestLocalOrderNumber,
        }),
      { locationId: identity.locationId },
    );
    return NextResponse.json({ lease });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "site_device_not_active") {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    throw error;
  }
}
