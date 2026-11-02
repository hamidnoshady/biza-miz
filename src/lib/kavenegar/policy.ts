/**
 * Issue #902 — the platform policy for managed child accounts.
 *
 * The policy lives on the SAME `platform_sms_config` singleton that already
 * holds the master credential (migration 0076). That is deliberate: the
 * pre-existing risk this issue had to close was two SMS configuration stores
 * answering "which account sends?" differently. There is one master credential
 * per install, and both the OTP path and the customer-management path resolve
 * it here. No second key store, no second environment variable.
 *
 * A managed child is created with
 *   * zero initial credit (funding is a separate, audited transfer),
 *   * panel login disabled where the provider permits it (`Status=2`),
 *   * a tariff and a line set the platform chooses — never the master's.
 */
import { query, withoutTenantScope } from "../db";

export interface ManagedChildPolicy {
  /** Off unless an operator has completed the eligibility checklist. */
  enabled: boolean;
  /** Provider `Planid` applied to new children; null = provider default. */
  planId: number | null;
  minAllowedCreditRial: number;
  senderLines: string[];
  note: string | null;
  /**
   * Funding policy (migration 0259). `bufferMessages` 0 means automatic top-up
   * is OFF — the default, because moving the platform's money has to be a
   * deliberate act. The caps and floor protect the master account once it is on.
   */
  fundingBufferMessages: number;
  fundingChildCapRial: number | null;
  fundingDailyCapRial: number | null;
  fundingMasterFloorRial: number;
  /**
   * Issue #902 §3 — the funding STRATEGY, migration 0261. The buffer is the
   * target in every strategy; the strategy decides WHEN a transfer is planned.
   */
  fundingStrategy: FundingStrategy;
  /** Trigger level in messages for `low_watermark`; 0 = same as the buffer. */
  fundingLowWatermarkMessages: number;
  /** UTC hour window for `scheduled` (start = end means all day). */
  fundingWindowStartHour: number;
  fundingWindowEndHour: number;
  /** Cross-business demand guard: the fleet's ceiling for one rolling day. */
  fundingGlobalDailyCapRial: number | null;
  /** Issue #902 #3 — credit above the floor that only transactional spend may use. */
  fundingTransactionalReserveRial: number;
  /** How this fleet's spend is classified for the reserve (migration 0267). */
  fundingPurpose: FundingPurpose;
  updatedAt: string | null;
}

/**
 * How often the platform is willing to pre-fund a child.
 *
 *   * `jit`           — top up on every pass that finds the child under target.
 *   * `low_watermark` — only after the child drops below a trigger, then refill
 *                       to the target (hysteresis).
 *   * `scheduled`     — JIT, but only inside a UTC hour window.
 *   * `manual`        — never automatically; every transfer is an operator act.
 */
export type FundingStrategy = "jit" | "low_watermark" | "scheduled" | "manual";

/**
 * How a fleet's provider spend is classified for the transactional reserve
 * (issue #902 #3, migration 0267).
 *
 * `marketing` is the default and the restrictive side: it may not spend the
 * reserved slice, so enabling a reserve can only hold capacity back — never let
 * more money out by accident.
 */
export type FundingPurpose = "marketing" | "transactional";

export const FUNDING_PURPOSES: readonly FundingPurpose[] = ["marketing", "transactional"] as const;

export function isFundingPurpose(value: unknown): value is FundingPurpose {
  return typeof value === "string" && (FUNDING_PURPOSES as readonly string[]).includes(value);
}

export const FUNDING_STRATEGIES: readonly FundingStrategy[] = [
  "jit",
  "low_watermark",
  "scheduled",
  "manual",
] as const;

export function isFundingStrategy(value: unknown): value is FundingStrategy {
  return typeof value === "string" && (FUNDING_STRATEGIES as readonly string[]).includes(value);
}

const DISABLED: ManagedChildPolicy = {
  enabled: false,
  planId: null,
  minAllowedCreditRial: 0,
  senderLines: [],
  note: null,
  fundingBufferMessages: 0,
  fundingChildCapRial: null,
  fundingDailyCapRial: null,
  fundingMasterFloorRial: 0,
  fundingStrategy: "jit",
  fundingLowWatermarkMessages: 0,
  fundingWindowStartHour: 0,
  fundingWindowEndHour: 0,
  fundingGlobalDailyCapRial: null,
  fundingTransactionalReserveRial: 0,
  fundingPurpose: "marketing",
  updatedAt: null,
};

