import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { TOUR_EVENT_TYPES, tourProgressView, type TourProgressEvent } from "@/lib/tours";
import { eligibleTourById, recordTourEvent } from "@/lib/tours-service";

/**
 * Records what the caller has seen of one tour (issue #972).
 *
 * The body names an event (`start | step_seen | pause | complete | reset`)
 * and, for the two step events, a step id of the CURRENT revision. There is
 * deliberately no field in which a client could claim a business action
 * succeeded: `step_seen` means the member pressed Next, and it is REFUSED for
 * an `action` step (`requires_evidence`). Those complete only through
 * `POST …/verify`, which asks the server to look up the domain evidence
 * (`tour_action_evidence`) for the step's verifier. Eligibility is re-checked on every write, so
 * a permission removed mid-tour stops the writes. Events are monotone unions
 * (see `applyTourEvent`), so a retry or a second device is harmless; only
 * `reset` removes anything, and only the caller's own row.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ tourId: string }> }) => {
    const guard = await requireMember();
    if (guard.error) return guard.error;

    const { tourId } = await context.params;
    const tour = await eligibleTourById(tourId, guard.session.businessId, guard.membership.permissions);
    if (!tour) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const body: unknown = await request.json().catch(() => null);
    const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const type = raw?.event;
    if (typeof type !== "string" || !(TOUR_EVENT_TYPES as readonly string[]).includes(type)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    let event: TourProgressEvent;
    if (type === "step_seen" || type === "pause") {
      if (typeof raw?.stepId !== "string" || raw.stepId.length > 64) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      event = { type, stepId: raw.stepId };
    } else {
      event = { type } as TourProgressEvent;
    }

    const result = await recordTourEvent(guard.session.businessId, guard.session.sub, tour, event);
    if (!result.ok) {
      // `requires_evidence` is a client mistake (it tried to mark an `action`
      // step as merely seen); `steps_unseen` is a state conflict. Neither is a
      // 500, and neither records anything.
      const status = result.error === "steps_unseen" ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ progress: tourProgressView(tour, result.progress) });
  },
);
