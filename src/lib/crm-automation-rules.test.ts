/**
 * The automations vocabulary, and the promises it makes.
 *
 * Four properties are pinned here, each of which is invisible until it breaks:
 *
 * 1. **A condition can only narrow a record that can satisfy it.** A
 *    `source_is` condition attached to a deal trigger would never hold, so the
 *    rule would silently never fire — the worst failure mode an automation can
 *    have, because nobody watches it.
 * 2. **An unknown value is refused, never ignored.** The validator rejects a
 *    condition, a source, a priority, an action and an action config it does not
 *    know, so "the rule looks scoped" cannot quietly mean "matches everything".
 * 3. **The only action that leaves the CRM is a signal.** Exactly one entry in
 *    the action vocabulary has `side: "growth"`, and it carries no channel, no
 *    template and no recipient — the boundary the issue draws, as a table.
 * 4. **The written form and the clock are deterministic.** `automationSentence`
 *    reads as «وقتی …، اگر …، آنگاه …», and `followUpDueAt` counts from the
 *    business's own day rather than from the server's clock.
 */
import { describe, expect, it } from "vitest";
import {
  CRM_AUTOMATION_ACTIONS,
  CRM_AUTOMATION_ACTION_DEFS,
  CRM_AUTOMATION_CONDITIONS,
  CRM_AUTOMATION_CONDITION_DEFS,
  CRM_AUTOMATION_NAME_MAX,
  CRM_AUTOMATION_TRIGGERS,
  CRM_AUTOMATION_TRIGGER_DEFS,
  FOLLOW_UP_HOUR,
  automationSentence,
  conditionsForTrigger,
  dealStageMoved,
  followUpDueAt,
  followUpSubject,
  matchesAutomationConditions,
  validateAutomationDraft,
  type CrmAutomationConditionValue,
} from "./crm-automation-rules";

const entity = {
  type: "deal" as const,
  id: "11111111-1111-4111-8111-111111111111",
  title: "قرارداد بزرگ",
  partyId: null,
};

describe("the automation vocabulary", () => {
  it("declares every condition only for triggers whose records can satisfy it", () => {
    for (const trigger of CRM_AUTOMATION_TRIGGERS) {
      const allowed = conditionsForTrigger(trigger);
      expect(allowed.length).toBeGreaterThan(0);
      for (const condition of allowed) {
        // The condition's own declaration and the trigger's view of it are the
        // same fact read from two sides; a mismatch is how one of them drifts.
        expect(CRM_AUTOMATION_CONDITION_DEFS[condition].triggers).toContain(trigger);
        // A condition with no value must say so, or the form would ask for one.
        if (CRM_AUTOMATION_CONDITION_DEFS[condition].valueKind === "none") {
          expect(CRM_AUTOMATION_CONDITION_DEFS[condition].label.length).toBeGreaterThan(0);
        }
      }
    }
    // Every trigger is about a record the audit vocabulary already names.
    for (const trigger of CRM_AUTOMATION_TRIGGERS) {
      expect(["deal", "case", "lead"]).toContain(CRM_AUTOMATION_TRIGGER_DEFS[trigger].entityType);
    }
  });

  it("leaves the CRM through exactly one action, and it carries no message", () => {
    const growth = CRM_AUTOMATION_ACTIONS.filter(
      (action) => CRM_AUTOMATION_ACTION_DEFS[action].side === "growth",
    );
    expect(growth).toEqual(["notify_growth"]);
    // A signal names a state, not a message: no template, no channel, no text.
    for (const action of CRM_AUTOMATION_ACTIONS) {
      const definition = CRM_AUTOMATION_ACTION_DEFS[action] as unknown as Record<string, unknown>;
      expect(definition.templateId).toBeUndefined();
      expect(definition.channel).toBeUndefined();
      expect(definition.recipients).toBeUndefined();
    }
  });
});

