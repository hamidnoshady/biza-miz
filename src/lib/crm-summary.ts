/**
 * The relationship summary — «خلاصهٔ رابطه».
 *
 * ## What this is, and what it is not
 *
 * It is a **deterministic** reading of the facts already on the customer file:
 * the health state and its reasons, the purchase aggregates, what is open, and
 * the newest entries on the unified timeline. Every line names the source it
 * came from, so a reader can go and check it.
 *
 * It is *not* a language model's impression. That distinction is the whole
 * design: a summary that can invent a fact about a person is worse than no
 * summary, because it is believed. A narrator may be added on top of this — to
 * rephrase, to translate, to choose what to lead with — but it must be able to
 * do so from these lines and only these lines, which is why each one carries
 * `source` and why nothing here is generated.
 *
 * ## Why it is computed on the client
 *
 * It reads the three things the profile screen has already fetched — the file,
 * the notes and the merged timeline — so it costs no extra query and cannot
 * disagree with the page it sits on. `crm-summary.test.ts` pins that property:
 * the same inputs always produce the same lines, and every line's source is one
 * of a closed set.
 *
 * Persian only, like the rest of the CRM surface.
 */

import type { CustomerHealth } from "./crm-health";
import { LIFECYCLE_STAGES, type LifecycleStage } from "./crm-scoring";
import { toPersianDigits } from "./digits";
import { formatJalali } from "./jalali";

/** Where a line's fact came from. Closed, so the UI can label it. */
export const SUMMARY_SOURCES = [
  "purchases",
  "lifecycle",
  "health",
  "timeline",
  "consent",
  "accounting",
  "open_items",
] as const;

export type SummarySource = (typeof SUMMARY_SOURCES)[number];

export const SUMMARY_SOURCE_LABELS: Record<SummarySource, string> = {
  purchases: "خریدها",
  lifecycle: "بخش‌بندی",
  health: "وضعیت رابطه",
  timeline: "تاریخچه",
  consent: "رضایت ارتباط",
  accounting: "حسابداری",
  open_items: "کارهای باز",
};

export interface RelationshipSummaryInput {
  name: string;
  health: CustomerHealth;
  stats: {
    orderCount: number;
    totalSpentRial: number;
    lastPurchaseDate: string | null;
    daysSinceLastPurchase: number | null;
    loyaltyPoints: number;
    openCases: number;
    openDeals: number;
  };
  accounting: { receivableRial: number; hasLedger: boolean; overdueRial: number };
  consent: { smsConsent: boolean; marketingConsent: boolean };
  rfm: { stage: string | null };
  /** Newest first, as `customerTimeline` returns them. */
  timeline: readonly { at: string; kindLabel: string; summary: string }[];
  /**
   * Formats integer Rial the way the screen does.
   *
   * Passed in rather than imported: the CRM renders through the member's money
   * context (Rial or Toman), and a summary that printed its own unit would show
   * a number in a different denomination from the metrics directly above it.
   */
  formatMoney: (rial: number) => string;
}

export interface SummaryLine {
  text: string;
  source: SummarySource;
}

export interface RelationshipSummary {
  /** One sentence: the state of the relationship and why. */
  headline: string;
  lines: SummaryLine[];
  /** What to do next, when the facts imply one. */
  nextStep: string | null;
}

/** How many history entries the summary quotes. Enough to see the shape. */
const TIMELINE_LINES = 3;

