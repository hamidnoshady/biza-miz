import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { listGrants } from "@/lib/platform-service";

/**
 * Recent impersonation grants, platform-wide or scoped to one business via
 * `?businessId=`. Read surface: the audit view for support access — who entered
 * which business, in what mode, for how long, and whether it is still open. Any
 * admin may see it, since accountability is the point.
 *
 * Each grant carries `isMine` for the admin asking. The console cannot work it
 * out for itself — it does not know its own platform-admin id — and without it
 * it labelled whichever session it found first «نشست من», including a
 * colleague's.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("businesses.read");
  if (error) return error;

  const businessId = request.nextUrl.searchParams.get("businessId") ?? undefined;
  return NextResponse.json({ grants: await listGrants(businessId, session.padmin) });
});
