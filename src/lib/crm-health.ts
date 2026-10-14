/**
 * Customer health — an explainable state, never a mystery score.
 *
 * ## Why a *state* and not a number
 *
 * A single 0-100 health score is the most common thing a CRM adds and the least
 * actionable: nobody can say why it is 62, so nobody trusts it, and the first
 * time it is wrong it is ignored forever. This module answers the same question
 * the way a person would — «این مشتری حالش چطور است؟» — with five states every
 * member already understands, and it returns the *reasons* alongside the state.
 *
 * The rule the module exists to keep: **the state is derived from the reasons,
 * not summarised into them.** `customerHealth` collects causes, each carrying
 * its own sentence and the state it implies, and the answer is the worst cause
 * with those sentences attached. There is no branch that can produce a state
 * with an empty explanation, and `crm-health.test.ts` asserts that over every
 * combination of inputs.
 *
 * ## The facts it reads
 *
 * - the lifecycle stage the RFM job already assigned (`crm-scoring.ts`), never
 *   a second scoring engine;
 * - purchase cadence: how long it has been since the last purchase, against the
 *   interval *this customer* actually buys at. «هر ۱۴ روز خرید میکرد، ۴۰ روز
 *   گذشته» is a reason; a global "90 days" threshold is a guess;
 * - open service tickets — a relationship with an unresolved complaint is not
 *   a healthy one, whatever the purchases say;
 * - a past-due receivable, read from Accounting (never recomputed here), which
 *   is the collections signal a shopkeeper acts on.
 *
 * Money is not re-derived: `overdueRial` arrives already computed by the
 * accounting contract, and the reason text says so.
 *
 * The thresholds live in named constants below and are exported, because the
 * UI quotes them in the «چرا؟» panel and a test pins each boundary.
 */

import { LIFECYCLE_STAGES, type LifecycleStage } from "./crm-scoring";
import { toPersianDigits } from "./digits";

export const CUSTOMER_HEALTH_STATES = [
  "excellent",
  "healthy",
  "needs_attention",
  "at_risk",
  "inactive",
] as const;

export type CustomerHealthState = (typeof CUSTOMER_HEALTH_STATES)[number];

/** Worst wins. The order is the escalation, and `worstOf` reads it. */
const SEVERITY: Record<CustomerHealthState, number> = {
  healthy: 0,
  excellent: 1,
  needs_attention: 2,
  at_risk: 3,
  inactive: 4,
};

export const CUSTOMER_HEALTH_META: Record<
  CustomerHealthState,
  { label: string; description: string; tone: "positive" | "neutral" | "active" | "danger" }
> = {
  excellent: {
    label: "عالی",
    description: "خرید منظم و به‌موقع، بدون مسئلهٔ باز.",
    tone: "positive",
  },
  healthy: {
    label: "سالم",
    description: "رابطه در وضعیت عادی است؛ نکته‌ای برای اقدام فوری نیست.",
    tone: "neutral",
  },
  needs_attention: {
    label: "نیاز به توجه",
    description: "یک نشانه هست که ارزش یک تماس یا پیگیری دارد.",
    tone: "active",
  },
  at_risk: {
    label: "در خطر",
    description: "الگوی خرید این مشتری به‌هم خورده یا مسئلهٔ بازی دارد.",
    tone: "danger",
  },
  inactive: {
    label: "غیرفعال",
    description: "خریدش متوقف شده است؛ بدون اقدام برنمی‌گردد.",
    tone: "neutral",
  },
};

/** A customer with no purchase history at all is not "at risk" — it is dormant. */
export const INACTIVE_SILENCE_DAYS = 180;
/** Silence past this multiple of their own cadence is a broken pattern. */
export const RISK_SILENCE_MULTIPLIER = 2.5;
/** Slower than this multiple is a slowdown worth a call. */
export const SLOWDOWN_SILENCE_MULTIPLIER = 1.5;
/** When there is no cadence to compare against (one purchase, or none). */
export const RISK_SILENCE_DAYS = 90;
export const ATTENTION_SILENCE_DAYS = 45;
/**
 * A floor under the ratio rules: a customer who buys weekly must not be flagged
 * for taking eleven days, which is what 1.5 × 7 would otherwise do.
 */
export const MIN_SILENCE_DAYS = 21;

