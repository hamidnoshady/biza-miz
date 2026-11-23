/**
 * Fixed-asset depreciation — pure math, no DB access (Phase 22 Wave 5,
 * second slice, issue #160 §2; the lifecycle extension is issue #833). DB
 * orchestration (posting, tracking which periods have already been
 * depreciated, disposal) lives in fixed-assets-service.ts.
 *
 * Three methods (issue #1325): straight-line (unchanged default),
 * declining-balance with an explicit annual rate and a documented switch
 * rule, and units-of-production on approved capacity and actual usage. The
 * method is chosen by the accountant and recorded on the asset (and on each
 * posting, as a snapshot of what priced it); changes are prospective. Disposals
 * and reversals are service concerns (`disposeFixedAsset` /
 * `reverseDepreciation`); this module only prices a month and decides whether
 * a month is eligible at all.
 *
 * ## The schedule model (issue #833 review follow-up)
 *
 * A depreciation schedule is a REAL calendar sequence, not a row count: the
 * `usefulLifeMonths` months starting at the month the asset entered service.
 * A month is eligible only while it lies inside the span of the estimate
 * schedule that governs it (and inside the final schedule's span) — an old
 * asset with a two-month life cannot depreciate "some much later month"; the
 * life has to be extended first, and the extension applies prospectively.
 *
 * Amounts are LIVE-authoritative: the caller passes the postings that are
 * live right now and the accumulated total they sum to, and nothing else. A
 * reversal is simply absent from those numbers, so a month re-posted after a
 * reversal — before or after an estimate change — is priced from what is
 * genuinely on the books. The frozen snapshots an estimate change records
 * are audit facts about what the change meant, never a second accounting
 * truth the schedule recomputes from.
 *
 * The schedule always lands on exactly cost minus the final salvage value:
 * every month is charged its schedule's straight-line rate, and the last
 * unposted month of the final schedule's span absorbs whatever rounding (or
 * correction) is left.
 */

import { isoDateToJalali, isValidIsoDate, jalaliMonthLength, jalaliToIsoDate, JALALI_MONTHS } from "./jalali";

export interface DepreciableAsset {
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
}

// ---------------------------------------------------------------------------
// Depreciation methods — issue #1325.
//
// `straight_line` is the default and its arithmetic is byte-for-byte what it
// was before this module supported anything else. The other two are opt-in per
// asset (or per effective-dated estimate change) by an accountant:
//
//   * `declining_balance` charges a fixed ANNUAL rate (basis points) against
//     the opening carrying amount, one twelfth per Jalali month:
//         charge = opening carrying × rate ÷ 12
//     `decliningBalanceSwitchPolicy` decides what happens as the carrying
//     amount falls:
//       - `none` — keep the declining charge for every month; the final open
//         month of the schedule still absorbs whatever remains, so the asset
//         lands exactly on cost − salvage by the end of its useful life (the
//         truing-up is a schedule rule, not a mid-life change of method).
//       - `straight_line` — from the first month where straight-line over the
//         remaining months (on the remaining carrying amount above salvage)
//         is at least the declining charge, charge that larger straight-line
//         amount instead. This is the common "DB with switch to SL" policy and
//         it exhausts the depreciable base smoothly by the schedule's end.
//
//   * `units_of_production` charges approved total capacity and actual usage:
//         per-unit rate = (cost − final salvage) ÷ approved total capacity
//         charge        = round(period units × per-unit rate)
//     The month in which cumulative production reaches capacity absorbs the
//     rounding remainder exactly. A period with no production charges nothing
//     (and is not an error); a period that would push cumulative production
//     past capacity is refused rather than silently over-depreciating.
//
// Every method is bounded by the same lifetime cap: the sum of all live
// postings may never exceed cost − final salvage, and no method can take the
// carrying amount below the residual value.
// ---------------------------------------------------------------------------

export type DepreciationMethod = "straight_line" | "declining_balance" | "units_of_production";

export const DEPRECIATION_METHODS: readonly DepreciationMethod[] = [
  "straight_line",
  "declining_balance",
  "units_of_production",
];

/** `none` keeps the declining charge; `straight_line` switches when SL is ≥ DB. */
export type DecliningBalanceSwitchPolicy = "none" | "straight_line";

export const DECLINING_BALANCE_SWITCH_POLICIES: readonly DecliningBalanceSwitchPolicy[] = [
  "none",
  "straight_line",
];

/** Annual declining-balance rate limits, in basis points (10000 = 100% p.a.). */
export const DECLINING_BALANCE_RATE_MIN_BPS = 1;
export const DECLINING_BALANCE_RATE_MAX_BPS = 10_000;

