/**
 * Phase 31 — pure guardrail rules for autopilot. Database access, tenancy,
 * provider calls and the executors themselves live in ai-autopilot-service.ts
 * and ai-autopilot-executors.ts; the decision of whether a proposal may be
 * applied unattended lives here so it is deterministic and unit-testable.
 */

import { ACTION_CATALOG, type ActionMeta, type ActionType } from "./ai";

export const AUTOPILOT_CATEGORIES = ["inventory", "pricing", "money", "customer", "waste", "website", "messaging"] as const;
export type AutopilotCategory = (typeof AUTOPILOT_CATEGORIES)[number];

export interface AutopilotCategorySetting {
  enabled: boolean;
  /**
   * Per category: inventory = max value of one adjustment/draft PO; pricing =
   * max absolute Rial change per item; money = max discount/expense/journal
   * total. null where the category has no monetary effect.
   */
  maxAmountRial: number | null;
  /** pricing = max % price change; money = max discount %. null elsewhere. */
  maxPercent: number | null;
  maxItemsPerRun: number;
  dailyActionLimit: number;
}

/**
 * The ceiling an owner cannot configure past. Mirrored by the CHECK
 * constraints in migration 0097, so neither the UI nor a direct DB write can
 * exceed it. A mis-set number can only ever narrow autopilot, never widen it.
 */
export const AUTOPILOT_CEILINGS: Record<AutopilotCategory, AutopilotCategorySetting> = {
  inventory: { enabled: true, maxAmountRial: 50_000_000, maxPercent: null, maxItemsPerRun: 25, dailyActionLimit: 5 },
  pricing: { enabled: true, maxAmountRial: 5_000_000, maxPercent: 15, maxItemsPerRun: 10, dailyActionLimit: 10 },
  money: { enabled: true, maxAmountRial: 20_000_000, maxPercent: 20, maxItemsPerRun: 5, dailyActionLimit: 5 },
  customer: { enabled: true, maxAmountRial: null, maxPercent: null, maxItemsPerRun: 20, dailyActionLimit: 20 },
  // Phase 32 — waste stopped being detect-only when the coworker gave it a
  // human-authored reason (see ACTION_CATALOG's `coworkerOnly`), so the
  // category needs caps that can express a real night: several items, more
  // than one shift a day, and — because a write-off has a real cost and no
  // honest one-click undo — a monetary ceiling it never had before.
  waste: { enabled: true, maxAmountRial: 20_000_000, maxPercent: null, maxItemsPerRun: 15, dailyActionLimit: 8 },
  // Phase 38 — the website's drafting actions. Nothing here has a Rial
  // effect: a draft post or an unpublished product is invisible to the
  // public until a human publishes it, and *publishing* is deliberately in no
  // category at all (see `website.post.publish` in ACTION_CATALOG).
  website: { enabled: true, maxAmountRial: null, maxPercent: null, maxItemsPerRun: 5, dailyActionLimit: 5 },
  // One event maps to one customer. This is deliberately a small daily cap and
  // a real Rial ceiling (the configured send rate), not an exemption hidden in
  // `customer` where a send's platform cost would be unmeasured.
  messaging: { enabled: true, maxAmountRial: 5_000_000, maxPercent: null, maxItemsPerRun: 1, dailyActionLimit: 20 },
};

/**
 * What a category starts at once an owner switches it on. Money is tightest.
 *
 * It used to say here that `expense.categorize` was the one eligible action
 * with *no* one-click undo, and that is why the category was clamped so hard.
 * Issue #832 §1 gave it an undo — a mirrored reversal, from the register and
 * from autopilot's own revert path — so the caps are now what they always
 * secondarily were: an automatic expense posting is money leaving the business,
 * and a reversal, however clean, still leaves a correction in the ledger that
 * somebody has to explain at period close. Same numbers, honest reason.
 */
export const AUTOPILOT_DEFAULTS: Record<AutopilotCategory, AutopilotCategorySetting> = {
  inventory: { enabled: false, maxAmountRial: 10_000_000, maxPercent: null, maxItemsPerRun: 10, dailyActionLimit: 2 },
  pricing: { enabled: false, maxAmountRial: 1_000_000, maxPercent: 5, maxItemsPerRun: 3, dailyActionLimit: 3 },
  money: { enabled: false, maxAmountRial: 5_000_000, maxPercent: 10, maxItemsPerRun: 1, dailyActionLimit: 2 },
  customer: { enabled: false, maxAmountRial: null, maxPercent: null, maxItemsPerRun: 10, dailyActionLimit: 10 },
  waste: { enabled: false, maxAmountRial: 2_000_000, maxPercent: null, maxItemsPerRun: 5, dailyActionLimit: 2 },
  website: { enabled: false, maxAmountRial: null, maxPercent: null, maxItemsPerRun: 2, dailyActionLimit: 2 },
  messaging: { enabled: false, maxAmountRial: 500_000, maxPercent: null, maxItemsPerRun: 1, dailyActionLimit: 5 },
};

