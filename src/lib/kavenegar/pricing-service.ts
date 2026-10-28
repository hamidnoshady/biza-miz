/**
 * Issue #902 — wholesale → retail pricing, margin evidence and JIT funding.
 *
 * Two very different numbers describe one SMS:
 *
 *   * the **retail** price the tenant pays, in Rial per segment, set by Billing
 *     on the platform singleton (`platform_message_config.sms_rial_per_segment`)
 *     and charged to the tenant's one wallet;
 *   * the **wholesale** price the provider charges the platform, in Rial per
 *     segment, reported per child account (`smsfarsicost` / `smsenglishcost`).
 *
 * They live in different domains and must never be conflated. This module
 * quotes both, computes the margin between them, and decides how much provider
 * credit a child should carry so the margin stays positive without the platform
 * pre-funding the provider forever.
 *
 * The funding maths is pure and lives at the top so it is testable without a
 * database: caps, the master floor, unresolved transfers and the 1,000-Rial
 * provider minimum are all decisions, not SQL.
 */
import { smsSegmentCount } from "../messaging-billing-pure";
import { query, withoutTenantScope, withoutTenantScopeTransaction } from "../db";
import type { KavenegarManagementClient } from "./rest";
import type { FundingStrategy } from "./policy";
import { getManagedChildPolicy } from "./policy";
import { applyReservedCreditTransfer, type CreditTransferRow } from "./provisioning-service";
import {
  alertForFundingBlock,
  alertForTransferState,
  raiseServiceAlert,
  resolveOtherBusinessAlerts,
  resolveServiceAlert,
} from "./alert-service";

/** Wholesale tariff of one child, exactly as the provider reports it. */
export interface ProviderTariff {
  /** Rial per Persian segment (`smsfarsicost`). */
  farsiRialPerSegment: number | null;
  /** Rial per English segment (`smsenglishcost`); the provider prices it higher. */
  englishRialPerSegment: number | null;
  pricingName: string | null;
  planId: number | null;
}

/**
 * Which wholesale bucket a body falls in. A body with any non-Latin character
 * is billed at the Persian (UCS-2) tariff — the same rule the provider applies,
 * and the reason a mixed "کد 1234" message is never quoted cheap.
 */
export type SmsTariffBucket = "persian" | "english";

export function tariffBucketFor(body: string): SmsTariffBucket {
  return /[^\u0000-\u007f]/.test(body) ? "persian" : "english";
}

/** Wholesale Rial for one segment of `bucket`; null when the tariff is unknown. */
export function wholesalePerSegment(
  tariff: ProviderTariff,
  bucket: SmsTariffBucket,
): number | null {
  const value = bucket === "persian" ? tariff.farsiRialPerSegment : tariff.englishRialPerSegment;
  return value === null || !Number.isFinite(value) || value < 0 ? null : Math.trunc(value);
}

export interface SmsPriceQuote {
  bucket: SmsTariffBucket;
  segments: number;
  /** What the tenant's wallet is charged. */
  retailRial: number;
  /** What the provider charges the platform, when the tariff is known. */
  wholesaleRial: number | null;
  marginRial: number | null;
  /** Margin in basis points (1/100 of a percent); integer. */
  marginBps: number | null;
  /**
   * True when any known tariff for this bucket would make the send a loss.
   * A send that loses money is a pricing bug, not a business decision, so the
   * console shows it and the drift report counts it.
   */
  belowCost: boolean;
}

/**
 * Quote one rendered message.
 *
 * `retailRialPerSegment` is the Billing-owned price, never derived here. When
 * the wholesale tariff is unknown the quote still returns the retail amount
 * (the tenant is charged exactly as before) but leaves the margin null rather
 * than pretending it is zero.
 */
export function quoteSmsPrice(input: {
  body: string;
  retailRialPerSegment: number;
  tariff: ProviderTariff;
}): SmsPriceQuote {
  const bucket = tariffBucketFor(input.body);
  const segments = Math.max(1, smsSegmentCount(input.body));
  const retailPerSegment = Math.max(0, Math.trunc(input.retailRialPerSegment));
  const retailRial = retailPerSegment * segments;
  const wholesale = wholesalePerSegment(input.tariff, bucket);
  const wholesaleRial = wholesale === null ? null : wholesale * segments;
  const marginRial = wholesaleRial === null ? null : retailRial - wholesaleRial;
  const marginBps =
    marginRial === null || retailRial === 0 ? null : Math.round((marginRial * 10_000) / retailRial);
  return {
    bucket,
    segments,
    retailRial,
    wholesaleRial,
    marginRial,
    marginBps,
    belowCost: marginRial !== null && marginRial < 0,
  };
}

// ---------------------------------------------------------------------------
// Funding maths (pure)
// ---------------------------------------------------------------------------