/** Approved total production capacity and its unit, e.g. 500_000 «عدد». */
export const CAPACITY_UNIT_LABEL_MAX_LENGTH = 40;

export interface DepreciationMethodConfig {
  method: DepreciationMethod;
  /** Annual rate in basis points; required for declining-balance, NULL otherwise. */
  decliningBalanceRateBps: number | null;
  /** Required for declining-balance; ignored by the other methods. */
  decliningBalanceSwitchPolicy: DecliningBalanceSwitchPolicy;
  /** Approved lifetime capacity; required for units-of-production, NULL otherwise. */
  totalCapacityUnits: number | null;
  capacityUnitLabel: string | null;
}

/**
 * Validates a chosen method and its parameters. Persian messages, matching
 * `validateFixedAsset`'s contract (empty = valid). A method's parameters are
 * cleared when they do not apply, so a method change never leaves a stale rate
 * or capacity behind on the asset row.
 */
export function normaliseDepreciationMethod(input: {
  method?: string | null;
  decliningBalanceRateBps?: number | null;
  decliningBalanceSwitchPolicy?: string | null;
  totalCapacityUnits?: number | null;
  capacityUnitLabel?: string | null;
}): { ok: true; config: DepreciationMethodConfig } | { ok: false; errors: string[] } {
  const method = (input.method?.trim() || "straight_line") as DepreciationMethod;
  if (!DEPRECIATION_METHODS.includes(method)) {
    return { ok: false, errors: ["روش استهلاک انتخاب‌شده معتبر نیست."] };
  }
  const errors: string[] = [];
  const rate = input.decliningBalanceRateBps ?? null;
  const policy = (input.decliningBalanceSwitchPolicy?.trim() || "none") as DecliningBalanceSwitchPolicy;
  const capacity = input.totalCapacityUnits ?? null;
  const unitLabel = input.capacityUnitLabel?.trim() || null;

  if (method === "declining_balance") {
    if (
      rate === null ||
      !Number.isInteger(rate) ||
      rate < DECLINING_BALANCE_RATE_MIN_BPS ||
      rate > DECLINING_BALANCE_RATE_MAX_BPS
    ) {
      errors.push("نرخ سالانهٔ استهلاک نزولی باید عدد صحیح بین ۱ تا ۱۰۰۰۰ (یک‌صدم درصد) باشد.");
    }
    if (!DECLINING_BALANCE_SWITCH_POLICIES.includes(policy)) {
      errors.push("سیاست تغییر روش نزولی معتبر نیست.");
    }
  }
  if (method === "units_of_production") {
    if (capacity === null || !Number.isSafeInteger(capacity) || capacity <= 0) {
      errors.push("برای روش مقدار تولید، ظرفیت کل تأییدشده باید عدد صحیح مثبت باشد.");
    }
    if (unitLabel && unitLabel.length > CAPACITY_UNIT_LABEL_MAX_LENGTH) {
      errors.push("واحد اندازه‌گیری ظرفیت بیش از حد طولانی است.");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      method,
      decliningBalanceRateBps: method === "declining_balance" ? rate : null,
      decliningBalanceSwitchPolicy: method === "declining_balance" ? policy : "none",
      totalCapacityUnits: method === "units_of_production" ? capacity : null,
      capacityUnitLabel: method === "units_of_production" ? unitLabel : null,
    },
  };
}

/** The method config carried by a schedule (or a posting's snapshot). */
export interface MethodBearingSchedule {
  method?: DepreciationMethod | null;
  decliningBalanceRateBps?: number | null;
  decliningBalanceSwitchPolicy?: DecliningBalanceSwitchPolicy | null;
  totalCapacityUnits?: number | null;
}

/** Resolves absent method data to straight-line — every legacy row's meaning. */
export function methodOf(schedule: MethodBearingSchedule): DepreciationMethodConfig {
  const method = schedule.method && DEPRECIATION_METHODS.includes(schedule.method)
    ? schedule.method
    : "straight_line";
  return {
    method,
    decliningBalanceRateBps: method === "declining_balance" ? schedule.decliningBalanceRateBps ?? null : null,
    decliningBalanceSwitchPolicy:
      method === "declining_balance"
        ? schedule.decliningBalanceSwitchPolicy === "straight_line"
          ? "straight_line"
          : "none"
        : "none",
    totalCapacityUnits: method === "units_of_production" ? schedule.totalCapacityUnits ?? null : null,
    capacityUnitLabel: null,
  };
}

