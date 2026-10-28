import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { revokeReviewLink } from "@/lib/media-review-service";
import { mediaReviewErrorResponse, reviewActor } from "../../../../../review-guard";

/**
 * Revoke a client link. Immediate, and the row stays.
 *
 * This is the reason §E streams bytes through the application instead of handing
 * out presigned URLs. `presignS3Get` already exists and would have been one line,
 * but a presigned URL keeps working until it expires no matter what anybody
 * decides — so with one, "revoke" would mean "wait up to thirty days", and a
 * client cut off for cause would still hold every file. Here revocation takes
 * effect on the next request.
 *
 * Revoking is idempotent: a screen that double-submits is told it succeeded, not
 * that it failed. The row is never deleted, because a revoked link that has
 * disappeared cannot answer the question an agency actually asks afterwards —
 * "did they open it before I cut them off?" `use_count` and `last_used_at` still
 * move on a revoked row for exactly that reason, and migration 0265 freezes
 * everything else about it.
 *
 * The verb is POST-to-`revoke` rather than DELETE. DELETE would promise the row is
 * gone, and it is not — it is history, deliberately, and a route that says
 * otherwise would be a lie the audit trail contradicts.
 */
export const POST = withTenantScope(
  async (
    _request: NextRequest,
    context: { params: Promise<{ id: string; linkId: string }> },
  ) => {
    const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
    if (error) return error;

    const { linkId } = await context.params;
    try {
      const link = await revokeReviewLink(session.businessId, reviewActor(session), linkId);
      return NextResponse.json({ link });
    } catch (err) {
      const mapped = mediaReviewErrorResponse(err);
      if (mapped) return mapped;
      throw err;
    }
  },
);
