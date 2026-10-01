import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import {
  countUnseenAutopilotActivity,
  listAutopilotActivity,
  markAutopilotActivitySeen,
} from "@/lib/ai-autopilot-service";

/**
 * Phase 31 — what autopilot actually did. There is no notification channel in
 * this product, so this list plus the launcher's unseen badge is how an owner
 * learns an unattended action ran.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
  if (guard.error) return guard.error;
  const { businessId, sub } = guard.session;

  if (new URL(request.url).searchParams.get("countOnly") === "1") {
    return NextResponse.json({ unseenCount: await countUnseenAutopilotActivity(businessId, sub) });
  }
  const { entries } = await listAutopilotActivity(businessId);
  return NextResponse.json({ entries, unseenCount: await countUnseenAutopilotActivity(businessId, sub) });
});

/** Marks this user's badge read. Per user, so one manager cannot clear it for the owner. */
export const POST = withTenantScope(async () => {
  const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
  if (guard.error) return guard.error;
  await markAutopilotActivitySeen(guard.session.businessId, guard.session.sub);
  return NextResponse.json({ ok: true });
});
