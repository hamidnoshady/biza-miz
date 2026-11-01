/**
 * Pins §C's error map.
 *
 * The value of this file is not the assertions, it is the *type*: `EXPECTED_STATUS`
 * is declared `Record<AgencyCampaignErrorCode, number>`, so adding a refusal code to
 * the service without deciding what HTTP status it deserves fails `tsc` here before
 * it can reach a route. That is the same net §E's `review-guard.test.ts` spreads and
 * §D's `guard.test.ts` before it, which caught a real omission there.
 *
 * The status values are pinned as well, because a silent renumbering is a behaviour
 * change no type can see. This screen's split is the one every register in the
 * product uses — 404 for a record that is not there, 400 for a field the member typed
 * wrong, 409 for anything a record refuses *because of where it is in its life
 * cycle* — and the campaigns section renders «این کمپین بسته شده است» off the 409s.
 * Turning one of those into a 400 would make the screen re-show an editable form for
 * a record that cannot be edited.
 */
import { describe, expect, it } from "vitest";
import { AgencyCampaignError } from "@/lib/agency-campaign-service";
import type { AgencyCampaignErrorCode } from "./campaign-guard";
import {
  AGENCY_CAMPAIGN_ERROR_CODES,
  AGENCY_CAMPAIGN_ERROR_STATUS,
  campaignActor,
  campaignErrorResponse,
  readCampaignBody,
} from "./campaign-guard";

const EXPECTED_STATUS: Record<AgencyCampaignErrorCode, number> = {
  // A record that is not there.
  campaign_not_found: 404,

  // A field the member typed wrong, or left out. Re-showing the form is the answer,
  // so these are 400s.
  client_required: 400,
  title_required: 400,
  text_too_long: 400,
  invalid_channel: 400,
  too_many_channels: 400,
  invalid_date: 400,
  window_reversed: 400,
  invalid_metric: 400,
  clicks_exceed_impressions: 400,
  invalid_metrics_source: 400,
  invalid_reference: 400,
  invalid_action: 400,

  // A record that refuses because of where it is in its life cycle. The request was
  // reasonable; the state says no. `start_date_required` and `end_date_required`
  // belong here rather than with the 400s above for exactly that reason: the member
  // asked for a legitimate step and the *record* is unfinished, which no amount of
  // re-typing the same request will fix — but filling in a date will.
  invalid_transition: 409,
  campaign_closed: 409,
  start_date_required: 409,
  end_date_required: 409,
  campaign_not_deletable: 409,
};

describe("campaign-guard", () => {
  it("gives every refusal the status this screen is written against", () => {
    // Both directions, so the two lists cannot drift: every code the service can
    // throw has a pinned status, and every pinned status is a real code.
    expect([...AGENCY_CAMPAIGN_ERROR_CODES].sort()).toEqual(Object.keys(EXPECTED_STATUS).sort());
    for (const code of AGENCY_CAMPAIGN_ERROR_CODES) {
      expect(AGENCY_CAMPAIGN_ERROR_STATUS[code], code).toBe(EXPECTED_STATUS[code]);
    }
  });

  it("answers a refusal with its code and its status", async () => {
    for (const code of AGENCY_CAMPAIGN_ERROR_CODES) {
      const response = campaignErrorResponse(new AgencyCampaignError(code));
      expect(response, code).not.toBeNull();
      expect(response!.status, code).toBe(EXPECTED_STATUS[code]);
      const body = (await response!.json()) as { error?: string };
      // The code reaches the member verbatim: the section holds the Persian wording,
      // because a message that has to be translated on the server is a message that
      // gets translated twice.
      expect(body.error, code).toBe(code);
    }
  });

  it("translates what 0278's trigger raises into a refusal this feature means", async () => {
    // 23514 is where §A's "without exposing another client's information" reaches
    // the member: the trigger refuses a foreign client, or one brand's campaign
    // carrying another brand's brief. The rule belongs to the database and the
    // translation belongs here.
    const check = campaignErrorResponse({ code: "23514", message: "client does not belong here" });
    expect(check!.status).toBe(400);
    expect(((await check!.json()) as { error?: string }).error).toBe("campaign_refused");

    // 23503 is the same door reached from a dangling reference.
    const foreign = campaignErrorResponse({ code: "23503", message: "violates foreign key" });
    expect(foreign!.status).toBe(400);

    // A lost race for the same series position is a collision, not a malformed
    // request: retrying the identical payload is the answer, so it is a 409.
    const unique = campaignErrorResponse({ code: "23505", message: "duplicate key" });
    expect(unique!.status).toBe(409);
  });

  it("returns null for anything it does not recognise, so a route rethrows it", () => {
    // §E's rule and it holds here: an unexpected error still reaches the platform's
    // own handler and log instead of being laundered into a generic message.
    expect(campaignErrorResponse(new Error("connection terminated"))).toBeNull();
    expect(campaignErrorResponse("not an error")).toBeNull();
    expect(campaignErrorResponse(null)).toBeNull();
    // A five-character string is not a SQLSTATE.
    expect(campaignErrorResponse({ code: "nope" })).toBeNull();
  });

  it("reads a body, and treats a malformed one as a 400 rather than an exception", async () => {
    const ok = await readCampaignBody(
      new Request("http://test/api/crm/client-campaigns", {
        method: "POST",
        body: JSON.stringify({ title: "بهاره" }),
      }),
    );
    expect(ok).toEqual({ title: "بهاره" });

    // A member posting from a stale tab is told their request was wrong, not that
    // the server broke.
    expect(
      await readCampaignBody(
        new Request("http://test/api/crm/client-campaigns", { method: "POST", body: "{not json" }),
      ),
    ).toBeNull();
    expect(
      await readCampaignBody(new Request("http://test/api/crm/client-campaigns", { method: "POST", body: "[]" })),
    ).toBeNull();
    expect(
      await readCampaignBody(
        new Request("http://test/api/crm/client-campaigns", { method: "POST", body: JSON.stringify(null) }),
      ),
    ).toBeNull();
    // An empty object *is* a body — the service decides that an empty patch is a
    // no-op returning the row, and that decision is not this function's to make.
    expect(
      await readCampaignBody(new Request("http://test/api/crm/client-campaigns", { method: "POST", body: "{}" })),
    ).toEqual({});
  });

  it("takes the actor from the session the route already verified", () => {
    expect(campaignActor({ sub: "user-1", fullName: "مریم احمدی" })).toEqual({
      userId: "user-1",
      name: "مریم احمدی",
    });
    // A session with no display name still has an actor: an empty string rather than
    // `undefined`, because the column it lands in is NOT NULL.
    expect(campaignActor({ sub: "user-1", fullName: null })).toEqual({ userId: "user-1", name: "" });
    expect(campaignActor({ sub: "user-1" })).toEqual({ userId: "user-1", name: "" });
  });
});
