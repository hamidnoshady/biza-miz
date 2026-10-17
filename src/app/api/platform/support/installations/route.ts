import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  ensureInstallation,
  listInstallations,
  revokeInstallation,
} from "@/lib/support-companion/installations";
import { clientIpFrom } from "@/lib/rate-limit";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** A business's verified support installations. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("support.context.read");
  if (error) return error;

  const businessId = request.nextUrl.searchParams.get("businessId") ?? "";
  if (!isUuid(businessId)) return NextResponse.json({ error: "business_required" }, { status: 400 });

  const installations = await listInstallations(businessId);
  return NextResponse.json({ installations });
});

/** Enroll an active site device (`enroll`), or revoke an installation (`revoke`).
 * Enrollment scopes support evidence to this install; it never activates
 * Hybrid sync and never bypasses activation gates. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("support.diagnostics.request");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const businessId = typeof body.businessId === "string" ? body.businessId : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!isUuid(businessId)) return NextResponse.json({ error: "business_required" }, { status: 400 });

  const auditBase = {
    adminId: session.padmin,
    businessId,
    entity: "support_installation",
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  };

  if (action === "enroll") {
    const siteDeviceId = typeof body.siteDeviceId === "string" ? body.siteDeviceId : "";
    if (!isUuid(siteDeviceId)) {
      return NextResponse.json({ error: "device_required" }, { status: 400 });
    }
    const enrolled = await ensureInstallation(businessId, siteDeviceId, {
      displayName: typeof body.displayName === "string" ? body.displayName : "",
    });
    if (!enrolled.ok) return NextResponse.json({ error: enrolled.error }, { status: 404 });
    await platformAudit({
      ...auditBase,
      action: "support.installation.enrolled",
      entityId: enrolled.installation.id,
      payload: { siteDeviceId, created: enrolled.created },
    });
    return NextResponse.json(
      { installation: enrolled.installation, created: enrolled.created },
      { status: enrolled.created ? 201 : 200 },
    );
  }

  if (action === "revoke") {
    const installationId = typeof body.installationId === "string" ? body.installationId : "";
    if (!isUuid(installationId)) {
      return NextResponse.json({ error: "installation_required" }, { status: 400 });
    }
    const revoked = await revokeInstallation(businessId, installationId);
    if (!revoked.ok) return NextResponse.json({ error: revoked.error }, { status: 404 });
    await platformAudit({
      ...auditBase,
      action: "support.installation.revoked",
      entityId: installationId,
      payload: {},
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
