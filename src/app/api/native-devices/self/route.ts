import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { listNativeDevicesForUser } from "@/lib/native-device-service";

/**
 * Issue #884 — the caller's own registered Android installations. Never
 * anybody else's: `requireMember` admits every role, and
 * `listNativeDevicesForUser` is what scopes the read to `session.sub` (owner
 * decision #1 — a plain member manages only their own devices).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireMember();
  if (error) return error;
  const devices = await listNativeDevicesForUser(session.businessId, session.sub);
  return NextResponse.json({ devices, currentDeviceId: session.nativeDeviceId ?? null });
});
