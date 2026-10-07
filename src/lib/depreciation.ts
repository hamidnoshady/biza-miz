/**
 * Fixed-asset depreciation — pure math, no DB access (Phase 22 Wave 5,
 * second slice, issue #160 §2). DB orchestration (posting, tracking which
 * periods have already been depreciated) lives in fixed-assets-service.ts.
 *
 * Straight-line only for v1 — the simplest default, matching every other
 * phase's "start simple, revisit if asked" pattern; no declining-balance,
 * units-of-production, or disposal/sale-of-asset workflow yet.
 */

import { isoDateToJalali, isValidIsoDate, jalaliMonthLength, jalaliToIsoDate, JALALI_MONTHS } from "./jalali";

export interface DepreciableAsset {
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
}

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
  if (!input.acquisitionDate?.trim() || Number.isNaN(Date.parse(input.acquisitionDate))) {
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
  if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths <= 0) {
    errors.push("عمر مفید باید عدد صحیح مثبت (به ماه) باشد.");
  }
  const inService = input.inServiceDate?.trim();
  if (inService) {
    if (!isValidIsoDate(inService)) errors.push("تاریخ بهره‌برداری معتبر نیست.");
    else if (isValidIsoDate(input.acquisitionDate?.trim()) && inService < input.acquisitionDate.trim()) {
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

/**
 * How much a period should depreciate, given `accumulatedSoFar` already
 * posted and `periodsPostedSoFar` prior periods. The regular monthly amount
 * for every period except the last scheduled one (`periodsPostedSoFar + 1
 * >= usefulLifeMonths`), which instead absorbs whatever's left of the
 * depreciable base — rounding `monthlyDepreciation` to the nearest whole
 * Rial each period would otherwise leave a few Rial of the depreciable base
 * permanently unposted (e.g. 100,000 over 3 months rounds to 33,333/month,
 * three of which sum to only 99,999). `0` means already fully depreciated;
 * the caller rejects posting that.
 */
export function depreciationForPeriod(
  asset: DepreciableAsset,
  accumulatedSoFar: number,
  periodsPostedSoFar: number,
): number {
  const remaining = depreciableBase(asset) - accumulatedSoFar;
  if (remaining <= 0) return 0;
  const isFinalScheduledPeriod = periodsPostedSoFar + 1 >= asset.usefulLifeMonths;
  return isFinalScheduledPeriod ? remaining : Math.min(monthlyDepreciation(asset), remaining);
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

export type DepreciationRefusal =
  | "invalid_period"
  | "invalid_entry_date"
  | "entry_date_outside_period"
  | "period_before_in_service"
  | "period_in_future"
  | "period_already_depreciated"
  | "fully_depreciated";

export interface DepreciationPlanInput {
  asset: DepreciableAsset & { inServiceDate: string };
  /** Period keys already posted for this asset (legacy rows: the key of their entry date). */
  postedPeriodKeys: string[];
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
 * the canonical month, the document date, and the amount — capped by
 * `depreciationForPeriod` at cost minus salvage. Refuses a month before the
 * asset entered service, a month that has not started yet, a document dated
 * outside its month, and a month already posted under any label.
 */
export function planDepreciation(input: DepreciationPlanInput): DepreciationPlan {
  const requestedDate = input.entryDate?.trim() || null;
  if (requestedDate && !isValidIsoDate(requestedDate)) return { ok: false, error: "invalid_entry_date" };

  let period: DepreciationPeriod | null;
  if (input.periodKey?.trim()) period = parseDepreciationPeriodKey(input.periodKey);
  else period = depreciationPeriodOfDate(requestedDate ?? input.today);
  if (!period) return { ok: false, error: "invalid_period" };

  const inService = depreciationPeriodOfDate(input.asset.inServiceDate);
  if (!inService || period.endsOn < inService.startsOn) return { ok: false, error: "period_before_in_service" };
  if (period.startsOn > input.today) return { ok: false, error: "period_in_future" };

  const entryDate = requestedDate ?? (period.endsOn <= input.today ? period.endsOn : input.today);
  if (entryDate < period.startsOn || entryDate > period.endsOn) return { ok: false, error: "entry_date_outside_period" };

  if (input.postedPeriodKeys.includes(period.key)) return { ok: false, error: "period_already_depreciated" };

  const amount = depreciationForPeriod(input.asset, input.accumulatedSoFar, input.postedPeriodKeys.length);
  if (amount <= 0) return { ok: false, error: "fully_depreciated" };
  return { ok: true, period, entryDate, amount };
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