type PolicyRow = {
  managed_child_accounts_enabled: boolean;
  managed_plan_id: number | null;
  managed_min_allowed_credit_rial: string | number;
  managed_sender_lines: string;
  managed_policy_note: string | null;
  managed_policy_updated_at: Date | null;
  managed_funding_buffer_messages: number;
  managed_funding_child_cap_rial: string | number | null;
  managed_funding_daily_cap_rial: string | number | null;
  managed_funding_master_floor_rial: string | number;
  managed_funding_strategy: FundingStrategy;
  managed_funding_low_watermark_messages: number;
  managed_funding_window_start_hour: number;
  managed_funding_window_end_hour: number;
  managed_funding_global_daily_cap_rial: string | number | null;
  managed_funding_transactional_reserve_rial: string | number;
  managed_funding_purpose: FundingPurpose;
};

export async function getManagedChildPolicy(): Promise<ManagedChildPolicy> {
  const row = await withoutTenantScope("platform", async () => {
    const { rows } = await query<PolicyRow>(
      `SELECT managed_child_accounts_enabled, managed_plan_id,
              managed_min_allowed_credit_rial, managed_sender_lines,
              managed_policy_note, managed_policy_updated_at,
              managed_funding_buffer_messages, managed_funding_child_cap_rial,
              managed_funding_daily_cap_rial, managed_funding_master_floor_rial,
              managed_funding_strategy, managed_funding_low_watermark_messages,
              managed_funding_window_start_hour, managed_funding_window_end_hour,
              managed_funding_global_daily_cap_rial,
              managed_funding_transactional_reserve_rial, managed_funding_purpose
         FROM platform_sms_config WHERE id = 1`,
    );
    return rows[0] ?? null;
  });
  if (!row) return DISABLED;
  return {
    enabled: row.managed_child_accounts_enabled,
    planId: row.managed_plan_id,
    minAllowedCreditRial: Math.max(0, Number(row.managed_min_allowed_credit_rial) || 0),
    senderLines: parseSenderLines(row.managed_sender_lines),
    note: row.managed_policy_note,
    fundingBufferMessages: Math.max(0, Number(row.managed_funding_buffer_messages) || 0),
    fundingChildCapRial: nullableInteger(row.managed_funding_child_cap_rial),
    fundingDailyCapRial: nullableInteger(row.managed_funding_daily_cap_rial),
    fundingMasterFloorRial: Math.max(0, Number(row.managed_funding_master_floor_rial) || 0),
    fundingStrategy: isFundingStrategy(row.managed_funding_strategy) ? row.managed_funding_strategy : "jit",
    fundingLowWatermarkMessages: Math.max(0, Number(row.managed_funding_low_watermark_messages) || 0),
    fundingWindowStartHour: clampHour(row.managed_funding_window_start_hour),
    fundingWindowEndHour: clampHour(row.managed_funding_window_end_hour),
    fundingGlobalDailyCapRial: nullableInteger(row.managed_funding_global_daily_cap_rial),
    fundingTransactionalReserveRial: Math.max(
      0,
      Number(row.managed_funding_transactional_reserve_rial) || 0,
    ),
    fundingPurpose: isFundingPurpose(row.managed_funding_purpose)
      ? row.managed_funding_purpose
      : "marketing",
    updatedAt: row.managed_policy_updated_at?.toISOString() ?? null,
  };
}

export interface SaveManagedChildPolicyInput {
  enabled?: boolean;
  planId?: number | null;
  minAllowedCreditRial?: number;
  senderLines?: string[] | string;
  note?: string | null;
  fundingBufferMessages?: number;
  fundingChildCapRial?: number | null;
  fundingDailyCapRial?: number | null;
  fundingMasterFloorRial?: number;
  fundingStrategy?: FundingStrategy;
  fundingLowWatermarkMessages?: number;
  fundingWindowStartHour?: number;
  fundingWindowEndHour?: number;
  fundingGlobalDailyCapRial?: number | null;
  fundingTransactionalReserveRial?: number;
  fundingPurpose?: FundingPurpose;
}

