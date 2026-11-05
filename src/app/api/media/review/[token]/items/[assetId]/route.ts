import { NextRequest, NextResponse } from "next/server";
import { decideReviewItem } from "@/lib/media-review-service";
import { mediaReviewErrorResponse, readReviewBody } from "../../../../review-guard";

/**
 * The client's decision on one asset in the round.
 *
 * Per-item, and not folded into the round endpoint, because the two are different
 * questions with different consequences: deciding an asset is reversible and
 * silent, while deciding the round settles the whole batch and moves the project
 * on. A screen that lets somebody approve five assets and then approve the round
 * is doing two things, and a route that does both would make it easy to do the
 * second one by accident.
 *
 * A decision replaces the previous one rather than accumulating — the same rule
 * migration 0022 sets for invitations — so the current status is a column and the
 * history of changing it lives in the event trail. Only a round in `sent` can be
 * decided on; a draft the client somehow reached, or one already settled, refuses
 * here and in the database.
 *
 * Like the rest of `/api/media/review/**` this is session-less by design and is
 * listed in `api-guards.test.ts`'s `PUBLIC_ROUTES`: the token is the credential,
 * and §B asks for client review without a new staff identity system, so the client
 * is never given a membership to authorise with.
 */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string; assetId: string }> },
): Promise<NextResponse> {
  const { token, assetId } = await context.params;
  const body = await readReviewBody(request);
  if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const view = await decideReviewItem(token, assetId, body.status, body.note);
    return NextResponse.json({ view }, { headers: NO_STORE });
  } catch (err) {
    const mapped = mediaReviewErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
