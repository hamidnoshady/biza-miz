import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { LEARNING_PATH_EVENT_TYPES } from "@/lib/learning-paths";
import { applyLearningPathEvent, learningPathById, learningPathProgressView, pathsForViewer, type LearningPathEvent } from "@/lib/learning-paths";
import { learningPathViewerFor } from "@/lib/learning-paths-service";
import { recordLearningPathEvent } from "@/lib/learning-paths-service";

/**
 * Records what the caller has completed of one learning path (issue #972,
 * item 3).
 *
 * The body names an event (`start | step_completed | pause | complete | reset`)
 * and, for `step_completed` and `pause`, a step id of the CURRENT revision.
 * Eligibility is re-checked on every write. Events are monotone unions, so a
 * retry or a second device is harmless; only `reset` removes anything.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ pathId: string }> }) => {
    const guard = await requireMember();
    if (guard.error) return guard.error;

    const { pathId } = await context.params;
    const path = learningPathById(pathId);
    if (!path) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const viewer = await learningPathViewerFor(
      guard.session.businessId,
      guard.membership.permissions,
    );
    const visible = pathsForViewer([path], {
      permissions: viewer.permissions,
      industry: viewer.industry,
    });
    if (visible.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const tour = visible[0];

    const body: unknown = await request.json().catch(() => null);
    const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const type = raw?.event;
    if (typeof type !== "string" || !(LEARNING_PATH_EVENT_TYPES as readonly string[]).includes(type)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    let event: LearningPathEvent;
    if (type === "step_completed" || type === "pause") {
      if (typeof raw?.stepId !== "string" || raw.stepId.length > 64) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      event = { type, stepId: raw.stepId } as LearningPathEvent;
    } else {
      event = { type } as LearningPathEvent;
    }

    const result = await recordLearningPathEvent(
      guard.session.businessId,
      guard.session.sub,
      tour,
      event,
    );
    if (!result.ok) {
      const status = result.error === "steps_uncompleted" ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    // Completed tours referenced by `tour` steps are confirmed through
    // tour progress; the path progress row itself only stores what the
    // client has explicitly marked complete.
    return NextResponse.json({
      progress: learningPathProgressView(tour, result.progress),
    });
  },
);