export interface CustomerHealthInput {
  /** The RFM job's lifecycle stage, or null when the customer has never been scored. */
  lifecycleStage: LifecycleStage | string | null;
  orderCount: number;
  /** Days since the last completed purchase; null when there has never been one. */
  daysSinceLastPurchase: number | null;
  /** Average days between purchases, when there is a cadence. */
  purchaseIntervalDays: number | null;
  openCases: number;
  openDeals: number;
  /** Past-due receivable in Rial, straight from Accounting. 0 when nothing is owed. */
  overdueRial: number;
}

export interface CustomerHealthReason {
  /** Stable key, for tests and for the UI to group on. */
  code: string;
  /** The sentence the «چرا؟» panel shows, with Persian digits. */
  text: string;
}

export interface CustomerHealth {
  state: CustomerHealthState;
  label: string;
  description: string;
  tone: (typeof CUSTOMER_HEALTH_META)[CustomerHealthState]["tone"];
  /** Never empty: the facts behind *this* state. */
  reasons: CustomerHealthReason[];
}

function metaFor(state: CustomerHealthState) {
  return CUSTOMER_HEALTH_META[state];
}

function days(count: number): string {
  return toPersianDigits(Math.round(count));
}

function lifecycleEntry(stage: LifecycleStage | string | null) {
  if (!stage) return null;
  return (LIFECYCLE_STAGES as Record<string, (typeof LIFECYCLE_STAGES)[LifecycleStage]>)[stage] ?? null;
}

/**
 * The silence limit above which this customer's pattern counts as broken.
 *
 * Ratio first (their own cadence), fixed band second (no cadence known), and a
 * floor under both so a frequent buyer is judged on their own rhythm rather
 * than on the calendar.
 */
function riskSilenceLimit(interval: number | null): number {
  if (interval && interval > 0) {
    return Math.max(Math.round(interval * RISK_SILENCE_MULTIPLIER), MIN_SILENCE_DAYS);
  }
  return RISK_SILENCE_DAYS;
}

function slowdownSilenceLimit(interval: number | null): number {
  if (interval && interval > 0) {
    return Math.max(Math.round(interval * SLOWDOWN_SILENCE_MULTIPLIER), MIN_SILENCE_DAYS);
  }
  return ATTENTION_SILENCE_DAYS;
}

/**
 * Classify one customer's relationship, with the reasons.
 *
 * The severity of the returned state is the severity of its worst cause, and
 * `reasons` holds every cause that argued for it — so a customer who is both
 * silent and carrying an unpaid invoice shows both facts, not whichever one the
 * code happened to check first.
 */
