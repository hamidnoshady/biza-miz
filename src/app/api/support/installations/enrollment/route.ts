import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import {
  beginEnrollment,
  listPendingEnrollments,
  revokeEnrollment,
  revokeSupportDeviceCredentials,
} from "@/lib/support-companion/device-credentials";
import { getInstallation } from "@/lib/support-companion/installations";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Owner-approved support enrollment (issue #984). The owner begins
 * enrollment from their own session and reads the single-use claim code to
 * the companion (in person or over the support call); the companion
 * completes it with its own locally-generated secret. Listing shows pending
 * enrollments for review — claim codes are never re-readable — and the owner
 * can revoke a pending enrollment or an installation's credentials outright.
 * Enrollment never activates Hybrid sync or bypasses activation gates.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  const pending = await listPendingEnrollments(session.businessId);
  return NextResponse.json({ enrollments: pending });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "begin") {
    const siteDeviceId = typeof body.siteDeviceId === "string" ? body.siteDeviceId : "";
    const installationId = typeof body.installationId === "string" ? body.installationId : "";
    if (siteDeviceId && !isUuid(siteDeviceId)) {
      return NextResponse.json({ error: "invalid_device" }, { status: 400 });
    }
    if (installationId) {
      if (!isUuid(installationId)) return NextResponse.json({ error: "invalid_installation" }, { status: 400 });
      const installation = await getInstallation(session.businessId, installationId);
      if (!installation) return NextResponse.json({ error: "installation_not_found" }, { status: 404 });
    }
    const begun = await beginEnrollment({
      businessId: session.businessId,
      approvedBy: session.sub,
      siteDeviceId: siteDeviceId || null,
      installationId: installationId || null,
    });
    // The claim code is returned exactly once, here. It is never stored.
    return NextResponse.json(begun, { status: 201 });
  }

  if (action === "revoke-enrollment") {
    const enrollmentId = typeof body.enrollmentId === "string" ? body.enrollmentId : "";
    if (!isUuid(enrollmentId)) return NextResponse.json({ error: "invalid_enrollment" }, { status: 400 });
    const revoked = await revokeEnrollment(session.businessId, enrollmentId);
    if (!revoked.ok) return NextResponse.json({ error: revoked.error }, { status: 404 });
    return NextResponse.json({ revoked: true });
  }

  if (action === "revoke-installation-credentials") {
    const installationId = typeof body.installationId === "string" ? body.installationId : "";
    if (!isUuid(installationId)) {
      return NextResponse.json({ error: "invalid_installation" }, { status: 400 });
    }
    const installation = await getInstallation(session.businessId, installationId);
    if (!installation) return NextResponse.json({ error: "installation_not_found" }, { status: 404 });
    const count = await revokeSupportDeviceCredentials(session.businessId, installationId);
    return NextResponse.json({ revokedCredentials: count });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
