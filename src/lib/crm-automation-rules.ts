/**
 * CRM automations: «وقتی → اگر → آنگاه».
 *
 * ## The shape of the feature, and its one hard boundary
 *
 * A rule is a **closed composition** of three vocabularies this module owns:
 *
 * | part | what it may be |
 * |---|---|
 * | **وقتی** (trigger) | three events the CRM already centralises: a deal changing stage, a ticket being opened, a lead being created |
 * | **اگر** (conditions) | four predicates, each declared for the triggers whose entity can satisfy it |
 * | **آنگاه** (action) | create a follow-up task, assign a member, or **signal Growth** |
 *
 * Nothing here sends anything. There is no channel, no template and no
 * recipient in the vocabulary — a CRM automation may put work in somebody's day,
 * hand a record to a member, or tell Growth that a customer's state changed.
 * Campaigns, consent-checked sends and the outbox belong to Growth, and
 * `crm-app-boundaries.test.ts` pins that the CRM has no code path into them.
 *
 * ## Why the vocabulary is code and the rules are rows
 *
 * The same reasoning as the smart queues: a rule a business writes is a
 * *composition* of the product's own parts, never a new part. A trigger nobody
 * implements would be a rule that silently never fires, and a condition whose
 * SQL does not exist would be a rule that silently fires always. So the
 * database stores the composition, this module decides what can be composed,
 * and everything below is pure — no database, no clock, no I/O — which is also
 * what makes it usable from the settings screen and testable without one.
 *
 * ## Determinism
 *
 * `matchesAutomationConditions` reads the *snapshot* the caller loaded, and
 * `followUpDueAt` takes the day it should count from. Nothing here reads the
 * clock, so a rule's behaviour is a function of its inputs and a test does not
 * have to freeze time to know what it does.
 */

import { CASE_PRIORITIES, isCasePriority } from "./crm-shared";
import { toPersianDigits } from "./digits";
import { formatToman } from "./money";
import { CRM_SOURCES, isCrmSource } from "./crm-sources";

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

export const CRM_AUTOMATION_TRIGGERS = [
  "deal_stage_changed",
  "case_opened",
  "lead_created",
] as const;

export type CrmAutomationTrigger = (typeof CRM_AUTOMATION_TRIGGERS)[number];

/** The record a trigger is about — the same closed list the audit log uses. */
export type CrmAutomationEntityType = "deal" | "case" | "lead";

export interface CrmAutomationTriggerDef {
  label: string;
  /** What happened, in a sentence — the «وقتی» line a reader checks first. */
  why: string;
  entityType: CrmAutomationEntityType;
}

export const CRM_AUTOMATION_TRIGGER_DEFS: Record<CrmAutomationTrigger, CrmAutomationTriggerDef> = {
  deal_stage_changed: {
    label: "جابه‌جایی فرصت در قیف",
    why: "هر بار یک معامله از مرحله‌ای به مرحلهٔ دیگر می‌رود — از جمله بردن یا باختن، و از جمله ورودِ نخستین: معامله‌ای که در مرحلهٔ «پیشنهاد» ساخته می‌شود، همان لحظه وارد آن مرحله شده است.",
    entityType: "deal",
  },
  case_opened: {
    label: "ثبت تیکت تازه",
    why: "هر بار یک شکایت یا درخواست خدمات ثبت می‌شود.",
    entityType: "case",
  },
  lead_created: {
    label: "ثبت سرنخ تازه",
    why: "هر بار یک پرس‌وجو از هر منبعی وارد فهرست سرنخ‌ها می‌شود.",
    entityType: "lead",
  },
};

// ---------------------------------------------------------------------------
// If
// ---------------------------------------------------------------------------

export const CRM_AUTOMATION_CONDITIONS = [
  "value_at_least",
  "source_is",
  "priority_is",
  "owner_is_empty",
] as const;

export type CrmAutomationCondition = (typeof CRM_AUTOMATION_CONDITIONS)[number];

export interface CrmAutomationConditionDef {
  label: string;
  why: string;
  /** The triggers whose records this can narrow. Never "all triggers". */
  triggers: readonly CrmAutomationTrigger[];
  /** How the value is read, written and labelled in the form. */
  valueKind: "amount" | "source" | "priority" | "none";
}