export interface FundingPolicy {
  /**
   * When to fund (migration 0261, issue #902 §3). The buffer below is the
   * target in every strategy; the strategy decides when a transfer is planned.
   */
  strategy: FundingStrategy;
  /** Target wholesale credit expressed as messages the child can still send. */
  bufferMessages: number;
  /**
   * Trigger level in messages for `low_watermark`. 0 (or >= the buffer) means
   * "trigger at the target", i.e. plain JIT behaviour.
   */
  watermarkMessages: number;
  /** UTC hour window for `scheduled`; start = end means the whole day. */
  windowStartHour: number;
  windowEndHour: number;
  /** Absolute per-child ceiling on provider credit. Null = none. */
  childCapRial: number | null;
  /** Maximum a child may receive in one rolling day. Null = none. */
  dailyCapRial: number | null;
  /** Cross-business guard: the ceiling for ALL children in one rolling day. */
  globalDailyCapRial: number | null;
  /** Wholesale credit the master account must retain. */
  masterFloorRial: number;
}

export const NO_FUNDING: FundingPolicy = {
  // Zero buffer already means "off"; `manual` is an explicit operator choice,
  // so the default stays `jit` and every existing caller keeps its meaning.
  strategy: "jit",
  bufferMessages: 0,
  watermarkMessages: 0,
  windowStartHour: 0,
  windowEndHour: 0,
  childCapRial: null,
  dailyCapRial: null,
  globalDailyCapRial: null,
  masterFloorRial: 0,
};

/**
 * Is the `scheduled` strategy inside its window right now?
 *
 * The provider is not ours, so the window is UTC and does not observe Iranian
 * daylight saving: an operator who wants «شبانه» gets a stable hour, and the
 * console shows the same number the planner uses. A window that wraps midnight
 * (22 → 3) is supported, which is the common case for a nightly top-up.
 * start === end means "no window": a strategy the operator selected by accident
 * funds normally rather than never.
 */
export function isFundingWindowOpen(input: {
  strategy: FundingStrategy;
  windowStartHour: number;
  windowEndHour: number;
  hourOfDay: number;
}): boolean {
  if (input.strategy !== "scheduled") return true;
  const start = Math.min(23, Math.max(0, Math.trunc(input.windowStartHour)));
  const end = Math.min(23, Math.max(0, Math.trunc(input.windowEndHour)));
  const hour = Math.min(23, Math.max(0, Math.trunc(input.hourOfDay)));
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  // Wrapping window, e.g. 22 → 3.
  return hour >= start || hour < end;
}

/**
 * The balance that triggers a refill, in messages.
 *
 * `jit` and `scheduled` refill as soon as the child is under target; only
 * `low_watermark` waits for a lower trigger — that hysteresis is what stops a
 * child that sits one message under target from being topped up all day.
 */
export function refillTriggerMessages(policy: {
  strategy: FundingStrategy;
  bufferMessages: number;
  watermarkMessages: number;
}): number {
  const buffer = Math.max(0, Math.trunc(policy.bufferMessages));
  if (policy.strategy !== "low_watermark") return buffer;
  const watermark = Math.max(0, Math.trunc(policy.watermarkMessages));
  // A watermark above the target is a typo, not an instruction: clamping it
  // keeps the rule "refill to the buffer, never above it".
  if (watermark === 0 || watermark >= buffer) return buffer;
  return watermark;
}

export type FundingBlockedReason =
  | "automatic_top_up_off"
  | "tariff_unknown"
  | "healthy"
  | "child_cap_reached"
  | "daily_cap_reached"
  | "master_floor"
  | "master_balance_unknown"
  | "unresolved_transfer"
  | "below_provider_minimum"
  | "outside_funding_window"
  | "global_daily_cap_reached";

export type FundingDecision =
  | { action: "none"; amountRial: 0; reason: FundingBlockedReason; targetBalanceRial: number | null }
  | { action: "transfer"; amountRial: number; reason: "top_up"; targetBalanceRial: number };

/** The provider rejects transfers below 1,000 Rial (`client/chargecredit`). */
export const MIN_PROVIDER_TRANSFER_RIAL = 1_000;

/** Round DOWN to a whole 1,000 Rial, the granularity the provider accepts. */
export function roundToProviderMinimum(amountRial: number): number {
  if (!Number.isFinite(amountRial) || amountRial <= 0) return 0;
  return Math.floor(amountRial / MIN_PROVIDER_TRANSFER_RIAL) * MIN_PROVIDER_TRANSFER_RIAL;
}

/**
 * How much provider credit this child should receive right now.
 *
 * Order matters, and each early exit is a real operational protection:
 *
 *   1. buffer 0 ⇒ automatic funding is off (operator chose manual funding);
 *   2. an unknown/in-flight transfer ⇒ move nothing until it is resolved
 *      (double-funding is the failure mode the journal exists to prevent);
 *   3. unknown tariff ⇒ cannot compute a target, so guess nothing;
 *   4. ceiling and daily cap clamp the amount;
 *   5. the master floor is subtracted from what the master may spend;
 *   6. anything below the provider's 1,000 Rial minimum is not attempted.
 *
 * Negative values (a child whose balance the provider reported above target)
 * produce `healthy`, never a claw-back: debits are an explicit operator action.
 */
