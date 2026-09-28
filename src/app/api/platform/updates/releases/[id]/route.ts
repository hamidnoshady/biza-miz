import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { updateDesktopReleaseRollout, type ReleaseLifecycleStatus, type ReleaseRolloutState } from "@/lib/desktop-release-service";
import { isUuid } from "@/lib/uuid";

interface Context { params: Promise<{ id: string }> }

export const PATCH = withPlatformScope(async (request: NextRequest, context: Context) => {
  const { session, error } = await requirePlatformCapability("updates.manage");
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const statuses: ReleaseLifecycleStatus[] = ["draft", "published", "paused", "withdrawn"];
  const rollouts: ReleaseRolloutState[] = ["internal", "pilot", "percentage", "full", "paused"];
  if (!statuses.includes(body.status as ReleaseLifecycleStatus) || !rollouts.includes(body.rolloutState as ReleaseRolloutState)) {
    return NextResponse.json({ error: "invalid_release_state" }, { status: 400 });
  }
  const rolloutState = body.rolloutState as ReleaseRolloutState;
  const rolloutPercentage = rolloutState === "full" ? 100
    : rolloutState === "pilot" || rolloutState === "percentage" ? Number(body.rolloutPercentage) : 0;
  if (!Number.isInteger(rolloutPercentage) ||
      (rolloutState === "pilot" && (rolloutPercentage < 1 || rolloutPercentage > 20)) ||
      (rolloutState === "percentage" && (rolloutPercentage < 1 || rolloutPercentage > 99))) {
    return NextResponse.json({ error: "invalid_rollout_percentage" }, { status: 400 });
  }
  const release = await updateDesktopReleaseRollout(id, {
    status: body.status as ReleaseLifecycleStatus,
    rolloutState,
    rolloutPercentage,
  });
  if (!release) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await platformAudit({
    adminId: session.padmin,
    action: "desktop_release.rollout.update",
    entity: "platform_release",
    entityId: release.id,
    payload: { status: release.status, rolloutState: release.rolloutState, rolloutPercentage: release.rolloutPercentage },
  });
  return NextResponse.json({ release });
});