export const CRM_AUTOMATION_CONDITION_DEFS: Record<
  CrmAutomationCondition,
  CrmAutomationConditionDef
> = {
  value_at_least: {
    label: "ارزش معامله دست‌کم",
    why: "فقط معامله‌هایی که ارزششان از این مبلغ کمتر نیست.",
    triggers: ["deal_stage_changed"],
    valueKind: "amount",
  },
  source_is: {
    label: "منبع سرنخ",
    why: "فقط سرنخ‌هایی که از یک منبع مشخص آمده‌اند.",
    triggers: ["lead_created"],
    valueKind: "source",
  },
  priority_is: {
    label: "اولویت تیکت",
    why: "فقط تیکت‌هایی با یک اولویت مشخص.",
    triggers: ["case_opened"],
    valueKind: "priority",
  },
  owner_is_empty: {
    label: "بدون مسئول",
    why: "فقط رکوردهایی که هنوز به هیچ عضوی واگذار نشده‌اند.",
    triggers: ["deal_stage_changed", "case_opened", "lead_created"],
    valueKind: "none",
  },
};

// ---------------------------------------------------------------------------
// Then
// ---------------------------------------------------------------------------

export const CRM_AUTOMATION_ACTIONS = ["create_follow_up", "assign_owner", "notify_growth"] as const;

export type CrmAutomationAction = (typeof CRM_AUTOMATION_ACTIONS)[number];

/** Where an action's effect lands. `growth` is a *signal*, never a send. */
export type CrmAutomationSide = "crm" | "growth";

export interface CrmAutomationActionDef {
  label: string;
  why: string;
  side: CrmAutomationSide;
  /** Which config keys the action needs, for the form and the validator. */
  needsMember: boolean;
  needsOffset: boolean;
  needsSignal: boolean;
}

export const CRM_AUTOMATION_ACTION_DEFS: Record<CrmAutomationAction, CrmAutomationActionDef> = {
  create_follow_up: {
    label: "ثبت کار پیگیری",
    why: "یک کار با موعد مشخص در فهرست کارها ساخته می‌شود تا پیگیری فراموش نشود.",
    side: "crm",
    needsMember: true,
    needsOffset: true,
    needsSignal: false,
  },
  assign_owner: {
    label: "واگذاری به یک عضو",
    why: "مالکیت رکورد به عضوی از همین کسب‌وکار منتقل می‌شود؛ کار بی‌صاحب نمی‌ماند.",
    side: "crm",
    needsMember: true,
    needsOffset: false,
    needsSignal: false,
  },
  notify_growth: {
    label: "اطلاع به رشد و بازاریابی",
    why: "فقط یک نشانه ثبت می‌شود که وضعیت این مشتری عوض شده؛ ارسال پیام کارِ خودِ رشد است و از اینجا انجام نمی‌شود.",
    side: "growth",
    needsMember: false,
    needsOffset: false,
    needsSignal: true,
  },
};

/** The follow-up offsets a rule may choose, in days from the business's today. */
export const CRM_FOLLOW_UP_OFFSETS = [0, 1, 3, 7] as const;
export type CrmFollowUpOffset = (typeof CRM_FOLLOW_UP_OFFSETS)[number];

/** The reasons Growth may be told about. A closed list, not free text. */
export const CRM_GROWTH_SIGNALS = ["high_value", "at_risk", "needs_follow_up"] as const;
export type CrmGrowthSignal = (typeof CRM_GROWTH_SIGNALS)[number];

export const CRM_GROWTH_SIGNAL_LABELS: Record<CrmGrowthSignal, string> = {
  high_value: "مشتری ارزشمند",
  at_risk: "در معرض ریزش",
  needs_follow_up: "نیازمند پیگیری",
};

// ---------------------------------------------------------------------------
// The entity a rule is evaluated against
// ---------------------------------------------------------------------------

/**
 * The snapshot the engine loads for one event.
 *
 * Deliberately a flat, explicit shape rather than the full row: a condition may
 * only read what is declared here, so adding a condition means adding a field
 * the loader fills — not discovering that some other column happened to be
 * present.
 */
