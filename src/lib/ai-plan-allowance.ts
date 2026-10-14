/**
 * Plan-included monthly AI credit (migration 0168) — the Plan Builder's AI limit.
 *
 * A billing plan may include a monthly AI allowance
 * (`billing_plans.monthly_ai_credit_rial`). The allowance is NOT a second
 * balance: it is a per-calendar-month cap that the wallet settlement consumes
 * FIRST, so a «Professional with ۱۰۰٬۰۰۰ تومان AI credit» plan needs no
 * manual grant and no second money table. Whatever the allowance does not
 * cover is charged to the wallet exactly as before.
 *
 * Period shape: one row per (business, calendar month) in
 * `ai_plan_allowance_usage`. The month is computed in Asia/Tehran so an
 * Iranian business's "month" flips at Iranian midnight, not UTC's.
 *
 * Effective cap rule (shared across read, affordability gate, and settlement):
 *   effectiveCreditRial = configuredCreditRial (from the business's current
 *   plan allowance for the period, or 0 when the subscription is expired/canceled
 *   or the plan includes no AI credit)
 *   remainingRial = Math.max(0, effectiveCreditRial - usedRial)
 */

import type { PoolClient } from "./db";
import { query, withoutTenantScope } from "./db";
import { isSubscriptionCarryingPlan } from "./billing-plans-service";

/** The billing calendar: everything AI-bills in Asia/Tehran. */
export const AI_BILLING_TIME_ZONE = "Asia/Tehran";

/**
 * The `period_month` key ('YYYY-MM') for a moment, in the billing calendar.
 * Pure — the unit test shifts a moment across the Tehran midnight to prove the
 * month flip happens at the right boundary.
 */
export function periodMonthFor(date: Date, timeZone: string = AI_BILLING_TIME_ZONE): string {
  // en-CA formats as YYYY-MM-DD; the first seven characters are the key.
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return formatted.slice(0, 7);
}

/** The current period key. */
export function currentPeriodMonth(): string {
  return periodMonthFor(new Date());
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const targetUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const offsetAt = (utcMs: number): number => {
    const parts = fmt.formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
      0,
    );
    return asUtc - utcMs;
  };
  const firstGuess = targetUtc - offsetAt(targetUtc);
  const refined = targetUtc - offsetAt(firstGuess);
  return new Date(refined);
}

/**
 * Compute the exact UTC `[startUtc, nextStartUtc)` window for the calendar
 * month containing `now` in `timeZone` (default `Asia/Tehran`).
 */
export function tehranMonthWindow(
  now: Date = new Date(),
  timeZone: string = AI_BILLING_TIME_ZONE,
): { periodMonth: string; startUtc: Date; nextStartUtc: Date } {
  const periodMonth = periodMonthFor(now, timeZone);
  const [yStr, mStr] = periodMonth.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    periodMonth,
    startUtc: zonedMidnightUtc(year, month, 1, timeZone),
    nextStartUtc: zonedMidnightUtc(nextYear, nextMonth, 1, timeZone),
  };
}

export interface PlanAllowance {
  /** The effective monthly AI credit right now (kept as `monthlyCreditRial` for compatibility). */
  monthlyCreditRial: number;
  /** The plan's configured monthly AI credit (0 when plan has none). */
  configuredCreditRial: number;
  /** The effective monthly AI credit cap for this billing period. */
  effectiveCreditRial: number;
  /** The snapshot grant recorded on the usage row (if any), synced to effectiveCreditRial. */
  grantedRial: number;
  /** What has already been consumed this month. */
  usedRial: number;
  /** effectiveCreditRial - usedRial, never negative. */
  remainingRial: number;
  /** Current period month key ('YYYY-MM') in Asia/Tehran. */
  periodMonth: string;
}

