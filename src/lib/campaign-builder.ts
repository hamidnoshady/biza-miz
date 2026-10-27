/**
 * Issue #901, first slice — the campaign builder's rules, as one pure module.
 *
 * A campaign here is a typed rule document: one *trigger* (WHEN) and one
 * *reward* (THEN), under hard *limits*. This slice supports exactly one of
 * each — a settled POS sale, and cashback — and the document shape is already
 * the one later triggers and rewards extend (`trigger.type` / `reward.type`
 * are the discriminants, `schemaVersion` is stored beside the document).
 *
 * Three things live here, framework-free and database-free so the Growth
 * screens, the API and a future import can all enforce the identical rules
 * (the split `campaign-rules.ts` already uses for promotions):
 *
 *   1. `parseCampaignDefinition` — validation. A campaign that cannot possibly
 *      pay (a fixed reward above its own budget, a per-customer cap below one
 *      reward, an empty branch list) is an invalid document, not a live one
 *      that silently does nothing. Unknown fields are rejected: a typed rule
 *      graph with a free-form tail is how an "unbounded workflow language"
 *      starts.
 *   2. `summarizeCampaign` — the human-readable rule, so an approver reads the
 *      same sentence the engine will enforce.
 *   3. `simulateCampaign` — the dry run. It replays a list of sale facts
 *      through the rules and reports the exposure. It never touches the
 *      database and its result says so (`dryRun: true`, `ledgerEffect:
 *      "none"`); nothing in this file creates a liability or posts an entry.
 *
 * Money is integer Rial throughout. Percentages are integer basis points
 * (1 bp = 0.01 %) so a reward is `floor(base * bps / 10000)` in BigInt — no
 * floating point ever decides how much a customer is owed.
 */

import { toPersianDigits } from "./digits";

/** Bump when the document shape changes incompatibly; stored beside every version. */
export const CAMPAIGN_SCHEMA_VERSION = 1;

export const MAX_CAMPAIGN_BUILDER_NAME_LENGTH = 120;
export const MAX_CAMPAIGN_BRANCHES = 200;
export const MAX_CAMPAIGN_HOLD_DAYS = 365;

export const CAMPAIGN_TRIGGER_TYPES = ["pos_sale_settled"] as const;
export type CampaignTriggerType = (typeof CAMPAIGN_TRIGGER_TYPES)[number];

export const CAMPAIGN_REWARD_TYPES = ["cashback"] as const;
export type CampaignRewardType = (typeof CAMPAIGN_REWARD_TYPES)[number];

/**
 * What the reward is computed on. Both are *settled net paid* — money actually
 * received, net of refunds — never the order total, so an unpaid, voided or
 * fully refunded sale earns nothing. `net_paid_excl_tax` additionally removes
 * the sale's tax in proportion to the paid share.
 */
export const CAMPAIGN_REWARD_BASES = ["net_paid", "net_paid_excl_tax"] as const;
export type CampaignRewardBasis = (typeof CAMPAIGN_REWARD_BASES)[number];

export const CAMPAIGN_REWARD_BASIS_LABELS: Record<CampaignRewardBasis, string> = {
  net_paid: "مبلغ خالص پرداخت‌شده",
  net_paid_excl_tax: "مبلغ خالص پرداخت‌شده بدون مالیات",
};

export interface PosSaleSettledTrigger {
  type: "pos_sale_settled";
  /** Minimum settled net paid amount for a sale to qualify, in Rial. 0 = any paid sale. */
  minNetPaidRial: number;
  /** Branch ids the campaign applies to; `null` = every branch. Never an empty list. */
  locationIds: string[] | null;
}

interface CashbackRewardBase {
  type: "cashback";
  basis: CampaignRewardBasis;
  /** Per-order ceiling, in Rial; `null` = none (percent rewards should normally set one). */
  maxPerOrderRial: number | null;
  /** Days after the sale before the reward becomes spendable (the return hold). */
  holdDays: number;
}

export interface PercentCashbackReward extends CashbackRewardBase {
  mode: "percent";
  /** Basis points of the reward basis: 500 = 5 %. */
  percentBps: number;
}