export interface CrmAutomationEntity {
  type: CrmAutomationEntityType;
  id: string;
  /** The name shown in the resulting task or in the run's own line. */
  title: string;
  /** The customer this record is about, when it has one. */
  partyId: string | null;
  /** For `value_at_least`. */
  valueRial?: number | null;
  /** For `source_is`. */
  source?: string | null;
  /** For `priority_is`. */
  priority?: string | null;
  /** For `owner_is_empty`, and for defaulting a follow-up's assignee. */
  ownerUserId?: string | null;
  ownerName?: string | null;
  /** For the sentence a run writes about a deal's move. */
  stageLabel?: string | null;
}

/** One `{key, value}` an automation's conditions list holds. */
export interface CrmAutomationConditionValue {
  key: CrmAutomationCondition;
  value?: string;
}

/** Whether one condition is satisfied by the snapshot. */
export function conditionMatches(
  condition: CrmAutomationConditionValue,
  entity: CrmAutomationEntity,
): boolean {
  switch (condition.key) {
    case "value_at_least": {
      const threshold = Number(condition.value ?? "");
      if (!Number.isFinite(threshold)) return false;
      return (entity.valueRial ?? 0) >= threshold;
    }
    case "source_is":
      return Boolean(entity.source) && entity.source === condition.value;
    case "priority_is":
      return Boolean(entity.priority) && entity.priority === condition.value;
    case "owner_is_empty":
      // A legacy row with a name and no id has an owner written down: it is not
      // «without an owner», and an automation that treated it as one would
      // reassign somebody else's customer.
      return !entity.ownerUserId && !(entity.ownerName ?? "").trim();
    default:
      // An unknown key is a rule the product does not have. It cannot be
      // satisfied, so the rule does not fire — which is the safe direction for
      // something that acts on real records without being watched.
      return false;
  }
}

/** Whether every condition holds. An empty list means "always". */
export function matchesAutomationConditions(
  conditions: readonly CrmAutomationConditionValue[],
  entity: CrmAutomationEntity,
): boolean {
  return conditions.every((condition) => conditionMatches(condition, entity));
}

