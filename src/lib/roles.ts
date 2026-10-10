/**
 * The role taxonomy: which roles exist, how each one signs in, and which ones
 * an administrator may hand out.
 *
 * This is split out of `team.ts` for the same reason `role-labels.ts` was split
 * out of the screens that used to carry their own `ROLE_LABELS` map. `team.ts`
 * imports `node:crypto` for invitation tokens, so no `"use client"` component
 * can import it — and three of them had responded by hand-copying the list:
 *
 *   src/app/dashboard/dashboard-sidebar.tsx   const PIN_ROLES = [...]
 *   src/app/dashboard/team/team-manager.tsx   const PIN_ROLES = [...]
 *   src/lib/platform-user-menu.ts             const PIN_ROLES = [...]
 *
 * each with a comment pointing back at `team.ts`, which is a comment doing a
 * compiler's job. Two new roles (`admin`, `viewer`) landed with the
 * authorization refactor and none of the three copies learned about them.
 * Which roles exist is a fact about the product, not a screen-local decision,
 * so it lives in one framework-free, client-safe module and every caller —
 * server route, server component, client component — asks this file.
 *
 * `team.ts` re-exports the sign-in predicates so its existing server callers
 * are unaffected, the same arrangement it already makes for `pin-policy.ts`.
 */
import type { Role } from "./auth-edge";

/**
 * Every role, in the order a human should see them: most authority first,
 * then the floor roles, then the read-only one.
 *
 * `ROLE_LABELS` in `role-labels.ts` is typed `Record<Role, string>`, so the
 * compiler already guarantees a label exists for each of these.
 */
export const ALL_ROLES: readonly Role[] = [
  "owner",
  "admin",
  "manager",
  "accountant",
  "cashier",
  "waiter",
  "kitchen",
];

/**
 * Roles that authenticate with an email and password (and therefore need a
 * global platform identity), versus roles that use a numeric PIN on a shared
 * device and may have `platform_user_id = null`.
 *
 * `admin` and `viewer` are password roles: an admin administers the business
 * and a viewer is typically an external accountant or auditor, and neither is
 * a person standing at a shared till.
 */
export const PASSWORD_ROLES: readonly Role[] = ["owner", "admin", "manager", "accountant"];
export const PIN_ROLES: readonly Role[] = ["cashier", "waiter", "kitchen"];

export function isPasswordRole(role: Role): boolean {
  return PASSWORD_ROLES.includes(role);
}

export function isPinRole(role: Role): boolean {
  return PIN_ROLES.includes(role);
}

/**
 * Roles that can be handed out through the team screen.
 *
 * Every role is assignable — including `owner`, which the API then guards
 * separately (only an owner may create another owner, and the last owner
 * cannot be demoted). This list is about what the *catalogue* contains; who
 * may pick a given entry is an authorization question answered server-side in
 * `PATCH /api/team/[id]`, never by omitting an option from a dropdown.
 */
/**
 * The credential a role's owner is expected to sign in with.
 *
 * Issue #854 (P1.12) — a membership must never be left *active* in a role whose
 * door it cannot open. `password` means the global identity (`platform_users`
 * password, reached through the tenant login screen); `pin` means the staff door
 * on a shared terminal. The mapping is total — every role has exactly one
 * intended model — which is what makes the transition rule below decidable
 * rather than a judgement call.
 */
export type LoginCredentialModel = "password" | "pin";

export function loginCredentialModelForRole(role: Role): LoginCredentialModel {
  return isPasswordRole(role) ? "password" : "pin";
}

export const ASSIGNABLE_ROLES: readonly Role[] = ALL_ROLES;

/**
 * Roles that can be invited by email — the password roles, since an invitation
 * is an email with a link, and a PIN role is created directly on the device
 * instead.
 */
export const INVITABLE_ROLES: readonly Role[] = PASSWORD_ROLES;

/**
 * Roles the first-run setup wizard can create.
 *
 * Everything except `owner`, who already exists by the time the wizard runs —
 * they are the person running it. The wizard's own copy of this list had
 * fallen three roles behind (`admin`, `viewer` and `owner`'s exclusion were
 * all encoded separately in the page, the API and a local `CreatableRole`
 * union), which is why it is derived here instead.
 */
export const SETUP_CREATABLE_ROLES: readonly Role[] = ALL_ROLES.filter((role) => role !== "owner");
