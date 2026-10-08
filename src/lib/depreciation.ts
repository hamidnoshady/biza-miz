/**
 * Fixed-asset depreciation — pure math, no DB access (Phase 22 Wave 5,
 * second slice, issue #160 §2; the lifecycle extension is issue #833). DB
 * orchestration (posting, tracking which periods have already been
 * depreciated, disposal) lives in fixed-assets-service.ts.
 *
 * Straight-line only for v1 — the simplest default, matching every other
 * phase's "start simple, revisit if asked" pattern; no declining-balance or
 * units-of-production yet. Disposals and reversals are service concerns
 * (`disposeFixedAsset` / `reverseDepreciation`); this module only prices a
 * month and decides whether a month is eligible at all.
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
  | "fully_depreciated";

/** One estimate schedule's parameters — the original, or one change's revision. */
export interface DepreciationSchedule extends DepreciableAsset {
  /** The month sequence's anchor: the schedule runs from the in-service month. */
  inServiceDate: string;
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

  const posted = new Set(input.postedPeriodKeys);
  let isLastOpenMonth = true;
  for (let key = addMonthsToPeriodKey(period.key, 1); finalEnd && key <= finalEnd; key = addMonthsToPeriodKey(key, 1)) {
    if (!posted.has(key)) {
      isLastOpenMonth = false;
      break;
    }
  }

  // The last open month of the final schedule absorbs whatever is left —
  // rounding, corrections, everything — so the schedule lands exactly.
  const amount = isLastOpenMonth
    ? remainingTotal
    : Math.min(monthlyDepreciation(input.schedule), remainingTotal);
  if (amount <= 0) return { ok: false, error: "fully_depreciated" };
  return { ok: true, period, entryDate, amount };
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
