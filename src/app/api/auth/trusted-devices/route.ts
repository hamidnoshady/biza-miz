import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { requireRecentAuth } from "@/lib/recent-auth";
import { listTrustedDevices, revokeTrustedDevice } from "@/lib/trusted-device";
import { uuidOrNull } from "@/lib/login-contract";

/**
 * Issue #885 — the member's own seven-day trusted devices.
 *
 * The policy requires that trust be *visible and revocable*: a convenience
 * that silently skips a verification step is a liability the moment the device
 * leaves the member's hands, and "show trusted devices and revoke actions in
 * account security settings" is the requirement, not a nicety.
 *
 * Scope is the caller's own membership and nothing wider. Both the list and
 * the revocation are keyed on `session.sub` / `session.businessId` taken from
 * the session, never from the request, so there is no shape of this endpoint
 * that reads or clears another member's devices. An owner revoking someone
 * else's trust is an administrative act and belongs on the team screen, not
 * here.
 *
 * `requireRecentAuth` guards the write: revoking trust is a security action,
 * and the platform's rule for those is a fresh authentication rather than a
 * session of any age. Reading the list is not gated that way — it discloses
 * nothing that is not already the caller's, and a member should be able to see
 * what is trusted without re-authenticating first.
 */
export const GET = withTenantScope(async () => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const devices = await listTrustedDevices(session.businessId, session.sub);
  return NextResponse.json({
    devices: devices.map((device) => ({
      id: device.id,
      deviceLabel: device.deviceLabel,
      factorSummary: device.factorSummary,
      trustedAt: device.trustedAt.toISOString(),
      expiresAt: device.expiresAt.toISOString(),
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      revokedAt: device.revokedAt?.toISOString() ?? null,
    })),
  });
});

/**
 * Revoke one device, addressed by id in the body.
 *
 * A DELETE with the id in the body rather than a dynamic segment so the
 * revocation stays inside this one route's scope checks; there is no
 * `[id]` variant that could be reached without them.
 */
export const DELETE = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const recentAuthError = requireRecentAuth(session);
  if (recentAuthError) return recentAuthError;

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const id = uuidOrNull(body.id);
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const revoked = await revokeTrustedDevice({
    businessId: session.businessId,
    userId: session.sub,
    id,
    reason: "user_revoked",
  });

  // A device that was already revoked answers the same as one just revoked.
  // Idempotency is the useful behaviour for a button a member may press twice,
  // and distinguishing the two would only tell a caller whether a row existed.
  return NextResponse.json({ revoked: true, alreadyRevoked: !revoked });
});
