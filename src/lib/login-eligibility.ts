/**
 * Issue #885 L13 — which roles may sign in by which method.
 *
 * The problem this replaces is drift, not disagreement. The same role lists
 * were written out literally in seven places across the login and credential
 * paths, with two different spacing conventions and no shared name, so "who
 * can use a PIN" was answered by whichever file you happened to open. Adding a
 * role meant finding all of them; missing one produced a member who shows up
 * on the roster but cannot be selected, or the reverse.
 *
 * Role *membership* is not restated here: `@/lib/roles` owns `PIN_ROLES` and
 * `PASSWORD_ROLES`, and `roles.test.ts` fails the build if any module
 * re-declares them. This module owns only the part that was genuinely
 * duplicated and genuinely policy — how those sets map onto a deployment
 * profile and onto each door, rendered as SQL.
 *
 * The doors differ on purpose, and that difference is a product decision
 * rather than an accident, so it is recorded here with its reason attached:
 *
 *   - Roster and PIN widen to the password roles off cloud, so an owner can
 *     run a shop-floor till on a standalone install with no cloud identity to
 *     fall back on. On cloud they do not: those roles have a platform account
 *     and sign in with a password at `/admin`.
 *   - WebAuthn accepts only the PIN roles, on every profile. A passkey is
 *     bound to one device and the privileged doors are not, so widening this
 *     would let an owner's authority ride on a shared till's authenticator.
 *
 * Note on scope: `iam/sync.ts` and `iam/login-credential-sync.ts` use the PIN
 * role list for *credential ownership* (whose PIN the cloud is authoritative
 * for) rather than login eligibility. They share the constant because it is
 * the same list of roles, not because the two questions are the same question
 * — changing one must not silently change the other.
 */

import { PASSWORD_ROLES, PIN_ROLES } from "./roles";

/** Render a role list as a SQL `IN` tuple. Values are literals, never input. */
function sqlTuple(roles: readonly string[]): string {
  return `(${roles.map((r) => `'${r}'`).join(", ")})`;
}

/** The till roles, as a SQL `IN` tuple: `('cashier', 'waiter', 'kitchen')`. */
export const STAFF_PIN_ROLES_SQL = sqlTuple(PIN_ROLES);

/** The password roles, as a SQL `IN` tuple. */
export const PASSWORD_ROLES_SQL = sqlTuple(PASSWORD_ROLES);

/**
 * The roles a PIN door accepts on a given deployment profile.
 *
 * Cloud: PIN roles only — the password roles have a platform account and use a
 * password. Local/hybrid: both sets, because a standalone install has nothing
 * else to offer an owner who is standing at the till.
 */
export function pinEligibleRolesSql(profile: "cloud" | "local" | "hybrid"): string {
  return profile === "cloud"
    ? STAFF_PIN_ROLES_SQL
    : sqlTuple([...PIN_ROLES, ...PASSWORD_ROLES]);
}

/** Is this role one the till doors accept on this profile? */
export function isPinEligibleRole(
  role: string,
  profile: "cloud" | "local" | "hybrid",
): boolean {
  if ((PIN_ROLES as readonly string[]).includes(role)) return true;
  return profile !== "cloud" && (PASSWORD_ROLES as readonly string[]).includes(role);
}

/**
 * The roles the WebAuthn door accepts.
 *
 * Deliberately the PIN-role list on *every* profile, and deliberately not
 * expressed in terms of `pinEligibleRolesSql`: the two look like one question
 * ("who can use this door") but are not. A passkey is bound to a device and
 * the privileged doors are not, so this must not widen when the PIN door does.
 */
export const WEBAUTHN_LOGIN_ROLES_SQL = STAFF_PIN_ROLES_SQL;