/** Which conditions a trigger's records can actually satisfy. */
export function conditionsForTrigger(
  trigger: CrmAutomationTrigger,
): readonly CrmAutomationCondition[] {
  return CRM_AUTOMATION_CONDITIONS.filter((key) =>
    CRM_AUTOMATION_CONDITION_DEFS[key].triggers.includes(trigger),
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const CRM_AUTOMATION_NAME_MAX = 80;

/**
 * The pure half of validation.
 *
 * Member ids are checked against the business by the service (that needs a
 * query); everything else — the name, the trigger, the conditions and their
 * values, the action and its config — is decided here, so the API and the test
 * suite agree by construction.
 */
export interface CrmAutomationDraft {
  name: string;
  triggerKey: string;
  conditions: CrmAutomationConditionValue[];
  actionKey: string;
  actionConfig: { memberId?: string | null; offsetDays?: number | null; signal?: string | null };
}

export type CrmAutomationConfigError =
  | "automation_name_required"
  | "automation_name_too_long"
  | "automation_trigger_invalid"
  | "automation_condition_invalid"
  | "automation_condition_duplicate"
  | "automation_condition_value_invalid"
  | "automation_action_invalid"
  | "automation_action_config_invalid";

export interface CrmAutomationNormalized {
  name: string;
  triggerKey: CrmAutomationTrigger;
  conditions: CrmAutomationConditionValue[];
  actionKey: CrmAutomationAction;
  actionConfig: { memberId: string | null; offsetDays: number | null; signal: CrmGrowthSignal | null };
}

export type CrmAutomationValidation =
  | { ok: true; value: CrmAutomationNormalized }
  | { ok: false; error: CrmAutomationConfigError };

export function validateAutomationDraft(draft: CrmAutomationDraft): CrmAutomationValidation {
  const name = (draft.name ?? "").trim();
  if (!name) return { ok: false, error: "automation_name_required" };
  if (name.length > CRM_AUTOMATION_NAME_MAX) {
    return { ok: false, error: "automation_name_too_long" };
  }

  const triggerKey = draft.triggerKey as CrmAutomationTrigger;
  if (!CRM_AUTOMATION_TRIGGERS.includes(triggerKey)) {
    return { ok: false, error: "automation_trigger_invalid" };
  }

  const allowed = new Set(conditionsForTrigger(triggerKey));
  const conditions: CrmAutomationConditionValue[] = [];
  const seen = new Set<CrmAutomationCondition>();
  for (const raw of draft.conditions ?? []) {
    const key = raw?.key as CrmAutomationCondition;
    if (!CRM_AUTOMATION_CONDITIONS.includes(key)) {
      return { ok: false, error: "automation_condition_invalid" };
    }
    if (!allowed.has(key)) {
      // A condition the entity cannot satisfy would never hold, so the rule
      // would never fire — refused at the door rather than discovered later.
      return { ok: false, error: "automation_condition_invalid" };
    }
    if (seen.has(key)) return { ok: false, error: "automation_condition_duplicate" };
    seen.add(key);

    const definition = CRM_AUTOMATION_CONDITION_DEFS[key];
    const value = raw.value?.trim() ?? "";
    if (definition.valueKind === "none") {
      conditions.push({ key });
      continue;
    }
    if (!value) return { ok: false, error: "automation_condition_value_invalid" };
    if (definition.valueKind === "amount") {
      const amount = Number(value.replace(/[^\d]/g, ""));
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: "automation_condition_value_invalid" };
      }
      conditions.push({ key, value: String(amount) });
      continue;
    }
    if (definition.valueKind === "source" && !isCrmSource(value)) {
      return { ok: false, error: "automation_condition_value_invalid" };
    }
    if (definition.valueKind === "priority" && !isCasePriority(value)) {
      return { ok: false, error: "automation_condition_value_invalid" };
    }
    conditions.push({ key, value });
  }

  const actionKey = draft.actionKey as CrmAutomationAction;
  if (!CRM_AUTOMATION_ACTIONS.includes(actionKey)) {
    return { ok: false, error: "automation_action_invalid" };
  }
  const action = CRM_AUTOMATION_ACTION_DEFS[actionKey];

  // Config is written as a normalized document: nulls for what the action does
  // not use, so a stored rule cannot carry a leftover member from an action the
  // business changed its mind about.
  const memberId = action.needsMember ? (draft.actionConfig?.memberId ?? "").trim() || null : null;
  if (action.needsMember && !memberId) return { ok: false, error: "automation_action_config_invalid" };

  let offsetDays: number | null = null;
  if (action.needsOffset) {
    const raw = draft.actionConfig?.offsetDays;
    const value = typeof raw === "number" ? raw : Number(raw ?? NaN);
    if (!CRM_FOLLOW_UP_OFFSETS.includes(value as CrmFollowUpOffset)) {
      return { ok: false, error: "automation_action_config_invalid" };
    }
    offsetDays = value;
  }

  let signal: CrmGrowthSignal | null = null;
  if (action.needsSignal) {
    const raw = (draft.actionConfig?.signal ?? "") as CrmGrowthSignal;
    if (!CRM_GROWTH_SIGNALS.includes(raw)) {
      return { ok: false, error: "automation_action_config_invalid" };
    }
    signal = raw;
  }

  return {
    ok: true,
    value: { name, triggerKey, conditions, actionKey, actionConfig: { memberId, offsetDays, signal } },
  };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** The hour a generated follow-up is due, in the business's own day. */
export const FOLLOW_UP_HOUR = "09:00";

/**
 * When a generated follow-up is due.
 *
 * The day is the *business's* today, not the server's: a café that closes after
 * midnight has a different date at 01:00 than the machine does, and
 * `businessToday` is already the app's answer to that question. The offset is
 * one of the declared steps, so «۳ روز بعد» is the same three days every time a
 * rule runs.
 *
 * Tehran's offset is written explicitly for the same reason the activity dialog
 * writes it: the app stores instants, and the business day is a Tehran day
 * (`formatJalali` renders it that way).
 */
export function followUpDueAt(businessToday: string, offsetDays: number): string {
  const [year, month, day] = businessToday.split("-").map((part) => Number(part));
  const shifted = new Date(Date.UTC(year, (month ?? 1) - 1, (day ?? 1) + offsetDays));
  const iso = shifted.toISOString().slice(0, 10);
  return new Date(`${iso}T${FOLLOW_UP_HOUR}:00+03:30`).toISOString();
}

/** The subject a generated follow-up carries for each trigger. */
export function followUpSubject(trigger: CrmAutomationTrigger, title: string): string {
  const trimmed = title.trim();
  switch (trigger) {
    case "deal_stage_changed":
      return `پیگیری معامله: ${trimmed}`;
    case "case_opened":
      return `پیگیری تیکت: ${trimmed}`;
    default:
      return `پیگیری سرنخ: ${trimmed}`;
  }
}

// ---------------------------------------------------------------------------
// The written form
// ---------------------------------------------------------------------------

/**
 * A rule as a Persian sentence — «وقتی …، اگر …، آنگاه …».
 *
 * The screen and the settings card both read the rule this way rather than
 * through a form's labels, because a rule nobody can restate in one line is a
 * rule nobody will be able to debug six months from now.
 */
export function automationSentence(rule: {
  triggerKey: CrmAutomationTrigger;
  conditions: CrmAutomationConditionValue[];
  actionKey: CrmAutomationAction;
  /** The normalized document `validateAutomationDraft` produces. */
  actionConfig: { memberId?: string | null; offsetDays?: number | null; signal?: string | null };
}): string {
  const trigger = CRM_AUTOMATION_TRIGGER_DEFS[rule.triggerKey]?.label ?? rule.triggerKey;
  const conditionText = rule.conditions
    .map((condition) => {
      const definition = CRM_AUTOMATION_CONDITION_DEFS[condition.key];
      if (!definition) return "";
      if (definition.valueKind === "amount") {
        const rial = Number(condition.value ?? 0);
        return `${definition.label} ${formatToman(rial)}`;
      }
      if (definition.valueKind === "source") {
        return `${definition.label}: ${condition.value ?? ""}`;
      }
      if (definition.valueKind === "priority") {
        return `${definition.label}: ${condition.value ?? ""}`;
      }
      return definition.label;
    })
    .filter(Boolean);

  const action = CRM_AUTOMATION_ACTION_DEFS[rule.actionKey];
  let actionText = action?.label ?? rule.actionKey;
  if (rule.actionKey === "create_follow_up") {
    const offset = rule.actionConfig.offsetDays ?? 0;
    actionText =
      offset === 0
        ? "ثبت کار پیگیری برای همان روز"
        : `ثبت کار پیگیری ${toPersianDigits(offset)} روز بعد`;
  } else if (rule.actionKey === "notify_growth") {
    actionText = "اطلاع به رشد و بازاریابی";
  }

  const parts = [`وقتی ${trigger}`];
  if (conditionText.length > 0) parts.push(`اگر ${conditionText.join(" و ")}`);
  parts.push(`آنگاه ${actionText}`);
  return parts.join("، ");
}

/**
 * Whether a deal's stage actually moved — the trigger's guard.
 *
 * Kept here rather than in the route so the "what counts as a move" question has
 * exactly one answer: a different canonical stage id, or an id appearing where
 * there was none. A save that rewrites the same stage (an edit to the value, a
 * board that re-posts) is not a move and fires nothing.
 */
export function dealStageMoved(
  before: { stageId?: string | null; stage?: string | null } | null,
  after: { stageId?: string | null; stage?: string | null } | null,
): boolean {
  if (!after) return false;
  // A deal that lost its stage has not entered one, so there is nothing for a
  // rule to hang its action on and nothing to name in the run log.
  if (!after.stageId && !after.stage) return false;
  if (!before) return true;
  // Canonical identity first: the legacy text beside it is kept in step, and a
  // rewrite of it that does not move the canonical stage is not a move.
  if (before.stageId || after.stageId) return before.stageId !== after.stageId;
  return Boolean(before.stage) && before.stage !== after.stage;
}

/** The sources a `source_is` condition may name. Re-exported for the form. */
export const AUTOMATION_SOURCE_OPTIONS = CRM_SOURCES;
/** The priorities a `priority_is` condition may name. */
export const AUTOMATION_PRIORITY_OPTIONS = CASE_PRIORITIES;
