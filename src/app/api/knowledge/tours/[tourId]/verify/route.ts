import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { tourProgressView } from "@/lib/tours";
import { eligibleTourById, loadTourProgress, verifyTourStep } from "@/lib/tours-service";

/**
 * Asks the server to confirm one verified-action step (issue #972, phase 2).
 *
 * The body carries ONE field — a step id. There is no `done`, `success` or
 * `evidence` field, by design: the answer comes from `tour_action_evidence`,
 * which only the domain endpoints that performed the write can populate, so a
 * page script cannot mark a sale, a product or a customer as created.
 *
 *  200 `{ verified: true, evidenceAt, evidenceBeforeTour, progress }` — evidence
       found (and whether the member had already done it before this run), the
       step is now seen
 *  409 `{ error: "evidence_missing" }`           — not done yet (the normal state
 *                                                  while the member is still on
 *                                                  the form; the overlay keeps
 *                                                  checking)
 *  400 — unknown step of this revision, or the step asks for nothing real
 *  404 — unknown or ineligible tour, exactly like every other tour read
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
    if (typeof raw?.stepId !== "string" || raw.stepId.length > 64) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    // Read the run's start before the write: it is what separates "you just did
    // it" from "you already knew how", and the write would move it forward.
    const before = await loadTourProgress(guard.session.businessId, guard.session.sub, [tour.id]);
    const startedAt = before.get(tour.id)?.startedAt ?? null;

    const result = await verifyTourStep(guard.session.businessId, guard.session.sub, tour, raw.stepId);
    if (!result.ok) {
      const status = result.error === "evidence_missing" ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({
      verified: true,
      evidenceAt: result.evidenceAt,
      evidenceBeforeTour: startedAt === null || Date.parse(result.evidenceAt) < Date.parse(startedAt),
      progress: tourProgressView(tour, result.progress),
    });
  },
);