/** Whole months from `from` to `to` (both `YYYY-MM`); negative when reversed. */
export function monthsBetweenPeriodKeys(from: string, to: string): number {
  const a = parseDepreciationPeriodKey(from);
  const b = parseDepreciationPeriodKey(to);
  if (!a || !b) return 0;
  return b.jy * 12 + b.jm - (a.jy * 12 + a.jm);
}

/** Field limits shared by the service, the routes and the UI forms (issue #833). */
export const FIXED_ASSET_NAME_MAX_LENGTH = 200;
export const FIXED_ASSET_SERIAL_MAX_LENGTH = 120;
export const FIXED_ASSET_USEFUL_LIFE_MAX_MONTHS = 1200; // 100 years — anything longer is a typo, not a schedule

/** Persian validation errors for a new fixed asset; empty = valid. */
export function validateFixedAsset(input: {
  name: string;
  acquisitionDate: string;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  /** When it entered service; absent = the purchase date. */
  inServiceDate?: string | null;
}): string[] {
  const errors: string[] = [];
  if (!input.name?.trim()) errors.push("نام دارایی الزامی است.");
  else if (input.name.trim().length > FIXED_ASSET_NAME_MAX_LENGTH) {
    errors.push("نام دارایی بیش از حد طولانی است.");
  }
  // Strict `YYYY-MM-DD` — `Date.parse` accepts «March 5, 2025» and «2025/01/02»,
  // which would then fail (or worse, shift) once Postgres parsed the date.
  if (!isValidIsoDate(input.acquisitionDate?.trim() ?? "")) {
    errors.push("تاریخ خرید معتبر نیست.");
  }
  if (!Number.isSafeInteger(input.cost) || input.cost <= 0) {
    errors.push("بهای تمام‌شده باید عدد صحیح مثبت باشد.");
  }
  if (!Number.isSafeInteger(input.salvageValue) || input.salvageValue < 0) {
    errors.push("ارزش اسقاط باید عدد صحیح نامنفی باشد.");
  }
  if (
    Number.isSafeInteger(input.cost) &&
    Number.isSafeInteger(input.salvageValue) &&
    input.salvageValue >= input.cost
  ) {
    errors.push("ارزش اسقاط باید کمتر از بهای تمام‌شده باشد.");
  }
  if (
    !Number.isInteger(input.usefulLifeMonths) ||
    input.usefulLifeMonths <= 0 ||
    input.usefulLifeMonths > FIXED_ASSET_USEFUL_LIFE_MAX_MONTHS
  ) {
    errors.push(`عمر مفید باید عدد صحیح بین ۱ تا ${FIXED_ASSET_USEFUL_LIFE_MAX_MONTHS} ماه باشد.`);
  }
  const inService = input.inServiceDate?.trim();
  if (inService) {
    if (!isValidIsoDate(inService)) errors.push("تاریخ بهره‌برداری معتبر نیست.");
    else if (isValidIsoDate(input.acquisitionDate?.trim() ?? "") && inService < input.acquisitionDate.trim()) {
      errors.push("تاریخ بهره‌برداری نمی‌تواند پیش از تاریخ خرید باشد.");
    }
  }
  return errors;
}

/** The depreciable base — the total amount ever depreciated over the asset's life. */
export function depreciableBase(asset: DepreciableAsset): number {
  return asset.cost - asset.salvageValue;
}

/** Straight-line: the depreciable base spread evenly over the useful life, rounded to whole Rial. */
export function monthlyDepreciation(asset: DepreciableAsset): number {
  return Math.round(depreciableBase(asset) / asset.usefulLifeMonths);
}

// ---------------------------------------------------------------------------
// Canonical depreciation periods — dashboard audit F07.
//
// A period used to be whatever text the operator typed («۱۴۰۴/۰۱», «p1»,
// «فروردین»), unique only as that exact string, so the same Jalali month could
// be depreciated twice under two spellings. The period is now a Jalali month,
// keyed `YYYY-MM` (Latin digits — a storage key, never shown), bound to the
// month's Gregorian start and end dates; the label is only a memo.
// ---------------------------------------------------------------------------

export interface DepreciationPeriod {
  /** `YYYY-MM`, Jalali year and month. */
  key: string;
  jy: number;
  jm: number;
  /** First and last Gregorian calendar day of the Jalali month (ISO). */
  startsOn: string;
  endsOn: string;
  /** Persian label, e.g. «مهر ۱۴۰۵» (Latin digits; the UI localises). */
  label: string;
}

