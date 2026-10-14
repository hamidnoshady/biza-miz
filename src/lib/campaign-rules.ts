/**
 * The campaign form's rules, as one pure module.
 *
 * Everything a campaign (`promotions` row) has to satisfy before it is worth
 * storing lives here — the kind catalogue, what each kind's `value` *means*,
 * and the validation itself — with no import of `pg` and no JSX, so the Growth
 * app's client form and `promotions-service.ts` can enforce the identical rule
 * set. Same split as `campaign-channels.ts` beside `campaign-audience.ts`.
 *
 * ## Why validation moved out of the screen
 *
 * The campaigns form used to validate nothing and let Postgres answer. Three
 * separate failures came out of that, and each is a test below:
 *
 *   - «مبلغ» left empty parsed to a throw inside the submit handler, so the
 *     form stayed disabled forever with nothing on screen to explain it;
 *   - a decimal percent or a decimal «حداقل تعداد» reached an `integer`
 *     column and came back as a raw driver error;
 *   - «از تاریخ» after «تا تاریخ», or a `buy_x_get_y` with no minimum
 *     quantity, saved perfectly and then never fired — a campaign that looks
 *     live in the list and silently discounts nothing.
 *
 * The last one is the reason this is a shared module rather than a few `if`s
 * in the component: a campaign that cannot possibly apply is not a UI problem,
 * it is an invalid row, and the service is the last line of defence for every
 * caller — the API route, a future import, the AI's tools.
 */

import type { PromotionKind, PromotionStacking } from "./promotions";

export const CAMPAIGN_KINDS: readonly PromotionKind[] = [
  "percent",
  "amount",
  "bundle_price",
  "buy_x_get_y",
] as const;

export const CAMPAIGN_KIND_LABELS: Record<PromotionKind, string> = {
  percent: "درصدی",
  amount: "مبلغ ثابت",
  bundle_price: "ست هدیه (قیمت کل)",
  buy_x_get_y: "تعداد مشخص با قیمت ثابت",
};

export const CAMPAIGN_STACKING_LABELS: Record<PromotionStacking, string> = {
  exclusive: "انحصاری",
  stackable: "ترکیب‌پذیر",
};

/** A name long enough for any real campaign, short enough not to break a list row. */
export const MAX_CAMPAIGN_NAME_LENGTH = 120;

/** Priority is an `integer` column; keep it inside a range a person can reason about. */
export const MAX_CAMPAIGN_PRIORITY = 1000;

/**
 * Whether a kind's `value` is a percent rather than money.
 *
 * `percent` is the only kind whose value is not Rial, and getting this wrong
 * means the form parses «۲۰» as twenty Rial (or two hundred, once the business
 * displays Toman) instead of twenty percent.
 */
export function isPercentKind(kind: PromotionKind): boolean {
  return kind === "percent";
}

/** `buy_x_get_y` is the only kind whose minimum quantity is what unlocks it. */
export function needsMinQuantity(kind: PromotionKind): boolean {
  return kind === "buy_x_get_y";
}

/**
 * Whether a kind is meaningless without an item scope.
 *
 * A `bundle_price` fires only when **every** member item of the bundle is in
 * the cart (`promotions.ts`), so a bundle with an empty `item_ids` can never
 * apply. The form cannot pick items yet, so it says so rather than saving a
 * campaign that would silently never fire.
 */
export function needsItemScope(kind: PromotionKind): boolean {
  return kind === "bundle_price";
}

/**
 * What the amount field is *called* for a kind, because it is not the same
 * quantity each time: a discount for `percent`/`amount`, but the **set price**
 * of the whole bundle for `bundle_price`/`buy_x_get_y`. Labelling the set
 * price «مبلغ تخفیف» is how a 500,000-Rial bundle gets entered as a
 * 500,000-Rial discount.
 */
export function campaignValueLabel(kind: PromotionKind, unitLabel: string): string {
  if (kind === "percent") return "درصد تخفیف";
  if (kind === "amount") return `مبلغ تخفیف هر قلم (${unitLabel})`;
  if (kind === "bundle_price") return `قیمت کل ست (${unitLabel})`;
  return `قیمت ثابت برای کل تعداد (${unitLabel})`;
}

