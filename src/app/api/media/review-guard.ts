/**
 * The shared guard and error map for §E's media review routes, the same shape as
 * `/api/aec/guard.ts`, `/api/workspace/guard.ts` and `/api/agency/guard.ts`.
 *
 * Two doors, one map. The tenant routes under `review-rounds/*` guard with
 * `requirePermission(PERMISSIONS.mediaView | mediaManage)` in the route file
 * itself, which is what `api-guards.test.ts`'s static scan looks for — a domain
 * helper that hides the call would be invisible to it, which is why §D needed a
 * bespoke predicate and this does not.
 *
 * The client routes under `review/[token]/*` have no session to require, and
 * that is not an oversight to be exempted but the feature: an external client is
 * authorised *by the token*, and `resolveReviewToken` is that guard. It checks
 * the namespace before any lookup, resolves the tenant from the token rather than
 * from a cookie, requires the link to be both unexpired and unrevoked, and
 * requires the round to still be with the client. Those routes are listed in
 * `api-guards.test.ts`'s documented public map with that reasoning written down.
 *
 * Note the asymmetry the statuses encode: there is no approve-style media
 * permission, because the client is not a member and must never become one.
 * Granting a client a user account to record a decision would be a second
 * identity system, which §B forbids.
 */
import { NextResponse } from "next/server";
import {
  MEDIA_REVIEW_ERROR_CODES,
  MediaReviewError,
  type MediaReviewErrorCode,
  type ReviewActor,
} from "@/lib/media-review-service";

/**
 * Code → HTTP status, exhaustively typed over the service's own union.
 *
 * `Record<MediaReviewErrorCode, number>` is the point: adding a code to the
 * service without giving it a status here fails `tsc`, so a new refusal cannot
 * quietly fall through to a default and be reported as the wrong kind of
 * failure. `review-guard.test.ts` pins the values as well as the coverage.
 *
 * The client-facing four are deliberately distinct statuses rather than one 403,
 * because they tell the client to do three different things: `token_expired` is
 * 410 Gone — ask the agency for a new link; `token_revoked` is 403 — the agency
 * cut this off on purpose, ask them why; `round_not_sent` is 404 — there is
 * nothing to review right now. "This link does not work" is not an answer anybody
 * can act on.
 */
export const MEDIA_REVIEW_ERROR_STATUS: Record<MediaReviewErrorCode, number> = {
  // The request itself is wrong.
  missing_fields: 400,
  invalid_format: 400,
  invalid_purpose: 400,
  invalid_action: 400,
  invalid_status: 400,
  note_required: 400,
  too_many_items: 400,
  // Nothing to act on: refusing to confirm which of these exists is the point.
  round_not_found: 404,
  link_not_found: 404,
  item_not_found: 404,
  asset_not_found: 404,
  round_not_sent: 404,
  // The credential is bad, spent or deliberately withdrawn.
  invalid_token: 401,
  token_expired: 410,
  token_revoked: 403,
  download_not_permitted: 403,
  // Allowed in principle, not while the round is in this state.
  round_frozen: 409,
  round_not_open_for_items: 409,
  invalid_transition: 409,
  items_pending: 409,
  items_not_approved: 409,
  link_exists: 409,
  // Not the caller's fault and not permanent.
  storage_unavailable: 503,
};

/** The actor a tenant route passes down, from the session it already verified. */
export function reviewActor(session: { sub: string; fullName?: string | null }): ReviewActor {
  return { userId: session.sub, fullName: session.fullName ?? "" };
}

/**
 * Map a service refusal to a response, or null when it is not one.
 *
 * Returning null rather than a blanket 500 is deliberate: the route rethrows what
 * this does not recognise, so an unexpected error still reaches the platform's own
 * handler and log instead of being laundered into a generic message. That is the
 * same reason `media-errors.ts` exists — a caught exception must not become an
 * uninformative one.
 */
export function mediaReviewErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof MediaReviewError) {
    const status = MEDIA_REVIEW_ERROR_STATUS[err.code] ?? 400;
    return NextResponse.json({ error: err.code }, { status });
  }
  return null;
}

/**
 * Parse a JSON body, or null.
 *
 * A malformed body is a 400 and not a thrown exception: a client screen posting
 * at a stale tab should be told its request was wrong, not that the server broke.
 */
export async function readReviewBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every code the service can throw, re-exported so a test can pin the map. */
export { MEDIA_REVIEW_ERROR_CODES, MediaReviewError };
export type { MediaReviewErrorCode };