export function planFunding(input: {
  policy: FundingPolicy;
  tariff: ProviderTariff;
  childBalanceRial: number;
  /** UTC hour the decision is taken in; used only by `scheduled`. */
  hourOfDay: number;
  /** The whole fleet's transfers in the last 24 hours (cross-business guard). */
  transferredTodayAllChildrenRial?: number;
  /**
   * The master account's wholesale credit. `null` means unknown: the
   * customer-management API exposes a child's balance but not the master's, so
   * the console may pass the figure an operator read from the panel. With an
   * unknown balance and a non-zero floor the plan refuses to move money rather
   * than fund through the floor.
   */
  masterBalanceRial: number | null;
  transferredTodayRial: number;
  unresolvedTransferRial: number;
}): FundingDecision {
  const { policy } = input;
  if (policy.strategy === "manual" || policy.bufferMessages <= 0) {
    return { action: "none", amountRial: 0, reason: "automatic_top_up_off", targetBalanceRial: null };
  }
  if (input.unresolvedTransferRial > 0) {
    return { action: "none", amountRial: 0, reason: "unresolved_transfer", targetBalanceRial: null };
  }

  // A buffer is expressed in messages, and the two buckets differ by a factor
  // of ~2.3. Funding plans on the DEARER bucket so an English message never
  // arrives with the child short of the target.
  const persian = wholesalePerSegment(input.tariff, "persian");
  const english = wholesalePerSegment(input.tariff, "english");
  const perSegment = Math.max(persian ?? -1, english ?? -1);
  if (perSegment <= 0) {
    return { action: "none", amountRial: 0, reason: "tariff_unknown", targetBalanceRial: null };
  }

  // A scheduled strategy that is outside its window does nothing — and it does
  // so before computing a target, so the log line reads "window", not "healthy".
  if (!isFundingWindowOpen({ ...policy, hourOfDay: input.hourOfDay })) {
    return {
      action: "none",
      amountRial: 0,
      reason: "outside_funding_window",
      targetBalanceRial: policy.bufferMessages * perSegment,
    };
  }

  const targetBalanceRial = policy.bufferMessages * perSegment;
  const triggerBalanceRial = refillTriggerMessages(policy) * perSegment;
  const balance = Math.max(0, Math.trunc(input.childBalanceRial));
  // `low_watermark` refills to the target but only once the child is below the
  // trigger; every other strategy triggers at the target itself.
  if (balance >= triggerBalanceRial) {
    return { action: "none", amountRial: 0, reason: "healthy", targetBalanceRial };
  }
  const deficit = targetBalanceRial - balance;
  if (deficit <= 0) {
    return { action: "none", amountRial: 0, reason: "healthy", targetBalanceRial };
  }

  let available = deficit;
  if (policy.childCapRial !== null) {
    const capRoom = policy.childCapRial - Math.max(0, Math.trunc(input.childBalanceRial));
    if (capRoom <= 0) {
      return { action: "none", amountRial: 0, reason: "child_cap_reached", targetBalanceRial };
    }
    available = Math.min(available, capRoom);
  }
  if (policy.dailyCapRial !== null) {
    const dailyRoom = policy.dailyCapRial - Math.max(0, Math.trunc(input.transferredTodayRial));
    if (dailyRoom <= 0) {
      return { action: "none", amountRial: 0, reason: "daily_cap_reached", targetBalanceRial };
    }
    available = Math.min(available, dailyRoom);
  }

  // Cross-business demand guard: one busy tenant must not be able to consume
  // the master credit that the rest of the fleet needs.
  if (policy.globalDailyCapRial !== null) {
    const fleetRoom =
      policy.globalDailyCapRial - Math.max(0, Math.trunc(input.transferredTodayAllChildrenRial ?? 0));
    if (fleetRoom <= 0) {
      return { action: "none", amountRial: 0, reason: "global_daily_cap_reached", targetBalanceRial };
    }
    available = Math.min(available, fleetRoom);
  }

  if (input.masterBalanceRial === null) {
    if (policy.masterFloorRial > 0) {
      return { action: "none", amountRial: 0, reason: "master_balance_unknown", targetBalanceRial };
    }
  } else {
    const spendableMaster = Math.max(
      0,
      Math.trunc(input.masterBalanceRial) - Math.max(0, Math.trunc(policy.masterFloorRial)),
    );
    if (spendableMaster <= 0) {
      return { action: "none", amountRial: 0, reason: "master_floor", targetBalanceRial };
    }
    available = Math.min(available, spendableMaster);
  }

  const amountRial = roundToProviderMinimum(available);
  if (amountRial < MIN_PROVIDER_TRANSFER_RIAL) {
    return { action: "none", amountRial: 0, reason: "below_provider_minimum", targetBalanceRial };
  }
  return { action: "transfer", amountRial, reason: "top_up", targetBalanceRial };
}

