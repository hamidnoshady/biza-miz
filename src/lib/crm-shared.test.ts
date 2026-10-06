import { describe, expect, it } from "vitest";
// The breach rule moved to its own pure module — see the note in `crm-shared.ts`
// about why it is not re-exported from there.
import { caseIsBreached } from "./crm-case-clock";
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABELS,
  ACTIVITY_STATE_LABELS,
  ACTIVITY_STATE_TONES,
  ACTIVITY_ASSIGNEE_MAX,
  ACTIVITY_BODY_MAX,
  ACTIVITY_STATES,
  ACTIVITY_SUBJECT_MAX,
  activityState,
  isActivityState,
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_PRIORITY_TARGET_HOURS,
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  CASE_STATUS_TONES,
  CONSENT_CHANNELS,
  CONSENT_CHANNEL_LABELS,
  CONSENT_SOURCES,
  CONSENT_SOURCE_LABELS,
  DEAL_STAGES,
  DEAL_STAGE_META,
  DUPLICATE_REASON_LABELS,
  duplicateConfidence,
  isActivityKind,
  isCasePriority,
  isCaseStatus,
  isDealStage,
  isOpenCase,
  mergeConsent,
  mergeTags,
  OPEN_DEAL_STAGES,
  sortTimeline,
  TIMELINE_KINDS,
  TIMELINE_KIND_LABELS,
  weightedPipelineValue,
  winRate,
  type TimelineEvent,
} from "./crm-shared";

describe("deal stages", () => {
  it("treats only won and lost as terminal", () => {
    expect(OPEN_DEAL_STAGES).toEqual(["lead", "qualified", "proposal", "negotiation"]);
    expect(DEAL_STAGE_META.won.terminal).toBe(true);
    expect(DEAL_STAGE_META.lost.terminal).toBe(true);
  });

  it("has Persian metadata and a sane probability for every stage", () => {
    for (const stage of DEAL_STAGES) {
      const meta = DEAL_STAGE_META[stage];
      expect(meta.key).toBe(stage);
      expect(/[\u0600-\u06FF]/.test(meta.label)).toBe(true);
      expect(meta.probability).toBeGreaterThanOrEqual(0);
      expect(meta.probability).toBeLessThanOrEqual(100);
    }
  });

  it("increases the default probability along the pipeline", () => {
    const open = OPEN_DEAL_STAGES.map((stage) => DEAL_STAGE_META[stage].probability);
    for (let i = 1; i < open.length; i += 1) expect(open[i]).toBeGreaterThan(open[i - 1]);
  });

  it("validates stage strings", () => {
    expect(isDealStage("proposal")).toBe(true);
    expect(isDealStage("closed")).toBe(false);
    expect(isDealStage(null)).toBe(false);
  });
});

describe("weightedPipelineValue", () => {
  it("weights each open deal by its probability", () => {
    const value = weightedPipelineValue([
      { stage: "lead", valueRial: 10_000_000, probability: 10 },
      { stage: "negotiation", valueRial: 10_000_000, probability: 75 },
    ]);
    expect(value).toBe(1_000_000 + 7_500_000);
  });

  it("falls back to the stage's default probability", () => {
    expect(weightedPipelineValue([{ stage: "qualified", valueRial: 1_000_000, probability: null }])).toBe(300_000);
  });

  it("excludes won deals so the forecast never double-counts the ledger", () => {
    // A won deal's money is already an order and a journal entry; counting it
    // in the pipeline too would be a second, unreconciled source of truth.
    const value = weightedPipelineValue([
      { stage: "won", valueRial: 90_000_000, probability: 100 },
      { stage: "lost", valueRial: 50_000_000, probability: 0 },
    ]);
    expect(value).toBe(0);
  });

  it("is zero for an empty pipeline", () => {
    expect(weightedPipelineValue([])).toBe(0);
  });

  it("stays in whole Rial", () => {
    const value = weightedPipelineValue([{ stage: "proposal", valueRial: 333_333, probability: 55 }]);
    expect(Number.isInteger(value)).toBe(true);
  });
});

describe("winRate", () => {
  it("counts only decided deals — an open deal is not yet a loss", () => {
    const rate = winRate([
      { stage: "won" },
      { stage: "lost" },
      { stage: "lead" },
      { stage: "negotiation" },
    ]);
    expect(rate).toBe(50);
  });

  it("returns zero when nothing has been decided", () => {
    expect(winRate([{ stage: "lead" }])).toBe(0);
    expect(winRate([])).toBe(0);
  });
});