const PERIOD_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function depreciationPeriod(jy: number, jm: number): DepreciationPeriod {
  const key = `${jy}-${String(jm).padStart(2, "0")}`;
  return {
    key,
    jy,
    jm,
    startsOn: jalaliToIsoDate(jy, jm, 1),
    endsOn: jalaliToIsoDate(jy, jm, jalaliMonthLength(jy, jm)),
    label: `${JALALI_MONTHS[jm - 1]} ${jy}`,
  };
}

/** The Jalali month an ISO date falls in, or null for a malformed date. */
export function depreciationPeriodOfDate(isoDate: string): DepreciationPeriod | null {
  const j = isoDateToJalali(isoDate);
  return j ? depreciationPeriod(j.jy, j.jm) : null;
}

/** Parses a `YYYY-MM` Jalali period key; null when it is not one. */
export function parseDepreciationPeriodKey(key: string): DepreciationPeriod | null {
  const m = PERIOD_KEY.exec(key.trim());
  if (!m) return null;
  try {
    return depreciationPeriod(Number(m[1]), Number(m[2]));
  } catch {
    return null;
  }
}

/**
 * A period key shifted by whole months (positive, negative or zero), carrying
 * over the year: `1404-01 + 2 = 1404-03`, `1404-01 − 1 = 1403-12`. The keys
 * are zero-padded, so the result still compares chronologically as a string.
 */
export function addMonthsToPeriodKey(key: string, months: number): string {
  const m = PERIOD_KEY.exec(key.trim());
  if (!m) return key;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + months;
  const jy = Math.floor(total / 12);
  const jm = total % 12 + 1;
  return `${jy}-${String(jm).padStart(2, "0")}`;
}

/**
 * The last month of a schedule: the month the asset entered service, plus the
 * useful life, minus one. Null when the in-service date is not a date.
 */
export function scheduleEndPeriodKey(inServiceDate: string, usefulLifeMonths: number): string | null {
  const start = depreciationPeriodOfDate(inServiceDate);
  return start ? addMonthsToPeriodKey(start.key, usefulLifeMonths - 1) : null;
}

export type DepreciationRefusal =
  | "invalid_period"
  | "invalid_entry_date"
  | "entry_date_outside_period"
  | "entry_date_in_future"
  | "period_before_in_service"
  | "period_beyond_schedule"
  | "period_in_future"
  | "period_already_depreciated"
  | "fully_depreciated"
  /* method-specific refusals (issue #1325) */
  | "capacity_required"
  | "production_units_required"
  | "production_exceeds_capacity";

/** One estimate schedule's parameters — the original, or one change's revision. */
export interface DepreciationSchedule extends DepreciableAsset, MethodBearingSchedule {
  /** The month sequence's anchor: the schedule runs from the in-service month. */
  inServiceDate: string;
}

/** A live posting as the schedule sees it: its month, amount and (UoP) units. */
export interface DepreciationPostingFact {
  periodKey: string;
  amount: number;
  unitsProduced?: number | null;
}

export interface DepreciationPlanInput {
  /**
   * The schedule in force for the requested month: the original parameters
   * for a month from before the first estimate change, the applicable
   * change's new parameters for a month from after it. The caller resolves
   * it by period — the latest change whose effective period is at or before
   * the requested month.
   */
  schedule: DepreciationSchedule;
  /**
   * The asset's final (current) estimate — what the asset row holds today.
   * The lifetime cap and the overall schedule end come from it: everything
   * ever posted must sum to `cost − finalSalvageValue`, and no posting may
   * go past the final schedule's last month.
   */
  finalSalvageValue: number;
  finalUsefulLifeMonths: number;
  /** Period keys already posted for this asset (legacy rows: the key of their entry date). */
  postedPeriodKeys: string[];
  /** Live accumulated depreciation — the sum of exactly those postings. */
  accumulatedSoFar: number;
  /**
   * The live postings themselves. Optional for callers that post months in
   * chronological order (the legacy shape); when present they are the source
   * of the opening carrying amount (declining-balance) and of cumulative
   * production (units-of-production), so out-of-order catch-up posting stays
   * exact.
   */
  postedPostings?: DepreciationPostingFact[] | null;
  /** Units produced in the period being posted — required for units-of-production. */
  unitsProduced?: number | null;
  /** Requested Jalali month; when absent it is the month of `entryDate`, else of `today`. */
  periodKey?: string | null;
  /** Requested document date; when absent the month's last day, or today inside the current month. */
  entryDate?: string | null;
  /** The business's today (ISO). */
  today: string;
}

export type DepreciationPlan =
  | { ok: true; period: DepreciationPeriod; entryDate: string; amount: number }
  | { ok: false; error: DepreciationRefusal };

