import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  removeReviewRoundItem,
  updateReviewRoundItem,
} from "@/lib/media-review-service";
import { mediaReviewErrorResponse, readReviewBody, reviewActor } from "../../../../review-guard";

/**
 * One asset inside one round: its agency-facing metadata, and its removal.
 *
 * Both are limited to a round that is still open for items. Relabelling a file
 * underneath a client who is reading the batch is the same failure as swapping the
 * file, so `format`, `version_label` and `position` freeze with everything else.
 *
 * `format` is metadata and not a new `media_assets.kind`: that column is
 * `image | video | document` and every upload path in the product branches on it,
 * so nine agency formats belong on the review item — and in the library's existing
 * `category` — rather than in an enum twelve other trades read.
 *
 * PATCH distinguishes an absent field from an explicit null, so a screen can clear
 * a version label without resending the rest of the item. Collapsing the two would
 * make every partial edit a full overwrite.
 */
export const PATCH = withTenantScope(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string; assetId: string }> },
  ) => {
    const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
    if (error) return error;

    const body = await readReviewBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const { id, assetId } = await context.params;
    const patch: { format?: unknown; versionLabel?: unknown; position?: unknown } = {};
    if ("format" in body) patch.format = body.format;
    if ("versionLabel" in body) patch.versionLabel = body.versionLabel;
    if ("position" in body) patch.position = body.position;

    try {
      const round = await updateReviewRoundItem(
        session.businessId,
        reviewActor(session),
        id,
        assetId,
        patch,
      );
      return NextResponse.json({ round });
    } catch (err) {
      const mapped = mediaReviewErrorResponse(err);
      if (mapped) return mapped;
      throw err;
    }
  },
);

export const DELETE = withTenantScope(
  async (
    _request: NextRequest,
    context: { params: Promise<{ id: string; assetId: string }> },
  ) => {
    const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
    if (error) return error;

    const { id, assetId } = await context.params;
    try {
      const round = await removeReviewRoundItem(
        session.businessId,
        reviewActor(session),
        id,
        assetId,
      );
      return NextResponse.json({ round });
    } catch (err) {
      const mapped = mediaReviewErrorResponse(err);
      if (mapped) return mapped;
      throw err;
    }
  },
);
