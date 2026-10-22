import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { listPairingCodes, listPairingLocations } from "@/lib/pairing-service";
import { listSiteDevices, revokeSiteDevice } from "@/lib/site-device-service";
import {
  issueLocalEnrollmentCode,
  listLocalEnrollmentCodes,
  listLocalInstallations,
  revokeLocalEnrollmentCode,
  revokeLocalInstallation,
  rotateLocalInstallationCredential,
  updateLocalInstallationPolicyOnCloud,
} from "@/lib/local-activation-cloud-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Devices & installations for one business — both Hybrid paired sites
 * (`site_devices` + `pairing_codes`) and Full Offline activated installations
 * (`local_installations` + `local_enrollment_codes`, issue #974).
 */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  const { id: businessId } = await ctx.params;
  if (!(await getBusiness(businessId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [installations, codes, locations, localInstallations, localCodes] = await Promise.all([
    listSiteDevices(businessId),
    listPairingCodes(businessId),
    listPairingLocations(businessId),
    listLocalInstallations(businessId),
    listLocalEnrollmentCodes(businessId),
  ]);
  return NextResponse.json({
    installations,
    codes,
    locations,
    localInstallations,
    localCodes,
  });
});

export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  const { id: businessId } = await ctx.params;
  if (!(await getBusiness(businessId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: {
    deviceId?: string;
    codeId?: string;
    locationId?: string;
    label?: string;
    enforceOfflineLease?: boolean;
    offlineLeaseDays?: number;
    status?: "active" | "disabled";
    action?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "issue_local_code") {
    const locationId = body.locationId?.trim();
    if (!locationId) {
      return NextResponse.json({ error: "missing_location" }, { status: 400 });
    }
    const issued = await issueLocalEnrollmentCode(businessId, locationId, {
      adminId: session.padmin,
    });
    if (!issued.ok) {
      return NextResponse.json({ error: issued.error }, { status: 409 });
    }
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "local_activation.code_issued",
      entity: "local_enrollment_code",
      entityId: issued.summary.id,
      payload: {
        locationId,
        enforceOfflineLease: Boolean(body.enforceOfflineLease),
      },
    });
    return NextResponse.json(
      { ok: true, code: issued.code, summary: issued.summary },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (body.action === "revoke_local_code") {
    const codeId = body.codeId?.trim();
    if (!codeId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const ok = await revokeLocalEnrollmentCode(businessId, codeId);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "local_activation.code_revoked",
      entity: "local_enrollment_code",
      entityId: codeId,
      payload: { codeId },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "rotate_local_installation") {
    const deviceId = body.deviceId?.trim();
    if (!deviceId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const rot = await rotateLocalInstallationCredential(businessId, deviceId, null);
    if (!rot.ok) {
      return NextResponse.json(
        { error: rot.error },
        { status: rot.error === "device_not_found" ? 404 : 409 },
      );
    }
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "local_activation.credential_rotated",
      entity: "local_installation",
      entityId: deviceId,
      payload: { graceEndsAt: rot.graceEndsAt },
    });
    return NextResponse.json({ ok: true, graceEndsAt: rot.graceEndsAt });
  }

  if (body.action === "update_local_installation") {
    const deviceId = body.deviceId?.trim();
    if (!deviceId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const pol = await updateLocalInstallationPolicyOnCloud({
      businessId,
      localInstallationId: deviceId,
      status: body.status,
      enforceOfflineLease: body.enforceOfflineLease,
      offlineLeaseDays: body.offlineLeaseDays,
      actorUserId: null,
    });
    if (!pol.ok) {
      return NextResponse.json(
        { error: pol.error },
        { status: pol.error === "not_found" ? 404 : 409 },
      );
    }
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "local_activation.installation_policy_updated",
      entity: "local_installation",
      entityId: deviceId,
      payload: {
        status: body.status,
        enforceOfflineLease: body.enforceOfflineLease,
        offlineLeaseDays: body.offlineLeaseDays,
      },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "revoke_local_installation") {
    const deviceId = body.deviceId?.trim();
    if (!deviceId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const rev = await revokeLocalInstallation(businessId, deviceId, null);
    if (!rev.ok) return NextResponse.json({ error: rev.error }, { status: 404 });
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "local_activation.installation_revoked",
      entity: "local_installation",
      entityId: deviceId,
      payload: { deviceId, alreadyRevoked: rev.alreadyRevoked },
    });
    return NextResponse.json({ ok: true, alreadyRevoked: rev.alreadyRevoked });
  }

  const deviceId = body.deviceId?.trim();
  if (body.action !== "revoke" || !deviceId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await revokeSiteDevice(businessId, deviceId, null);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });

  await platformAudit({
    adminId: session.padmin,
    businessId,
    action: "pairing.device_revoked",
    entity: "site_device",
    entityId: deviceId,
    payload: { deviceId, alreadyRevoked: result.alreadyRevoked },
  });
  return NextResponse.json({ ok: true, alreadyRevoked: result.alreadyRevoked });
});
