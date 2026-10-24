import { NextRequest, NextResponse } from "next/server";
import { query, withTenant } from "@/lib/db";
import { resolveSyncCredential } from "@/lib/server-sync";
import {
  listDesktopReleases,
  reportDeviceRuntimeStatus,
  validateRuntimeStatusReport,
} from "@/lib/desktop-release-service";
import { currentCentralRuntime } from "@/lib/app-update";
import {
  decideDeviceUpdate,
  loadDevicePolicyLayers,
  recordPolicyDelivery,
} from "@/lib/desktop-update-policy-service";
import {
  deliverNextDesktopUpdateCommand,
  recordDesktopUpdateCommandResults,
} from "@/lib/desktop-update-command-service";

function bearerFrom(request: NextRequest): string {
  const auth = request.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

/**
 * Authenticated site → Central runtime telemetry.  The bearer credential, not
 * the body, selects the device/business/location receiving this report.
 */
export async function POST(request: NextRequest) {
  const bearer = bearerFrom(request);
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const identity = await resolveSyncCredential(bearer);
  // Legacy business-wide tokens cannot truthfully identify one installation.
  if (!identity?.siteDeviceId || !identity.locationId) {
    return NextResponse.json({ error: "device_credential_required" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const validated = validateRuntimeStatusReport(body);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  const releases = await listDesktopReleases();
  const decision = await withTenant(identity.businessId, async () => {
    const identityScope = {
      businessId: identity.businessId,
      siteDeviceId: identity.siteDeviceId!,
      locationId: identity.locationId!,
    };
    const report = await reportDeviceRuntimeStatus(identityScope, validated.report);
    const { rows } = await query<{ public_id: string }>(
      `SELECT public_id FROM site_devices WHERE id=$1 AND business_id=$2 AND location_id=$3`,
      [identity.siteDeviceId, identity.businessId, identity.locationId],
    );
    const publicId = rows[0]?.public_id;
    if (!publicId) return null;
    // Eligibility (policy, channel, pin, hold, rollout) is decided here, before
    // anything leaves Central; the device is never asked what it may install.
    const layers = await loadDevicePolicyLayers(identityScope);
    const next = decideDeviceUpdate({
      identity: { ...identityScope, publicDeviceId: publicId },
      layers, releases, reportedChannel: validated.report.releaseChannel, now: new Date(),
    });
    await recordPolicyDelivery(identityScope, next.document.policyVersion, validated.report.appliedPolicyVersion);
    await recordDesktopUpdateCommandResults(identityScope, validated.report.commandResults);
    const updateCommand = await deliverNextDesktopUpdateCommand({ ...identityScope, publicDeviceId: publicId });
    return { ...next, updateCommand, reportedAt: report.reportedAt };
  }, { locationId: identity.locationId });

  if (!decision) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json({
    centralRuntime: currentCentralRuntime(),
    targetRelease: decision.targetRelease,
    updatePolicy: decision.document,
    updateCommand: decision.updateCommand,
    reportedAt: decision.reportedAt,
  });
}
