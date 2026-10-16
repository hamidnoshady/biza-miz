import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { listDesktopReleases } from "@/lib/desktop-release-service";
import { validateDesktopUpdatePolicyPatch, POLICY_KEYS } from "@/lib/desktop-update-policy";
import {
  readBusinessPolicyOverview,
  writeDesktopUpdatePolicy,
  type PolicyTarget,
} from "@/lib/desktop-update-policy-service";
import { isUuid } from "@/lib/uuid";

/** The platform default plus every override one business has (read-only: any platform admin). */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId || !isUuid(businessId)) return NextResponse.json({ error: "invalid_business" }, { status: 400 });
  const overview = await readBusinessPolicyOverview(businessId);
  if (!overview) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(overview);
});

function parseTarget(value: unknown): PolicyTarget | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const id = (key: string) => (typeof input[key] === "string" && isUuid(input[key] as string) ? (input[key] as string) : null);
  if (input.scope === "platform") return { scope: "platform" };
  const businessId = id("businessId");
  if (!businessId) return null;
  if (input.scope === "business") return { scope: "business", businessId };
  if (input.scope === "location") {
    const locationId = id("locationId");
    return locationId ? { scope: "location", businessId, locationId } : null;
  }
  if (input.scope === "device") {
    const siteDeviceId = id("siteDeviceId");
    return siteDeviceId ? { scope: "device", businessId, siteDeviceId } : null;
  }
  return null;
}

/**
 * Superadmin policy write. Authorization is `updates.manage` checked here, on
 * the server; every write needs a reason and lands in the platform audit log
 * with the layer's before/after, so "who changed this device's policy and why"
 * always has an answer.
 */
export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("updates.manage");
  if (error) return error;
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }

  const target = parseTarget(body.target);
  if (!target) return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) return NextResponse.json({ error: "reason_required" }, { status: 400 });

  const set = validateDesktopUpdatePolicyPatch(body.set ?? {});
  if (!set.ok) return NextResponse.json({ error: set.error, key: set.key }, { status: 400 });
  const clear = Array.isArray(body.clear) ? body.clear : [];
  if (!clear.every((key): key is string => typeof key === "string" && (POLICY_KEYS as readonly string[]).includes(key))) {
    return NextResponse.json({ error: "unknown_policy_key" }, { status: 400 });
  }
  if (Object.keys(set.patch).length === 0 && clear.length === 0) {
    return NextResponse.json({ error: "empty_change" }, { status: 400 });
  }
  const expectedVersion = body.expectedVersion === undefined || body.expectedVersion === null ? null : Number(body.expectedVersion);
  if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
    return NextResponse.json({ error: "invalid_expected_version" }, { status: 400 });
  }
  // A pin must name a release that exists; an unknown id would silently pin nothing.
  if (set.patch.targetReleaseId) {
    const releases = await listDesktopReleases();
    if (!releases.some((release) => release.id === set.patch.targetReleaseId)) {
      return NextResponse.json({ error: "release_not_found" }, { status: 400 });
    }
  }

  const result = await writeDesktopUpdatePolicy({
    target, set: set.patch, clear, reason, adminId: session.padmin, expectedVersion,
  });
  if (!result.ok) {
    const status = result.error === "version_conflict" ? 409 : result.error === "target_not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  await platformAudit({
    adminId: session.padmin,
    businessId: target.scope === "platform" ? null : target.businessId,
    action: "desktop_update_policy.write",
    entity: "desktop_update_policy",
    entityId: `${target.scope}:${result.layer.version}`,
    payload: { target, reason, set: set.patch, clear, before: result.before, after: result.layer.patch, version: result.layer.version },
  });
  return NextResponse.json({ layer: result.layer });
});