// ---------------------------------------------------------------------------
// Database reads (Superadmin / tick only)
// ---------------------------------------------------------------------------

export interface BusinessPriceSnapshot {
  businessId: string;
  accountId: string;
  provisionState: string;
  retailRialPerSegment: number;
  tariff: ProviderTariff;
  childBalanceRial: number | null;
  providerBalanceAt: string | null;
  policy: FundingPolicy;
}

type SnapshotRow = {
  business_id: string;
  account_id: string;
  provision_state: string;
  retail_rial_per_segment: string | number;
  sms_farsi_cost_rial: string | number | null;
  sms_english_cost_rial: string | number | null;
  pricing_name: string | null;
  plan_id: number | null;
  provider_balance_rial: string | number | null;
  provider_balance_at: Date | null;
  managed_funding_buffer_messages: number;
  managed_funding_child_cap_rial: string | number | null;
  managed_funding_daily_cap_rial: string | number | null;
  managed_funding_master_floor_rial: string | number;
  managed_funding_strategy: FundingStrategy;
  managed_funding_low_watermark_messages: number;
  managed_funding_window_start_hour: number;
  managed_funding_window_end_hour: number;
  managed_funding_global_daily_cap_rial: string | number | null;
};

/** One business's retail rate, wholesale tariff and funding policy. */
export async function getBusinessPriceSnapshot(
  businessId: string,
): Promise<BusinessPriceSnapshot | null> {
  const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
    query<SnapshotRow>(
      `SELECT a.business_id, a.id AS account_id, a.provision_state,
              COALESCE(c.sms_rial_per_segment, 0) AS retail_rial_per_segment,
              a.sms_farsi_cost_rial, a.sms_english_cost_rial, a.pricing_name, a.plan_id,
              a.provider_balance_rial, a.provider_balance_at,
              s.managed_funding_buffer_messages,
              s.managed_funding_child_cap_rial,
              s.managed_funding_daily_cap_rial,
              s.managed_funding_master_floor_rial,
              s.managed_funding_strategy,
              s.managed_funding_low_watermark_messages,
              s.managed_funding_window_start_hour,
              s.managed_funding_window_end_hour,
              s.managed_funding_global_daily_cap_rial
         FROM kavenegar_business_accounts a
         LEFT JOIN platform_message_config c ON c.id
         LEFT JOIN platform_sms_config s ON s.id = 1
        WHERE a.business_id = $1`,
      [businessId],
    ),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    businessId: row.business_id,
    accountId: row.account_id,
    provisionState: row.provision_state,
    retailRialPerSegment: numberOr(row.retail_rial_per_segment, 0),
    tariff: {
      farsiRialPerSegment: nullableNumber(row.sms_farsi_cost_rial),
      englishRialPerSegment: nullableNumber(row.sms_english_cost_rial),
      pricingName: row.pricing_name,
      planId: row.plan_id,
    },
    childBalanceRial: nullableNumber(row.provider_balance_rial),
    providerBalanceAt: row.provider_balance_at?.toISOString() ?? null,
    policy: {
      // A row written before 0261 (or by an older worker mid-deploy) has no
      // strategy column value; "jit" is what that build actually did.
      strategy: normaliseStrategy(row.managed_funding_strategy),
      bufferMessages: row.managed_funding_buffer_messages,
      watermarkMessages: Math.max(0, Number(row.managed_funding_low_watermark_messages) || 0),
      windowStartHour: Math.min(23, Math.max(0, Number(row.managed_funding_window_start_hour) || 0)),
      windowEndHour: Math.min(23, Math.max(0, Number(row.managed_funding_window_end_hour) || 0)),
      childCapRial: nullableNumber(row.managed_funding_child_cap_rial),
      dailyCapRial: nullableNumber(row.managed_funding_daily_cap_rial),
      globalDailyCapRial: nullableNumber(row.managed_funding_global_daily_cap_rial),
      masterFloorRial: numberOr(row.managed_funding_master_floor_rial, 0),
    },
  };
}

/**
 * How much this child received in the last 24 hours, and what is unresolved.
 *
 * An in-flight `pending` row counts against the day's cap even before it is
 * applied: the provider may already have moved that credit, and a cap that only
 * counted *applied* rows would let two workers plan past it. Because a transfer
 * is one row that changes state, the figure does not double-count when the row
 * becomes `applied` — it was already in the sum.
 */
