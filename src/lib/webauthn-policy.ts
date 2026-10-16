/**
 * Issue #854 follow-up (F02 / F12) — who may manage which half of their own
 * biometric (WebAuthn) credentials, answered once for the server routes *and*
 * the Profile card.
 *
 * ## The drift this replaces
 *
 * The Profile card offered «افزودن این دستگاه» to every role while every
 * WebAuthn credential route was `requireRole(...PIN_ROLES)`, so an owner or a
 * manager was shown a ceremony that always ended in a 403. Worse, the same
 * role gate guarded *listing* and *removing*, so a member whose role had moved
 * from cashier to manager could no longer even see — let alone remove — the
 * authenticator still registered to their membership.
 *
 * ## The policy
 *
 * Three different questions, deliberately kept apart:
 *
 *  - **List** — every member may see their own registered authenticators. It
 *    is their account, and an authenticator they cannot see is one they cannot
 *    revoke. Neither browser support nor deployment authority changes this.
 *  - **Remove** — every member may remove their own authenticator wherever the
 *    deployment lets members write `webauthn_credential` (every profile today:
 *    the credential is device-bound and local by definition). Removing a factor
 *    only ever *reduces* what can sign in, and it needs no browser WebAuthn
 *    support — it is a plain API call. The routes still demand recent auth.
 *  - **Register** — only the roles whose door biometric is an alternative to:
 *    the PIN roles. A passkey is bound to one device and the privileged doors
 *    are not, so enrolling one for an owner/admin/manager/accountant would let
 *    a privileged authority ride on a shared till's authenticator (the reason
 *    `login-eligibility.ts` gives for the WebAuthn door). The browser must also
 *    support WebAuthn — a client-only fact layered on top by the card.
 *
 * Framework-free and client-safe on purpose (it imports only `roles.ts` and a
 * type), so the server routes and the `"use client"` card ask the same module.
 */
import type { Role } from "./auth-edge";
import { PIN_ROLES } from "./roles";
import type { CredentialSurface } from "./credential-authority";

/**
 * The roles that may *enrol* a WebAuthn authenticator. An alias of
 * `PIN_ROLES`, not a copy, so it cannot drift from the role taxonomy
 * (`roles.test.ts` forbids re-declaring the list).
 */
export const WEBAUTHN_ENROLMENT_ROLES: readonly Role[] = PIN_ROLES;

export function mayEnrolWebauthn(role: Role | string): boolean {
  return (WEBAUTHN_ENROLMENT_ROLES as readonly string[]).includes(role);
}

/** Why registration is not offered, so the card can say so instead of hiding it silently. */
export type WebauthnRegisterBlock = "role" | "deployment" | null;

export interface WebauthnManagementPolicy {
  /** Always true: a member may always see their own authenticators. */
  canList: true;
  /** May start/finish a registration ceremony (before browser support is known). */
  canRegister: boolean;
  /** May remove one of their own authenticators. */
  canRemove: boolean;
  registerBlockedBy: WebauthnRegisterBlock;
}

export function webauthnManagementPolicy(input: {
  role: Role | string;
  /** The deployment's authority over `webauthn_credential`. */
  surface?: Pick<CredentialSurface, "readOnly"> | null;
}): WebauthnManagementPolicy {
  const deploymentWritable = input.surface?.readOnly !== true;
  const roleEligible = mayEnrolWebauthn(input.role);
  return {
    canList: true,
    canRegister: roleEligible && deploymentWritable,
    canRemove: deploymentWritable,
    registerBlockedBy: !roleEligible ? "role" : !deploymentWritable ? "deployment" : null,
  };
}
