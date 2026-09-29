import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { listPairingCodes, listPairingLocations } from "@/lib/pairing-service";
import { listSiteDevices, revokeSiteDevice } from "@/lib/site-device-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Devices & installations for one business — the operational counterpart to
 * the entitlement flags next door.
 *
 * A paired Windows install is a device identity with a credential, a branch, a
 * last-seen stamp and its own credential-rotation state; a pairing code is a
 * one-time secret that creates one. Neither is an entitlement, which is why
 * this reads its own endpoint rather than sharing the Features & Apps page
 * (issue #755 §15): mixing a credential's lifetime with a feature flag's on/off
 * state made the pairing controls look like a capability switch.
 *
 * `business.provision` (owner-only) guards the whole surface, matching the
 * existing pairing endpoint: a live code's existence and expiry are
 * operational secrets, and the only reason to read this page is to decide
 * whether to issue, rotate or revoke.
 */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  const { id: businessId } = await ctx.params;
  if (!(await getBusiness(businessId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [installations, codes, locations] = await Promise.all([
    listSiteDevices(businessId),
    listPairingCodes(businessId),
    listPairingLocations(businessId),
  ]);
  return NextResponse.json({ installations, codes, locations });
});

/**
 * Revoke a paired installation — the kill switch for a laptop that is lost,
 * sold or being replaced. Scoped to the business named in the path, so a
 * device id from another tenant can never be reached, and audited with the
 * admin who did it. Rotation stays a tenant-side action (the running desktop is
 * the only party that can acknowledge a staged credential).
 */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  const { id: businessId } = await ctx.params;
  let body: { deviceId?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
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