describe("validateAutomationDraft", () => {
  const base = {
    name: "پیگیری مذاکره",
    triggerKey: "deal_stage_changed",
    conditions: [{ key: "value_at_least", value: "10000000" }] as CrmAutomationConditionValue[],
    actionKey: "create_follow_up",
    actionConfig: { memberId: "22222222-2222-4222-8222-222222222222", offsetDays: 3 },
  };

  it("accepts a rule the product can actually run, and normalizes it", () => {
    const result = validateAutomationDraft(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("پیگیری مذاکره");
    expect(result.value.actionConfig.memberId).toBe("22222222-2222-4222-8222-222222222222");
    // A field the action does not use is stored as null rather than left over.
    const reassign = validateAutomationDraft({
      ...base,
      actionKey: "assign_owner",
      actionConfig: { memberId: "22222222-2222-4222-8222-222222222222", offsetDays: 7, signal: "at_risk" },
    });
    expect(reassign.ok).toBe(true);
    if (reassign.ok) {
      expect(reassign.value.actionConfig).toEqual({
        memberId: "22222222-2222-4222-8222-222222222222",
        offsetDays: null,
        signal: null,
      });
    }
  });

  it("refuses a condition the trigger's records cannot satisfy", () => {
    // `source_is` belongs to leads; a deal has no acquisition source.
    const result = validateAutomationDraft({
      ...base,
      conditions: [{ key: "source_is", value: "instagram" }],
    });
    expect(result).toEqual({ ok: false, error: "automation_condition_invalid" });
  });

  it("refuses a duplicate condition rather than running the last one", () => {
    const result = validateAutomationDraft({
      ...base,
      conditions: [
        { key: "value_at_least", value: "10000000" },
        { key: "value_at_least", value: "50000000" },
      ],
    });
    expect(result).toEqual({ ok: false, error: "automation_condition_duplicate" });
  });

  it("refuses values outside the closed vocabularies", () => {
    expect(validateAutomationDraft({ ...base, triggerKey: "deal_won" })).toEqual({
      ok: false,
      error: "automation_trigger_invalid",
    });
    expect(validateAutomationDraft({ ...base, actionKey: "send_campaign" })).toEqual({
      ok: false,
      error: "automation_action_invalid",
    });
    expect(validateAutomationDraft({ ...base, conditions: [{ key: "value_at_least", value: "" }] })).toEqual({
      ok: false,
      error: "automation_condition_value_invalid",
    });
    expect(
      validateAutomationDraft({
        ...base,
        triggerKey: "lead_created",
        conditions: [{ key: "source_is", value: "carrier_pigeon" }],
      }),
    ).toEqual({ ok: false, error: "automation_condition_value_invalid" });
    expect(
      validateAutomationDraft({
        ...base,
        triggerKey: "case_opened",
        conditions: [{ key: "priority_is", value: "yesterday" }],
      }),
    ).toEqual({ ok: false, error: "automation_condition_value_invalid" });
  });

  it("refuses an action config the action cannot run without", () => {
    expect(validateAutomationDraft({ ...base, actionConfig: {} })).toEqual({
      ok: false,
      error: "automation_action_config_invalid",
    });
    expect(validateAutomationDraft({ ...base, actionConfig: { ...base.actionConfig, offsetDays: 2 } })).toEqual({
      ok: false,
      error: "automation_action_config_invalid",
    });
    expect(
      validateAutomationDraft({
        ...base,
        actionKey: "notify_growth",
        actionConfig: { signal: "make_them_buy" },
      }),
    ).toEqual({ ok: false, error: "automation_action_config_invalid" });
  });

  it("holds the name to its own limit", () => {
    expect(validateAutomationDraft({ ...base, name: "   " })).toEqual({
      ok: false,
      error: "automation_name_required",
    });
    expect(validateAutomationDraft({ ...base, name: "ب".repeat(CRM_AUTOMATION_NAME_MAX + 1) })).toEqual({
      ok: false,
      error: "automation_name_too_long",
    });
  });
});

describe("matchesAutomationConditions", () => {
  it("holds an amount threshold", () => {
    expect(
      matchesAutomationConditions([{ key: "value_at_least", value: "5000000" }], {
        ...entity,
        valueRial: 5_000_000,
      }),
    ).toBe(true);
    expect(
      matchesAutomationConditions([{ key: "value_at_least", value: "5000000" }], {
        ...entity,
        valueRial: 4_999_999,
      }),
    ).toBe(false);
    // A deal with no value at all is not "at least" anything.
    expect(matchesAutomationConditions([{ key: "value_at_least", value: "1" }], entity)).toBe(false);
  });

  it("treats a name written down without an id as an owner", () => {
    // The trap this pins: a legacy row whose owner is only text is *not*
    // unowned, and a rule that reassigned it would take somebody's customer.
    expect(matchesAutomationConditions([{ key: "owner_is_empty" }], { ...entity, ownerName: "مریم" })).toBe(false);
    expect(
      matchesAutomationConditions([{ key: "owner_is_empty" }], {
        ...entity,
        ownerUserId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe(false);
    expect(matchesAutomationConditions([{ key: "owner_is_empty" }], { ...entity, ownerName: "   " })).toBe(true);
    expect(matchesAutomationConditions([{ key: "owner_is_empty" }], entity)).toBe(true);
  });

  it("requires every condition, and an empty list means always", () => {
    expect(matchesAutomationConditions([], entity)).toBe(true);
    expect(
      matchesAutomationConditions(
        [
          { key: "value_at_least", value: "1000000" },
          { key: "owner_is_empty" },
        ],
        { ...entity, valueRial: 1_000_000, ownerName: "مریم" },
      ),
    ).toBe(false);
  });

  it("cannot be satisfied by a condition this build does not know", () => {
    // A row written by a later release, read by this one: the rule does not
    // fire. Firing it would act on real records under a rule nobody can read.
    const unknown = [{ key: "weather_is" } as unknown as CrmAutomationConditionValue];
    expect(matchesAutomationConditions(unknown, entity)).toBe(false);
  });
});

describe("the written form and the clock", () => {
  it("reads as وقتی / اگر / آنگاه, in the reader's unit", () => {
    const sentence = automationSentence({
      triggerKey: "deal_stage_changed",
      conditions: [{ key: "value_at_least", value: "100000000" }],
      actionKey: "create_follow_up",
      actionConfig: { memberId: null, offsetDays: 3, signal: null },
    });
    expect(sentence).toContain("وقتی");
    expect(sentence).toContain("اگر");
    expect(sentence).toContain("آنگاه");
    // 100,000,000 Rial is 10,000,000 Toman — shown in Toman, grouped.
    expect(sentence).toContain("۱۰٬۰۰۰٬۰۰۰");
    expect(sentence).toContain("۳ روز بعد");
  });

  it("omits the «اگر» clause when there is no condition", () => {
    const sentence = automationSentence({
      triggerKey: "case_opened",
      conditions: [],
      actionKey: "notify_growth",
      actionConfig: { memberId: null, offsetDays: null, signal: "at_risk" },
    });
    expect(sentence).not.toContain("اگر");
    expect(sentence).toContain("رشد و بازاریابی");
  });

  it("makes a follow-up due on the business's own day", () => {
    // 09:00 Tehran (UTC+03:30) is 05:30 UTC.
    expect(followUpDueAt("2026-10-05", 0)).toBe("2026-10-05T05:30:00.000Z");
    expect(followUpDueAt("2026-10-05", 3)).toBe("2026-10-08T05:30:00.000Z");
    // Across a month boundary, which is where a hand-rolled date add breaks.
    expect(followUpDueAt("2026-10-31", 1)).toBe("2026-11-01T05:30:00.000Z");
    expect(FOLLOW_UP_HOUR).toBe("09:00");
  });

  it("names the subject after the record the trigger is about", () => {
    expect(followUpSubject("deal_stage_changed", " قرارداد بزرگ ")).toBe("پیگیری معامله: قرارداد بزرگ");
    expect(followUpSubject("case_opened", "یخچال خراب")).toBe("پیگیری تیکت: یخچال خراب");
    expect(followUpSubject("lead_created", "پرس‌وجوی قیمت")).toBe("پیگیری سرنخ: پرس‌وجوی قیمت");
  });
});

describe("dealStageMoved", () => {
  const stageA = "11111111-1111-4111-8111-111111111111";
  const stageB = "33333333-3333-4333-8333-333333333333";

  it("fires for a real move, and for a deal being born on a stage", () => {
    expect(dealStageMoved(null, { stageId: stageA, stage: "lead" })).toBe(true);
    expect(dealStageMoved({ stageId: stageA }, { stageId: stageB })).toBe(true);
    // A pre-0157 row with no stage id has only its legacy text to compare.
    expect(dealStageMoved({ stage: "lead" }, { stage: "won" })).toBe(true);
    // Canonical identity wins: a legacy text rewrite that does not move the
    // canonical stage is not a move.
    expect(dealStageMoved({ stageId: stageA, stage: "lead" }, { stageId: stageA, stage: "won" })).toBe(false);
  });

  it("does not fire for a re-save, an empty stage, or a missing row", () => {
    expect(dealStageMoved({ stageId: stageA }, { stageId: stageA })).toBe(false);
    expect(dealStageMoved({ stageId: stageA }, {})).toBe(false);
    expect(dealStageMoved({ stageId: stageA }, null)).toBe(false);
  });
});
