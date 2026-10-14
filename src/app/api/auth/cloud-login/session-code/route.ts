import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { CLOUD_SESSION_CODE_COOKIE, isLoginToken } from "@/lib/desktop-cloud-login";

/**
 * Phase 46, on the desktop: the cloud pane takes the single-use session code
 * the cloud sign-in left behind, once. It stays in an httpOnly cookie until
 * then, so no page script holds it longer than the pane's first load.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const value = request.cookies.get(CLOUD_SESSION_CODE_COOKIE)?.value;
  const response = NextResponse.json({ code: isLoginToken(value) ? value : null });
  response.cookies.set(CLOUD_SESSION_CODE_COOKIE, "", { path: "/api/auth/cloud-login", maxAge: 0 });
  return response;
}