/**
 * Decides one depreciation posting from facts read under the asset's lock:
 * the canonical month, the document date, and the amount.
 *
 * ## Chronology and catch-up policy (issue #833)
 *
 * Continuity is NOT required: months are identified, not counted by position.
 * A register that started depreciating late, or skipped months, posts each
 * missing scheduled month individually as catch-up — each at its own
 * schedule's rate, under the estimate version in force for that month — and
 * the final scheduled period absorbs the rounding remainder, so the schedule
 * always lands on exactly cost minus the final salvage value. Out-of-order
 * posting is the same thing: the amount depends only on which months are
 * live and which schedule governs the requested month, never on the order
 * the rows arrived, and a reversed posting is simply not live.
 *
 * What is refused: a month before the asset entered service; a month past
 * the governing schedule's end (or the final schedule's end — extending a
 * life only helps from the change forward); a month that has not started
 * yet; the same canonical month twice; a document dated outside its month;
 * and a document dated after today — a past month's document is dated at its
 * month's last day (or any past day within the month), never a future one,
 * so no posting can carry a date the business has not reached yet.
 */
export function planDepreciation(input: DepreciationPlanInput): DepreciationPlan {
  const requestedDate = input.entryDate?.trim() || null;
  if (requestedDate && !isValidIsoDate(requestedDate)) return { ok: false, error: "invalid_entry_date" };

  let period: DepreciationPeriod | null;
  if (input.periodKey?.trim()) period = parseDepreciationPeriodKey(input.periodKey);
  else period = depreciationPeriodOfDate(requestedDate ?? input.today);
  if (!period) return { ok: false, error: "invalid_period" };

  const inService = depreciationPeriodOfDate(input.schedule.inServiceDate);
  if (!inService || period.endsOn < inService.startsOn) return { ok: false, error: "period_before_in_service" };
  if (period.startsOn > input.today) return { ok: false, error: "period_in_future" };

  const entryDate = requestedDate ?? (period.endsOn <= input.today ? period.endsOn : input.today);
  if (entryDate < period.startsOn || entryDate > period.endsOn) return { ok: false, error: "entry_date_outside_period" };
  // A date inside the current month but still ahead of the business's today is
  // a document from the future — the month has started, the day has not.
  if (entryDate > input.today) return { ok: false, error: "entry_date_in_future" };

  if (input.postedPeriodKeys.includes(period.key)) return { ok: false, error: "period_already_depreciated" };

  // The real schedule: eligibility ends with the governing schedule's last
  // month — and with the final schedule's last month, because a life that a
  // later change shortened has ended even for months an older schedule once
  // covered. Extending a life only re-opens months from the change forward.
  const governingEnd = scheduleEndPeriodKey(input.schedule.inServiceDate, input.schedule.usefulLifeMonths);
  const finalEnd = scheduleEndPeriodKey(input.schedule.inServiceDate, input.finalUsefulLifeMonths);
  if ((governingEnd && period.key > governingEnd) || (finalEnd && period.key > finalEnd)) {
    return { ok: false, error: "period_beyond_schedule" };
  }

  // What is genuinely left: the final salvage bounds the lifetime total, and
  // only live postings count against it — a reversal gives the amount back.
  const remainingTotal = input.schedule.cost - input.finalSalvageValue - input.accumulatedSoFar;
  if (remainingTotal <= 0) return { ok: false, error: "fully_depreciated" };

  const facts = input.postedPostings ?? null;
  const unitsBefore = facts
    ? facts.filter((p) => p.periodKey < period.key).reduce((sum, p) => sum + (p.unitsProduced ?? 0), 0)
    : 0;
  const method = methodOf(input.schedule);

  // Units-of-production is usage-driven, not calendar-driven: the month's own
  // production prices it, the approved capacity bounds it, and nothing is
  // absorbed on a "last open month" rule (a capacity that is not exhausted by
  // the schedule's end is an estimate to revise, not a rounding remainder).
  if (method.method === "units_of_production") {
    const capacity = method.totalCapacityUnits;
    if (!capacity || capacity <= 0) return { ok: false, error: "capacity_required" };
    const units = input.unitsProduced;
    if (units === null || units === undefined || !Number.isSafeInteger(units) || units < 0) {
      return { ok: false, error: "production_units_required" };
    }
    if (unitsBefore + units > capacity) return { ok: false, error: "production_exceeds_capacity" };
    if (units === 0) return { ok: false, error: "fully_depreciated" };
    const base = input.schedule.cost - input.finalSalvageValue;
    let amount = Math.round((units * base) / capacity);
    // The month that reaches capacity absorbs the per-unit rounding exactly.
    if (unitsBefore + units >= capacity) amount = remainingTotal;
    amount = Math.min(amount, remainingTotal);
    if (amount <= 0) return { ok: false, error: "fully_depreciated" };
    return { ok: true, period, entryDate, amount };
  }

  const posted = new Set(input.postedPeriodKeys);
  let isLastOpenMonth = true;
  for (let key = addMonthsToPeriodKey(period.key, 1); finalEnd && key <= finalEnd; key = addMonthsToPeriodKey(key, 1)) {
    if (!posted.has(key)) {
      isLastOpenMonth = false;
      break;
    }
  }

  // Declining balance prices from the carrying amount at the START of the
  // requested month, which the live postings before it determine — a catch-up
  // month is priced as if the schedule had been followed, not from today's
  // total. Without the posting facts the caller is posting chronologically, so
  // the live accumulated total is that opening amount.
  const openingAccumulated = facts
    ? facts.filter((p) => p.periodKey < period.key).reduce((sum, p) => sum + p.amount, 0)
    : input.accumulatedSoFar;

  const charge = depreciationCharge({
    cost: input.schedule.cost,
    salvageValue: input.schedule.salvageValue,
    usefulLifeMonths: input.schedule.usefulLifeMonths,
    method: method.method,
    decliningBalanceRateBps: method.decliningBalanceRateBps,
    decliningBalanceSwitchPolicy: method.decliningBalanceSwitchPolicy,
    inServiceDate: input.schedule.inServiceDate,
    periodKey: period.key,
    openingAccumulated,
    finalSalvageValue: input.finalSalvageValue,
  });

  // The last open month of the final schedule absorbs whatever is left —
  // rounding, corrections, everything — so the schedule lands exactly.
  const amount = isLastOpenMonth ? remainingTotal : Math.min(charge, remainingTotal);
  if (amount <= 0) return { ok: false, error: "fully_depreciated" };
  return { ok: true, period, entryDate, amount };
}

