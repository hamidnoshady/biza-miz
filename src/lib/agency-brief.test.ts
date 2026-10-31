import { describe, expect, it } from "vitest";

import {
  AGENCY_BRIEF_ACTIONS,
  AGENCY_BRIEF_CHANNELS,
  AGENCY_BRIEF_CHANNEL_LIMIT,
  AGENCY_BRIEF_CHANNEL_LABELS,
  AGENCY_BRIEF_ACTION_LABELS,
  AGENCY_BRIEF_DELIVERABLE_LIMIT,
  AGENCY_BRIEF_QUANTITY_MAX,
  AGENCY_BRIEF_STATUSES,
  AGENCY_BRIEF_STATUS_LABELS,
  AGENCY_BRIEF_STATUS_TONES,
  AGENCY_BRIEF_TITLE_MAX_LENGTH,
  agencyBriefActionTarget,
  agencyBriefActionsFrom,
  agencyBriefConfirmationNeedsName,
  agencyBriefObjectiveRequired,
  canPerformAgencyBriefAction,
  canTransitionAgencyBrief,
  isAgencyBriefAction,
  isAgencyBriefChannel,
  isAgencyBriefDeletable,
  isAgencyBriefDeliverable,
  isAgencyBriefFrozen,
  isAgencyBriefOpen,
  isAgencyBriefStatus,
  normalizeAgencyBriefBudget,
  normalizeAgencyBriefChannels,
  normalizeAgencyBriefDeliverables,
  normalizeAgencyBriefText,
} from "./agency-brief";
import { AGENCY_MEDIA_FORMATS } from "./media-review";

describe("agency brief vocabulary", () => {
  it("names every status, and every one of them has a label and a tone", () => {
    expect(AGENCY_BRIEF_STATUSES).toEqual([
      "draft",
      "sent",
      "confirmed",
      "superseded",
      "withdrawn",
    ]);
    // Exhaustiveness: adding a status without a label would compile, because the
    // Record's key type widens with the union, but the panel would then render
    // `undefined`. These two loops are what make that a test failure instead.
    for (const status of AGENCY_BRIEF_STATUSES) {
      expect(AGENCY_BRIEF_STATUS_LABELS[status].length).toBeGreaterThan(0);
      expect(["active", "positive", "neutral", "danger"]).toContain(
        AGENCY_BRIEF_STATUS_TONES[status],
      );
    }
    expect(Object.keys(AGENCY_BRIEF_STATUS_LABELS)).toHaveLength(AGENCY_BRIEF_STATUSES.length);
    expect(Object.keys(AGENCY_BRIEF_STATUS_TONES)).toHaveLength(AGENCY_BRIEF_STATUSES.length);
  });

  it("names every action, and every one of them has a label", () => {
    expect(AGENCY_BRIEF_ACTIONS).toEqual(["send", "withdraw", "confirm", "supersede", "reopen"]);
    for (const action of AGENCY_BRIEF_ACTIONS) {
      expect(AGENCY_BRIEF_ACTION_LABELS[action].length).toBeGreaterThan(0);
    }
    expect(Object.keys(AGENCY_BRIEF_ACTION_LABELS)).toHaveLength(AGENCY_BRIEF_ACTIONS.length);
  });

  it("accepts only its own statuses and actions", () => {
    expect(isAgencyBriefStatus("confirmed")).toBe(true);
    expect(isAgencyBriefStatus("approved")).toBe(false);
    expect(isAgencyBriefStatus(null)).toBe(false);
    expect(isAgencyBriefStatus(7)).toBe(false);
    expect(isAgencyBriefAction("supersede")).toBe(true);
    expect(isAgencyBriefAction("delete")).toBe(false);
  });

  it("labels every channel, and reuses §E's format vocabulary for deliverables", () => {
    for (const channel of AGENCY_BRIEF_CHANNELS) {
      expect(AGENCY_BRIEF_CHANNEL_LABELS[channel].length).toBeGreaterThan(0);
    }
    expect(Object.keys(AGENCY_BRIEF_CHANNEL_LABELS)).toHaveLength(AGENCY_BRIEF_CHANNELS.length);
    // The point of the reuse: a deliverable and a review-round item can be
    // described in the same words, so `brief` has to still be one of them.
    expect(AGENCY_MEDIA_FORMATS).toContain("brief");
    expect(isAgencyBriefDeliverable({ title: "بریف کارفرما", format: "brief" })).toBe(true);
  });
});

