import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isReviewRoundStatus } from "@/lib/media-review";
import { createReviewRound, listReviewRounds } from "@/lib/media-review-service";
import { mediaReviewErrorResponse, readReviewBody, reviewActor } from "../review-guard";

/**
 * Review rounds — the batches an agency sends a client for approval (issue #1128
 * §E).
 *
 * A round, and not an asset, is the unit of client approval: agencies send a
 * batch, collect decisions, revise and resend, and it is the sequence of rounds
 * over one asset that constitutes its version history. That is also why the
 * client and campaign live here rather than on `media_assets` — the asset is a
 * file, and who it is *for* is a property of the engagement. One creative sent to
 * two clients is two rounds over one asset, which a column on the asset could not
 * represent without picking a winner.
 *
 * Reading is `media.view`; assembling a round is `media.manage`. There is
 * deliberately no approve-style media permission, because the party who approves
 * is the client and the client is not a member: they are authorised by the token
 * in `/api/media/review/[token]`, never by a tenant role.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const rawStatus = params.get("status") ?? "all";
  // An unrecognised filter is ignored rather than refused: a stale bookmark or a
  // screen that predates a status should still show the list, not an error.
  const status =
    rawStatus === "open" || rawStatus === "all" || isReviewRoundStatus(rawStatus) ? rawStatus : "all";
  const limit = Number(params.get("limit") ?? "");

  const rounds = await listReviewRounds(session.businessId, {
    status,
    projectId: params.get("projectId"),
    clientPartyId: params.get("clientPartyId"),
    campaignId: params.get("campaignId"),
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return NextResponse.json({ rounds });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;

  const body = await readReviewBody(request);
  if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  // `formats` is keyed by asset id and is advisory metadata: an unknown key or
  // value is dropped by the service rather than refused, because a stale picker
  // value must not block sending a client their proofs.
  const formats =
    body.formats && typeof body.formats === "object" && !Array.isArray(body.formats)
      ? (body.formats as Record<string, unknown>)
      : {};
  const assetIds = Array.isArray(body.assetIds) ? body.assetIds : [];

  try {
    const round = await createReviewRound(session.businessId, reviewActor(session), {
      title: String(body.title ?? ""),
      note: body.note == null ? null : String(body.note),
      projectId: body.projectId == null ? null : String(body.projectId),
      clientPartyId: body.clientPartyId == null ? null : String(body.clientPartyId),
      campaignId: body.campaignId == null ? null : String(body.campaignId),
      assetIds,
      formats,
    });
    return NextResponse.json({ round }, { status: 201 });
  } catch (err) {
    const mapped = mediaReviewErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
});
