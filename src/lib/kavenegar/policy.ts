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
  updatedAt: string | null;
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
};

export async function getManagedChildPolicy(): Promise<ManagedChildPolicy> {
  const row = await withoutTenantScope("platform", async () => {
    const { rows } = await query<PolicyRow>(
      `SELECT managed_child_accounts_enabled, managed_plan_id,
              managed_min_allowed_credit_rial, managed_sender_lines,
              managed_policy_note, managed_policy_updated_at,
              managed_funding_buffer_messages, managed_funding_child_cap_rial,
              managed_funding_daily_cap_rial, managed_funding_master_floor_rial
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
    updatedAt: null,
  };

  await withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO platform_sms_config
         (id, managed_child_accounts_enabled, managed_plan_id,
          managed_min_allowed_credit_rial, managed_sender_lines,
          managed_policy_note, managed_policy_updated_at,
          managed_funding_buffer_messages, managed_funding_child_cap_rial,
          managed_funding_daily_cap_rial, managed_funding_master_floor_rial)
       VALUES (1, $1, $2, $3, $4, $5, now(), $6, $7, $8, $9)
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
             managed_funding_master_floor_rial = $9`,
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
      ],
    );
  });

  return getManagedChildPolicy();
}

/**
 * Provider line numbers, comma-separated. Accepts Persian/Arabic digits and
 * drops anything that cannot be a line — a stray word here would be sent to the
 * provider as a line assignment, so validation is strict rather than clever.
 */
export function parseSenderLines(value: string | null | undefined): string[] {
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
