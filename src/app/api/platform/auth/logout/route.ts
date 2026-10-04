import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  revokePlatformAdminSession,
  verifyPlatformSession,
} from "@/lib/platform-auth";

/**
 * Clears the caller's own platform session cookie and best-effort revokes its
 * server-side `auth_admin_sessions` row.
 */
export async function POST() {
  const store = await cookies();
  const token = store.get(PLATFORM_SESSION_COOKIE)?.value;
  const session = token ? await verifyPlatformSession(token) : null;

  if (session?.sessionId) {
    await revokePlatformAdminSession(session.padmin, session.sessionId).catch(() => {});
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(PLATFORM_SESSION_COOKIE, "", { ...platformSessionCookieOptions(), maxAge: 0 });
  return res;
}
