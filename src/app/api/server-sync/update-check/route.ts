import { NextRequest, NextResponse } from "next/server";
import { query, withTenant } from "@/lib/db";
import { resolveSyncCredential } from "@/lib/server-sync";
import { currentCentralRuntime } from "@/lib/app-update";
import { listDesktopReleases, selectTargetRelease } from "@/lib/desktop-release-service";

/**
 * Compatibility read for paired sites. New clients report and discover in one
 * POST to /runtime-status. This endpoint still exposes the same separated
 * Central provenance + Desktop target and never labels a Docker SHA as a
 * Desktop version.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const identity = await resolveSyncCredential(bearer);
  if (!identity?.siteDeviceId || !identity.locationId) {
    return NextResponse.json({ error: "device_credential_required" }, { status: 401 });
  }
  const device = await withTenant(identity.businessId, async () => {
    const { rows } = await query<{ public_id: string; release_channel: "stable" | "beta" | "internal" | null }>(
      `SELECT d.public_id,rs.release_channel
         FROM site_devices d
         LEFT JOIN site_device_runtime_status rs ON rs.site_device_id=d.id
        WHERE d.id=$1 AND d.business_id=$2 AND d.location_id=$3`,
      [identity.siteDeviceId, identity.businessId, identity.locationId],
    );
    return rows[0] ?? null;
  }, { locationId: identity.locationId });
  if (!device) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const releases = await listDesktopReleases();
  const targetRelease = selectTargetRelease(releases, device.release_channel ?? "stable", device.public_id);
  return NextResponse.json({
    // Old clients require this field. "unknown" makes their legacy inequality
    // helper decline an update rather than comparing semver to a Docker SHA.
    version: "unknown",
    centralRuntime: currentCentralRuntime(),
    targetRelease,
  });
}
