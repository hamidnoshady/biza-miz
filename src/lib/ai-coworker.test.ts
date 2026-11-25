import { describe, expect, it } from "vitest";
import { AUTOPILOT_DEFAULTS, type AutopilotCategorySetting } from "./ai-autopilot";
import type { LocalBusinessClock } from "./ai-proactive";
import type { ProposedAction } from "./ai";
import {
  dedupeKeyForEvent,
  dedupeKeyForSchedule,
  eventMatchesJob,
  planCoworkerActions,
  runStatusFromActions,
  scheduleDedupeKeyIfDue,
  summarizeRun,
  validateJobInput,
  type CoworkerJobInput,
} from "./ai-coworker";

const clock: LocalBusinessClock = { dateKey: "2026-08-23", hour: 22, weekday: 0 };

function job(overrides: Partial<CoworkerJobInput> = {}): CoworkerJobInput {
  return {
    templateKey: "shift_close_waste",
    title: "ضایعات نان",
    locationId: null,
    projectId: null,
    triggerKind: "event",
    eventKind: "shift_close",
    scheduleHour: null,
    scheduleWeekday: null,
    params: {},
    approvalMode: "ask",
    enabled: true,
    ...overrides,
  };
}

const wasteAction: ProposedAction = {
  type: "inventory.waste.log",
  title: "ضایعات نان",
  summary: "۴ عدد",
  payload: { inventoryItemId: "item-1", quantity: "4", reason: "spoilage" },
};

function enabledWaste(): AutopilotCategorySetting {
  return { ...AUTOPILOT_DEFAULTS.waste, enabled: true };
}

describe("validateJobInput", () => {
  it("accepts a well-formed event job", () => {
    expect(validateJobInput(job())).toEqual([]);
  });

  it("accepts a well-formed schedule job and requires its hour", () => {
    expect(
      validateJobInput(job({ triggerKind: "schedule", eventKind: null, scheduleHour: 8 })),
    ).toEqual([]);
    expect(
      validateJobInput(job({ triggerKind: "schedule", eventKind: null, scheduleHour: null })),
    ).toContain("coworker_hour_invalid");
  });

  it("refuses a job that is half event and half schedule — it would fire twice", () => {
    expect(validateJobInput(job({ scheduleHour: 8 }))).toContain("coworker_trigger_mixed");
    expect(
      validateJobInput(job({ triggerKind: "schedule", scheduleHour: 8 })),
    ).toContain("coworker_trigger_mixed");
  });

  it("requires an event kind for an event trigger", () => {
    expect(validateJobInput(job({ eventKind: null }))).toContain("coworker_event_required");
  });

  it("bounds the hour and weekday", () => {
    const base = { triggerKind: "schedule" as const, eventKind: null };
    expect(validateJobInput(job({ ...base, scheduleHour: 24 }))).toContain("coworker_hour_invalid");
    expect(validateJobInput(job({ ...base, scheduleHour: 8, scheduleWeekday: 9 }))).toContain(
      "coworker_weekday_invalid",
    );
  });
});

describe("scheduleDedupeKeyIfDue", () => {
  const scheduled = job({ triggerKind: "schedule", eventKind: null, scheduleHour: 8 });

  it("is due from its hour onwards, so a box asleep at 08:00 still runs at 09:40", () => {
    expect(scheduleDedupeKeyIfDue(scheduled, { ...clock, hour: 7 })).toBeNull();
    expect(scheduleDedupeKeyIfDue(scheduled, { ...clock, hour: 8 })).toBe("schedule:2026-08-23:08");
    expect(scheduleDedupeKeyIfDue(scheduled, { ...clock, hour: 9 })).toBe("schedule:2026-08-23:08");
  });

  it("keys per local business day, so the same hour tomorrow is a different claim", () => {
    const today = scheduleDedupeKeyIfDue(scheduled, { ...clock, hour: 8 });
    const tomorrow = scheduleDedupeKeyIfDue(scheduled, { dateKey: "2026-08-24", hour: 8, weekday: 1 });
    expect(today).not.toBe(tomorrow);
  });

  it("honours a weekday pin and an off switch", () => {
    const weekly = { ...scheduled, scheduleWeekday: 6 };
    expect(scheduleDedupeKeyIfDue(weekly, { ...clock, hour: 8, weekday: 0 })).toBeNull();
    expect(scheduleDedupeKeyIfDue(weekly, { ...clock, hour: 8, weekday: 6 })).not.toBeNull();
    expect(scheduleDedupeKeyIfDue({ ...scheduled, enabled: false }, { ...clock, hour: 8 })).toBeNull();
  });

  it("never fires an event or manual job on the clock", () => {
    expect(scheduleDedupeKeyIfDue(job(), clock)).toBeNull();
    expect(scheduleDedupeKeyIfDue(job({ triggerKind: "manual", eventKind: null }), clock)).toBeNull();
  });
});

describe("eventMatchesJob", () => {
  it("matches its own kind only", () => {
    expect(eventMatchesJob(job(), { kind: "shift_close", locationId: "loc-1" })).toBe(true);
    expect(eventMatchesJob(job(), { kind: "shift_open", locationId: "loc-1" })).toBe(false);
  });

  it("a branch-scoped job ignores every other branch's events", () => {
    const scoped = job({ locationId: "loc-1" });
    expect(eventMatchesJob(scoped, { kind: "shift_close", locationId: "loc-1" })).toBe(true);
    expect(eventMatchesJob(scoped, { kind: "shift_close", locationId: "loc-2" })).toBe(false);
  });

  it("an all-branch job follows whichever branch raised the event", () => {
    expect(eventMatchesJob(job(), { kind: "shift_close", locationId: "loc-2" })).toBe(true);
  });

  it("a disabled job matches nothing", () => {
    expect(eventMatchesJob(job({ enabled: false }), { kind: "shift_close", locationId: null })).toBe(false);
  });
});

