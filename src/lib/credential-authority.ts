/**
 * Issue #854 (P1.13 / P1.14 / P1.15) — which deployment owns which credential.
 *
 * The platform runs in three deployment profiles (`cloud`, `hybrid`, `local`),
 * and until this module each surface decided for itself what a Hybrid site was
 * allowed to write. The result was predictable and reported as three separate
 * findings: a Hybrid site could locally set a member's PIN, locally change a
 * login phone, and locally create memberships and invitations the cloud did not
 * own — while the Profile screen kept rendering fully editable password and
 * MFA forms that the backend then rejected with `login_managed_by_cloud`
 * (#854 P1.14, P1.15, P1.13).
 *
 * The table below is the single answer. It is deliberately a *data* structure
 * rather than a set of `if (profile === "hybrid")` checks scattered through
 * routes: the scattered version is how the drift happened, and a table can be
 * rendered in the UI (so a read-only control can say *why*) and pinned by a
 * test (so a new field cannot be added without deciding who owns it).
 *
 * **Cloud is always the source of truth for a global identity.** A Hybrid site
 * replicates that state so it can keep working offline; it never originates a
 * change to it. "apply" below means the site may persist a value *the cloud
 * sent it*, and must present it read-only; "local-only" means the field has no
 * cloud counterpart at all.
 */
import { authErrorMessage } from "./auth-contracts";
import type { DeploymentProfile } from "./deployment-mode";

/** Every credential/state field whose ownership this platform has to name. */
export type CredentialField =
  | "global_password"
  | "platform_token_version"
  | "totp_secret"
  | "sms_mfa_factor"
  | "mfa_recovery_codes"
  | "staff_pin"
  | "login_phone"
  | "phone_verified_state"
  | "employee_sessions"
  | "webauthn_credential"
  | "membership"
  | "membership_role";

/**
 * What a given deployment profile may do with a field.
 *
 *  - `authoritative` — this profile originates and owns the value.
 *  - `apply`         — this profile stores a value it was sent, and may not
 *                      originate a change. Read-only in the UI.
 *  - `local-only`    — the field has no meaning outside this profile.
 */
export type CredentialAuthority = "authoritative" | "apply" | "local-only";

export type CredentialAuthorityTable = Readonly<
  Record<DeploymentProfile, Readonly<Record<CredentialField, CredentialAuthority>>>
>;

const ALL_APPLY: Readonly<Record<CredentialField, CredentialAuthority>> = {
  global_password: "apply",
  platform_token_version: "apply",
  totp_secret: "apply",
  sms_mfa_factor: "apply",
  mfa_recovery_codes: "apply",
  staff_pin: "apply",
  login_phone: "apply",
  phone_verified_state: "apply",
  employee_sessions: "local-only",
  webauthn_credential: "local-only",
  membership: "apply",
  membership_role: "apply",
};

/**
 * The authority matrix.
 *
 * `cloud` owns everything global and *also* the local-only operational fields
 * (it is a deployment profile, not "remote": a cloud-hosted business still has
 * employee sessions and biometric credentials of its own).
 *
 * `hybrid` owns only what cannot exist anywhere else — the terminal sessions
 * and the biometric credentials bound to this site's devices — and applies
 * everything global.
 *
 * `local` is standalone, so it is authoritative for everything: there is no
 * cloud to conflict with.
 */
export const CREDENTIAL_AUTHORITY: CredentialAuthorityTable = {
  cloud: {
    global_password: "authoritative",
    platform_token_version: "authoritative",
    totp_secret: "authoritative",
    sms_mfa_factor: "authoritative",
    mfa_recovery_codes: "authoritative",
    staff_pin: "authoritative",
    login_phone: "authoritative",
    phone_verified_state: "authoritative",
    employee_sessions: "authoritative",
    webauthn_credential: "authoritative",
    membership: "authoritative",
    membership_role: "authoritative",
  },
  hybrid: ALL_APPLY,
  local: {
    global_password: "authoritative",
    platform_token_version: "authoritative",
    totp_secret: "authoritative",
    sms_mfa_factor: "authoritative",
    mfa_recovery_codes: "authoritative",
    staff_pin: "authoritative",
    login_phone: "authoritative",
    phone_verified_state: "authoritative",
    employee_sessions: "authoritative",
    webauthn_credential: "authoritative",
    membership: "authoritative",
    membership_role: "authoritative",
  },
};

