import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { listDesktopReleases } from "@/lib/desktop-release-service";
import { previewDevicePolicy } from "@/lib/desktop-update-policy-service";
import { isUuid } from "@/lib/uuid";

/**
 * The resolved policy for one device, exactly as Central would hand it over,
 * with the layer each value came from (inherited vs explicitly overridden).
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const siteDeviceId = request.nextUrl.searchParams.get("siteDeviceId");
  if (!siteDeviceId || !isUuid(siteDeviceId)) return NextResponse.json({ error: "invalid_device" }, { status: 400 });
  const decision = await previewDevicePolicy(siteDeviceId, await listDesktopReleases());
  if (!decision) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    policy: decision.resolved.policy,
    sources: decision.resolved.sources,
    policyVersion: decision.resolved.policyVersion,
    latest: decision.resolved.latest,
    channel: decision.document.policy.channel,
    targetVersion: decision.targetRelease?.version ?? null,
    targetReleaseId: decision.targetRelease?.id ?? null,
    withheldReason: decision.withheldReason,
  });
});
