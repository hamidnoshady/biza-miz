import { NextRequest, NextResponse } from "next/server";
import { query, withTenant } from "@/lib/db";
import { resolveSyncCredential } from "@/lib/server-sync";
import {
  listDesktopReleases,
  reportDeviceRuntimeStatus,
  selectTargetRelease,
  validateRuntimeStatusReport,
} from "@/lib/desktop-release-service";
import { currentCentralRuntime } from "@/lib/app-update";

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

  const device = await withTenant(identity.businessId, async () => {
    const report = await reportDeviceRuntimeStatus(
      {
        businessId: identity.businessId,
        siteDeviceId: identity.siteDeviceId!,
        locationId: identity.locationId!,
      },
      validated.report,
    );
    const { rows } = await query<{ public_id: string }>(
      `SELECT public_id FROM site_devices WHERE id=$1 AND business_id=$2 AND location_id=$3`,
      [identity.siteDeviceId, identity.businessId, identity.locationId],
    );
    return { ...report, publicId: rows[0]?.public_id ?? null };
  }, { locationId: identity.locationId });

  if (!device.publicId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const releases = await listDesktopReleases();
  const targetRelease = selectTargetRelease(releases, validated.report.releaseChannel, device.publicId);

  return NextResponse.json({
    centralRuntime: currentCentralRuntime(),
    targetRelease,
    reportedAt: device.reportedAt,
  });
}
