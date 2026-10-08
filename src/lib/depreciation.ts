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
  | "entry_date_in_future"
  | "period_before_in_service"
  | "period_in_future"
  | "period_already_depreciated"
  | "fully_depreciated";

export interface DepreciationPlanInput {
  asset: DepreciableAsset & { inServiceDate: string };
  /** Period keys already posted for this asset (legacy rows: the key of their entry date). */
  postedPeriodKeys: string[];
  accumulatedSoFar: number;
  /**
   * Periods counted against the schedule that governs the requested month.
   * Defaults to `postedPeriodKeys.length` — every live posting — which is
   * right for an asset with no estimate changes. With changes, the caller
   * passes the window-scoped count (live at the applicable change, plus
   * postings since into that change's window), because a catch-up month from
   * *before* the change must not shorten the revised schedule's remaining
   * life, and a later revision's postings must not either.
   */
  schedulePeriodsPosted?: number;
  /** Requested Jalali month; when absent it is the month of `entryDate`, else of `today`. */
  periodKey?: string | null;
  /** Requested document date; when absent the month's last day, or today inside the current month. */
  entryDate?: string | null;
  /** The business's today (ISO). */
  today: string;
  /**
   * The estimate change in force for the month being planned, when there is
   * one. The caller resolves it *by period* — the latest change whose
   * effective period is at or before the requested month, not merely the
   * latest change recorded — and scopes `accumulatedSoFar` /
   * `postedPeriodKeys` to that revision's window (everything live at the
   * change, plus everything posted since into periods the revision governs;
   * charges belonging to a later revision's window are excluded). Once an
   * asset's useful life or salvage value has been revised, every period from
   * the change forward spreads *what was left when the estimate changed* over
   * *the life that was left*, prospectively — the historical postings are
   * never recomputed, and a catch-up month from before the change is charged
   * under the schedule that was in force for it.
   */
  revision?: DepreciationRevision | null;
}

export type DepreciationPlan =
  | { ok: true; period: DepreciationPeriod; entryDate: string; amount: number }
  | { ok: false; error: DepreciationRefusal };

/**
 * What a change of estimate froze (issue #833): the schedule a revised asset
 * runs on from the change forward. All three counts are snapshots taken when
 * the change was recorded — under the asset's row lock — so the amounts are
 * facts, never re-derived folklore.
 */
export interface DepreciationRevision {
  /** Live depreciation periods already posted when the estimate changed. */
  periodsPostedAtChange: number;
  /** Live accumulated depreciation when the estimate changed. */
  accumulatedAtChange: number;
  /** Depreciable amount left when the estimate changed (new salvage applied). */
  remainingBase: number;
  /** Months that remaining amount now has to fit into; 0 = due in full on the next period. */
  remainingLifeMonths: number;
}

/**
 * The amount for one period under a revised estimate: the remaining base
 * spread over the revised remaining life, with the same final-period
 * rounding correction `depreciationForPeriod` applies to a virgin schedule —
 * the last scheduled period absorbs whatever is left, so a revised schedule
 * also lands on the exact depreciable amount.
 *
 * `remainingLifeMonths` of 0 means the revision left no scheduled months (the
 * life was shortened to what had already been consumed): the whole remaining
 * base falls due on the next period.
 */
export function depreciationForPeriodUnderRevision(
  revision: DepreciationRevision,
  accumulatedSoFar: number,
  periodsPostedSoFar: number,
): number {
  const accumulatedSinceChange = accumulatedSoFar - revision.accumulatedAtChange;
  const remaining = revision.remainingBase - accumulatedSinceChange;
  if (remaining <= 0) return 0;
  const periodsSinceChange = periodsPostedSoFar - revision.periodsPostedAtChange;
  const isFinalScheduledPeriod =
    revision.remainingLifeMonths <= 0 || periodsSinceChange + 1 >= revision.remainingLifeMonths;
  if (isFinalScheduledPeriod) return remaining;
  return Math.min(Math.round(revision.remainingBase / revision.remainingLifeMonths), remaining);
}

/**
 * Decides one depreciation posting from facts read under the asset's lock:
 * the canonical month, the document date, and the amount — capped by
 * `depreciationForPeriod` at cost minus salvage. Refuses a month before the
 * asset entered service, a month that has not started yet, a document dated
 * outside its month, a document dated after today, and a month already
 * posted under any label.
 *
 * ## Chronology and catch-up policy (issue #833)
 *
 * Continuity is NOT required: months are identified, not counted by position.
 * A register that started depreciating late, or skipped months, posts each
 * missing month individually as catch-up — each at its own schedule amount,
 * under the estimate version in force for that month (see `revision`) — and
 * the final scheduled period absorbs the rounding remainder, so the schedule
 * always lands on exactly cost minus salvage. Out-of-order posting is the
 * same thing: a later month may be posted before an earlier one; the amount
 * depends only on which months are live and which schedule version governs
 * the requested month, never on the order the rows arrived.
 *
 * What is refused: a month before the asset entered service, a month that has
 * not started, the same canonical month twice, a document dated outside its
 * month, and a document dated after today — a past month's document is dated
 * at its month's last day (or any past day within the month), never a future
 * one, so no posting can carry a date the business has not reached yet.
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
  // A date inside the current month but still ahead of the business's today is
  // a document from the future — the month has started, the day has not.
  if (entryDate > input.today) return { ok: false, error: "entry_date_in_future" };

  if (input.postedPeriodKeys.includes(period.key)) return { ok: false, error: "period_already_depreciated" };

  const schedulePeriodsPosted = input.schedulePeriodsPosted ?? input.postedPeriodKeys.length;
  const amount = input.revision
    ? depreciationForPeriodUnderRevision(input.revision, input.accumulatedSoFar, schedulePeriodsPosted)
    : depreciationForPeriod(input.asset, input.accumulatedSoFar, schedulePeriodsPosted);
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
