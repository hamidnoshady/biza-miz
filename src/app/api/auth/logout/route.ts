import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { revokeSession } from "@/lib/employee-service";
import { clearNativeDeviceAuthStateOnSignOut } from "@/lib/native-device-service";

export async function POST() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;

  // Phase 20 Wave 2 — best-effort: an already-revoked/expired row (or any
  // other failure here) must never stop the cookie from being cleared, which
  // is this route's one unconditional job.
  if (session?.employeeSessionId) {
    const sessionId = session.employeeSessionId;
    await withTenant(session.businessId, () => revokeSession(sessionId, session.businessId, session.sub)).catch(
      () => {},
    );
  }
  if (session?.nativeDeviceId) {
    const deviceId = session.nativeDeviceId;
    await withTenant(session.businessId, () =>
      clearNativeDeviceAuthStateOnSignOut(deviceId, session.businessId, session.sub),
    ).catch(() => {});
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
