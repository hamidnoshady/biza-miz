/**
 * Phase 24 Wave 2 — the per-business two-factor policy.
 *
 * Exactly one knob today, and deliberately so: the spec says a business "may
 * opt to extend the requirement to `manager`; off by default", and nothing
 * more. `owner` is not a knob — the requirement on the full permission set is
 * the point of the wave and is not negotiable per tenant.
 *
 * Read on the login path, where no session exists yet and the business has
 * only just been chosen, so it takes an explicit `businessId` and runs under
 * the caller's scope rather than fetching one of its own.
 */
import { query } from "./db";
import { SETTING_KEYS } from "./settings";

export interface MfaPolicy {
  /** Extend the second-factor requirement to `manager` memberships. */
  requireForManagers: boolean;
  /**
   * Extend the second-factor requirement to `accountant` memberships
   * (issue #854 P1.1: "Accountant: configurable / risk-based, but supported
   * fully"). Off by default — an external accountant is often a contractor on
   * a personal phone, but a business that wants the ledger covered can say so.
   *
   * `owner` and `admin` are **not** knobs: they are mandatory by construction
   * (`MANDATORY_MFA_ROLES`), because the role that can administer the business
   * is precisely the account a stolen password must not be enough for.
   */
  requireForAccountants: boolean;
}

export const DEFAULT_MFA_POLICY: MfaPolicy = {
  requireForManagers: false,
  requireForAccountants: false,
};

export function normalizeMfaPolicy(value: unknown): MfaPolicy {
  if (!value || typeof value !== "object") return { ...DEFAULT_MFA_POLICY };
  const raw = value as Record<string, unknown>;
  return {
    requireForManagers: raw.requireForManagers === true,
    requireForAccountants: raw.requireForAccountants === true,
  };
}

/**
 * The policy for one business.
 *
 * Runs the read itself rather than going through `getSetting` because the
 * login route reaches it inside the `withoutTenantScope("login", …)` window,
 * before any business scope has been entered — so the `business_id` predicate
 * here is doing the filtering that RLS would otherwise do, and is not optional.
 */
export async function getMfaPolicy(businessId: string): Promise<MfaPolicy> {
  const { rows } = await query<{ value: unknown }>(
    `SELECT value FROM settings
      WHERE business_id = $1 AND location_id IS NULL AND key = $2`,
    [businessId, SETTING_KEYS.mfaPolicy],
  );
  return normalizeMfaPolicy(rows[0]?.value);
}

export async function setMfaPolicy(businessId: string, policy: MfaPolicy): Promise<MfaPolicy> {
  const next = normalizeMfaPolicy(policy);
  await query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, $2, $3)
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [businessId, SETTING_KEYS.mfaPolicy, JSON.stringify(next)],
  );
  return next;
}