describe("the brief's status chain", () => {
  it("runs draft -> sent -> confirmed -> superseded", () => {
    expect(canTransitionAgencyBrief("draft", "sent")).toBe(true);
    expect(canTransitionAgencyBrief("sent", "confirmed")).toBe(true);
    expect(canTransitionAgencyBrief("confirmed", "superseded")).toBe(true);
  });

  it("lets a brief be withdrawn from draft or from sent", () => {
    expect(canTransitionAgencyBrief("draft", "withdrawn")).toBe(true);
    expect(canTransitionAgencyBrief("sent", "withdrawn")).toBe(true);
  });

  it("lets a withdrawn brief be reopened, and nothing else move backwards", () => {
    expect(canTransitionAgencyBrief("withdrawn", "draft")).toBe(true);
    expect(canTransitionAgencyBrief("withdrawn", "sent")).toBe(false);
    expect(canTransitionAgencyBrief("withdrawn", "confirmed")).toBe(false);
  });

  it("refuses to skip sending, and refuses to un-confirm anything", () => {
    // Confirming a brief the client was never shown would record an agreement
    // that never happened.
    expect(canTransitionAgencyBrief("draft", "confirmed")).toBe(false);
    expect(canTransitionAgencyBrief("confirmed", "draft")).toBe(false);
    expect(canTransitionAgencyBrief("confirmed", "sent")).toBe(false);
    expect(canTransitionAgencyBrief("confirmed", "withdrawn")).toBe(false);
    expect(canTransitionAgencyBrief("superseded", "draft")).toBe(false);
    expect(canTransitionAgencyBrief("superseded", "confirmed")).toBe(false);
  });

  it("maps each action onto exactly the transition it is allowed to make", () => {
    expect(agencyBriefActionTarget("send")).toBe("sent");
    expect(agencyBriefActionTarget("withdraw")).toBe("withdrawn");
    expect(agencyBriefActionTarget("confirm")).toBe("confirmed");
    expect(agencyBriefActionTarget("supersede")).toBe("superseded");
    expect(agencyBriefActionTarget("reopen")).toBe("draft");
    for (const status of AGENCY_BRIEF_STATUSES) {
      for (const action of AGENCY_BRIEF_ACTIONS) {
        expect(canPerformAgencyBriefAction(status, action)).toBe(
          canTransitionAgencyBrief(status, agencyBriefActionTarget(action)),
        );
      }
    }
  });

  it("offers the panel only actions the route would accept", () => {
    expect(agencyBriefActionsFrom("draft")).toEqual(["send", "withdraw"]);
    expect(agencyBriefActionsFrom("sent")).toEqual(["withdraw", "confirm"]);
    expect(agencyBriefActionsFrom("confirmed")).toEqual(["supersede"]);
    expect(agencyBriefActionsFrom("withdrawn")).toEqual(["reopen"]);
    // A superseded brief is a closed record: nothing left to do to it.
    expect(agencyBriefActionsFrom("superseded")).toEqual([]);
  });

  it("freezes only what the client has confirmed", () => {
    expect(isAgencyBriefFrozen("draft")).toBe(false);
    // `sent` is not frozen: correcting a brief before anyone relies on it is
    // ordinary work, and the client has agreed to nothing yet.
    expect(isAgencyBriefFrozen("sent")).toBe(false);
    expect(isAgencyBriefFrozen("confirmed")).toBe(true);
    expect(isAgencyBriefFrozen("superseded")).toBe(true);
    expect(isAgencyBriefFrozen("withdrawn")).toBe(false);
  });

  it("counts a draft or a sent brief as open work", () => {
    expect(isAgencyBriefOpen("draft")).toBe(true);
    expect(isAgencyBriefOpen("sent")).toBe(true);
    expect(isAgencyBriefOpen("confirmed")).toBe(false);
    expect(isAgencyBriefOpen("superseded")).toBe(false);
    expect(isAgencyBriefOpen("withdrawn")).toBe(false);
  });

  it("deletes only drafts", () => {
    expect(isAgencyBriefDeletable("draft")).toBe(true);
    for (const status of AGENCY_BRIEF_STATUSES) {
      if (status !== "draft") expect(isAgencyBriefDeletable(status)).toBe(false);
    }
  });

  it("demands an objective only once the client is being asked to read it", () => {
    expect(agencyBriefObjectiveRequired("draft")).toBe(false);
    expect(agencyBriefObjectiveRequired("sent")).toBe(true);
    expect(agencyBriefObjectiveRequired("confirmed")).toBe(true);
    expect(agencyBriefObjectiveRequired("superseded")).toBe(true);
    expect(agencyBriefObjectiveRequired("withdrawn")).toBe(false);
  });

  it("demands a name when the client's confirmation is recorded", () => {
    expect(agencyBriefConfirmationNeedsName("confirm")).toBe(true);
    for (const action of AGENCY_BRIEF_ACTIONS) {
      if (action !== "confirm") expect(agencyBriefConfirmationNeedsName(action)).toBe(false);
    }
  });
});