describe("activityState", () => {
  const today = "2026-03-10";

  it("calls a task due today «امروز», not overdue", () => {
    // Nobody's morning list should open with the day's own work already red.
    expect(activityState({ dueAt: "2026-03-10T09:00:00Z", completedAt: null }, today)).toBe("due");
  });

  it("marks yesterday's unfinished task overdue", () => {
    expect(activityState({ dueAt: "2026-03-09T09:00:00Z", completedAt: null }, today)).toBe("overdue");
  });

  it("keeps a completed task done even when it was late", () => {
    expect(
      activityState({ dueAt: "2026-01-01T09:00:00Z", completedAt: "2026-02-01T09:00:00Z" }, today),
    ).toBe("done");
  });

  it("treats an activity with no due date as planned, never overdue", () => {
    expect(activityState({ dueAt: null, completedAt: null }, today)).toBe("planned");
  });

  it("names every state it labels, and nothing else", () => {
    // The list's filter chips iterate ACTIVITY_STATES; a state with no label
    // would render an empty chip.
    for (const state of ACTIVITY_STATES) {
      expect(ACTIVITY_STATE_LABELS[state]).toBeTruthy();
      expect(isActivityState(state)).toBe(true);
    }
    expect(isActivityState("cancelled")).toBe(false);
    expect(isActivityState(undefined)).toBe(false);
  });

  it("keeps the field ceilings usable, not merely present", () => {
    // The API rejects past these and the inputs mirror them as maxLength, so a
    // ceiling below a realistic title would silently truncate real work.
    expect(ACTIVITY_SUBJECT_MAX).toBeGreaterThanOrEqual(100);
    expect(ACTIVITY_BODY_MAX).toBeGreaterThan(ACTIVITY_SUBJECT_MAX);
    expect(ACTIVITY_ASSIGNEE_MAX).toBeGreaterThanOrEqual(60);
  });

  it("has a Persian label and a tone for every state", () => {
    for (const state of ["done", "due", "overdue", "planned"] as const) {
      expect(/[\u0600-\u06FF]/.test(ACTIVITY_STATE_LABELS[state])).toBe(true);
      expect(ACTIVITY_STATE_TONES[state]).toBeTruthy();
    }
    // Overdue is the only state that should shout.
    expect(ACTIVITY_STATE_TONES.overdue).toBe("danger");
  });

  it("validates activity kinds and labels each one", () => {
    for (const kind of ACTIVITY_KINDS) expect(ACTIVITY_KIND_LABELS[kind]).toBeTruthy();
    expect(isActivityKind("call")).toBe(true);
    expect(isActivityKind("email")).toBe(false);
  });
});

describe("cases", () => {
  const now = new Date("2026-03-10T12:00:00Z");

  it("breaches an urgent case left open past its target", () => {
    expect(
      caseIsBreached(
        { status: "open", priority: "urgent", openedAt: "2026-03-10T00:00:00Z", resolvedAt: null },
        now,
      ),
    ).toBe(true);
  });

  it("does not breach a case that is still inside its target", () => {
    expect(
      caseIsBreached(
        { status: "open", priority: "normal", openedAt: "2026-03-10T00:00:00Z", resolvedAt: null },
        now,
      ),
    ).toBe(false);
  });

  it("does not blame the shop while the clock belongs to the customer", () => {
    // `waiting` means we asked the customer something. Marking the shop late
    // for the customer's silence would make the indicator meaningless.
    expect(
      caseIsBreached(
        { status: "waiting", priority: "urgent", openedAt: "2020-01-01T00:00:00Z", resolvedAt: null },
        now,
      ),
    ).toBe(false);
  });

  it("never breaches a finished case", () => {
    for (const status of ["resolved", "closed"] as const) {
      expect(
        caseIsBreached(
          { status, priority: "urgent", openedAt: "2020-01-01T00:00:00Z", resolvedAt: "2020-01-02T00:00:00Z" },
          now,
        ),
      ).toBe(false);
    }
  });

  it("survives an unparsable opened_at instead of reporting a false breach", () => {
    expect(
      caseIsBreached({ status: "open", priority: "urgent", openedAt: "not a date", resolvedAt: null }, now),
    ).toBe(false);
  });

  it("orders the priority targets from most to least urgent", () => {
    expect(CASE_PRIORITY_TARGET_HOURS.urgent).toBeLessThan(CASE_PRIORITY_TARGET_HOURS.high);
    expect(CASE_PRIORITY_TARGET_HOURS.high).toBeLessThan(CASE_PRIORITY_TARGET_HOURS.normal);
    expect(CASE_PRIORITY_TARGET_HOURS.normal).toBeLessThan(CASE_PRIORITY_TARGET_HOURS.low);
  });

  it("knows which statuses still need attention", () => {
    expect(isOpenCase("open")).toBe(true);
    expect(isOpenCase("in_progress")).toBe(true);
    expect(isOpenCase("waiting")).toBe(true);
    expect(isOpenCase("resolved")).toBe(false);
    expect(isOpenCase("closed")).toBe(false);
  });

  it("labels and tones every status and priority in Persian", () => {
    for (const status of CASE_STATUSES) {
      expect(/[\u0600-\u06FF]/.test(CASE_STATUS_LABELS[status])).toBe(true);
      expect(CASE_STATUS_TONES[status]).toBeTruthy();
    }
    for (const priority of CASE_PRIORITIES) {
      expect(/[\u0600-\u06FF]/.test(CASE_PRIORITY_LABELS[priority])).toBe(true);
    }
    expect(isCaseStatus("open")).toBe(true);
    expect(isCaseStatus("archived")).toBe(false);
    expect(isCasePriority("urgent")).toBe(true);
    expect(isCasePriority("critical")).toBe(false);
  });
});

