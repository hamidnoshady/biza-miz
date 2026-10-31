import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createReviewLink } from "@/lib/media-review-service";
import { mediaReviewErrorResponse, readReviewBody, reviewActor } from "../../../review-guard";

/**
 * Mint a scoped client link for a round.
 *
 * The response is the *only* time the plaintext token exists anywhere. It is
 * returned once, to the member who asked for it, and never stored: the database
 * holds its sha-256 and a non-secret display prefix, and migration 0265 pins the
 * hash to `^[0-9a-f]{64}$` so a plaintext token could not be persisted even by a
 * bug. A screen that fails to show it must ask for a new link, which is the correct
 * failure — an unrecoverable credential is the point, not an inconvenience.
 *
 * One live link per round per purpose, held by a partial unique index. Re-issuing
 * therefore replaces rather than accumulating tokens that all still work, which is
 * the rule migration 0022 set for invitations: a drawer full of valid links nobody
 * can enumerate is a drawer full of ways to be leaked.
 *
 * `purpose` is not a preference. A `review` link lets a client look and decide; a
 * `download` link hands over bytes. Approving a print-ready proof is not the same
 * as being given it, and an agency that is still owed for the work decides when
 * the bytes move — so widening one to the other is a separate, deliberate grant.
 *
 * Gated on `media.manage`, the only write permission the Media Library has. There
 * is no approve-style media permission and this is not the place to invent one:
 * the party who approves is the client, and the client is authorised by holding
 * the token, never by a tenant role.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
    if (error) return error;

    const body = await readReviewBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const { id } = await context.params;
    try {
      const { link, token } = await createReviewLink(session.businessId, reviewActor(session), id, {
        purpose: body.purpose,
        ttlDays: body.ttlDays,
      });
      // `token` appears in this response and nowhere else, ever.
      return NextResponse.json({ link, token }, { status: 201 });
    } catch (err) {
      const mapped = mediaReviewErrorResponse(err);
      if (mapped) return mapped;
      throw err;
    }
  },
);
