/**
 * Intangible assets — the pure half (issue #1326).
 *
 * Accounting rules only: what a valid intangible is, what a month's
 * amortization is, what an impairment or a disposal costs, and whether the
 * register still agrees with its mapped control accounts. DB orchestration —
 * locking, journal posting, reversal, history — lives in
 * `intangible-assets-service.ts`.
 *
 * ## Why the arithmetic is not re-implemented here
 *
 * A finite-life intangible is a straight-line schedule over a Jalali calendar:
 * exactly the discipline `depreciation.ts` already owns (canonical `YYYY-MM`
 * month keys, exact Rial, the final month absorbing rounding, no future
 * months, no double posting, a lifetime cap). Re-implementing that with
 * slightly different rounding would give the platform two ways to price a
 * month. So the schedule decisions are delegated to `planDepreciation` and
 * `projectDepreciationSchedule`, and this module only supplies the intangible
 * rules around them:
 *
 *   * an indefinite-life asset is **never** amortized — it is reviewed for
 *     impairment instead (issue #1326 §2), and the service refuses outright;
 *   * an intangible has no "salvage value": the residual is what the asset is
 *     expected to be worth at the end of its life, and the residual floor is
 *     what the schedule lands on;
 *   * impairment sits beside accumulated amortization, so carrying amount is
 *     `cost − accumulated amortization − accumulated impairment`;
 *   * a disposal's gain/loss compares proceeds with that carrying amount, not
 *     with cost less amortization alone.
 */

import {
  addMonthsToPeriodKey,
  depreciationPeriodOfDate,
  parseDepreciationPeriodKey,
  planDepreciation,
  projectDepreciationSchedule,
  scheduleEndPeriodKey,
  type DepreciationPeriod,
  type DepreciationRefusal,
  type DepreciationScheduleRow,
} from "./depreciation";
import { isValidIsoDate } from "./jalali";

/** Finite assets amortize; indefinite ones are reviewed for impairment. */
export type UsefulLifeType = "finite" | "indefinite";

export const USEFUL_LIFE_TYPES: readonly UsefulLifeType[] = ["finite", "indefinite"];

/**
 * The classes an accountant may choose. Kept deliberately small and generic:
 * the platform is multi-industry, so the class describes the accounting
 * treatment, not one industry's vocabulary.
 */
export type IntangibleAssetClass =
  | "software"
  | "license"
  | "patent"
  | "trademark"
  | "copyright"
  | "development"
  | "other";

export const INTANGIBLE_ASSET_CLASSES: readonly IntangibleAssetClass[] = [
  "software",
  "license",
  "patent",
  "trademark",
  "copyright",
  "development",
  "other",
];

/** Persian labels — the UI never shows the stored key. */
export const INTANGIBLE_ASSET_CLASS_LABELS: Record<IntangibleAssetClass, string> = {
  software: "نرم‌افزار",
  license: "مجوز و لایسنس",
  patent: "اختراع",
  trademark: "علامت تجاری",
  copyright: "حق تکثیر",
  development: "توسعهٔ قابل سرمایه‌گذاری",
  other: "سایر",
};

export const USEFUL_LIFE_TYPE_LABELS: Record<UsefulLifeType, string> = {
  finite: "عمر محدود",
  indefinite: "عمر نامحدود",
};

/** Who the asset was acquired from — evidence of the capitalization basis. */
export type IntangibleAcquisitionSource = "purchase" | "development" | "contribution" | "other";

export const INTANGIBLE_ACQUISITION_SOURCES: readonly IntangibleAcquisitionSource[] = [
  "purchase",
  "development",
  "contribution",
  "other",
];

export const INTANGIBLE_NAME_MAX_LENGTH = 200;
export const INTANGIBLE_CODE_MAX_LENGTH = 40;
export const INTANGIBLE_DESCRIPTION_MAX_LENGTH = 2000;
export const INTANGIBLE_REASON_MAX_LENGTH = 500;
export const INTANGIBLE_EVIDENCE_MAX_LENGTH = 500;
export const INTANGIBLE_POLICY_NOTE_MAX_LENGTH = 1000;
/** 50 years — beyond that a "finite" life is a typo, not an estimate. */
export const INTANGIBLE_USEFUL_LIFE_MAX_MONTHS = 600;

export interface IntangibleAssetInput {
  name: string;
  code?: string | null;
  assetClass: string;
  acquisitionDate: string;
  availableForUseDate?: string | null;
  acquisitionSource?: string | null;
  /** Total capitalized amount, including directly attributable cost. */
  cost: number;
  directlyAttributableCost?: number | null;
  usefulLifeType: string;
  usefulLifeMonths?: number | null;
  residualValue?: number | null;
  capitalizationPolicyNote?: string | null;
}