/** One line under the amount field explaining what the number does. */
export function campaignValueHint(kind: PromotionKind): string {
  if (kind === "percent") return "درصدی از مبلغ هر قلمِ مشمول کم می‌شود.";
  if (kind === "amount") return "این مبلغ از هر قلمِ مشمول کم می‌شود و هیچ‌گاه بیشتر از خود قلم نیست.";
  if (kind === "bundle_price") {
    return "قیمتی که کل ست با آن فروخته می‌شود؛ تخفیف، اختلاف آن با جمع اقلام است.";
  }
  return "قیمتی که «حداقل تعداد» با آن فروخته می‌شود؛ تخفیف، اختلاف آن با جمع اقلام است.";
}

/** «HH:MM» as the `time` column and the engine both read it. */
export function isValidHm(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

/** Minutes past midnight for an already-valid «HH:MM». */
function hmMinutes(value: string): number {
  const [h, m] = value.trim().split(":");
  return Number(h) * 60 + Number(m);
}

/** A calendar date as the `date` column stores it — Gregorian ISO, the wire format. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The shape both the form and the service validate. Every field is optional the way the API body is. */
export interface CampaignDraft {
  name?: string | null;
  kind?: string | null;
  value?: unknown;
  minQuantity?: unknown;
  priority?: unknown;
  stacking?: string | null;
  activeFrom?: string | null;
  activeTo?: string | null;
  timeFrom?: string | null;
  timeTo?: string | null;
  daysOfWeek?: unknown;
  itemIds?: unknown;
}

/**
 * Every reason this campaign cannot be saved, in Persian, in the order the
 * form lays its fields out.
 *
 * Returns *all* the problems rather than the first: a form that reveals one
 * mistake per submit makes the person guess how many are left.
 */
export function validateCampaignDraft(draft: CampaignDraft): string[] {
  const problems: string[] = [];

  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (!name) problems.push("نام کمپین را بنویسید.");
  else if (name.length > MAX_CAMPAIGN_NAME_LENGTH) {
    problems.push(`نام کمپین نمی‌تواند بیشتر از ${MAX_CAMPAIGN_NAME_LENGTH} نویسه باشد.`);
  }

  const kind = draft.kind as PromotionKind;
  if (!CAMPAIGN_KINDS.includes(kind)) {
    // Without a known kind the value rules below have no meaning, so stop here.
    problems.push("نوع کمپین نامعتبر است.");
    return problems;
  }

  if (draft.stacking != null && draft.stacking !== "exclusive" && draft.stacking !== "stackable") {
    problems.push("قانون ترکیب کمپین نامعتبر است.");
  }

  const value = Number(draft.value);
  if (draft.value === "" || draft.value == null || !Number.isFinite(value)) {
    problems.push(
      isPercentKind(kind) ? "درصد تخفیف را وارد کنید." : "مبلغ کمپین را وارد کنید.",
    );
  } else if (!Number.isInteger(value)) {
    problems.push(
      isPercentKind(kind)
        ? "درصد تخفیف باید یک عدد صحیح باشد."
        : "مبلغ کمپین باید یک عدد صحیح باشد.",
    );
  } else if (value < 0) {
    problems.push("مقدار کمپین نمی‌تواند منفی باشد.");
  } else if (isPercentKind(kind) && value > 100) {
    problems.push("درصد تخفیف نمی‌تواند بیشتر از ۱۰۰ باشد.");
  } else if (value === 0 && (kind === "percent" || kind === "amount")) {
    // A zero discount is a campaign that fires and takes nothing off; it would
    // sit in the list as «در حال اجرا» and change no price.
    problems.push("مقدار کمپین باید بزرگ‌تر از صفر باشد.");
  }

  if (needsMinQuantity(kind)) {
    const minQuantity = Number(draft.minQuantity);
    if (draft.minQuantity === "" || draft.minQuantity == null || !Number.isFinite(minQuantity)) {
      problems.push("برای این نوع کمپین، «حداقل تعداد» الزامی است؛ بدون آن کمپین هرگز اعمال نمی‌شود.");
    } else if (!Number.isInteger(minQuantity) || minQuantity <= 0) {
      problems.push("«حداقل تعداد» باید یک عدد صحیح بزرگ‌تر از صفر باشد.");
    }
  }

  if (draft.priority != null && draft.priority !== "") {
    const priority = Number(draft.priority);
    if (!Number.isFinite(priority) || !Number.isInteger(priority)) {
      problems.push("اولویت باید یک عدد صحیح باشد.");
    } else if (Math.abs(priority) > MAX_CAMPAIGN_PRIORITY) {
      problems.push(`اولویت باید بین ${-MAX_CAMPAIGN_PRIORITY} و ${MAX_CAMPAIGN_PRIORITY} باشد.`);
    }
  }

  const from = draft.activeFrom?.trim() || "";
  const to = draft.activeTo?.trim() || "";
  if (from && !isIsoDate(from)) problems.push("«از تاریخ» معتبر نیست.");
  if (to && !isIsoDate(to)) problems.push("«تا تاریخ» معتبر نیست.");
  if (from && to && isIsoDate(from) && isIsoDate(to) && from > to) {
    problems.push("«از تاریخ» باید پیش از «تا تاریخ» باشد؛ وگرنه کمپین هیچ‌وقت اجرا نمی‌شود.");
  }

  const timeFrom = draft.timeFrom?.trim() || "";
  const timeTo = draft.timeTo?.trim() || "";
  if (timeFrom && !isValidHm(timeFrom)) problems.push("«از ساعت» معتبر نیست.");
  if (timeTo && !isValidHm(timeTo)) problems.push("«تا ساعت» معتبر نیست.");
  if (timeFrom && timeTo && isValidHm(timeFrom) && isValidHm(timeTo)) {
    const start = hmMinutes(timeFrom);
    const end = hmMinutes(timeTo);
    if (start === end) {
      problems.push("«از ساعت» و «تا ساعت» نمی‌توانند یکی باشند.");
    } else if (start > end) {
      // The engine reads the window as a single same-day range with an
      // exclusive upper bound, so 22:00→02:00 matches no moment at all rather
      // than wrapping past midnight.
      problems.push(
        "بازهٔ ساعتی نمی‌تواند از نیمه‌شب رد شود؛ «تا ساعت» باید بعد از «از ساعت» همان روز باشد.",
      );
    }
  }

  if (draft.daysOfWeek != null) {
    if (!Array.isArray(draft.daysOfWeek)) {
      problems.push("روزهای هفته معتبر نیست.");
    } else if (
      draft.daysOfWeek.some(
        (day) => !Number.isInteger(Number(day)) || Number(day) < 0 || Number(day) > 6,
      )
    ) {
      problems.push("روزهای هفته معتبر نیست.");
    }
  }

  return problems;
}

/**
 * A warning is not a reason to refuse the save — it is something the owner
 * should see before the campaign quietly does nothing.
 *
 * A `bundle_price` with no item scope is the case that matters: the row is
 * perfectly valid, the list will label it «در حال اجرا», and the engine will
 * skip it on every single cart because a bundle with no members can never be
 * complete.
 */
export function campaignWarnings(draft: CampaignDraft): string[] {
  const warnings: string[] = [];
  const kind = draft.kind as PromotionKind;
  const itemIds = Array.isArray(draft.itemIds) ? draft.itemIds : [];
  if (needsItemScope(kind) && itemIds.length === 0) {
    warnings.push(
      "ست هدیه تا وقتی اقلام آن مشخص نشده باشد اعمال نمی‌شود. اقلام ست را در «شامل چه کالاهایی می‌شود؟» به‌صورت «کالاهای مشخص» انتخاب کنید.",
    );
  }
  return warnings;
}

/**
 * The Persian week, in the order an Iranian calendar prints it, mapped to the
 * `days_of_week` column's JS `Date.getDay()` convention (0 = Sunday) — the same
 * convention the engine compares against. The list starts at شنبه, which is
 * `6`, so the order here is deliberately not `0..6`.
 */
export const CAMPAIGN_WEEKDAYS: readonly { value: number; label: string; short: string }[] = [
  { value: 6, label: "شنبه", short: "ش" },
  { value: 0, label: "یکشنبه", short: "ی" },
  { value: 1, label: "دوشنبه", short: "د" },
  { value: 2, label: "سه‌شنبه", short: "س" },
  { value: 3, label: "چهارشنبه", short: "چ" },
  { value: 4, label: "پنجشنبه", short: "پ" },
  { value: 5, label: "جمعه", short: "ج" },
];

/** «شنبه، دوشنبه» — the selected days in calendar order, or null for «هر روز». */
export function formatWeekdays(days: readonly number[] | null | undefined): string | null {
  if (!days || days.length === 0 || days.length === 7) return null;
  const chosen = CAMPAIGN_WEEKDAYS.filter((day) => days.includes(day.value));
  return chosen.length > 0 ? chosen.map((day) => day.label).join("، ") : null;
}