export async function getFundingWindow(
  businessId: string,
): Promise<{ transferredTodayRial: number; unresolvedTransferRial: number }> {
  const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
    query<{ transferred_today: string | number | null; unresolved: string | number | null }>(
      `SELECT
         COALESCE(sum(amount_rial) FILTER (
           WHERE amount_rial > 0
             AND ((state = 'applied' AND applied_at >= now() - interval '24 hours')
                  OR (state = 'pending' AND created_at >= now() - interval '24 hours'))
         ), 0) AS transferred_today,
         COALESCE(sum(abs(amount_rial)) FILTER (WHERE state IN ('pending', 'unknown')), 0) AS unresolved
       FROM kavenegar_credit_transfers
      WHERE business_id = $1`,
      [businessId],
    ),
  );
  return {
    transferredTodayRial: numberOr(rows[0]?.transferred_today ?? 0, 0),
    unresolvedTransferRial: numberOr(rows[0]?.unresolved ?? 0, 0),
  };
}

/**
 * The fleet's transfers in the last 24 hours — the input to the cross-business
 * demand guard. Signed debits (claw-backs) are excluded: only credit that
 * actually left the master counts against the ceiling.
 */
export async function getFleetFundingWindow(): Promise<{ transferredTodayAllChildrenRial: number }> {
  const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
    query<{ transferred_today: string | number | null }>(
      `SELECT COALESCE(sum(amount_rial) FILTER (
                WHERE amount_rial > 0
                  AND ((state = 'applied' AND applied_at >= now() - interval '24 hours')
                       OR (state = 'pending' AND created_at >= now() - interval '24 hours'))
              ), 0) AS transferred_today
         FROM kavenegar_credit_transfers`,
    ),
  );
  return { transferredTodayAllChildrenRial: numberOr(rows[0]?.transferred_today ?? 0, 0) };
}

export interface FundingPlan {
  businessId: string;
  snapshot: BusinessPriceSnapshot;
  decision: FundingDecision;
  transferredTodayRial: number;
  unresolvedTransferRial: number;
}

/**
 * Read everything the funding decision needs for one business.
 *
 * The master balance is passed in by the caller (the tick fetches it once for
 * the whole pass, the console fetches it for one action) rather than read here,
 * so the plan function stays a pure decision over explicit inputs.
 */
export async function planBusinessFunding(
  businessId: string,
  input: { masterBalanceRial: number | null; hourOfDay?: number },
): Promise<FundingPlan | null> {
  const snapshot = await getBusinessPriceSnapshot(businessId);
  if (!snapshot) return null;
  const [window, fleet] = await Promise.all([getFundingWindow(businessId), getFleetFundingWindow()]);
  return {
    businessId,
    snapshot,
    transferredTodayRial: window.transferredTodayRial,
    unresolvedTransferRial: window.unresolvedTransferRial,
    decision: planFunding({
      policy: snapshot.policy,
      tariff: snapshot.tariff,
      childBalanceRial: snapshot.childBalanceRial ?? 0,
      hourOfDay: input.hourOfDay ?? new Date().getUTCHours(),
      transferredTodayRial: window.transferredTodayRial,
      transferredTodayAllChildrenRial: fleet.transferredTodayAllChildrenRial,
      masterBalanceRial: input.masterBalanceRial,
      unresolvedTransferRial: window.unresolvedTransferRial,
    }),
  };
}

function normaliseStrategy(value: string | null | undefined): FundingStrategy {
  return value === "jit" || value === "low_watermark" || value === "scheduled" || value === "manual"
    ? value
    : "jit";
}

// ---------------------------------------------------------------------------
// Margin evidence for the console
// ---------------------------------------------------------------------------

export interface MarginRow {
  businessId: string;
  businessName: string | null;
  retailChargedRial: number;
  providerCostRial: number;
  marginRial: number;
  /** Sends whose provider cost the provider did not report. */
  unreportedCostSends: number;
  sends: number;
}

/**
 * Retail charged vs. provider cost over a window.
 *
 * Retail comes from the Billing domain's own rating (`billing_usage_ratings`),
 * provider cost from `message_outbox.provider_cost_rial`. Neither is
 * recomputed here: the point of the report is to compare what two systems
 * independently recorded, which is also what makes it a usable control.
 */