/**
 * Validates a registration. Persian messages, matching the fixed-asset
 * validator's contract, with empty meaning valid. A subscription or a routine
 * licence fee is not automatically an asset just because it arrived as an
 * invoice: capitalization is an explicit, documented decision, so the service
 * requires the policy note and the approving user for every registration
 * (issue #1326 §1 "Do not assume every software subscription … qualifies").
 */
export function validateIntangibleAsset(input: IntangibleAssetInput): string[] {
  const errors: string[] = [];
  const name = input.name?.trim() ?? "";
  if (!name) errors.push("نام دارایی نامشهود الزامی است.");
  else if (name.length > INTANGIBLE_NAME_MAX_LENGTH) errors.push("نام دارایی نامشهود بیش از حد طولانی است.");

  const code = input.code?.trim() ?? "";
  if (code && code.length > INTANGIBLE_CODE_MAX_LENGTH) errors.push("کد دارایی نامشهود بیش از حد طولانی است.");

  if (!INTANGIBLE_ASSET_CLASSES.includes(input.assetClass as IntangibleAssetClass)) {
    errors.push("طبقهٔ دارایی نامشهود معتبر نیست.");
  }

  if (!isValidIsoDate(input.acquisitionDate?.trim() ?? "")) errors.push("تاریخ تحصیل معتبر نیست.");
  const available = input.availableForUseDate?.trim() ?? "";
  if (available) {
    if (!isValidIsoDate(available)) errors.push("تاریخ آمادهٔ بهره‌برداری معتبر نیست.");
    else if (isValidIsoDate(input.acquisitionDate?.trim() ?? "") && available < input.acquisitionDate.trim()) {
      errors.push("تاریخ آمادهٔ بهره‌برداری نمی‌تواند پیش از تاریخ تحصیل باشد.");
    }
  }

  const source = input.acquisitionSource?.trim() || "purchase";
  if (!INTANGIBLE_ACQUISITION_SOURCES.includes(source as IntangibleAcquisitionSource)) {
    errors.push("منشأ تحصیل دارایی نامشهود معتبر نیست.");
  }

  if (!Number.isSafeInteger(input.cost) || input.cost <= 0) {
    errors.push("بهای تمام‌شدهٔ سرمایه‌ای‌شده باید عدد صحیح مثبت (ریال) باشد.");
  }
  const attributable = input.directlyAttributableCost ?? 0;
  if (!Number.isSafeInteger(attributable) || attributable < 0) {
    errors.push("هزینه‌های مستقیم قابل انتساب باید عدد صحیح نامنفی باشد.");
  } else if (Number.isSafeInteger(input.cost) && attributable >= input.cost) {
    errors.push("هزینه‌های مستقیم قابل انتساب باید کمتر از بهای تمام‌شدهٔ کل باشد.");
  }

  const lifeType = input.usefulLifeType?.trim() as UsefulLifeType;
  if (!USEFUL_LIFE_TYPES.includes(lifeType)) {
    errors.push("نوع عمر مفید (محدود یا نامحدود) باید مشخص شود.");
  } else if (lifeType === "finite") {
    const months = input.usefulLifeMonths;
    if (
      months === null ||
      months === undefined ||
      !Number.isInteger(months) ||
      months <= 0 ||
      months > INTANGIBLE_USEFUL_LIFE_MAX_MONTHS
    ) {
      errors.push(`عمر مفید دارایی با عمر محدود باید عدد صحیح بین ۱ تا ${INTANGIBLE_USEFUL_LIFE_MAX_MONTHS} ماه باشد.`);
    }
  } else if (input.usefulLifeMonths !== null && input.usefulLifeMonths !== undefined) {
    errors.push("دارایی با عمر نامحدود نباید عمر مفید ماهانه داشته باشد.");
  }

  const residual = input.residualValue ?? 0;
  if (!Number.isSafeInteger(residual) || residual < 0) {
    errors.push("ارزش باقی‌مانده باید عدد صحیح نامنفی باشد.");
  } else if (Number.isSafeInteger(input.cost) && residual >= input.cost) {
    errors.push("ارزش باقی‌مانده باید کمتر از بهای تمام‌شده باشد.");
  }

  const policy = input.capitalizationPolicyNote?.trim() ?? "";
  if (!policy) errors.push("یادداشت سیاست سرمایه‌ای‌سازی (مبنای شناسایی دارایی) الزامی است.");
  else if (policy.length > INTANGIBLE_POLICY_NOTE_MAX_LENGTH) errors.push("یادداشت سیاست سرمایه‌ای‌سازی بیش از حد طولانی است.");

  return errors;
}

