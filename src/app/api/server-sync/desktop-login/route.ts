import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { isLoginToken } from "@/lib/desktop-cloud-login";
import { redeemDeviceLoginCode } from "@/lib/desktop-cloud-login-service";
import { requireSiteCredential } from "@/lib/server-sync-auth";

/**
 * Phase 46: a paired desktop redeems the device code the cloud handed its
 * owner's browser. Bearer-authenticated with the site device credential —
 * only the install the code was minted for can redeem it — and answers which
 * member signed in plus a single-use code for the desktop's cloud pane.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSiteCredential(request);
  if ("response" in auth) return auth.response;
  const { identity } = auth;
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  if (!isLoginToken(body?.code)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const code = body.code;
  const redeemed = await withTenant(
    identity.businessId,
    () => redeemDeviceLoginCode({ businessId: identity.businessId, siteDeviceId: identity.siteDeviceId, code }),
    { locationId: identity.locationId },
  );
  if (!redeemed) return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  return NextResponse.json(redeemed);
}
