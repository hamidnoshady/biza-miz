import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { desktopLoginLink, isLoginToken } from "@/lib/desktop-cloud-login";
import { issueDeviceLoginCode } from "@/lib/desktop-cloud-login-service";
import { accessibleLocationsFor } from "@/lib/setup-state";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 46 — the cloud half of «ورود با حساب ابری»: the signed-in member
 * confirms on /desktop-login and gets the link that hands the browser back to
 * the desktop app. The code is bound to one paired install of *this* business
 * and to a branch the member may work in.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // A platform operator's support session acts *in* the business; it may not
  // sign the member in on their own till.
  if (session.imp) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { state?: unknown; device?: unknown } | null;
  if (!isLoginToken(body?.state) || typeof body?.device !== "string" || !UUID.test(body.device)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const state = body.state;
  const device = body.device;
  const result = await withTenant(
    session.businessId,
    async () => {
      const { locations } = await accessibleLocationsFor(session);
      return issueDeviceLoginCode({
        businessId: session.businessId,
        userId: session.sub,
        devicePublicId: device,
        state,
        accessibleLocationIds: locations.map((location) => location.id),
      });
    },
    { locationId: session.locationId, userId: session.sub },
  );
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ url: desktopLoginLink(result.code, state) });
}