/** A console write. Validation belongs to the route, which reports which field failed. */
export async function saveManagedChildPolicy(
  input: SaveManagedChildPolicyInput,
): Promise<ManagedChildPolicy> {
  const current = await getManagedChildPolicy();
  const next: ManagedChildPolicy = {
    enabled: input.enabled ?? current.enabled,
    planId: input.planId === undefined ? current.planId : input.planId,
    minAllowedCreditRial:
      input.minAllowedCreditRial === undefined
        ? current.minAllowedCreditRial
        : Math.max(0, Math.trunc(input.minAllowedCreditRial)),
    senderLines:
      input.senderLines === undefined
        ? current.senderLines
        : Array.isArray(input.senderLines)
          ? input.senderLines
          : parseSenderLines(input.senderLines),
    note: input.note === undefined ? current.note : input.note,
    fundingBufferMessages:
      input.fundingBufferMessages === undefined
        ? current.fundingBufferMessages
        : Math.max(0, Math.trunc(input.fundingBufferMessages)),
    fundingChildCapRial:
      input.fundingChildCapRial === undefined
        ? current.fundingChildCapRial
        : input.fundingChildCapRial === null
          ? null
          : Math.max(0, Math.trunc(input.fundingChildCapRial)),
    fundingDailyCapRial:
      input.fundingDailyCapRial === undefined
        ? current.fundingDailyCapRial
        : input.fundingDailyCapRial === null
          ? null
          : Math.max(0, Math.trunc(input.fundingDailyCapRial)),
    fundingMasterFloorRial:
      input.fundingMasterFloorRial === undefined
        ? current.fundingMasterFloorRial
        : Math.max(0, Math.trunc(input.fundingMasterFloorRial)),
    fundingStrategy: input.fundingStrategy ?? current.fundingStrategy,
    fundingLowWatermarkMessages:
      input.fundingLowWatermarkMessages === undefined
        ? current.fundingLowWatermarkMessages
        : Math.max(0, Math.trunc(input.fundingLowWatermarkMessages)),
    fundingWindowStartHour:
      input.fundingWindowStartHour === undefined
        ? current.fundingWindowStartHour
        : clampHour(input.fundingWindowStartHour),
    fundingWindowEndHour:
      input.fundingWindowEndHour === undefined
        ? current.fundingWindowEndHour
        : clampHour(input.fundingWindowEndHour),
    fundingGlobalDailyCapRial:
      input.fundingGlobalDailyCapRial === undefined
        ? current.fundingGlobalDailyCapRial
        : input.fundingGlobalDailyCapRial === null
          ? null
          : Math.max(0, Math.trunc(input.fundingGlobalDailyCapRial)),
    fundingTransactionalReserveRial:
      input.fundingTransactionalReserveRial === undefined
        ? current.fundingTransactionalReserveRial
        : Math.max(0, Math.trunc(input.fundingTransactionalReserveRial)),
    fundingPurpose: input.fundingPurpose ?? current.fundingPurpose,
    updatedAt: null,
  };

  await withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO platform_sms_config
         (id, managed_child_accounts_enabled, managed_plan_id,
          managed_min_allowed_credit_rial, managed_sender_lines,
          managed_policy_note, managed_policy_updated_at,
          managed_funding_buffer_messages, managed_funding_child_cap_rial,
          managed_funding_daily_cap_rial, managed_funding_master_floor_rial,
          managed_funding_strategy, managed_funding_low_watermark_messages,
          managed_funding_window_start_hour, managed_funding_window_end_hour,
          managed_funding_global_daily_cap_rial,
          managed_funding_transactional_reserve_rial, managed_funding_purpose)
       VALUES (1, $1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO UPDATE
         SET managed_child_accounts_enabled = $1,
             managed_plan_id = $2,
             managed_min_allowed_credit_rial = $3,
             managed_sender_lines = $4,
             managed_policy_note = $5,
             managed_policy_updated_at = now(),
             managed_funding_buffer_messages = $6,
             managed_funding_child_cap_rial = $7,
             managed_funding_daily_cap_rial = $8,
             managed_funding_master_floor_rial = $9,
             managed_funding_strategy = $10,
             managed_funding_low_watermark_messages = $11,
             managed_funding_window_start_hour = $12,
             managed_funding_window_end_hour = $13,
             managed_funding_global_daily_cap_rial = $14,
             managed_funding_transactional_reserve_rial = $15,
             managed_funding_purpose = $16`,
      [
        next.enabled,
        next.planId,
        next.minAllowedCreditRial,
        next.senderLines.join(","),
        next.note,
        next.fundingBufferMessages,
        next.fundingChildCapRial,
        next.fundingDailyCapRial,
        next.fundingMasterFloorRial,
        next.fundingStrategy,
        next.fundingLowWatermarkMessages,
        next.fundingWindowStartHour,
        next.fundingWindowEndHour,
        next.fundingGlobalDailyCapRial,
        next.fundingTransactionalReserveRial,
        next.fundingPurpose,
      ],
    );
  });

  return getManagedChildPolicy();
}

/** A UTC hour the funding window accepts (0–23). */
export function clampHour(value: number | null | undefined): number {
  const hour = Math.trunc(Number(value) || 0);
  return Math.min(23, Math.max(0, hour));
}

/**
 * Provider line numbers, comma-separated. Accepts Persian/Arabic digits and
 * drops anything that cannot be a line — a stray word here would be sent to the
 * provider as a line assignment, so validation is strict rather than clever.
 */
function parseSenderLines(value: string | null | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(/[,،\s]+/)
        .map((line) => line.trim())
        .map((line) => line.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0)))
        .filter((line) => /^\d{3,20}$/.test(line)),
    ),
  ];
}

function nullableInteger(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** True when a proposed line list is entirely acceptable (for the route's 400). */
export function isValidSenderLines(value: string): boolean {
  if (!value.trim()) return true;
  const parts = value.split(/[,،\s]+/).filter(Boolean);
  return parts.every((line) => /^[0-9۰-۹]{3,20}$/.test(line));
}