describe("channel normalisation", () => {
  it("keeps vocabulary order and drops duplicates", () => {
    expect(normalizeAgencyBriefChannels(["print", "social", "print"])).toEqual([
      "social",
      "print",
    ]);
    expect(normalizeAgencyBriefChannels([])).toEqual([]);
    expect(normalizeAgencyBriefChannels(undefined)).toEqual([]);
    expect(normalizeAgencyBriefChannels(null)).toEqual([]);
  });

  it("refuses rather than silently dropping a channel nobody recognises", () => {
    // The refusal is the point: a typo that vanished would leave the brief
    // describing less than the client asked for, and nothing would say so.
    expect(normalizeAgencyBriefChannels(["social", "billboard"])).toBeNull();
    expect(normalizeAgencyBriefChannels("social")).toBeNull();
    expect(normalizeAgencyBriefChannels([null])).toBeNull();
    expect(normalizeAgencyBriefChannels(["SOCIAL"])).toBeNull();
  });

  it("refuses more channels than a brief can carry", () => {
    const tooMany = AGENCY_BRIEF_CHANNELS.slice(0, AGENCY_BRIEF_CHANNEL_LIMIT).concat("other");
    expect(tooMany).toHaveLength(AGENCY_BRIEF_CHANNEL_LIMIT + 1);
    expect(normalizeAgencyBriefChannels(tooMany)).toBeNull();
    expect(normalizeAgencyBriefChannels([...AGENCY_BRIEF_CHANNELS])).toEqual([
      ...AGENCY_BRIEF_CHANNELS,
    ]);
  });

  it("accepts only its own channel keys", () => {
    expect(isAgencyBriefChannel("outdoor")).toBe(true);
    expect(isAgencyBriefChannel("billboard")).toBe(false);
  });
});