export interface FixedCashbackReward extends CashbackRewardBase {
  mode: "fixed";
  fixedRial: number;
}

export type CashbackReward = PercentCashbackReward | FixedCashbackReward;

export interface CampaignLimits {
  /** The campaign's hard budget, in Rial. Required: a reward that cannot run out is not a campaign. */
  totalBudgetRial: number;
  /** Lifetime reward ceiling per customer, in Rial; `null` = none. */
  perCustomerCapRial: number | null;
}

export interface CampaignDefinition {
  trigger: PosSaleSettledTrigger;
  reward: CashbackReward;
  limits: CampaignLimits;
}

export interface CampaignProblem {
  /** Dotted path into the document, e.g. `reward.percentBps`. */
  path: string;
  code: string;
  message: string;
}

export type ParseCampaignResult =
  | { ok: true; definition: CampaignDefinition }
  | { ok: false; problems: CampaignProblem[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveRial(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeRial(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates an untrusted campaign document and returns it with its optional
 * fields normalised (`null` rather than missing), so a stored document and its
 * hash are canonical. Every problem is reported, not just the first, so a form
 * can mark all of them at once.
 */
export function parseCampaignDefinition(input: unknown): ParseCampaignResult {
  const problems: CampaignProblem[] = [];
  const problem = (path: string, code: string, message: string) => problems.push({ path, code, message });

  if (!isRecord(input)) {
    return { ok: false, problems: [{ path: "", code: "definition_invalid", message: "تعریف کمپین باید یک شیء باشد." }] };
  }

  const rejectUnknown = (obj: Record<string, unknown>, allowed: readonly string[], path: string) => {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        problem(path ? `${path}.${key}` : key, "unknown_field", `فیلد «${key}» در تعریف کمپین شناخته‌شده نیست.`);
      }
    }
  };

  rejectUnknown(input, ["trigger", "reward", "limits"], "");

  // ── trigger ────────────────────────────────────────────────────────────────
  let trigger: PosSaleSettledTrigger | null = null;
  if (!isRecord(input.trigger)) {
    problem("trigger", "trigger_required", "رویداد شروع کمپین مشخص نشده است.");
  } else if (input.trigger.type !== "pos_sale_settled") {
    problem("trigger.type", "trigger_unsupported", "فعلاً فقط رویداد «فروش تسویه‌شده در صندوق» پشتیبانی می‌شود.");
  } else {
    rejectUnknown(input.trigger, ["type", "minNetPaidRial", "locationIds"], "trigger");
    const minNetPaidRial = input.trigger.minNetPaidRial;
    const locationIds = input.trigger.locationIds ?? null;
    let ok = true;
    if (!isNonNegativeRial(minNetPaidRial)) {
      problem("trigger.minNetPaidRial", "min_net_paid_invalid", "حداقل مبلغ فروش باید عدد صحیح صفر یا بیشتر باشد.");
      ok = false;
    }
    let branches: string[] | null = null;
    if (locationIds !== null) {
      if (!Array.isArray(locationIds) || locationIds.length === 0) {
        problem("trigger.locationIds", "branches_invalid", "فهرست شعبه‌ها نباید خالی باشد؛ برای همهٔ شعبه‌ها آن را خالی نگذارید (null).");
        ok = false;
      } else if (locationIds.length > MAX_CAMPAIGN_BRANCHES) {
        problem("trigger.locationIds", "branches_too_many", "تعداد شعبه‌های انتخابی بیش از حد مجاز است.");
        ok = false;
      } else if (locationIds.some((id) => typeof id !== "string" || id.trim() === "")) {
        problem("trigger.locationIds", "branches_invalid", "شناسهٔ شعبه‌ها باید متن غیرخالی باشد.");
        ok = false;
      } else {
        branches = [...new Set((locationIds as string[]).map((id) => id.trim()))].sort();
      }
    }
    if (ok) trigger = { type: "pos_sale_settled", minNetPaidRial: minNetPaidRial as number, locationIds: branches };
  }

  // ── reward ─────────────────────────────────────────────────────────────────
  let reward: CashbackReward | null = null;
  if (!isRecord(input.reward)) {
    problem("reward", "reward_required", "پاداش کمپین مشخص نشده است.");
  } else if (input.reward.type !== "cashback") {
    problem("reward.type", "reward_unsupported", "فعلاً فقط پاداش «بازگشت وجه» پشتیبانی می‌شود.");
  } else {
    const r = input.reward;
    rejectUnknown(r, ["type", "mode", "percentBps", "fixedRial", "basis", "maxPerOrderRial", "holdDays"], "reward");
    let ok = true;

    if (!CAMPAIGN_REWARD_BASES.includes(r.basis as CampaignRewardBasis)) {
      problem("reward.basis", "basis_invalid", "مبنای محاسبهٔ پاداش معتبر نیست.");
      ok = false;
    }
    const maxRaw = r.maxPerOrderRial ?? null;
    let maxPerOrder: number | null = null;
    if (maxRaw !== null) {
      if (isPositiveRial(maxRaw)) {
        maxPerOrder = maxRaw;
      } else {
        problem("reward.maxPerOrderRial", "max_per_order_invalid", "سقف پاداش هر سفارش باید عدد صحیح مثبت باشد.");
        ok = false;
      }
    }
    if (
      typeof r.holdDays !== "number" ||
      !Number.isSafeInteger(r.holdDays) ||
      r.holdDays < 0 ||
      r.holdDays > MAX_CAMPAIGN_HOLD_DAYS
    ) {
      problem("reward.holdDays", "hold_days_invalid", `مدت نگهداری پاداش باید عدد صحیح بین ۰ تا ${toPersianDigits(MAX_CAMPAIGN_HOLD_DAYS)} روز باشد.`);
      ok = false;
    }

    if (r.mode === "percent") {
      if (r.fixedRial !== undefined) {
        problem("reward.fixedRial", "unknown_field", "مبلغ ثابت فقط برای حالت «مبلغ ثابت» معنی دارد.");
        ok = false;
      }
      if (typeof r.percentBps !== "number" || !Number.isSafeInteger(r.percentBps) || r.percentBps < 1 || r.percentBps > 10_000) {
        problem("reward.percentBps", "percent_invalid", "درصد پاداش باید بین ۰٫۰۱ و ۱۰۰ درصد باشد.");
        ok = false;
      }
      if (ok) {
        reward = {
          type: "cashback",
          mode: "percent",
          percentBps: r.percentBps as number,
          basis: r.basis as CampaignRewardBasis,
          maxPerOrderRial: maxPerOrder,
          holdDays: r.holdDays as number,
        };
      }
    } else if (r.mode === "fixed") {
      if (r.percentBps !== undefined) {
        problem("reward.percentBps", "unknown_field", "درصد فقط برای حالت «درصدی» معنی دارد.");
        ok = false;
      }
      if (!isPositiveRial(r.fixedRial)) {
        problem("reward.fixedRial", "fixed_invalid", "مبلغ ثابت پاداش باید عدد صحیح مثبت باشد.");
        ok = false;
      } else if (maxPerOrder !== null && maxPerOrder < r.fixedRial) {
        problem("reward.maxPerOrderRial", "max_below_fixed", "سقف هر سفارش کمتر از مبلغ ثابت پاداش است؛ این کمپین هرگز پاداش کامل نمی‌دهد.");
        ok = false;
      }
      if (ok) {
        reward = {
          type: "cashback",
          mode: "fixed",
          fixedRial: r.fixedRial as number,
          basis: r.basis as CampaignRewardBasis,
          maxPerOrderRial: maxPerOrder,
          holdDays: r.holdDays as number,
        };
      }
    } else {
      problem("reward.mode", "mode_invalid", "نوع پاداش باید «درصدی» یا «مبلغ ثابت» باشد.");
    }
  }

  // ── limits ─────────────────────────────────────────────────────────────────
  let limits: CampaignLimits | null = null;
  if (!isRecord(input.limits)) {
    problem("limits", "limits_required", "محدودیت‌های مالی کمپین مشخص نشده است.");
  } else {
    rejectUnknown(input.limits, ["totalBudgetRial", "perCustomerCapRial"], "limits");
    let ok = true;
    const capRaw = input.limits.perCustomerCapRial ?? null;
    let perCustomerCap: number | null = null;
    if (!isPositiveRial(input.limits.totalBudgetRial)) {
      problem("limits.totalBudgetRial", "budget_required", "بودجهٔ کل کمپین الزامی است و باید عدد صحیح مثبت باشد.");
      ok = false;
    }
    if (capRaw !== null) {
      if (isPositiveRial(capRaw)) {
        perCustomerCap = capRaw;
      } else {
        problem("limits.perCustomerCapRial", "customer_cap_invalid", "سقف پاداش هر مشتری باید عدد صحیح مثبت باشد.");
        ok = false;
      }
    }
    if (ok) {
      limits = { totalBudgetRial: input.limits.totalBudgetRial as number, perCustomerCapRial: perCustomerCap };
    }
  }

  // ── cross-field rules: a campaign that can never pay is invalid ───────────
  if (reward && limits) {
    if (reward.mode === "fixed") {
      if (reward.fixedRial > limits.totalBudgetRial) {
        problem("limits.totalBudgetRial", "reward_exceeds_budget", "مبلغ ثابت پاداش از بودجهٔ کل بیشتر است؛ هیچ پاداشی پرداخت نمی‌شود.");
      }
      if (limits.perCustomerCapRial !== null && reward.fixedRial > limits.perCustomerCapRial) {
        problem("limits.perCustomerCapRial", "reward_exceeds_customer_cap", "مبلغ ثابت پاداش از سقف هر مشتری بیشتر است؛ هیچ پاداشی پرداخت نمی‌شود.");
      }
    }
  }

  if (problems.length > 0 || !trigger || !reward || !limits) return { ok: false, problems };
  return { ok: true, definition: { trigger, reward, limits } };
}

// ── summary ───────────────────────────────────────────────────────────────────

/** «۵» for 500 bps, «۲٫۵» for 250. */
export function formatPercentBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  if (fraction === 0) return toPersianDigits(whole);
  const digits = String(fraction).padStart(2, "0").replace(/0+$/, "");
  return `${toPersianDigits(whole)}٫${toPersianDigits(digits)}`;
}

/**
 * The rule in words, one sentence per line, for the review step. `formatRial`
 * is the caller's money formatter (the business-selected unit), so this module
 * never decides between Toman and Rial.
 */
export function summarizeCampaign(definition: CampaignDefinition, formatRial: (rial: number) => string): string[] {
  const { trigger, reward, limits } = definition;
  const lines: string[] = [];

  const scope = trigger.locationIds === null ? "در همهٔ شعبه‌ها" : `در ${toPersianDigits(trigger.locationIds.length)} شعبهٔ انتخاب‌شده`;
  lines.push(
    trigger.minNetPaidRial > 0
      ? `وقتی فروشی در صندوق تسویه شود و مبلغ خالص پرداخت‌شده‌اش دست‌کم ${formatRial(trigger.minNetPaidRial)} باشد (${scope})`
      : `وقتی فروشی در صندوق تسویه شود (${scope})`,
  );

  const basis = CAMPAIGN_REWARD_BASIS_LABELS[reward.basis];
  if (reward.mode === "percent") {
    lines.push(`${formatPercentBps(reward.percentBps)} درصد از ${basis} به‌عنوان بازگشت وجه برای مشتری ذخیره می‌شود`);
  } else {
    lines.push(`مبلغ ثابت ${formatRial(reward.fixedRial)} به‌عنوان بازگشت وجه برای مشتری ذخیره می‌شود`);
  }
  if (reward.maxPerOrderRial !== null) lines.push(`پاداش هر سفارش حداکثر ${formatRial(reward.maxPerOrderRial)} است`);

  lines.push(
    reward.holdDays === 0
      ? "پاداش بلافاصله قابل استفاده است"
      : `پاداش پس از ${toPersianDigits(reward.holdDays)} روز نگهداری (مهلت مرجوعی) قابل استفاده می‌شود`,
  );

  lines.push(`بودجهٔ کل کمپین ${formatRial(limits.totalBudgetRial)} است و با تمام‌شدنش پاداش جدیدی صادر نمی‌شود`);
  if (limits.perCustomerCapRial !== null) {
    lines.push(`هر مشتری در مجموع حداکثر ${formatRial(limits.perCustomerCapRial)} پاداش می‌گیرد`);
  }
  return lines;
}

// ── simulation ────────────────────────────────────────────────────────────────

/**
 * One sale, as the dry run sees it. `netPaidRial` is money actually received
 * net of refunds, excluding on-account («نسیه») tender — never the order total.
 */
export interface SimulationSale {
  orderId: string;
  locationId: string;
  customerId: string | null;
  /** `completed` is the only status that can earn; the rest are named so the report can say why not. */
  status: "completed" | "voided" | "other";
  /** ISO instant the sale closed; orders the replay. */
  closedAt: string;
  totalRial: number;
  taxRial: number;
  netPaidRial: number;
}

export const EXCLUSION_REASONS = [
  "voided",
  "not_completed",
  "out_of_scope_branch",
  "no_customer",
  "not_settled",
  "below_minimum",
  "no_reward",
  "customer_cap_reached",
  "budget_exhausted",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const EXCLUSION_REASON_LABELS: Record<ExclusionReason, string> = {
  voided: "سفارش ابطال‌شده",
  not_completed: "سفارش تکمیل‌نشده",
  out_of_scope_branch: "خارج از شعبه‌های کمپین",
  no_customer: "بدون مشتری مشخص",
  not_settled: "تسویه‌نشده یا کاملاً مرجوع‌شده",
  below_minimum: "کمتر از حداقل مبلغ",
  no_reward: "پاداش محاسبه‌شده صفر است",
  customer_cap_reached: "سقف پاداش مشتری تمام شده",
  budget_exhausted: "بودجهٔ کمپین تمام شده",
};

export interface SimulationOutcome {
  orderId: string;
  closedAt: string;
  rewardRial: number;
  reason: ExclusionReason | null;
  /** True when the per-customer cap reduced (but did not remove) this reward. */
  clippedByCustomerCap: boolean;
}

export interface SimulationResult {
  /** A simulation is a dry run by construction. */
  dryRun: true;
  /** …and by construction never posts: no journal entry, no liability. */
  ledgerEffect: "none";
  salesConsidered: number;
  rewardedSales: number;
  rewardedCustomers: number;
  /** Total reward the campaign would have reserved over the replayed sales. */
  exposureRial: number;
  /** Of that, what the return hold would already have released at `asOf`. */
  availableRial: number;
  pendingRial: number;
  budgetRial: number;
  budgetRemainingRial: number;
  /** The first sale the budget turned away, if any. */
  budgetExhaustedAtOrderId: string | null;
  largestRewardRial: number;
  excluded: Record<ExclusionReason, number>;
  outcomes: SimulationOutcome[];
}

const DAY_MS = 86_400_000;

/**
 * The reward one qualifying sale earns before the per-customer cap and the
 * budget: the percentage (or fixed amount) of the basis, then the per-order
 * ceiling. Exported so a checkout-side caller can use the very same number.
 */
export function rewardForSale(reward: CashbackReward, sale: Pick<SimulationSale, "totalRial" | "taxRial" | "netPaidRial">): number {
  const netPaid = BigInt(Math.max(0, sale.netPaidRial));
  let base = netPaid;
  if (reward.basis === "net_paid_excl_tax" && sale.totalRial > 0 && sale.taxRial > 0) {
    const paidShare = BigInt(Math.min(sale.netPaidRial, sale.totalRial));
    const total = BigInt(sale.totalRial);
    // Rounded up: when a sale is partly paid, the tax share removed from the
    // basis is never understated.
    const taxShare = (BigInt(sale.taxRial) * paidShare + total - 1n) / total;
    base = netPaid > taxShare ? netPaid - taxShare : 0n;
  }

  let amount = reward.mode === "percent" ? (base * BigInt(reward.percentBps)) / 10_000n : BigInt(reward.fixedRial);
  if (reward.mode === "fixed" && base === 0n) amount = 0n;
  if (reward.maxPerOrderRial !== null && amount > BigInt(reward.maxPerOrderRial)) amount = BigInt(reward.maxPerOrderRial);
  return Number(amount);
}

/**
 * Replays `sales` through the campaign and reports what it would have done.
 *
 * Sales are processed oldest first (ties by order id) so the budget is spent in
 * the order it would be spent live. Two caps, deliberately different:
 *
 *   - the **per-customer cap clips**: a customer 30 000 short of their cap
 *     still earns 30 000 — a cap is a ceiling on a total;
 *   - the **budget blocks**: a reward that does not fit what is left is turned
 *     away whole, never issued part-paid, because a half-reward is a number
 *     nobody promised the customer. A later, smaller sale can still fit.
 *
 * `asOf` splits exposure into what the return hold would already have
 * released (`availableRial`) and what would still be pending.
 */
export function simulateCampaign(definition: CampaignDefinition, sales: readonly SimulationSale[], asOf: Date): SimulationResult {
  const { trigger, reward, limits } = definition;
  const excluded = Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0])) as Record<ExclusionReason, number>;
  const scope = trigger.locationIds === null ? null : new Set(trigger.locationIds);
  const ordered = [...sales].sort((a, b) =>
    a.closedAt === b.closedAt ? (a.orderId < b.orderId ? -1 : 1) : a.closedAt < b.closedAt ? -1 : 1,
  );

  const perCustomer = new Map<string, number>();
  const outcomes: SimulationOutcome[] = [];
  let remaining = limits.totalBudgetRial;
  let exposure = 0;
  let available = 0;
  let rewardedSales = 0;
  let largest = 0;
  let exhaustedAt: string | null = null;
  const holdMs = reward.holdDays * DAY_MS;

  const reject = (sale: SimulationSale, reason: ExclusionReason) => {
    excluded[reason] += 1;
    outcomes.push({ orderId: sale.orderId, closedAt: sale.closedAt, rewardRial: 0, reason, clippedByCustomerCap: false });
  };

  for (const sale of ordered) {
    if (sale.status === "voided") {
      reject(sale, "voided");
      continue;
    }
    if (sale.status !== "completed") {
      reject(sale, "not_completed");
      continue;
    }
    if (scope && !scope.has(sale.locationId)) {
      reject(sale, "out_of_scope_branch");
      continue;
    }
    if (!sale.customerId) {
      reject(sale, "no_customer");
      continue;
    }
    if (sale.netPaidRial <= 0) {
      reject(sale, "not_settled");
      continue;
    }
    if (sale.netPaidRial < trigger.minNetPaidRial) {
      reject(sale, "below_minimum");
      continue;
    }

    let amount = rewardForSale(reward, sale);
    if (amount <= 0) {
      reject(sale, "no_reward");
      continue;
    }

    let clipped = false;
    if (limits.perCustomerCapRial !== null) {
      const room = limits.perCustomerCapRial - (perCustomer.get(sale.customerId) ?? 0);
      if (room <= 0) {
        reject(sale, "customer_cap_reached");
        continue;
      }
      if (amount > room) {
        amount = room;
        clipped = true;
      }
    }

    if (amount > remaining) {
      if (exhaustedAt === null) exhaustedAt = sale.orderId;
      reject(sale, "budget_exhausted");
      continue;
    }

    remaining -= amount;
    exposure += amount;
    rewardedSales += 1;
    if (amount > largest) largest = amount;
    perCustomer.set(sale.customerId, (perCustomer.get(sale.customerId) ?? 0) + amount);
    if (new Date(sale.closedAt).getTime() + holdMs <= asOf.getTime()) available += amount;
    outcomes.push({ orderId: sale.orderId, closedAt: sale.closedAt, rewardRial: amount, reason: null, clippedByCustomerCap: clipped });
  }

  return {
    dryRun: true,
    ledgerEffect: "none",
    salesConsidered: ordered.length,
    rewardedSales,
    rewardedCustomers: perCustomer.size,
    exposureRial: exposure,
    availableRial: available,
    pendingRial: exposure - available,
    budgetRial: limits.totalBudgetRial,
    budgetRemainingRial: remaining,
    budgetExhaustedAtOrderId: exhaustedAt,
    largestRewardRial: largest,
    excluded,
    outcomes,
  };
}
