import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  deleteReviewRound,
  getReviewRound,
  updateReviewRound,
  type UpdateReviewRoundInput,
} from "@/lib/media-review-service";
import { mediaReviewErrorResponse, readReviewBody, reviewActor } from "../../review-guard";

/**
 * One review round: its items, its links and the trail of who did what.
 *
 * The GET is what an agency screen opens to see a round, and it carries the three
 * things a dashboard has to be able to show at once — how far the client has got
 * (`itemCount` / `decidedCount`), which links are still live, and the audit trail.
 * A round with a live link is a round somebody outside the tenant can open right
 * now, which is a fact an agency needs in view rather than behind a second call.
 *
 * DELETE removes a *draft* only. Migration 0265 refuses any other state, because a
 * round a client has seen is history whether or not they decided on it; the check
 * in the service exists so the refusal arrives as a code a screen can translate
 * («این دور ارسال شده است») rather than as a constraint violation.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.mediaView);
    if (error) return error;

    const { id } = await context.params;
    const round = await getReviewRound(session.businessId, id);
    if (!round) return NextResponse.json({ error: "round_not_found" }, { status: 404 });
    return NextResponse.json({ round });
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
    if (error) return error;

    const body = await readReviewBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const { id } = await context.params;
    // Built field by field with `in`, and *not* by coercing each value to a
    // string. The distinction is the whole point of a PATCH: an absent field is
    // left alone, while a field explicitly set to null is cleared. Collapsing the
    // two — `body.note == null ? null : String(body.note)` — would turn every
    // partial edit into a full overwrite and silently blank the fields a screen
    // did not send. §D shipped exactly that bug and paid for it in CI.
    const patch: UpdateReviewRoundInput = {};
    if ("title" in body) patch.title = body.title;
    if ("note" in body) patch.note = body.note;
    if ("projectId" in body) patch.projectId = body.projectId;
    if ("clientPartyId" in body) patch.clientPartyId = body.clientPartyId;
    if ("campaignId" in body) patch.campaignId = body.campaignId;

    try {
      const round = await updateReviewRound(session.businessId, reviewActor(session), id, patch);
      return NextResponse.json({ round });
    } catch (err) {
      const mapped = mediaReviewErrorResponse(err);
      if (mapped) return mapped;
      throw err;
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
    if (error) return error;

    const { id } = await context.params;
    try {
      await deleteReviewRound(session.businessId, reviewActor(session), id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      const mapped = mediaReviewErrorResponse(err);
      if (mapped) return mapped;
      throw err;
    }
  },
);