describe("sortTimeline", () => {
  const event = (summary: string, at: string): TimelineEvent => ({
    at,
    kind: "note",
    kindLabel: TIMELINE_KIND_LABELS.note,
    summary,
  });

  it("puts the newest event first", () => {
    const sorted = sortTimeline([
      event("old", "2026-01-01T00:00:00Z"),
      event("new", "2026-03-01T00:00:00Z"),
      event("mid", "2026-02-01T00:00:00Z"),
    ]);
    expect(sorted.map((e) => e.summary)).toEqual(["new", "mid", "old"]);
  });

  it("does not mutate the array it was given", () => {
    // The timeline service merges several capped source lists; sorting one of
    // them in place would reorder a caller's own array behind its back.
    const input = [event("a", "2026-01-01T00:00:00Z"), event("b", "2026-03-01T00:00:00Z")];
    sortTimeline(input);
    expect(input.map((e) => e.summary)).toEqual(["a", "b"]);
  });

  it("has a Persian label for every timeline kind", () => {
    for (const kind of TIMELINE_KINDS) {
      expect(/[\u0600-\u06FF]/.test(TIMELINE_KIND_LABELS[kind])).toBe(true);
    }
  });
});

describe("merge rules", () => {
  it("intersects consent — a merge can never grant permission nobody gave", () => {
    // The one asymmetry in the whole merge: everything else unions, consent
    // ANDs, because the merged record must be defensible from both sides.
    expect(mergeConsent(true, true)).toBe(true);
    expect(mergeConsent(true, false)).toBe(false);
    expect(mergeConsent(false, true)).toBe(false);
    expect(mergeConsent(false, false)).toBe(false);
  });

  it("unions tags and drops blanks", () => {
    expect(mergeTags(["vip", "tehran"], ["vip", "wholesale"])).toEqual(["vip", "tehran", "wholesale"]);
    expect(mergeTags(null, null)).toEqual([]);
    expect(mergeTags(["  "], ["a"])).toEqual(["a"]);
  });

  it("ranks a shared phone above a shared email above a shared name", () => {
    expect(duplicateConfidence("phone")).toBeGreaterThan(duplicateConfidence("email"));
    expect(duplicateConfidence("email")).toBeGreaterThan(duplicateConfidence("name"));
    // «محمد محمدی» is not one person: a name match must stay a question.
    expect(duplicateConfidence("name")).toBeLessThan(50);
    expect(duplicateConfidence("shoe size" as never)).toBe(0);
  });

  it("labels every duplicate reason", () => {
    for (const reason of ["phone", "email", "name"] as const) {
      expect(/[\u0600-\u06FF]/.test(DUPLICATE_REASON_LABELS[reason])).toBe(true);
    }
  });
});

describe("consent vocabulary", () => {
  it("labels every channel and source in Persian", () => {
    for (const channel of CONSENT_CHANNELS) {
      expect(/[\u0600-\u06FF]/.test(CONSENT_CHANNEL_LABELS[channel])).toBe(true);
    }
    for (const source of CONSENT_SOURCES) {
      expect(/[\u0600-\u06FF]/.test(CONSENT_SOURCE_LABELS[source])).toBe(true);
    }
  });

  it("includes «merge» as a source, so a consent lost to a merge is explainable", () => {
    expect(CONSENT_SOURCES).toContain("merge");
  });
});