export function relationshipSummary(input: RelationshipSummaryInput): RelationshipSummary {
  const { stats, health, accounting } = input;
  const money = (rial: number) => input.formatMoney(Math.round(rial));
  const lines: SummaryLine[] = [];

  // 1. Who they are to the business, in numbers, from the purchase facts.
  if (stats.orderCount > 0) {
    lines.push({
      source: "purchases",
      text: `${toPersianDigits(String(stats.orderCount))} خرید به ارزش ${money(stats.totalSpentRial)}${
        stats.lastPurchaseDate
          ? `؛ آخرین خرید ${toPersianDigits(formatJalali(stats.lastPurchaseDate))}`
          : ""
      }.`,
    });
  } else {
    lines.push({ source: "purchases", text: "هنوز خریدی برای این مشتری ثبت نشده است." });
  }

  // 2. The lifecycle bucket the RFM job assigned (one scoring engine).
  if (input.rfm.stage) {
    const stage = LIFECYCLE_STAGES[input.rfm.stage as LifecycleStage];
    lines.push({
      source: "lifecycle",
      text: stage
        ? `در بخش‌بندی چرخهٔ عمر در گروه «${stage.label}» است: ${stage.description}`
        : `در بخش‌بندی چرخهٔ عمر در گروه «${input.rfm.stage}» است.`,
    });
  }

  // 3. The health state and what produced it — the first two reasons only: the
  //    panel below already prints them all, and a summary that repeats itself
  //    stops being a summary.
  for (const reason of health.reasons.slice(0, 2)) {
    lines.push({ source: "health", text: reason.text });
  }

  // 4. What is open right now.
  if (stats.openCases > 0 || stats.openDeals > 0) {
    const parts: string[] = [];
    if (stats.openCases > 0) parts.push(`${toPersianDigits(String(stats.openCases))} تیکت باز`);
    if (stats.openDeals > 0) parts.push(`${toPersianDigits(String(stats.openDeals))} معاملهٔ باز`);
    lines.push({ source: "open_items", text: `${parts.join(" و ")} دارد.` });
  }

  // 5. What the books say — through the accounting contract, never recomputed.
  if (accounting.hasLedger && accounting.receivableRial > 0) {
    lines.push({
      source: "accounting",
      text: `طبق دفاتر ${money(accounting.receivableRial)} بدهکار است${
        accounting.overdueRial > 0 ? ` که ${money(accounting.overdueRial)} آن سررسید شده است` : ""
      }.`,
    });
  }

  // 6. The newest things that happened, quoted from the timeline it is shown
  //    beside — so the summary and the history can never disagree.
  for (const event of input.timeline.slice(0, TIMELINE_LINES)) {
    lines.push({
      source: "timeline",
      text: `${toPersianDigits(formatJalali(event.at, { withTime: false }))} — ${event.kindLabel}: ${event.summary}`,
    });
  }

  // 7. Reachability, which decides whether any of the above can be acted on by
  //    message.
  if (!input.consent.smsConsent && !input.consent.marketingConsent) {
    lines.push({ source: "consent", text: "رضایت ارتباطی برای پیامک و ایمیل ثبت نشده است." });
  } else {
    const channels = [
      input.consent.smsConsent ? "پیامک" : null,
      input.consent.marketingConsent ? "ایمیل" : null,
    ].filter(Boolean);
    lines.push({ source: "consent", text: `رضایت ارتباط برای ${channels.join(" و ")} ثبت شده است.` });
  }

  const headline = `${input.name} — وضعیت رابطه: ${health.label}؛ ${health.reasons[0]?.text ?? health.description}`;

  return { headline, lines, nextStep: nextStepFor(input, health) };
}

/**
 * The next step, derived from the state rather than from a rule engine.
 *
 * A summary that ends in "and therefore…" is the difference between a report
 * and a working tool, and the mapping is deliberately small: each state has
 * exactly one obvious action, and the reader can disagree with it by reading
 * the reasons above it.
 */
function nextStepFor(input: RelationshipSummaryInput, health: CustomerHealth): string | null {
  if (health.state === "at_risk") {
    if (input.accounting.overdueRial > 0) return "برای تسویهٔ بدهی سررسیدشده تماس بگیرید.";
    if (input.stats.openCases > 0) return "تیکت‌های باز را تعیین تکلیف کنید؛ شکایت حل‌نشده مشتری را نگه نمی‌دارد.";
    return "تماس پیگیری بگذارید؛ ریتم خریدش به‌هم خورده است.";
  }
  if (health.state === "inactive") {
    return "یک پیشنهاد بازگشت بفرستید یا پرونده را بایگانی کنید تا فهرست تماس‌ها شلوغ نشود.";
  }
  if (health.state === "needs_attention") {
    return "یک پیگیری کوتاه در برنامه بگذارید و نتیجه را ثبت کنید.";
  }
  if (input.stats.openDeals > 0) return "معاملهٔ باز را جلو ببرید؛ بهانهٔ طبیعی برای تماس آماده است.";
  if (health.state === "excellent") return "پاداش یا دعوت به معرفی مشتری؛ اینها معرف‌های طبیعی کسب‌وکارند.";
  return null;
}
