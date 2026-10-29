import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { transitionReviewRound } from "@/lib/media-review-service";
import { mediaReviewErrorResponse, readReviewBody, reviewActor } from "../../../review-guard";

/**
 * The agency's half of the round's state machine: `send` and `withdraw`.
 *
 * One route for both rather than an endpoint per move, so the transition table in
 * `media-review.ts` stays the only place that says what may follow what. A route
 * per move is how a codebase ends up with five handlers that each believe
 * something slightly different about which states are legal.
 *
 * The client's three decisions are deliberately *not* here. They arrive through
 * `/api/media/review/[token]`, authorised by the token, because the client is not
 * a member and must never be given a tenant role to act with — a `media.approve`
 * permission would be an invitation to solve that by adding the client to the
 * staff list, which §B forbids.
 *
 * Withdrawing revokes every live link in the same transaction. That is not
 * tidiness: a withdrawn round whose link still worked would be a round the agency
 * believes it has taken back and has not.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
    if (error) return error;

    const body = await readReviewBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const { id } = await context.params;
    try {
      const round = await transitionReviewRound(
        session.businessId,
        reviewActor(session),
        id,
        body.action,
      );
      return NextResponse.json({ round });
    } catch (err) {
      const mapped = mediaReviewErrorResponse(err);
      if (mapped) return mapped;
      throw err;
    }
  },
);
