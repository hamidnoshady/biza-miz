import { NextRequest, NextResponse } from "next/server";
import { CLOUD_LOGIN_STATE_COOKIE, cloudLoginPageUrl, newLoginToken } from "@/lib/desktop-cloud-login";
import { desktopCloudLoginContext } from "@/lib/desktop-cloud-login-local";
import { requestHost } from "@/lib/host";

/**
 * Phase 46, on the desktop: «ورود با حساب ابری» starts here. Answers the
 * cloud page to open in the system browser and remembers a fresh `state` in an
 * httpOnly cookie of *this* window, which the callback checks before it
 * redeems anything. Session-less: nobody is signed in yet.
 */
export async function POST(request: NextRequest) {
  const context = await desktopCloudLoginContext(requestHost(request.headers));
  if (!context) return NextResponse.json({ error: "cloud_login_unavailable" }, { status: 409 });
  const state = newLoginToken();
  const url = cloudLoginPageUrl(context.remoteUrl, state, context.devicePublicId);
  if (!url) return NextResponse.json({ error: "cloud_login_unavailable" }, { status: 409 });
  const response = NextResponse.json({ url });
  response.cookies.set(CLOUD_LOGIN_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/auth/cloud-login",
    maxAge: 10 * 60,
  });
  return response;
}