function toRial(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Shared pure effective-cap calculation used by `getPlanAllowance`,
 * `checkAiAffordability`, and `consumePlanAllowanceTx`.
 */
export function resolveEffectivePlanAllowance(input: {
  configuredCreditRial: number;
  grantedRial?: number | null;
  usedRial: number;
  subscriptionCarrying?: boolean;
  periodMonth?: string;
}): PlanAllowance {
  const carrying = input.subscriptionCarrying !== false;
  const configuredCreditRial = toRial(input.configuredCreditRial);
  const effectiveCreditRial = carrying ? configuredCreditRial : 0;
  const usedRial = toRial(input.usedRial);
  const grantedRial = effectiveCreditRial > 0 ? effectiveCreditRial : toRial(input.grantedRial);
  const remainingRial = Math.max(0, effectiveCreditRial - usedRial);
  return {
    monthlyCreditRial: effectiveCreditRial,
    configuredCreditRial,
    effectiveCreditRial,
    grantedRial,
    usedRial,
    remainingRial,
    periodMonth: input.periodMonth ?? currentPeriodMonth(),
  };
}

type AllowanceQueryRow = {
  monthly_credit: string | null;
  used: string | null;
  granted: string | null;
  sub_status: string | null;
  sub_period_end: Date | string | null;
  sub_cancel_at_period_end: boolean | null;
  sub_auto_renew: boolean | null;
  sub_grace_end: Date | string | null;
  sub_trial_end: Date | string | null;
};

const ALLOWANCE_SELECT_SQL = `
  SELECT COALESCE(
           (SELECT al.included_quantity FROM billing_plan_meter_allowances al
             WHERE al.plan_key = p.key AND al.meter_key = 'ai.credit'),
           p.monthly_ai_credit_rial
         ) AS monthly_credit,
         a.used_rial AS used,
         a.granted_rial AS granted,
         s.status AS sub_status,
         s.current_period_end AS sub_period_end,
         s.cancel_at_period_end AS sub_cancel_at_period_end,
         s.auto_renew AS sub_auto_renew,
         s.grace_end AS sub_grace_end,
         s.trial_end AS sub_trial_end
    FROM businesses b
    LEFT JOIN billing_plans p ON p.key = b.plan
    LEFT JOIN business_subscriptions s ON s.business_id = b.id
    LEFT JOIN ai_plan_allowance_usage a
           ON a.business_id = b.id AND a.period_month = $2
   WHERE b.id = $1
`;

function rowToPlanAllowance(
  row: AllowanceQueryRow | undefined,
  periodMonth: string,
  now: Date,
): PlanAllowance {
  if (!row) {
    return resolveEffectivePlanAllowance({
      configuredCreditRial: 0,
      usedRial: 0,
      periodMonth,
    });
  }
  const carrying = isSubscriptionCarryingPlan(
    {
      status: row.sub_status,
      currentPeriodEnd: row.sub_period_end,
      cancelAtPeriodEnd: row.sub_cancel_at_period_end,
      autoRenew: row.sub_auto_renew,
      graceEnd: row.sub_grace_end,
      trialEnd: row.sub_trial_end,
    },
    now.toISOString(),
  );
  return resolveEffectivePlanAllowance({
    configuredCreditRial: toRial(row.monthly_credit),
    grantedRial: toRial(row.granted),
    usedRial: toRial(row.used),
    subscriptionCarrying: carrying,
    periodMonth,
  });
}

/**
 * A business's remaining plan allowance for the current month.
 * Read path — uses the exact same `resolveEffectivePlanAllowance` rule as
 * `consumePlanAllowanceTx`.
 */
export async function getPlanAllowance(
  businessId: string,
  now: Date = new Date(),
): Promise<PlanAllowance> {
  const periodMonth = periodMonthFor(now);
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<AllowanceQueryRow>(ALLOWANCE_SELECT_SQL, [businessId, periodMonth]);
    return rowToPlanAllowance(rows[0], periodMonth, now);
  });
}

/**
 * Consume up to `amountRial` of the plan allowance, INSIDE the caller's
 * transaction. Locks the business's wallet row so concurrent calls on the same
 * business serialize even when invoked outside `withWalletTx`. Returns what
 * was actually consumed.
 */
export async function consumePlanAllowanceTx(
  client: PoolClient,
  businessId: string,
  amountRial: number,
  now: Date = new Date(),
): Promise<number> {
  const amount = Math.max(0, Math.floor(amountRial));
  if (amount === 0) return 0;

  const periodMonth = periodMonthFor(now);

  // Ensure per-business serialization even if called directly in a transaction.
  await client.query(
    `INSERT INTO business_wallets (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`,
    [businessId],
  );
  await client.query(
    `SELECT business_id FROM business_wallets WHERE business_id = $1 FOR UPDATE`,
    [businessId],
  );

  const plan = await client.query<AllowanceQueryRow>(ALLOWANCE_SELECT_SQL, [businessId, periodMonth]);
  const effective = rowToPlanAllowance(plan.rows[0], periodMonth, now);

  if (effective.effectiveCreditRial <= 0) {
    if (toRial(plan.rows[0]?.granted) > 0) {
      await client.query(
        `UPDATE ai_plan_allowance_usage
            SET granted_rial = 0, updated_at = now()
          WHERE business_id = $1 AND period_month = $2`,
        [businessId, periodMonth],
      );
    }
    return 0;
  }

  const consumed = Math.min(amount, effective.remainingRial);
  await client.query(
    `INSERT INTO ai_plan_allowance_usage (business_id, period_month, granted_rial, used_rial)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, period_month)
     DO UPDATE SET used_rial = ai_plan_allowance_usage.used_rial + $4,
                   granted_rial = EXCLUDED.granted_rial,
                   updated_at = now()`,
    [businessId, periodMonth, effective.effectiveCreditRial, consumed],
  );
  return consumed;
}