/** Persian labels for the amortization refusals the service maps to 4xx codes. */
export const AMORTIZATION_REFUSAL_LABELS: Record<string, string> = {
  invalid_period: "ماه درخواستی معتبر نیست.",
  invalid_entry_date: "تاریخ سند معتبر نیست.",
  entry_date_outside_period: "تاریخ سند باید داخل همان ماه باشد.",
  entry_date_in_future: "تاریخ سند نمی‌تواند بعد از امروز کسب‌وکار باشد.",
  period_before_in_service: "این ماه پیش از آمادهٔ بهره‌برداری دارایی است.",
  period_beyond_schedule: "این ماه خارج از برنامهٔ استهلاک دارایی است.",
  period_in_future: "ماه درخواستی هنوز شروع نشده است.",
  period_already_amortized: "این ماه قبلاً استهلاک شده است.",
  fully_amortized: "دارایی به‌طور کامل مستهلک شده است.",
  indefinite_life_not_amortized: "دارایی با عمر نامحدود استهلاک نمی‌شود؛ آن را برای کاهش ارزش بررسی کنید.",
};

/**
 * The refusals this module can produce. The two month-level refusals are named
 * for amortization rather than depreciation so an API client never receives a
 * depreciation word for an intangible; the shared plan is translated below.
 */
export type IntangibleAmortizationRefusal =
  | Exclude<
      DepreciationRefusal,
      | "capacity_required"
      | "production_units_required"
      | "production_exceeds_capacity"
      | "period_already_depreciated"
      | "fully_depreciated"
    >
  | "period_already_amortized"
  | "fully_amortized"
  | "indefinite_life_not_amortized";

export interface AmortizableAsset {
  cost: number;
  residualValue: number;
  usefulLifeMonths: number;
  availableForUseDate: string;
}

/** Everything ever amortized over a finite life: cost less the residual. */
export function amortizableBase(asset: Pick<AmortizableAsset, "cost" | "residualValue">): number {
  return Math.max(0, asset.cost - asset.residualValue);
}

export type AmortizationPlan =
  | { ok: true; period: DepreciationPeriod; entryDate: string; amount: number }
  | { ok: false; error: IntangibleAmortizationRefusal };

/**
 * One month's amortization, decided from facts read under the asset's lock.
 *
 * Delegates the calendar/rounding/lifetime-cap rules to `planDepreciation` with
 * `straight_line` — the only method an intangible uses — and refuses an
 * indefinite-life asset before any arithmetic happens: such an asset is never
 * amortized, whatever month is asked for.
 */
export function planAmortization(input: {
  usefulLifeType: UsefulLifeType;
  asset: AmortizableAsset;
  postedPeriodKeys: string[];
  accumulatedSoFar: number;
  postedPostings: { periodKey: string; amount: number; unitsProduced?: number | null }[];
  periodKey?: string | null;
  entryDate?: string | null;
  today: string;
}): AmortizationPlan {
  if (input.usefulLifeType !== "finite") {
    return { ok: false, error: "indefinite_life_not_amortized" };
  }
  const plan = planDepreciation({
    schedule: {
      cost: input.asset.cost,
      salvageValue: input.asset.residualValue,
      usefulLifeMonths: input.asset.usefulLifeMonths,
      inServiceDate: input.asset.availableForUseDate,
      method: "straight_line",
    },
    finalSalvageValue: input.asset.residualValue,
    finalUsefulLifeMonths: input.asset.usefulLifeMonths,
    postedPeriodKeys: input.postedPeriodKeys,
    accumulatedSoFar: input.accumulatedSoFar,
    postedPostings: input.postedPostings,
    periodKey: input.periodKey ?? null,
    entryDate: input.entryDate ?? null,
    today: input.today,
  });
  if (plan.ok) return plan;
  // Straight-line can never produce the production-method refusals, so the
  // remainder is exactly this module's union after the two renames.
  const error = (
    plan.error === "period_already_depreciated"
      ? "period_already_amortized"
      : plan.error === "fully_depreciated"
        ? "fully_amortized"
        : plan.error
  ) as IntangibleAmortizationRefusal;
  return { ok: false, error };
}

export interface AmortizationScheduleRow {
  periodKey: string;
  label: string;
  startsOn: string;
  endsOn: string;
  /** `posted` = a live journaled posting; `forecast` = projection only. */
  status: "posted" | "forecast";
  openingCarrying: number;
  amortization: number;
  closingCarrying: number;
  accumulated: number;
  remainingAmortizableBase: number;
  entryId: string | null;
  journalEntryId: string | null;
}

