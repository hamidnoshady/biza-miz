import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { addReviewRoundItems } from "@/lib/media-review-service";
import { mediaReviewErrorResponse, readReviewBody, reviewActor } from "../../../review-guard";

/**
 * Add assets to a round.
 *
 * Only while the round is open for items — draft, sent back for changes, or
 * rejected. Once a client is reading a batch, the batch stops changing: adding a
 * file to a round under review means the client approves something they were never
 * shown, and migration 0265 refuses it at the row level for exactly that reason.
 *
 * Membership of the tenant is *not* checked here. The trigger on
 * `media_review_round_items` refuses an asset belonging to another business or one
 * that is in the bin, which is a stronger guarantee than anything this route could
 * assert — it holds for a hand-written query too, and it is the guard §E's "never
 * public cross-tenant URLs" actually rests on, since a client link resolves to a
 * round and the round resolves to its items.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
    if (error) return error;

    const body = await readReviewBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const { id } = await context.params;
    const formats =
      body.formats && typeof body.formats === "object" && !Array.isArray(body.formats)
        ? (body.formats as Record<string, unknown>)
        : {};

    try {
      const round = await addReviewRoundItems(
        session.businessId,
        reviewActor(session),
        id,
        Array.isArray(body.assetIds) ? body.assetIds : [],
        formats,
      );
      return NextResponse.json({ round });
    } catch (err) {
      const mapped = mediaReviewErrorResponse(err);
      if (mapped) return mapped;
      throw err;
    }
  },
);