export function customerHealth(input: CustomerHealthInput): CustomerHealth {
  const orderCount = Math.max(0, Math.round(input.orderCount || 0));
  const openCases = Math.max(0, Math.round(input.openCases || 0));
  const openDeals = Math.max(0, Math.round(input.openDeals || 0));
  const overdueRial = Math.max(0, Math.round(input.overdueRial || 0));
  const silence = input.daysSinceLastPurchase === null ? null : Math.max(0, Math.round(input.daysSinceLastPurchase));
  const interval =
    input.purchaseIntervalDays && input.purchaseIntervalDays > 0
      ? Math.round(input.purchaseIntervalDays)
      : null;
  const stage = lifecycleEntry(input.lifecycleStage);

  const causes: { state: CustomerHealthState; reason: CustomerHealthReason }[] = [];
  const note = (state: CustomerHealthState, code: string, text: string) =>
    causes.push({ state, reason: { code, text } });

  if (orderCount === 0 || silence === null) {
    note("inactive", "never_purchased", "هنوز خریدی برای این مشتری ثبت نشده است.");
  } else if (silence >= INACTIVE_SILENCE_DAYS) {
    note(
      "inactive",
      "long_silence",
      `${days(silence)} روز از آخرین خرید گذشته است (بیش از ${toPersianDigits(
        String(INACTIVE_SILENCE_DAYS),
      )} روز).`,
    );
  }

  if (input.lifecycleStage === "lost" || input.lifecycleStage === "hibernating") {
    note(
      "inactive",
      "lifecycle",
      `در بخش‌بندی مشتریان «${stage?.label ?? input.lifecycleStage}» است: ${stage?.description ?? "بخشی که خرید را متوقف کرده"}`,
    );
  }

  if (input.lifecycleStage === "at_risk" || input.lifecycleStage === "cant_lose") {
    note(
      "at_risk",
      "lifecycle",
      `در بخش‌بندی مشتریان «${stage?.label ?? input.lifecycleStage}» است: ${stage?.description ?? "مشتری‌ای که در حال از دست رفتن است"}`,
    );
  } else if (input.lifecycleStage === "needs_attention" || input.lifecycleStage === "about_to_sleep") {
    note(
      "needs_attention",
      "lifecycle",
      `در بخش‌بندی مشتریان «${stage?.label ?? input.lifecycleStage}» است: ${stage?.description ?? "کم‌کم فاصله گرفته است"}`,
    );
  }

  if (silence !== null && orderCount > 0) {
    const limit = riskSilenceLimit(interval);
    const slow = slowdownSilenceLimit(interval);
    if (silence >= limit) {
      note(
        "at_risk",
        "silence",
        interval
          ? `به‌طور میانگین هر ${days(interval)} روز خرید می‌کرد؛ ${days(silence)} روز گذشته است.`
          : `${days(silence)} روز است خرید نکرده است.`,
      );
    } else if (silence >= slow) {
      note(
        "needs_attention",
        "slowdown",
        interval
          ? `کمی کندتر از ریتم خودش؛ معمولاً هر ${days(interval)} روز می‌خرید و ${days(silence)} روز گذشته است.`
          : `کمی بیش از حد معمول؛ ${days(silence)} روز است خرید نکرده است.`,
      );
    }
  }

  if (openCases >= 2) {
    note("at_risk", "open_cases", `${toPersianDigits(String(openCases))} تیکت باز دارد.`);
  } else if (openCases === 1) {
    note("needs_attention", "open_case", "یک تیکت باز دارد.");
  }

  if (overdueRial > 0) {
    note(
      "at_risk",
      "overdue_receivable",
      "بدهی سررسیدشده دارد؛ مبلغ از حسابداری خوانده شده است، نه اینجا محاسبه شود.",
    );
  }

  const worsened = causes.filter((cause) => cause.state !== "healthy" && cause.state !== "excellent");
  if (worsened.length > 0) {
    const worst = worsened.reduce((current, cause) =>
      SEVERITY[cause.state] > SEVERITY[current.state] ? cause : current,
    );
    const state = worst.state;
    // Every signal is shown, worst first, even when it argued for a milder
    // state than the one that won. Hiding a past-due invoice because the
    // customer is also dormant would be the module deciding which fact the
    // reader is allowed to see.
    const ordered = [...worsened].sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state]);
    const seen = new Set<string>();
    const reasons: CustomerHealthReason[] = [];
    for (const cause of ordered) {
      if (seen.has(cause.reason.code)) continue;
      seen.add(cause.reason.code);
      reasons.push(cause.reason);
    }
    return { state, ...metaFor(state), reasons };
  }

  // Nothing is wrong. Say what is going well, so «سالم» and «عالی» are answers
  // rather than an absence of alarms.
  const lifecycleGood =
    input.lifecycleStage === "champion" || input.lifecycleStage === "loyal";
  const steady =
    silence !== null &&
    silence <= (interval ? Math.max(Math.round(interval * 1.2), MIN_SILENCE_DAYS) : ATTENTION_SILENCE_DAYS);
  const state: CustomerHealthState = lifecycleGood && steady && orderCount >= 3 ? "excellent" : "healthy";
  const reasons: CustomerHealthReason[] = [];
  if (stage && lifecycleGood) {
    reasons.push({ code: "lifecycle", text: `در بخش‌بندی مشتریان «${stage.label}» است.` });
  }
  if (orderCount > 0) {
    reasons.push({
      code: "purchases",
      text: `${toPersianDigits(String(orderCount))} خرید ثبت‌شده دارد${silence !== null ? ` و ${days(silence)} روز از آخرین خرید گذشته است` : ""}.`,
    });
  }
  if (openDeals > 0) {
    reasons.push({
      code: "open_deals",
      text: `${toPersianDigits(String(openDeals))} معاملهٔ باز دارد؛ پیگیری در جریان است.`,
    });
  }
  if (reasons.length === 0) {
    reasons.push({ code: "no_signal", text: "نشانهٔ هشداری ثبت نشده است." });
  }
  return { state, ...metaFor(state), reasons };
}