export async function getManagedMarginReport(input: {
  since: Date;
  until: Date;
}): Promise<MarginRow[]> {
  const { rows } = await withoutTenantScope("platform", async () =>
    query<{
      business_id: string;
      business_name: string | null;
      retail_charged: string | number | null;
      provider_cost: string | number | null;
      unreported: string | number;
      sends: string | number;
    }>(
      `WITH sent AS (
         SELECT o.business_id,
                count(*) AS sends,
                COALESCE(sum(o.provider_cost_rial), 0) AS provider_cost,
                count(*) FILTER (WHERE o.provider_cost_rial IS NULL) AS unreported
           FROM message_outbox o
          WHERE o.status IN ('sent', 'delivered')
            AND o.sent_at >= $1 AND o.sent_at < $2
          GROUP BY o.business_id
       ), retail AS (
         SELECT e.business_id, COALESCE(sum(r.rated_amount_rial), 0) AS retail_charged
           FROM billing_usage_events e
           JOIN billing_usage_ratings r ON r.usage_event_id = e.id
          WHERE e.source = 'messaging'
            AND e.occurred_at >= $1 AND e.occurred_at < $2
          GROUP BY e.business_id
       )
       SELECT COALESCE(s.business_id, r.business_id) AS business_id,
              b.name AS business_name,
              COALESCE(r.retail_charged, 0) AS retail_charged,
              COALESCE(s.provider_cost, 0) AS provider_cost,
              COALESCE(s.unreported, 0) AS unreported,
              COALESCE(s.sends, 0) AS sends
         FROM sent s
         FULL OUTER JOIN retail r ON r.business_id = s.business_id
         LEFT JOIN businesses b ON b.id = COALESCE(s.business_id, r.business_id)
        ORDER BY (COALESCE(r.retail_charged, 0) - COALESCE(s.provider_cost, 0)) ASC`,
      [input.since, input.until],
    ),
  );
  return rows.map((row) => {
    const retailChargedRial = numberOr(row.retail_charged, 0);
    const providerCostRial = numberOr(row.provider_cost, 0);
    return {
      businessId: row.business_id,
      businessName: row.business_name,
      retailChargedRial,
      providerCostRial,
      marginRial: retailChargedRial - providerCostRial,
      unreportedCostSends: numberOr(row.unreported, 0),
      sends: numberOr(row.sends, 0),
    };
  });
}

