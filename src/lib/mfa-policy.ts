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
import { revokeTrustedDevicesForBusiness } from "./trusted-device";

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
  const previous = await getMfaPolicy(businessId);
  await query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, $2, $3)
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [businessId, SETTING_KEYS.mfaPolicy, JSON.stringify(next)],
  );

  // Issue #885 — a policy change invalidates the trust earned under the old one.
  //
  // The seven-day device exemption exists to skip a *routine* challenge. When
  // the owner widens the requirement, every exemption already granted was
  // earned against a weaker rule, so honouring it would let a manager who had
  // not been challenged in a week silently skip the very requirement just
  // switched on. Trust is re-earnable the next time the member verifies, which
  // is the whole point: this costs one challenge, not access.
  //
  // Only on an actual change, so re-saving the same policy does not log
  // everyone out of their trusted devices for nothing.
  /*
   * Every field the policy can tighten is compared, not just the first one.
   *
   * `requireForAccountants` is a separate switch (#854) and it exempts exactly
   * the same routine challenge, so an accountant's seven-day device trust is
   * just as stale after it flips as a manager's is after theirs. Comparing only
   * `requireForManagers` left a real hole: an owner could switch MFA on for
   * every accountant in the business and not one of them would be asked, until
   * their device trust happened to expire on its own.
   *
   * One revocation covers whichever field moved — the exemption is per device,
   * not per role, so there is nothing to split.
   */
  const managersChanged = previous.requireForManagers !== next.requireForManagers;
  const accountantsChanged = previous.requireForAccountants !== next.requireForAccountants;
  if (managersChanged || accountantsChanged) {
    const tightened =
      (managersChanged && next.requireForManagers) ||
      (accountantsChanged && next.requireForAccountants);
    await revokeTrustedDevicesForBusiness({
      businessId,
      reason: tightened ? "mfa_policy_tightened" : "mfa_policy_changed",
    });
  }

  return next;
}