describe("deliverable normalisation", () => {
  it("keeps a well-formed deliverable and fills in what was omitted", () => {
    expect(normalizeAgencyBriefDeliverables([{ title: " تیزر نوروز " }])).toEqual([
      { title: "تیزر نوروز", format: null, quantity: null },
    ]);
    expect(
      normalizeAgencyBriefDeliverables([
        { title: "پوست", format: "static_creative", quantity: 8 },
      ]),
    ).toEqual([{ title: "پوست", format: "static_creative", quantity: 8 }]);
    expect(normalizeAgencyBriefDeliverables(undefined)).toEqual([]);
    expect(normalizeAgencyBriefDeliverables(null)).toEqual([]);
  });

  it("refuses a deliverable that is not one", () => {
    expect(normalizeAgencyBriefDeliverables([{ title: "" }])).toBeNull();
    expect(normalizeAgencyBriefDeliverables([{ title: "   " }])).toBeNull();
    expect(normalizeAgencyBriefDeliverables([{}])).toBeNull();
    expect(normalizeAgencyBriefDeliverables([{ title: "x", format: "hologram" }])).toBeNull();
    expect(normalizeAgencyBriefDeliverables(["تیزر"])).toBeNull();
    expect(normalizeAgencyBriefDeliverables({ title: "تیزر" })).toBeNull();
    expect(normalizeAgencyBriefDeliverables([null])).toBeNull();
  });

  it("refuses a quantity that is not a count of things", () => {
    expect(isAgencyBriefDeliverable({ title: "x", quantity: 0 })).toBe(false);
    expect(isAgencyBriefDeliverable({ title: "x", quantity: -3 })).toBe(false);
    expect(isAgencyBriefDeliverable({ title: "x", quantity: 2.5 })).toBe(false);
    expect(isAgencyBriefDeliverable({ title: "x", quantity: "3" })).toBe(false);
    expect(isAgencyBriefDeliverable({ title: "x", quantity: 3 })).toBe(true);
    expect(isAgencyBriefDeliverable({ title: "x", quantity: null })).toBe(true);
    expect(
      isAgencyBriefDeliverable({ title: "x", quantity: AGENCY_BRIEF_QUANTITY_MAX + 1 }),
    ).toBe(false);
    expect(isAgencyBriefDeliverable({ title: "x", quantity: AGENCY_BRIEF_QUANTITY_MAX })).toBe(true);
  });

  it("refuses a title longer than the column holds, and too many deliverables", () => {
    const longTitle = "ا".repeat(AGENCY_BRIEF_TITLE_MAX_LENGTH + 1);
    expect(isAgencyBriefDeliverable({ title: longTitle })).toBe(false);
    const atTheLimit = Array.from({ length: AGENCY_BRIEF_DELIVERABLE_LIMIT }, (_, i) => ({
      title: `قلم ${i + 1}`,
    }));
    expect(normalizeAgencyBriefDeliverables(atTheLimit)).toHaveLength(
      AGENCY_BRIEF_DELIVERABLE_LIMIT,
    );
    expect(normalizeAgencyBriefDeliverables([...atTheLimit, { title: "یکی بیشتر" }])).toBeNull();
  });
});

describe("budget and text normalisation", () => {
  it("treats an unsaid budget as absent, never as zero", () => {
    expect(normalizeAgencyBriefBudget(undefined)).toBeNull();
    expect(normalizeAgencyBriefBudget(null)).toBeNull();
    expect(normalizeAgencyBriefBudget("")).toBeNull();
    // Zero would read as "the client offered nothing", which is a different fact.
    expect(normalizeAgencyBriefBudget(0)).toBeNull();
    expect(normalizeAgencyBriefBudget(-500)).toBeNull();
    expect(normalizeAgencyBriefBudget(Number.NaN)).toBeNull();
    expect(normalizeAgencyBriefBudget(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeAgencyBriefBudget("abc")).toBeNull();
  });

  it("rounds a real budget to whole rial", () => {
    expect(normalizeAgencyBriefBudget(1500)).toBe(1500);
    expect(normalizeAgencyBriefBudget("1500")).toBe(1500);
    expect(normalizeAgencyBriefBudget(1500.4)).toBe(1500);
    expect(normalizeAgencyBriefBudget(1500.6)).toBe(1501);
    expect(normalizeAgencyBriefBudget(1)).toBe(1);
  });

  it("trims text and refuses to truncate it", () => {
    expect(normalizeAgencyBriefText("  هدف  ", 100)).toBe("هدف");
    expect(normalizeAgencyBriefText(undefined, 100)).toBe("");
    expect(normalizeAgencyBriefText(null, 100)).toBe("");
    // Cutting a client's acceptance criteria to fit would change what they
    // agreed to, so over-long is refused rather than shortened.
    expect(normalizeAgencyBriefText("ا".repeat(AGENCY_BRIEF_TITLE_MAX_LENGTH + 1), AGENCY_BRIEF_TITLE_MAX_LENGTH)).toBeNull();
    expect(normalizeAgencyBriefText(7, 100)).toBeNull();
    expect(normalizeAgencyBriefText({}, 100)).toBeNull();
  });
});