export interface AmortizationScheduleTotals {
  cost: number;
  residualValue: number;
  amortizableBase: number;
  postedAmortization: number;
  forecastAmortization: number;
  accumulated: number;
  closingCarrying: number;
  remainingAmortizableBase: number;
}

/**
 * The whole schedule, posted months from history and future months projected.
 * An indefinite-life asset has no schedule at all — the accountant reviews it
 * for impairment instead, so returning an invented "0 per month" series would
 * be worse than returning nothing.
 */
export function projectAmortization(input: {
  usefulLifeType: UsefulLifeType;
  asset: AmortizableAsset;
  livePostings: { periodKey: string; amount: number; entryId?: string | null; journalEntryId?: string | null; periodLabel?: string | null }[];
  throughPeriodKey?: string | null;
  todayPeriodKey: string;
  /** Accumulated impairment, so carrying amounts shown match the register. */
  accumulatedImpairment?: number;
}): { rows: AmortizationScheduleRow[]; totals: AmortizationScheduleTotals } {
  const impairment = Math.max(0, input.accumulatedImpairment ?? 0);
  const emptyTotals = (): AmortizationScheduleTotals => ({
    cost: input.asset.cost,
    residualValue: input.asset.residualValue,
    amortizableBase: amortizableBase(input.asset),
    postedAmortization: 0,
    forecastAmortization: 0,
    accumulated: 0,
    closingCarrying: Math.max(0, input.asset.cost - impairment),
    remainingAmortizableBase: amortizableBase(input.asset),
  });
  if (input.usefulLifeType !== "finite") return { rows: [], totals: emptyTotals() };

  const projected = projectDepreciationSchedule({
    asset: {
      cost: input.asset.cost,
      salvageValue: input.asset.residualValue,
      usefulLifeMonths: input.asset.usefulLifeMonths,
      inServiceDate: input.asset.availableForUseDate,
      method: "straight_line",
    },
    livePostings: input.livePostings.map((p) => ({ ...p, method: "straight_line" as const })),
    throughPeriodKey: input.throughPeriodKey ?? null,
    todayPeriodKey: input.todayPeriodKey,
  });

  const rows: AmortizationScheduleRow[] = projected.rows.map((row: DepreciationScheduleRow) => ({
    periodKey: row.periodKey,
    label: row.label,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    status: row.status,
    openingCarrying: Math.max(0, row.openingCarrying - impairment),
    amortization: row.depreciation,
    closingCarrying: Math.max(0, row.closingCarrying - impairment),
    accumulated: row.accumulated,
    remainingAmortizableBase: row.remainingDepreciableBase,
    entryId: row.entryId,
    journalEntryId: row.journalEntryId,
  }));

  return {
    rows,
    totals: {
      cost: projected.totals.cost,
      residualValue: projected.totals.salvageValue,
      amortizableBase: projected.totals.depreciableBase,
      postedAmortization: projected.totals.postedDepreciation,
      forecastAmortization: projected.totals.forecastDepreciation,
      accumulated: projected.totals.accumulated,
      closingCarrying: Math.max(0, projected.totals.closingCarrying - impairment),
      remainingAmortizableBase: projected.totals.remainingDepreciableBase,
    },
  };
}

/** Cost less what has been posted against it — the one carrying-amount rule. */
export function intrinsicCarryingAmount(input: {
  cost: number;
  accumulatedAmortization: number;
  accumulatedImpairment: number;
}): number {
  return Math.max(0, input.cost - input.accumulatedAmortization - input.accumulatedImpairment);
}

/**
 * An impairment assessment's effect: the excess of carrying amount over the
 * recoverable amount. Null when the assessment finds no impairment — the
 * caller records the review, not an invented write-down.
 */
export function impairmentCharge(input: {
  carryingAmount: number;
  recoverableAmount: number;
}): number | null {
  if (!Number.isSafeInteger(input.recoverableAmount) || input.recoverableAmount < 0) return null;
  const charge = Math.max(0, input.carryingAmount - input.recoverableAmount);
  return charge > 0 ? charge : null;
}

/**
 * How much of a previous impairment may be reversed: never more than what is
 * still recognized, and never a write-up above the amount that would have been
 * the carrying amount had no impairment been recorded. The service passes both
 * ceilings; this function only enforces the smaller.
 */
export function reversibleImpairment(input: {
  outstandingImpairment: number;
  requestedAmount: number;
}): number | null {
  if (!Number.isSafeInteger(input.requestedAmount) || input.requestedAmount <= 0) return null;
  const amount = Math.min(input.requestedAmount, Math.max(0, input.outstandingImpairment));
  return amount > 0 ? amount : null;
}

