import { NextRequest, NextResponse } from "next/server";
import { decideReviewRound, getClientReviewView } from "@/lib/media-review-service";
import { mediaReviewErrorResponse, readReviewBody } from "../../review-guard";

/**
 * The client's review screen, addressed by token alone.
 *
 * This route is in `api-guards.test.ts`'s `PUBLIC_ROUTES` with a reason attached,
 * and the reason matters: there is no session to require here, because the party
 * reading it is not a member and must never become one. §B asks for client review
 * *without a new staff identity system*, so the credential is the token — short
 * lived, scoped to one round, revocable — and the guard is `resolveReviewToken`
 * running before a single row is read. Authorising by membership would mean
 * inviting the client onto the staff list to look at their own proofs.
 *
 * Every response is `no-store`. The URL carries a secret, so a shared cache or a
 * proxy log keying on it would be handing the credential to somebody else; the
 * client's own browser has no use for a cached approval screen either, since its
 * whole job is to show the current state.
 *
 * GET is the view. POST is the client's decision on the *whole* round — approve,
 * request changes, or reject — and returns the refreshed view so the screen can
 * update in place without a second request. Per-item decisions live on
 * `items/[assetId]`; splitting them keeps "one asset" and "the whole batch" from
 * being the same endpoint doing two different jobs.
 */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const view = await getClientReviewView(token);
    return NextResponse.json({ view }, { headers: NO_STORE });
  } catch (err) {
    const mapped = mediaReviewErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  const body = await readReviewBody(request);
  if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const view = await decideReviewRound(token, {
      action: body.action,
      // The name is free text and is never used to look anybody up: it exists so
      // the audit trail can say *who* at the client decided, which a token cannot
      // tell us on its own.
      clientName: body.clientName,
      note: body.note,
    });
    return NextResponse.json({ view }, { headers: NO_STORE });
  } catch (err) {
    const mapped = mediaReviewErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