/**
 * One period's charge under the time-based methods (straight-line or
 * declining-balance). Never negative, never past the lifetime cap — the caller
 * applies that cap with the live accumulated total. Units-of-production is
 * priced by `planDepreciation`/`projectDepreciationSchedule`, where the month's
 * production is known.
 */
export function depreciationCharge(input: {
  cost: number;
  /** The governing schedule's salvage (used by straight-line). */
  salvageValue: number;
  usefulLifeMonths: number;
  method: DepreciationMethod;
  decliningBalanceRateBps?: number | null;
  decliningBalanceSwitchPolicy?: DecliningBalanceSwitchPolicy | null;
  /** The governing schedule's in-service date (the schedule's anchor). */
  inServiceDate: string;
  /** The period being priced, for the remaining-months switch test. */
  periodKey: string;
  /** Accumulated live depreciation strictly before the period. */
  openingAccumulated: number;
  /** The lifetime residual floor (the final schedule's salvage). */
  finalSalvageValue: number;
}): number {
  if (input.method === "units_of_production") return 0;
  const openingCarrying = Math.max(0, input.cost - input.openingAccumulated);
  if (input.method === "declining_balance") {
    const bps = input.decliningBalanceRateBps ?? 0;
    // bps is an ANNUAL rate in hundredths of a percent: /10000 /12 = /120000.
    const declining = (openingCarrying * bps) / 120_000;
    if (input.decliningBalanceSwitchPolicy !== "straight_line") return Math.max(0, Math.round(declining));
    // The switch compares the declining charge with straight-line over the
    // months remaining in the governing schedule (this month through the last
    // scheduled month, inclusive) on the remaining carrying amount above the
    // residual value — the standard "larger of the two" switch rule.
    const endKey = scheduleEndPeriodKey(input.inServiceDate, input.usefulLifeMonths);
    const remaining = endKey ? Math.max(1, monthsBetweenPeriodKeys(input.periodKey, endKey) + 1) : 1;
    const straightLine = Math.max(0, openingCarrying - input.finalSalvageValue) / remaining;
    return Math.max(0, Math.round(Math.max(declining, straightLine)));
  }
  return Math.max(0, Math.round((input.cost - input.salvageValue) / input.usefulLifeMonths));
}

// ---------------------------------------------------------------------------
// Projected depreciation schedule — issue #1325.
//
// One row per Jalali month from the in-service month to the schedule's end
// (or an earlier requested horizon). A month with a live posting is `posted`
// and carries that posting's amount — historical truth, never recomputed. A
// month without one is `forecast`: the amount the approved method would charge
// if it were posted today. Forecast rows are pure arithmetic; they never create
// a journal entry and nothing in the ledger reads them.
//
// The rows chain opening carrying amount → period depreciation → accumulated
// → closing carrying amount, so the accountant sees the same arithmetic the
// posting path uses. `remainingDepreciableBase` is cost − accumulated − the
// residual floor, never negative.
// ---------------------------------------------------------------------------

