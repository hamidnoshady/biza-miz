import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requireRole } from "@/lib/auth";
import { deploymentRole } from "@/lib/deployment-role";
import {
  getDesktopLinkView,
  issueDesktopCode,
  revokeDesktopCode,
} from "@/lib/desktop-link-service";
import { revokeSiteDevice, rotateSiteCredential } from "@/lib/site-device-service";
import {
  issueLocalEnrollmentCode,
  listLocalEnrollmentCodes,
  listLocalInstallations,
  revokeLocalEnrollmentCode,
  revokeLocalInstallation,
  rotateLocalInstallationCredential,
  updateLocalInstallationPolicyOnCloud,
} from "@/lib/local-activation-cloud-service";

/**
 * Owner self-service for connecting a desktop install to this business — both
 * Hybrid (`profile: "hybrid"`, operational branch sync) and Full Offline
 * (`profile: "local"`, mandatory Cloud activation + business metadata refresh
 * with zero operational transaction replication, issue #974).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  const role = deploymentRole();
  const [hybridView, localCodes, localInstallations] = await Promise.all([
    getDesktopLinkView(session.businessId, request.headers),
    role === "central" ? listLocalEnrollmentCodes(session.businessId) : Promise.resolve([]),
    role === "central"
      ? listLocalInstallations(session.businessId)
      : Promise.resolve([]),
  ]);

  return NextResponse.json({
    ...hybridView,
    localCodes,
    localInstallations,
    role,
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "not_central_server" }, { status: 409 });
  }

  let body: {
    locationId?: string;
    profile?: "hybrid" | "local";
    label?: string;
    enforceOfflineLease?: boolean;
    offlineLeaseDays?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const locationId = body.locationId?.trim();
  if (!locationId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  if (body.profile === "local") {
    const view = await getDesktopLinkView(session.businessId, request.headers);
    const issued = await issueLocalEnrollmentCode(
      session.businessId,
      locationId,
      { userId: session.sub },
    );
    if (!issued.ok) {
      return NextResponse.json({ error: issued.error }, { status: 409 });
    }
    const response = NextResponse.json(
      {
        code: issued.code,
        address: view.address,
        summary: issued.summary,
        profile: "local",
      },
      { status: 201 },
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const result = await issueDesktopCode(
    session.businessId,
    session.platformUserId ?? null,
    request.headers,
    locationId,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  const response = NextResponse.json(
    { code: result.code, address: result.address, summary: result.summary, profile: "hybrid" },
    { status: 201 },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
});

export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "not_central_server" }, { status: 409 });
  }

  let body: {
    deviceId?: string;
    profile?: "hybrid" | "local";
    action?: "rotate" | "revoke" | "policy";
    status?: "active" | "disabled";
    enforceOfflineLease?: boolean;
    offlineLeaseDays?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const deviceId = body.deviceId?.trim();
  if (!deviceId || !body.action) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  if (body.profile === "local") {
    if (body.action === "rotate") {
      const rot = await rotateLocalInstallationCredential(
        session.businessId,
        deviceId,
        session.sub,
      );
      if (!rot.ok) {
        return NextResponse.json(
          { error: rot.error },
          { status: rot.error === "device_not_found" ? 404 : 409 },
        );
      }
      return NextResponse.json({ pending: true, graceEndsAt: rot.graceEndsAt });
    }
    if (body.action === "policy") {
      const pol = await updateLocalInstallationPolicyOnCloud({
        businessId: session.businessId,
        localInstallationId: deviceId,
        status: body.status,
        enforceOfflineLease: body.enforceOfflineLease,
        offlineLeaseDays: body.offlineLeaseDays,
        actorUserId: session.sub,
      });
      if (!pol.ok) {
        return NextResponse.json(
          { error: pol.error },
          { status: pol.error === "not_found" ? 404 : 409 },
        );
      }
      return NextResponse.json({ ok: true });
    }
    if (body.action === "revoke") {
      const rev = await revokeLocalInstallation(session.businessId, deviceId, session.sub);
      if (!rev.ok) return NextResponse.json({ error: rev.error }, { status: 404 });
      return NextResponse.json({ ok: true, alreadyRevoked: rev.alreadyRevoked });
    }
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  if (body.action !== "rotate" && body.action !== "revoke") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  if (body.action === "rotate") {
    const result = await rotateSiteCredential(session.businessId, deviceId, session.sub);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.error === "device_not_found" ? 404 : 409 },
      );
    }
    return NextResponse.json({
      pending: true,
      graceEndsAt: result.graceEndsAt,
      device: result.device,
    });
  }

  const result = await revokeSiteDevice(session.businessId, deviceId, session.sub);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ ok: true, alreadyRevoked: result.alreadyRevoked });
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: { codeId?: string; profile?: "hybrid" | "local" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.codeId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  if (body.profile === "local") {
    const revoked = await revokeLocalEnrollmentCode(
      session.businessId,
      body.codeId,
    );
    if (!revoked) return NextResponse.json({ error: "code_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  const revoked = await revokeDesktopCode(session.businessId, body.codeId);
  if (!revoked) return NextResponse.json({ error: "code_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
