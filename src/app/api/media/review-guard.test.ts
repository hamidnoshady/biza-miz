/**
 * Pins §E's error map.
 *
 * The value of this file is not the assertions, it is the *type*: `EXPECTED_STATUS`
 * is declared `Record<MediaReviewErrorCode, number>`, so adding a refusal code to
 * the service without deciding what HTTP status it deserves fails `tsc` here
 * before it can reach a route. That is the same net §D's `guard.test.ts` spreads,
 * and it caught a real omission there (`schedule_impact_required`).
 *
 * The status values themselves are also pinned, because a silent renumbering is a
 * behaviour change no type can see: a client screen that branches on 410 to say
 * «ask the agency for a new link» breaks if that becomes a 403, and nothing else
 * in the build would notice.
 */
import { describe, expect, it } from "vitest";
import {
  MEDIA_REVIEW_ERROR_CODES,
  MEDIA_REVIEW_ERROR_STATUS,
  MediaReviewError,
  mediaReviewErrorResponse,
  readReviewBody,
  reviewActor,
  type MediaReviewErrorCode,
} from "./review-guard";

/**
 * The statuses §E's screens and clients are written against, spelled out.
 *
 * If you are changing one of these, you are changing an API contract: the client
 * review screen distinguishes 401 / 403 / 410 / 404 to tell somebody whose link
 * died what to do next, and a tenant screen distinguishes 400 from 409 to know
 * whether to re-show a form or to explain a state.
 */
const EXPECTED_STATUS: Record<MediaReviewErrorCode, number> = {
  missing_fields: 400,
  invalid_format: 400,
  invalid_purpose: 400,
  invalid_action: 400,
  invalid_status: 400,
  note_required: 400,
  too_many_items: 400,
  round_not_found: 404,
  link_not_found: 404,
  item_not_found: 404,
  asset_not_found: 404,
  round_not_sent: 404,
  invalid_token: 401,
  token_expired: 410,
  token_revoked: 403,
  download_not_permitted: 403,
  round_frozen: 409,
  round_not_open_for_items: 409,
  invalid_transition: 409,
  items_pending: 409,
  items_not_approved: 409,
  link_exists: 409,
  storage_unavailable: 503,
};

describe("media review error map (issue #1128 §E)", () => {
  it("gives every code the status the contract says", () => {
    for (const code of MEDIA_REVIEW_ERROR_CODES) {
      expect(MEDIA_REVIEW_ERROR_STATUS[code], `${code} status drifted`).toBe(EXPECTED_STATUS[code]);
    }
  });

  it("maps exactly the codes the service can throw, and no others", () => {
    // A key here that the service cannot throw is a status nobody will ever see;
    // a code the service can throw that is missing here would fall through to the
    // `?? 400` default and be reported as a bad request when it is not one.
    expect([...Object.keys(MEDIA_REVIEW_ERROR_STATUS)].sort()).toEqual(
      [...MEDIA_REVIEW_ERROR_CODES].sort(),
    );
  });

  it("has no duplicate statuses hiding two different meanings", () => {
    // Not a rule about uniqueness — several codes legitimately share 400 — but the
    // four client-facing credential outcomes must each be distinguishable, because
    // each tells the client to do something different.
    const clientCodes: MediaReviewErrorCode[] = [
      "invalid_token",
      "token_expired",
      "token_revoked",
      "round_not_sent",
    ];
    const statuses = clientCodes.map((code) => EXPECTED_STATUS[code]);
    expect(new Set(statuses).size, "two credential refusals share a status").toBe(statuses.length);
  });

  it("answers a MediaReviewError with its code and status", async () => {
    const response = mediaReviewErrorResponse(new MediaReviewError("token_expired"));
    expect(response).not.toBeNull();
    expect(response?.status).toBe(410);
    expect(await response?.json()).toEqual({ error: "token_expired" });
  });

  it("returns null for anything else, so a route rethrows rather than launders", () => {
    expect(mediaReviewErrorResponse(new Error("connection reset"))).toBeNull();
    expect(mediaReviewErrorResponse(undefined)).toBeNull();
    expect(mediaReviewErrorResponse("token_expired")).toBeNull();
  });

  it("builds an actor from a session, tolerating a missing display name", () => {
    expect(reviewActor({ sub: "u1", fullName: "نازنین" })).toEqual({ userId: "u1", fullName: "نازنین" });
    // The service falls back to reading users.full_name, and then to a Persian
    // label, so an empty name here must not throw — the trail still gets a name.
    expect(reviewActor({ sub: "u2" })).toEqual({ userId: "u2", fullName: "" });
    expect(reviewActor({ sub: "u3", fullName: null })).toEqual({ userId: "u3", fullName: "" });
  });

  it("reads a JSON object body and refuses anything that is not one", async () => {
    const json = (body: string) =>
      new Request("http://localhost/api/media/review-rounds", { method: "POST", body });

    expect(await readReviewBody(json(`{"title":"x"}`))).toEqual({ title: "x" });
    expect(await readReviewBody(json(`not json`))).toBeNull();
    // An array or a scalar is not a body this API can act on, and accepting one
    // would let `body.title` read as undefined rather than be refused.
    expect(await readReviewBody(json(`[1,2]`))).toBeNull();
    expect(await readReviewBody(json(`"x"`))).toBeNull();
    expect(await readReviewBody(json(`null`))).toBeNull();
  });
});