export interface DepreciationScheduleRow {
  periodKey: string;
  label: string;
  startsOn: string;
  endsOn: string;
  /** `posted` = a live journaled posting; `forecast` = projection only. */
  status: "posted" | "forecast";
  method: DepreciationMethod;
  /** Carrying amount at the start of the month (cost − live accumulated before it). */
  openingCarrying: number;
  depreciation: number;
  /** Carrying amount after this month. */
  closingCarrying: number;
  accumulated: number;
  /** Cost − accumulated − residual value, floored at zero. */
  remainingDepreciableBase: number;
  /** Units of production charged in the month, when the method uses them. */
  unitsProduced: number | null;
  /** The register row / journal entry behind a posted month. */
  entryId: string | null;
  journalEntryId: string | null;
  periodLabel: string | null;
}

export interface DepreciationScheduleTotals {
  cost: number;
  salvageValue: number;
  depreciableBase: number;
  postedDepreciation: number;
  forecastDepreciation: number;
  accumulated: number;
  closingCarrying: number;
  remainingDepreciableBase: number;
}

export function projectDepreciationSchedule(input: {
  asset: DepreciableAsset & MethodBearingSchedule & { inServiceDate: string };
  /** Only LIVE (non-reversed) postings — a reversal is absent, exactly as `planDepreciation` sees it. */
  livePostings: (DepreciationPostingFact & { method?: DepreciationMethod | null; entryId?: string | null; journalEntryId?: string | null; periodLabel?: string | null })[];
  /** Forecast units per future month for a units-of-production asset. */
  forecastUnitsPerPeriod?: number | null;
  /** The last month to project (inclusive); defaults to the schedule's end. */
  throughPeriodKey?: string | null;
  /** The month the business is in — rows after it are future months. */
  todayPeriodKey: string;
}): { rows: DepreciationScheduleRow[]; totals: DepreciationScheduleTotals } {
  const cost = input.asset.cost;
  const salvage = input.asset.salvageValue;
  const base = Math.max(0, cost - salvage);
  const method = methodOf(input.asset);
  const startPeriod = depreciationPeriodOfDate(input.asset.inServiceDate);
  const endKey = scheduleEndPeriodKey(input.asset.inServiceDate, input.asset.usefulLifeMonths);

  const emptyTotals = (): DepreciationScheduleTotals => ({
    cost,
    salvageValue: salvage,
    depreciableBase: base,
    postedDepreciation: 0,
    forecastDepreciation: 0,
    accumulated: 0,
    closingCarrying: cost,
    remainingDepreciableBase: base,
  });
  if (!startPeriod || !endKey) return { rows: [], totals: emptyTotals() };

  const through =
    input.throughPeriodKey && input.throughPeriodKey < endKey ? input.throughPeriodKey : endKey;
  if (through < startPeriod.key) return { rows: [], totals: emptyTotals() };

  const postedByKey = new Map(input.livePostings.map((p) => [p.periodKey, p]));
  const rows: DepreciationScheduleRow[] = [];
  let accumulated = 0;
  let cumulativeUnits = 0;
  let postedDepreciation = 0;
  let forecastDepreciation = 0;

  for (let key = startPeriod.key; key <= through; key = addMonthsToPeriodKey(key, 1)) {
    const period = parseDepreciationPeriodKey(key);
    if (!period) break;
    const openingCarrying = Math.max(0, cost - accumulated);
    const remainingBefore = Math.max(0, base - accumulated);
    if (remainingBefore <= 0) break;

    const posted = postedByKey.get(key);
    const rowMethod = posted?.method ?? method.method;
    let amount: number;
    let units: number | null = null;

    if (posted) {
      amount = posted.amount;
      units = posted.unitsProduced ?? null;
      if (units !== null) cumulativeUnits += units;
      postedDepreciation += amount;
    } else if (rowMethod === "units_of_production") {
      const capacity = method.totalCapacityUnits ?? 0;
      const planned = key > input.todayPeriodKey ? Math.max(0, input.forecastUnitsPerPeriod ?? 0) : 0;
      units = Math.max(0, Math.trunc(planned));
      if (capacity > 0 && units > 0) {
        amount = Math.round((units * base) / capacity);
        if (cumulativeUnits + units >= capacity) amount = remainingBefore;
      } else {
        amount = 0;
      }
      cumulativeUnits += units;
      amount = Math.min(Math.max(0, amount), remainingBefore);
      forecastDepreciation += amount;
    } else {
      amount = depreciationCharge({
        cost,
        salvageValue: salvage,
        usefulLifeMonths: input.asset.usefulLifeMonths,
        method: rowMethod,
        decliningBalanceRateBps: method.decliningBalanceRateBps,
        decliningBalanceSwitchPolicy: method.decliningBalanceSwitchPolicy,
        inServiceDate: input.asset.inServiceDate,
        periodKey: key,
        openingAccumulated: accumulated,
        finalSalvageValue: salvage,
      });
      // The schedule's last month absorbs whatever rounding is left, exactly
      // as a posting for that month would (the time-based methods must land on
      // cost − residual by the end of the useful life).
      if (key === endKey) amount = remainingBefore;
      amount = Math.min(Math.max(0, amount), remainingBefore);
      forecastDepreciation += amount;
    }

    accumulated += amount;
    rows.push({
      periodKey: key,
      label: period.label,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      status: posted ? "posted" : "forecast",
      method: rowMethod,
      openingCarrying,
      depreciation: amount,
      closingCarrying: Math.max(0, cost - accumulated),
      accumulated,
      remainingDepreciableBase: Math.max(0, base - accumulated),
      unitsProduced: units,
      entryId: posted?.entryId ?? null,
      journalEntryId: posted?.journalEntryId ?? null,
      periodLabel: posted?.periodLabel ?? null,
    });
  }

  return {
    rows,
    totals: {
      cost,
      salvageValue: salvage,
      depreciableBase: base,
      postedDepreciation,
      forecastDepreciation,
      accumulated,
      closingCarrying: Math.max(0, cost - accumulated),
      remainingDepreciableBase: Math.max(0, base - accumulated),
    },
  };
}

