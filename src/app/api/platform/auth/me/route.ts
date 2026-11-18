import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { CAPABILITIES_FOR } from "@/lib/platform-admin";

/**
 * Returns the caller's own platform session, or null. Self-guarding — like the
 * tenant `auth/me`, it reveals only the caller's own identity, so any platform
 * cookie (or none) is a valid request. The console bootstraps from this: no
 * session → bounce to `/platform/login`; a session → render, using the returned
 * capability list to decide which controls to show.
 */
export const GET = withPlatformScope(async () => {
  const { session } = await requirePlatformAdmin();
  if (!session) {
    return NextResponse.json({ admin: null });
  }
  return NextResponse.json({
    admin: {
      id: session.padmin,
      fullName: session.fullName,
      email: session.email,
      role: session.role,
    },
    capabilities: CAPABILITIES_FOR(session.role),
    aiSessionScope: session.sessionId
      ? createHash("sha256").update(`ai:${session.padmin}:${session.sessionId}:${session.role}`).digest("hex")
      : undefined,
  });
});