describe("dedupe keys", () => {
  it("namespaces by trigger so an event and a schedule can never collide", () => {
    expect(dedupeKeyForEvent("abc")).toBe("event:abc");
    expect(dedupeKeyForSchedule(clock, 8)).toBe("schedule:2026-08-23:08");
  });
});

describe("planCoworkerActions — the approval gate", () => {
  const base = {
    actions: [wasteAction],
    settingFor: () => enabledWaste(),
    appliedTodayInCategory: () => 0,
    contextFor: () => ({ documentValueRial: 100_000 }),
  };

  it("holds everything when the owner chose 'ask me first'", () => {
    const [plan] = planCoworkerActions({ ...base, approvalMode: "ask", hasAuthorizer: true });
    expect(plan.decision.decision).toBe("needs_confirmation");
  });

  it("never applies waste unattended, even in 'auto' with the caps admitting it (GH #1567 F7)", () => {
    const [plan] = planCoworkerActions({ ...base, approvalMode: "auto", hasAuthorizer: true });
    expect(plan.decision).toMatchObject({ decision: "needs_confirmation", reasonCode: "human_approval_required" });
  });

  it("Phase 38 — holds a website publish even in 'auto' mode with a fully open setting", () => {
    const publish = { type: "website.post.publish" as const, title: "انتشار", summary: "", payload: { postId: "p1" } };
    const [plan] = planCoworkerActions({
      ...base,
      actions: [publish],
      approvalMode: "auto",
      hasAuthorizer: true,
      settingFor: () => ({ enabled: true, maxAmountRial: null, maxPercent: null, maxItemsPerRun: 99, dailyActionLimit: 99 }),
    });
    expect(plan.decision).toMatchObject({ decision: "needs_confirmation", reasonCode: "action_not_eligible" });
  });

  it("refuses to write unattended with no human's authority behind it", () => {
    const [plan] = planCoworkerActions({ ...base, approvalMode: "auto", hasAuthorizer: false });
    // A stock write is held for a human before the authority is even asked.
    expect(plan.decision).toMatchObject({ decision: "needs_confirmation", reasonCode: "human_approval_required" });
  });

  it("cannot be a way around Phase 31's caps — an over-cap action is still held", () => {
    const [plan] = planCoworkerActions({
      ...base,
      approvalMode: "auto",
      hasAuthorizer: true,
      // Way past the waste category's default 2,000,000 ﷼ ceiling.
      contextFor: () => ({ documentValueRial: 900_000_000 }),
    });
    expect(plan.decision).toMatchObject({ decision: "needs_confirmation", reasonCode: "human_approval_required" });
  });

  it("holds an action whose category the owner never switched on", () => {
    const [plan] = planCoworkerActions({
      ...base,
      approvalMode: "auto",
      hasAuthorizer: true,
      settingFor: () => AUTOPILOT_DEFAULTS.waste,
    });
    expect(plan.decision).toMatchObject({ decision: "needs_confirmation", reasonCode: "human_approval_required" });
  });

  it("holds an action that has no unattended executor at all", () => {
    const [plan] = planCoworkerActions({
      ...base,
      approvalMode: "auto",
      hasAuthorizer: true,
      actions: [
        {
          // menu.item.create is now human-gated (F7) and would answer first;
          // a table merge is ungated and has no unattended executor.
          type: "table.merge",
          title: "ادغام میز",
          summary: "",
          payload: { sourceOrderId: "o1", targetOrderId: "o2" },
        },
      ],
      settingFor: () => null,
    });
    expect(plan.decision).toMatchObject({
      decision: "needs_confirmation",
      reasonCode: "action_not_eligible",
    });
  });
});

describe("runStatusFromActions", () => {
  it("distinguishes a night that half-worked from one that failed", () => {
    expect(runStatusFromActions(["applied", "applied"])).toBe("applied");
    expect(runStatusFromActions(["applied", "failed"])).toBe("partially_applied");
    expect(runStatusFromActions(["failed", "failed"])).toBe("failed");
    expect(runStatusFromActions(["rejected", "rejected"])).toBe("rejected");
  });

  it("stays pending while any action still awaits a decision", () => {
    expect(runStatusFromActions(["applied", "pending"])).toBe("pending_approval");
  });

  it("treats no actions as nothing to do, not as a failure", () => {
    expect(runStatusFromActions([])).toBe("skipped");
  });
});

describe("summarizeRun", () => {
  it("prefers the skip reason, in the owner's own terms", () => {
    expect(summarizeRun({ jobTitle: "ضایعات نان", statuses: [], skipReason: "چیزی نمانده بود." })).toBe(
      "چیزی نمانده بود.",
    );
  });

  it("counts what actually happened", () => {
    expect(summarizeRun({ jobTitle: "ضایعات", statuses: ["applied", "pending", "failed"] })).toContain(
      "۱ اقدام ثبت شد".replace("۱", "1"),
    );
  });
});
