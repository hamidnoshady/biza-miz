import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listResearchRuns } from "@/lib/ai-research";
import {
  RESEARCH_SUPERSEDED_BY,
  researchRetiredBody,
  RESEARCH_RETIRED_STATUS,
} from "@/lib/ai-research-retirement";

/**
 * Issue #812 §5 — Deep Research history; issue #1367 — retired for new work.
 *
 * `GET` is the read-only compatibility surface: a member still sees their own
 * historical runs, their sourced findings and their costs, scoped to this
 * business and to their own `user_id`. Nothing about that data changes when the
 * workflow is retired, which is the whole point of retiring it rather than
 * deleting it.
 *
 * `POST` used to create a run in `awaiting_approval` and is now gone. The
 * refusal is here, at the boundary, and again in `createResearchRun`, so a
 * direct request cannot create a run by calling the route or the service.
 */
export const GET = withTenantScope(async () => {
  // §11 — reading a run history is an assistant capability, not a management
  // one: the runs listed are this member's own, and the read is scoped by
  // `userId` below. `withTenantScope` establishes the business; this is what
  // establishes that the caller may spend its budget at all.
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const session = guard.session;
  const runs = await listResearchRuns({ businessId: session.businessId, userId: session.sub });
  return NextResponse.json({
    runs,
    // Additive: tells a client that this is history, not a launch surface, so a
    // cached page does not keep offering a create button after the rollout.
    retired: true,
    supersededBy: RESEARCH_SUPERSEDED_BY,
  });
});

export const POST = withTenantScope(async (_request: NextRequest) => {
  // Authorization still runs first: an unauthorized caller learns nothing about
  // the platform's product decisions, only that they may not use the assistant.
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;

  // Issue #1367 — no new Deep Research job, ever, through this route. 410 Gone
  // rather than 404: the endpoint exists and the caller needs a stable code, so
  // a stale client can show the right message instead of retrying.
  return NextResponse.json(researchRetiredBody(), { status: RESEARCH_RETIRED_STATUS });
});