export type DisposalKind = "sale" | "retirement" | "write_off";

export const DISPOSAL_KIND_LABELS: Record<DisposalKind, string> = {
  sale: "فروش",
  retirement: "کنارگذاری",
  write_off: "حذف",
};

export interface IntangibleDisposalOutcome {
  /** Cost less accumulated amortization and impairment at the disposal date. */
  netBookValue: number;
  /** Proceeds above carrying amount — a gain. */
  gain: number;
  /** Proceeds below carrying amount — a loss. */
  loss: number;
}

export function intangibleDisposalOutcome(input: {
  cost: number;
  accumulatedAmortization: number;
  accumulatedImpairment: number;
  proceeds: number;
}): IntangibleDisposalOutcome {
  const netBookValue = intrinsicCarryingAmount(input);
  const delta = input.proceeds - netBookValue;
  return { netBookValue, gain: Math.max(0, delta), loss: Math.max(0, -delta) };
}

// ---------------------------------------------------------------------------
// Register ↔ general ledger (issue #1326 §4 "Portfolio reconciliation against
// mapped GL control accounts"). Unlike the tangible register, an intangible's
// accounts are chosen per asset, so reconciliation compares the register's own
// totals with the live balances of exactly those mapped accounts — no account
// code ranges are assumed.
// ---------------------------------------------------------------------------
export interface IntangibleReconciliationInput {
  registerCost: bigint;
  registerAccumulatedAmortization: bigint;
  registerAccumulatedImpairment: bigint;
  /** Net debit balance of the asset accounts this register maps to. */
  ledgerCost: bigint;
  /** Net credit balance of the accumulated-amortization/impairment accounts. */
  ledgerAccumulatedAmortization: bigint;
  ledgerAccumulatedImpairment: bigint;
  /** Assets whose account mapping is incomplete — they cannot be reconciled. */
  unmappedCount: number;
}

export interface IntangibleReconciliation {
  registerCost: string;
  ledgerCost: string;
  costDifference: string;
  registerAccumulatedAmortization: string;
  ledgerAccumulatedAmortization: string;
  amortizationDifference: string;
  registerAccumulatedImpairment: string;
  ledgerAccumulatedImpairment: string;
  impairmentDifference: string;
  unmappedCount: number;
  status: "reconciled" | "difference";
}

/** Differences are ledger − register; reconciled only when all three are zero. */
export function reconcileIntangibleRegister(input: IntangibleReconciliationInput): IntangibleReconciliation {
  const costDifference = input.ledgerCost - input.registerCost;
  const amortizationDifference = input.ledgerAccumulatedAmortization - input.registerAccumulatedAmortization;
  const impairmentDifference = input.ledgerAccumulatedImpairment - input.registerAccumulatedImpairment;
  return {
    registerCost: input.registerCost.toString(),
    ledgerCost: input.ledgerCost.toString(),
    costDifference: costDifference.toString(),
    registerAccumulatedAmortization: input.registerAccumulatedAmortization.toString(),
    ledgerAccumulatedAmortization: input.ledgerAccumulatedAmortization.toString(),
    amortizationDifference: amortizationDifference.toString(),
    registerAccumulatedImpairment: input.registerAccumulatedImpairment.toString(),
    ledgerAccumulatedImpairment: input.ledgerAccumulatedImpairment.toString(),
    impairmentDifference: impairmentDifference.toString(),
    unmappedCount: input.unmappedCount,
    status:
      costDifference === 0n && amortizationDifference === 0n && impairmentDifference === 0n
        ? "reconciled"
        : "difference",
  };
}

/** The month an indefinite-life asset's next impairment review is due. */
export function impairmentReviewDuePeriod(availableForUseDate: string, reviewMonths = 12): string | null {
  const start = depreciationPeriodOfDate(availableForUseDate);
  if (!start) return null;
  if (!Number.isInteger(reviewMonths) || reviewMonths <= 0) return start.key;
  return addMonthsToPeriodKey(start.key, reviewMonths);
}

/** The last month of a finite schedule, for the register's "remaining life". */
export function scheduleEnd(availableForUseDate: string, usefulLifeMonths: number): string | null {
  return scheduleEndPeriodKey(availableForUseDate, usefulLifeMonths);
}

/** Parses a stored `YYYY-MM` key — re-exported so route handlers share one parser. */
export function parseAmortizationPeriodKey(key: string): DepreciationPeriod | null {
  return parseDepreciationPeriodKey(key);
}
