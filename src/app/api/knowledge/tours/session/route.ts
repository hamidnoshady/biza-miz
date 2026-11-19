import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { tourSessionKey } from "@/lib/tour-session-key";

/**
 * The caller's opaque queue key (issue #972, Phase G). The tour runtime asks
 * once per mount so it can (a) flush events queued by the same member and
 * (b) discard events queued by whoever used this browser before — without
 * replaying them into the new member's account.
 *
 * It exposes no identity and authorizes nothing: every read and write still
 * comes from the session cookie and the server's own membership check.
 */
export const GET = withTenantScope(async () => {
  const guard = await requireMember();
  if (guard.error) return guard.error;
  return NextResponse.json(
    { sessionKey: tourSessionKey(guard.session.businessId, guard.session.sub) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