function numberOr(value: string | number | null, fallback: number): number {
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Funding execution
// ---------------------------------------------------------------------------

export interface FundingExecution {
  plan: FundingPlan;
  /** Null when the plan decided not to move money, or the child is not active. */
  transfer: {
    id: string;
    state: "pending" | "applied" | "unknown" | "failed";
    amountRial: number;
    balanceAfterRial: number | null;
  } | null;
  duplicate: boolean;
  /**
   * Set when this pass did not even get to decide: another worker holds the
   * child's funding lock. Deferring is the correct answer — the worker that
   * holds the lock is about to do the same thing.
   */
  skipped?: "busy" | null;
}

/**
 * The advisory-lock keys.
 *
 * Two guards make concurrent funding safe (issue #902 §3: "concurrent business
 * demand", "avoid duplicate transfers"):
 *
 *   * a **per-child** key, so a tick and an operator click — or two ticks on
 *     two instances — cannot both decide for the same child;
 *   * a **fleet** key, taken only when a global daily cap is configured, so two
 *     different children cannot each read "the fleet has room" and then both
 *     take it.
 *
 * `hashtext` maps the child's account UUID into the advisory-lock space; the
 * fleet key is a fixed constant. Locks are transaction-scoped, so a crash
 * releases them with the transaction — there is no lock to leak.
 */
const FLEET_FUNDING_LOCK_KEY = 902_003;

async function tryLockChildFunding(accountId: string): Promise<boolean> {
  const { rows } = await query<{ locked: boolean }>(
    `SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS locked`,
    [`kavenegar-funding:${accountId}`],
  );
  return rows[0]?.locked === true;
}

async function lockFleetFunding(): Promise<void> {
  await query(`SELECT pg_advisory_xact_lock($1::bigint)`, [FLEET_FUNDING_LOCK_KEY]);
}

export interface ReservedFunding {
  plan: FundingPlan | null;
  /** The committed `pending` transfer awaiting a provider call. */
  transfer: CreditTransferRow | null;
  skipped: "busy" | null;
}

/**
 * Decide, and reserve the decision, in one short transaction.
 *
 * This is the concurrency guard, and it is deliberately the *only* place a
 * plan becomes money. Inside one transaction that holds the child's advisory
 * lock (and the fleet lock when a global cap is configured) we:
 *
 *   1. re-read the snapshot and both windows — now including in-flight
 *      reservations, so a transfer another worker has already committed counts
 *      against the caps;
 *   2. re-run the pure planner against those fresh numbers;
 *   3. allocate the day's idempotency key and commit the row as `pending`.
 *
 * The provider call then happens *outside* the transaction: a network round
 * trip must never be made while holding a database lock, and a decision must
 * never be taken without one. If the provider later reports a definite failure
 * the row becomes `failed` and the amount stops counting; if the outcome is
 * unknown it stays `unknown`, keeps counting, and blocks the child until the
 * reconciliation read resolves it.
 */
export async function reserveAutomaticTransfer(input: {
  businessId: string;
  masterBalanceRial: number | null;
  now?: Date;
}): Promise<ReservedFunding> {
  const now = input.now ?? new Date();
  return withoutTenantScopeTransaction("kavenegar-provisioning", async () => {
    const snapshot = await getBusinessPriceSnapshot(input.businessId);
    if (!snapshot) return { plan: null, transfer: null, skipped: null };
    if (!(await tryLockChildFunding(snapshot.accountId))) {
      return { plan: null, transfer: null, skipped: "busy" as const };
    }
    if (snapshot.policy.globalDailyCapRial !== null) await lockFleetFunding();

    const [window, fleet] = await Promise.all([
      getFundingWindow(input.businessId),
      getFleetFundingWindow(),
    ]);
    const plan: FundingPlan = {
      businessId: input.businessId,
      snapshot,
      transferredTodayRial: window.transferredTodayRial,
      unresolvedTransferRial: window.unresolvedTransferRial,
      decision: planFunding({
        policy: snapshot.policy,
        tariff: snapshot.tariff,
        childBalanceRial: snapshot.childBalanceRial ?? 0,
        hourOfDay: now.getUTCHours(),
        transferredTodayRial: window.transferredTodayRial,
        transferredTodayAllChildrenRial: fleet.transferredTodayAllChildrenRial,
        masterBalanceRial: input.masterBalanceRial,
        unresolvedTransferRial: window.unresolvedTransferRial,
      }),
    };
    if (plan.decision.action !== "transfer") {
      return { plan, transfer: null, skipped: null };
    }
    if (snapshot.provisionState !== "active") {
      return { plan, transfer: null, skipped: null };
    }

    const key = await nextAutomaticTransferKey(snapshot.accountId, now);
    const { rows } = await query<CreditTransferRow>(
      `INSERT INTO kavenegar_credit_transfers
         (business_id, account_id, amount_rial, idempotency_key, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, business_id, account_id, amount_rial, idempotency_key, state,
                 last_error_code, balance_after_rial, created_at, applied_at`,
      [
        input.businessId,
        snapshot.accountId,
        plan.decision.amountRial,
        key,
        "automatic managed-service buffer",
      ],
    );
    return { plan, transfer: rows[0] ?? null, skipped: null };
  });
}

/**
 * Apply one funding plan.
 *
 * The journal, not this function, is the guard against moving money twice:
 * every automatic transfer carries a deterministic idempotency key, so a tick
 * that runs twice in the same minute asks for the same key and the second call
 * is answered from the committed row.
 */
export async function fundManagedChild(input: {
  businessId: string;
  client: KavenegarManagementClient;
  masterBalanceRial: number | null;
  now?: Date;
}): Promise<FundingExecution | null> {
  const reserved = await reserveAutomaticTransfer({
    businessId: input.businessId,
    masterBalanceRial: input.masterBalanceRial,
    now: input.now,
  });
  if (reserved.skipped === "busy") {
    // Another worker is deciding for this child right now. There is nothing to
    // do and nothing to report: it is about to do exactly what this pass would.
    return null;
  }
  if (!reserved.plan) return null;
  if (!reserved.transfer) {
    return { plan: reserved.plan, transfer: null, duplicate: false };
  }

  // The decision is committed; the provider call happens outside any
  // transaction and outside any lock.
  const applied = await applyReservedCreditTransfer({ transfer: reserved.transfer, client: input.client });
  return {
    plan: reserved.plan,
    duplicate: false,
    transfer: {
      id: applied.id,
      state: applied.state,
      amountRial: Number(applied.amount_rial),
      balanceAfterRial:
        applied.balance_after_rial === null ? null : Number(applied.balance_after_rial),
    },
  };
}

/**
 * `auto:<account>:<UTC day>:<n>` — the day and sequence make a retry of the
 * same decision collapse onto the same journal row, while a genuinely later
 * top-up in the same day gets a new key.
 */
async function nextAutomaticTransferKey(accountId: string, now: Date): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
    query<{ used: string | number }>(
      `SELECT count(*) AS used
         FROM kavenegar_credit_transfers
        WHERE account_id = $1 AND idempotency_key LIKE 'auto:%'
          AND created_at >= date_trunc('day', now())`,
      [accountId],
    ),
  );
  const sequence = Math.max(0, Number(rows[0]?.used ?? 0)) + 1;
  return `auto:${accountId}:${day}:${sequence}`;
}

export interface FundingTickResult {
  planned: number;
  funded: number;
  failed: number;
  /** Children another worker held the funding lock for; deliberately untouched. */
  deferred: number;
  /** Alerts raised or refreshed by this pass. */
  alerts: number;
}

/**
 * Funding outcomes that describe *cap or policy pressure* rather than a fault.
 * When one of these clears, the alert it raised is closed by the same pass that
 * sees it clear — otherwise the panel would keep a resolved condition forever.
 */
const BUSINESS_FUNDING_ALERTS = [
  "child_cap_reached",
  "daily_cap_reached",
  "unresolved_transfer",
  "funding_failed",
  "tariff_missing",
] as const;