/** Who owns `field` under `profile`. */
export function authorityFor(
  profile: DeploymentProfile,
  field: CredentialField,
): CredentialAuthority {
  return CREDENTIAL_AUTHORITY[profile][field];
}

/**
 * Whether this deployment may originate a write to `field`.
 *
 * The one predicate every credential-writing route asks. `apply` and
 * `local-only` both refuse here — a route that wants to *store a replicated
 * value* uses `mayApplyCredential` instead, which is a different question with
 * a different answer.
 */
export function mayWriteCredential(
  profile: DeploymentProfile,
  field: CredentialField,
  options: { selfService?: boolean } = {},
): boolean {
  const authority = authorityFor(profile, field);
  if (authority === "authoritative") return true;
  // A local-only field is authoritative on every profile that has one; `apply`
  // is the only refusal.
  if (authority === "local-only") return true;
  void options;
  return false;
}

/**
 * Whether the field may be written by a local *self-service* action that
 * verifies current proof.
 *
 * Hybrid is the interesting case, and the answer is still no for the fields
 * that matter: a site that let a member rotate their global password locally
 * would create a credential the cloud does not know about, which is the second
 * source of truth #843/#850 were about. Staff PIN and the local WebAuthn
 * credential are the exceptions the product explicitly wants — a till must be
 * able to issue a new PIN while the uplink is down — so they are listed here
 * rather than special-cased at the call site.
 */
const HYBRID_LOCAL_SELF_SERVICE_FIELDS: readonly CredentialField[] = [
  "staff_pin",
  "webauthn_credential",
  "employee_sessions",
];

export function maySelfServiceWrite(
  profile: DeploymentProfile,
  field: CredentialField,
): boolean {
  if (mayWriteCredential(profile, field)) return true;
  return profile === "hybrid" && HYBRID_LOCAL_SELF_SERVICE_FIELDS.includes(field);
}

/**
 * Persian explanation shown in place of a control this deployment does not own.
 *
 * Issue #854 (P2.3/2.28) — one source of the sentence. The literal used to exist
 * here *and* as `AUTH_ERROR_MESSAGES.login_managed_by_cloud`, which is the same
 * drift this pass removes everywhere else: two copies of one user-facing string,
 * one of which the API also returns as an error message. The error-code table is
 * the canonical home (it is what the routes send), so this reads from it.
 */
export function cloudManagedNotice(): string {
  return authErrorMessage("login_managed_by_cloud");
}

/**
 * The read-only/editable description a Profile screen renders from, so the UI
 * never has to hard-code `profile === "hybrid"`.
 */
export interface CredentialSurface {
  field: CredentialField;
  /** True when this deployment may originate a change. */
  editable: boolean;
  /** True when the value is shown but not editable. */
  readOnly: boolean;
  /** Persian reason for the read-only state, when there is one. */
  notice: string | null;
}

export function describeCredentialSurface(
  profile: DeploymentProfile,
  field: CredentialField,
): CredentialSurface {
  const editable = maySelfServiceWrite(profile, field);
  return {
    field,
    editable,
    readOnly: !editable,
    notice: editable ? null : cloudManagedNotice(),
  };
}

/**
 * Fields whose *local* creation is refused outright on a Hybrid site.
 *
 * Creating a membership is the one action the cloud must own even in principle:
 * a site that invents memberships the cloud has never seen produces rows that
 * disappear at the next sync, and roles/overrides the cloud cannot arbitrate.
 * #854 P1.13 is exactly this — direct creation already refused, invitations did
 * not.
 */
export const HYBRID_REFUSED_CREATION_FIELDS: readonly CredentialField[] = [
  "membership",
  "membership_role",
  "global_password",
  "login_phone",
  "totp_secret",
  "sms_mfa_factor",
  "mfa_recovery_codes",
];

export function hybridRefusesLocalCreation(
  profile: DeploymentProfile,
  field: CredentialField,
): boolean {
  return profile === "hybrid" && HYBRID_REFUSED_CREATION_FIELDS.includes(field);
}