// ---------------------------------------------------------------------------
// Disposal — issue #833. The gain/loss a sale, retirement or write-off realises,
// from the same reconstructed numbers the register shows everywhere else.
// ---------------------------------------------------------------------------

export interface FixedAssetDisposalOutcome {
  /** Cost less live accumulated depreciation at the moment of disposal. */
  netBookValue: number;
  /** Proceeds above net book value — credited to 4920 «سود فروش دارایی ثابت». */
  gain: number;
  /** Proceeds below net book value — debited to 5750 «زیان فروش دارایی ثابت». */
  loss: number;
}

export function disposalOutcome(input: {
  cost: number;
  accumulatedDepreciation: number;
  proceeds: number;
}): FixedAssetDisposalOutcome {
  const netBookValue = Math.max(0, input.cost - input.accumulatedDepreciation);
  const delta = input.proceeds - netBookValue;
  return { netBookValue, gain: Math.max(0, delta), loss: Math.max(0, -delta) };
}

// ---------------------------------------------------------------------------
// Register ↔ general ledger — dashboard audit F09.
// ---------------------------------------------------------------------------

export interface FixedAssetReconciliationInput {
  registerCost: bigint;
  registerAccumulated: bigint;
  /** Net debit balance of the non-contra 1500–1599 asset accounts. */
  ledgerCost: bigint;
  /** Net credit balance of the contra 1500–1599 accounts (accumulated depreciation). */
  ledgerAccumulated: bigint;
  unlinkedCount: number;
  unlinkedCost: bigint;
}

export interface FixedAssetReconciliation {
  registerCost: string;
  ledgerCost: string;
  costDifference: string;
  registerAccumulated: string;
  ledgerAccumulated: string;
  accumulatedDifference: string;
  unlinkedCount: number;
  unlinkedCost: string;
  status: "reconciled" | "difference";
}

/** Differences are ledger − register; "reconciled" only when both are zero. */
export function reconcileFixedAssetRegister(input: FixedAssetReconciliationInput): FixedAssetReconciliation {
  const costDifference = input.ledgerCost - input.registerCost;
  const accumulatedDifference = input.ledgerAccumulated - input.registerAccumulated;
  return {
    registerCost: input.registerCost.toString(),
    ledgerCost: input.ledgerCost.toString(),
    costDifference: costDifference.toString(),
    registerAccumulated: input.registerAccumulated.toString(),
    ledgerAccumulated: input.ledgerAccumulated.toString(),
    accumulatedDifference: accumulatedDifference.toString(),
    unlinkedCount: input.unlinkedCount,
    unlinkedCost: input.unlinkedCost.toString(),
    status: costDifference === 0n && accumulatedDifference === 0n ? "reconciled" : "difference",
  };
}