/**
 * One bounded funding pass over the active children that need it most.
 *
 * Children whose balance the provider reported longest ago (or never) come
 * first, so a single pass spreads across the fleet instead of topping up the
 * same five accounts forever.
 */
export async function runManagedFundingTick(input: {
  client: KavenegarManagementClient;
  masterBalanceRial?: number | null;
  limit?: number;
}): Promise<FundingTickResult> {
  // A platform that never opted in to customer management must not call that
  // API on a timer at all — the switch has to control the traffic, not just the
  // decisions.
  const policy = await getManagedChildPolicy();
  if (!policy.enabled || policy.fundingStrategy === "manual" || policy.fundingBufferMessages <= 0) {
    return { planned: 0, funded: 0, failed: 0, deferred: 0, alerts: 0 };
  }
  const limit = Math.min(Math.max(1, input.limit ?? 25), 100);
  const businessIds = await withoutTenantScope("platform", async () => {
    const { rows } = await query<{ business_id: string }>(
      `SELECT business_id
         FROM kavenegar_business_accounts
        WHERE provision_state = 'active'
        ORDER BY provider_balance_at ASC NULLS FIRST
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => row.business_id);
  });

  const result: FundingTickResult = { planned: 0, funded: 0, failed: 0, deferred: 0, alerts: 0 };
  for (const businessId of businessIds) {
    try {
      const execution = await fundManagedChild({
        businessId,
        client: input.client,
        masterBalanceRial: input.masterBalanceRial ?? null,
      });
      if (!execution) {
        result.deferred += 1;
        continue;
      }
      result.planned += 1;
      if (execution.transfer?.state === "applied") result.funded += 1;
      if (execution.transfer && execution.transfer.state !== "applied") result.failed += 1;
      result.alerts += await recordFundingAlerts(businessId, execution);
    } catch (error) {
      console.error(
        `kavenegar funding failed for business ${businessId}:`,
        error instanceof Error ? error.message : error,
      );
      // A throw is an incident, not a quiet pass: the next tick will most
      // likely throw the same way, so an operator has to hear about it.
      await raiseServiceAlert({
        kind: "funding_failed",
        businessId,
        detail: { reason: error instanceof Error ? error.message : String(error) },
      }).then(
        () => undefined,
        () => undefined,
      );
      result.alerts += 1;
    }
  }

  // Fleet-level evidence. One applied transfer proves the master had spendable
  // credit and that the fleet cap had room *at that moment*; a supplied master
  // balance proves the figure is no longer unknown. Each clears exactly its own
  // condition — a healthy pass that funded nothing proves nothing about either,
  // because it may simply not have needed money.
  if (result.funded > 0) {
    await resolveServiceAlert({ kind: "master_credit_low" });
    await resolveServiceAlert({ kind: "fleet_cap_reached" });
  }
  if (input.masterBalanceRial !== null && input.masterBalanceRial !== undefined) {
    await resolveServiceAlert({ kind: "master_balance_unknown" });
  }
  return result;
}

/**
 * Turn one funding outcome into alerts — raising what needs a human, closing
 * what no longer does.
 *
 * A pass that *did* move money, or found the child healthy, is positive
 * evidence about every business-scoped funding condition at once, so it closes
 * them. A pass that was blocked by a cap raises exactly that cap's alert and
 * leaves the others alone: guessing why the earlier ones are still open is how
 * an alert ledger starts lying.
 */
async function recordFundingAlerts(businessId: string, execution: FundingExecution): Promise<number> {
  let raised = 0;
  const transferState = execution.transfer?.state ?? null;
  const transferAlert =
    transferState && execution.transfer
      ? alertForTransferState(transferState, businessId, execution.transfer.id)
      : null;
  if (transferAlert) {
    await raiseServiceAlert(transferAlert);
    raised += 1;
  }

  const blocked =
    execution.plan.decision.action === "none"
      ? alertForFundingBlock(execution.plan.decision.reason, businessId)
      : null;
  if (blocked) {
    await raiseServiceAlert({
      ...blocked,
      accountId: blocked.businessId ? execution.plan.snapshot.accountId : null,
      detail: {
        reason: execution.plan.decision.action === "none" ? execution.plan.decision.reason : "blocked",
        targetBalanceRial: execution.plan.decision.targetBalanceRial,
        transferredTodayRial: execution.plan.transferredTodayRial,
        childBalanceRial: execution.plan.snapshot.childBalanceRial,
      },
    });
    raised += 1;
  } else if (transferAlert === null) {
    // Nothing is wrong for this child: close the cap/unresolved alerts an
    // earlier pass may have opened.
    await resolveOtherBusinessAlerts({
      businessId,
      keepKind: null,
      kinds: [...BUSINESS_FUNDING_ALERTS],
    });
  }
  return raised;
}