export const AUTOPILOT_CATEGORY_LABELS: Record<AutopilotCategory, string> = {
  inventory: "موجودی و انبار",
  pricing: "قیمت و منو",
  money: "مالی و تخفیف",
  customer: "پروندهٔ مشتری",
  waste: "ضایعات",
  website: "وب‌سایت",
  messaging: "پیام‌های رویدادی مشتری",
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clampOptionalAmount(input: number | null | undefined, ceiling: number | null): number | null {
  if (ceiling === null) return null;
  if (input === null || input === undefined || !Number.isFinite(input)) return null;
  const truncated = Math.trunc(input);
  if (truncated <= 0) return null;
  return Math.min(truncated, ceiling);
}

/**
 * Applied on write AND on read, so lowering a ceiling in a later release
 * retroactively narrows every stored setting with no data migration.
 */
export function clampAutopilotSetting(
  category: AutopilotCategory,
  input: Partial<AutopilotCategorySetting>,
): AutopilotCategorySetting {
  const ceiling = AUTOPILOT_CEILINGS[category];
  const fallback = AUTOPILOT_DEFAULTS[category];
  return {
    enabled: input.enabled ?? false,
    maxAmountRial: clampOptionalAmount(input.maxAmountRial ?? fallback.maxAmountRial, ceiling.maxAmountRial),
    maxPercent: clampOptionalAmount(input.maxPercent ?? fallback.maxPercent, ceiling.maxPercent),
    maxItemsPerRun: clampNumber(input.maxItemsPerRun ?? fallback.maxItemsPerRun, 1, ceiling.maxItemsPerRun),
    dailyActionLimit: clampNumber(input.dailyActionLimit ?? fallback.dailyActionLimit, 1, ceiling.dailyActionLimit),
  };
}

export type AutopilotDecision =
  | { decision: "auto_apply" }
  | { decision: "needs_confirmation"; reasonCode: string; reasonFa: string };

/**
 * What the caps are measured against. The service supplies whatever it can
 * read; a missing value never silently passes a cap — it defers instead.
 */
export interface AutopilotAmountContext {
  /** menu.item.priceUpdate: the item's price before the change, integer Rial. */
  currentPriceRial?: number;
  /** order.discount.apply: the order subtotal a percent discount applies to. */
  orderSubtotalRial?: number;
  /** inventory.*: the computed value of the document, integer Rial. */
  documentValueRial?: number;
  /** messaging.campaign.trigger: current configured price of the rendered one-recipient message. */
  messageCostRial?: number;
}

const REASONS: Record<string, string> = {
  action_not_eligible: "این اقدام هرگز به‌صورت خودکار اجرا نمی‌شود و همیشه به تأیید شما نیاز دارد.",
  unknown_action: "این اقدام شناخته نشد.",
  approval_requested: "شما برای این کار «قبل از ثبت بپرس» را انتخاب کرده‌اید.",
  no_authorizer: "کاربر تأییدکنندهٔ این کار مشخص نیست، پس ثبت خودکار انجام نمی‌شود.",
  category_disabled: "اجرای خودکار برای این دسته خاموش است.",
  daily_limit_reached: "سقف تعداد اجرای خودکار امروز در این دسته تکمیل شده است.",
  too_many_items: "تعداد اقلام این پیشنهاد بیش از حد مجاز اجرای خودکار است.",
  invalid_payload: "اطلاعات این پیشنهاد کامل یا معتبر نیست.",
  missing_context: "برای سنجش این پیشنهاد در برابر سقف تعیین‌شده، اطلاعات کافی در دسترس نبود.",
  price_change_too_large: "درصد تغییر قیمت بیش از سقف تعیین‌شدهٔ شماست.",
  amount_over_cap: "مبلغ این پیشنهاد بیش از سقف تعیین‌شدهٔ شماست.",
  unbalanced_entry: "بدهکار و بستانکار این سند برابر نیست.",
  payload_touches_other_fields: "این پیشنهاد فیلدهایی بیرون از یادداشت را تغییر می‌دهد.",
};

function defer(reasonCode: string): AutopilotDecision {
  return { decision: "needs_confirmation", reasonCode, reasonFa: REASONS[reasonCode] ?? REASONS.invalid_payload };
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function lineCount(payload: Record<string, unknown>): number {
  for (const key of ["lines", "items"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.length;
  }
  return 1;
}

/**
 * The single gate between a model's proposal and an unattended write.
 *
 * `needs_confirmation` never means "dropped" — the caller still records the
 * proposal in the audit trail as an ordinary clickable one, so the owner sees
 * everything autopilot considered and can apply it by hand.
 */
export function evaluateAutopilotProposal(input: {
  meta: ActionMeta;
  payload: Record<string, unknown>;
  setting: AutopilotCategorySetting;
  appliedTodayInCategory: number;
  context: AutopilotAmountContext;
}): AutopilotDecision {
  const { meta, payload, setting, appliedTodayInCategory, context } = input;

  if (!meta.autopilotCategory || !meta.executor) return defer("action_not_eligible");
  if (!setting.enabled) return defer("category_disabled");
  if (appliedTodayInCategory >= setting.dailyActionLimit) return defer("daily_limit_reached");
  if (lineCount(payload) > setting.maxItemsPerRun) return defer("too_many_items");

  switch (meta.type) {
    case "menu.item.priceUpdate": {
      const next = finiteNumber(payload.price);
      const current = context.currentPriceRial;
      if (next === null || next <= 0) return defer("invalid_payload");
      if (current === undefined || current <= 0) return defer("missing_context");
      const delta = Math.abs(next - current);
      if (setting.maxPercent !== null && (delta / current) * 100 > setting.maxPercent) {
        return defer("price_change_too_large");
      }
      if (setting.maxAmountRial !== null && delta > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "menu.item.disable":
      return payload.isActive === false ? { decision: "auto_apply" } : defer("invalid_payload");

    case "order.discount.apply": {
      const discount = payload.discount as Record<string, unknown> | undefined;
      const value = finiteNumber(discount?.value);
      const subtotal = context.orderSubtotalRial;
      if (!discount || value === null || value <= 0) return defer("invalid_payload");
      if (subtotal === undefined || subtotal <= 0) return defer("missing_context");
      // Checked in both directions: a small percentage of a large bill can
      // breach the Rial cap, and a small amount can breach the percent cap.
      const amountRial = discount.type === "percent" ? (subtotal * value) / 100 : value;
      const percent = (amountRial / subtotal) * 100;
      if (percent > 100) return defer("invalid_payload");
      if (setting.maxPercent !== null && percent > setting.maxPercent) return defer("amount_over_cap");
      if (setting.maxAmountRial !== null && amountRial > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "expense.categorize": {
      const amount = finiteNumber(payload.amount);
      if (amount === null || amount <= 0) return defer("invalid_payload");
      if (setting.maxAmountRial !== null && amount > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "journal.manual.propose": {
      const lines = Array.isArray(payload.lines) ? (payload.lines as Record<string, unknown>[]) : null;
      if (!lines || lines.length === 0) return defer("invalid_payload");
      let debit = 0;
      let credit = 0;
      for (const line of lines) {
        const d = finiteNumber(line.debit) ?? 0;
        const c = finiteNumber(line.credit) ?? 0;
        if (d < 0 || c < 0) return defer("invalid_payload");
        debit += d;
        credit += c;
      }
      // createDraft would refuse an unbalanced entry anyway; refusing here as
      // well keeps the model's unbalanced output away from an unattended path.
      if (debit !== credit) return defer("unbalanced_entry");
      if (debit <= 0) return defer("invalid_payload");
      if (setting.maxAmountRial !== null && debit > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "inventory.reorder.draftPO":
    case "inventory.adjustment.propose": {
      const value = context.documentValueRial;
      if (value === undefined) return defer("missing_context");
      if (setting.maxAmountRial !== null && value > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "inventory.waste.log": {
      const quantity = finiteNumber(payload.quantity);
      if (quantity === null || quantity <= 0) return defer("invalid_payload");
      if (typeof payload.reason !== "string" || payload.reason.length === 0) return defer("invalid_payload");
      // The cost is the inventory layers' own, computed by the service from
      // the database — never a number the caller supplied — so a cap on it
      // measures the real loss.
      const cost = context.documentValueRial;
      if (cost === undefined) return defer("missing_context");
      if (setting.maxAmountRial !== null && cost > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "inventory.production.run": {
      const batches = finiteNumber(payload.batches);
      if (batches === null || batches <= 0) return defer("invalid_payload");
      if (typeof payload.formulaId !== "string" || payload.formulaId.length === 0) return defer("invalid_payload");
      const value = context.documentValueRial;
      if (value === undefined) return defer("missing_context");
      if (setting.maxAmountRial !== null && value > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "messaging.campaign.trigger": {
      if (typeof payload.customerId !== "string" || typeof payload.templateId !== "string" ||
          (payload.channel !== "sms" && payload.channel !== "email")) return defer("invalid_payload");
      const cost = context.messageCostRial;
      if (cost === undefined) return defer("missing_context");
      if (setting.maxAmountRial !== null && cost > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "website.post.draft":
    case "website.post.update": {
      // A draft never reaches the public; what the gate checks is that the
      // model actually wrote something, and wrote it as a *draft*. The publish
      // action is not in this switch: it has no category and no executor, so
      // it fell to `action_not_eligible` above — always, whatever the setting.
      if (meta.type === "website.post.update" && (typeof payload.postId !== "string" || payload.postId.length === 0)) {
        return defer("invalid_payload");
      }
      const title = payload.title;
      const body = payload.body;
      if (meta.type === "website.post.draft") {
        if (typeof title !== "string" || title.trim().length === 0) return defer("invalid_payload");
        if (typeof body !== "string" || body.trim().length === 0) return defer("invalid_payload");
      } else if (title === undefined && body === undefined) {
        return defer("invalid_payload");
      }
      if (payload.publish === true || payload.status === "published") return defer("action_not_eligible");
      return { decision: "auto_apply" };
    }

    case "website.product.upsert": {
      if (typeof payload.title !== "string" || payload.title.trim().length === 0) return defer("invalid_payload");
      const price = finiteNumber(payload.priceRial);
      if (price === null || price <= 0 || !Number.isInteger(price)) return defer("invalid_payload");
      return { decision: "auto_apply" };
    }

    case "customer.note.add": {
      const notes = payload.notes;
      if (typeof notes !== "string" || notes.trim().length === 0 || notes.length > 2_000) {
        return defer("invalid_payload");
      }
      // The endpoint is a full PUT on the customer, so the guard — not the
      // endpoint — is what stops a "note" proposal from quietly rewriting a
      // phone number or credit terms.
      const allowed = new Set(["customerId", "notes"]);
      if (Object.keys(payload).some((key) => !allowed.has(key))) {
        return defer("payload_touches_other_fields");
      }
      return { decision: "auto_apply" };
    }

    default:
      return defer("action_not_eligible");
  }
}

/**
 * The unattended-execution ceiling as ONE named policy, shared verbatim by the
 * three features that can write without a person watching — autopilot, the
 * coworker, and (Phase D) automations.
 *
 * Historically each feature re-derived the same four questions in its own
 * words. That duplication was the real risk: an owner who set "money: at most
 * 5,000,000 ﷼ unattended" said that about their *business*, and a second copy
 * of the rule is a second place it can silently drift. This function is that
 * single copy. Every unattended write in the system funnels through it.
 *
 * Four gates, in order, none of which the caller's own `approvalMode` can
 * override, and none of which is ever a *drop* — a "no" means the proposal is
 * held for a human on the identical manual apply path, exactly as Phase 31
 * requires:
 *   1. the action is real and has an unattended executor at all;
 *   2. the owner chose 'auto' for this piece of work;
 *   3. a real user's authority backs it;
 *   4. the per-category caps admit this specific payload
 *      (delegated to `evaluateAutopilotProposal`, the amount-level gate).
 */
export interface UnattendedActionInput {
  meta: ActionMeta | undefined;
  payload: Record<string, unknown>;
  /** The caller's approval choice: 'auto' at all, or always 'ask'. */
  approvalMode: "ask" | "auto";
  /** Whether a real user's authority backs an unattended write. */
  hasAuthorizer: boolean;
  /** The category's stored setting, or null when the owner never enabled it. */
  setting: AutopilotCategorySetting | null;
  appliedTodayInCategory: number;
  context: AutopilotAmountContext;
}

export function evaluateUnattendedAction(input: UnattendedActionInput): AutopilotDecision {
  const { meta } = input;
  // 1 — a real action with an unattended path. `unknown_action` (the payload
  // named a type that is not in the catalogue) is distinct from a known action
  // that simply has no executor, which `evaluateAutopilotProposal` reports as
  // `action_not_eligible` below.
  if (!meta) return defer("unknown_action");
  // 2 — the owner opted this piece of work into unattended writes at all.
  if (input.approvalMode !== "auto") return defer("approval_requested");
  // 3 — an unattended write is never anonymous.
  if (!input.hasAuthorizer) return defer("no_authorizer");
  // 4 — the action has a category the owner switched on, and its caps admit
  // this payload. A null setting means the category was never enabled; an
  // action with no category at all is caught by `action_not_eligible` inside.
  if (!input.setting) return defer("action_not_eligible");
  return evaluateAutopilotProposal({
    meta,
    payload: input.payload,
    setting: input.setting,
    appliedTodayInCategory: input.appliedTodayInCategory,
    context: input.context,
  });
}

/** Action types an autopilot run for `category` may propose. */
export function actionTypesForCategory(category: AutopilotCategory): ActionType[] {
  return (Object.keys(ACTION_CATALOG) as ActionType[]).filter(
    // `coworkerOnly` is excluded on purpose: this list is what an *autopilot*
    // run — the model deciding for itself what is worth doing — is offered.
    // Phase 31's reasoning still holds there. See ACTION_CATALOG's own note.
    (type) => ACTION_CATALOG[type].autopilotCategory === category && !ACTION_CATALOG[type].coworkerOnly,
  );
}
