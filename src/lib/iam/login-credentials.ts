/**
 * Global login: an owner's password and second factor are the cloud's, and a
 * paired desktop replicates them so the same password and the same
 * authenticator work on both sides — offline too. Deliberately *not* part of
 * the IAM snapshot, whose contract is "metadata only": this travels on its own
 * site-authenticated endpoint (`/api/iam/login-credentials`).
 *
 * The TOTP secret is carried in plain base32 over TLS because each server
 * encrypts it at rest under its *own* key; the desktop re-encrypts on arrival.
 */
import { PIN_ROLES } from "../roles";
import { createHash } from "node:crypto";
import { stable } from "./reconciliation";

/**
 * Issue #948 P0-1 — version of the cloud-global-identity → local-platform-
 * identity contract this module implements.
 *
 * v1 (legacy clouds): records carry no `platformUserId`; each side identified
 * the person by email and the site minted its own local `platform_users.id`.
 * The cloud's login readiness check compares global IDs exactly, so v1
 * replication could create a local identity under a different UUID than the
 * cloud's and `identity_not_synced` would persist forever (fingerprint
 * short-circuit: nothing noticed the wrong binding).
 *
 * v2 (current): every record names the cloud's canonical global identity ID
 * (`platform_users.id` on the cloud). The site binds its local row to exactly
 * that ID — re-keying a legacy row when needed — so readiness, fingerprints,
 * revocation and diagnostics all compare the same identifier. A record may
 * still carry `null` for a membership with no global identity (PIN-only).
 */
export const IDENTITY_CONTRACT_VERSION = 2;

export interface ReplicatedLoginCredential {
  /** The membership (`users.id`) the identity signs in as. */
  membershipId: string;
  /**
   * The cloud's global identity ID (`platform_users.id` on the cloud) — the
   * canonical key of contract v2. `null` = the membership has no global
   * identity (PIN-only staff); `undefined` = a legacy cloud that predates the
   * field, which keeps v1 behaviour deliberately.
   */
  platformUserId?: string | null;
  email: string;
  fullName: string;
  passwordHash: string;
  isActive: boolean;
  /** Monotonic version incremented on password change or global sign-out. */
  tokenVersion?: number;
  mfa: Array<{
    method: "totp" | "sms_otp";
    isPrimary: boolean;
    phoneE164: string | null;
    totpSecret: string | null;
  }>;
  /** bcrypt hashes — portable between servers as they are. */
  recoveryCodes: Array<{ codeHash: string; usedAt: string | null }>;
}

/**
 * Order-independent digest. The site compares the cloud's against one built
 * from its *own current* rows (not a remembered payload), so a credential
 * changed on either side is noticed. A recovery code counts as spent or not —
 * the two servers stamp the moment independently.
 *
 * Issue #948 P0-1 — the canonical global identity ID is part of the digest.
 * Identical password/MFA/PIN material bound to the *wrong* identity must never
 * fingerprint as converged (the pre-v2 short-circuit that left
 * `identity_not_synced` unrepaired). `undefined` and `null` normalize the same
 * way, so a legacy payload without IDs keeps comparing equal to a local build
 * masked the same way (see `applyLoginCredentials`).
 */
export function loginCredentialsFingerprint(credentials: readonly ReplicatedLoginCredential[]): string {
  const canonical = [...credentials]
    .sort((a, b) => a.membershipId.localeCompare(b.membershipId))
    .map((c) => ({
      ...c,
      platformUserId: normalizeIdentityId(c.platformUserId),
      email: c.email.trim().toLowerCase(),
      tokenVersion: c.tokenVersion ?? 1,
      mfa: [...c.mfa].sort((a, b) => a.method.localeCompare(b.method)),
      recoveryCodes: [...c.recoveryCodes]
        .sort((a, b) => a.codeHash.localeCompare(b.codeHash))
        .map((code) => ({ codeHash: code.codeHash, spent: code.usedAt !== null })),
    }));
  return createHash("sha256").update(stable(canonical)).digest("hex");
}

/** UUIDs compare byte-wise; `undefined`/`null` are the same "no identity". */
function normalizeIdentityId(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value.trim().toLowerCase() : null;
}

/** A recovery code the site saw spent, reported so the cloud stops accepting it too. */
export interface SpentRecoveryCode {
  membershipId: string;
  codeHash: string;
  usedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCredentialRecord(value: unknown): value is ReplicatedLoginCredential {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.membershipId !== "string" || !UUID.test(record.membershipId)) return false;
  // Contract v2: the canonical global identity ID. Absent (or null) is
  // legitimate — legacy cloud / PIN-only membership — but a present value must
  // be a real UUID, never a half-sent identifier we would bind a row to.
  if (record.platformUserId !== undefined && record.platformUserId !== null
    && (typeof record.platformUserId !== "string" || !UUID.test(record.platformUserId))) return false;
  if (typeof record.email !== "string" || typeof record.fullName !== "string") return false;
  if (typeof record.passwordHash !== "string" || record.passwordHash.length === 0) return false;
  if (typeof record.isActive !== "boolean") return false;
  if (record.tokenVersion !== undefined && (typeof record.tokenVersion !== "number" || !Number.isFinite(record.tokenVersion))) return false;
  if (!Array.isArray(record.mfa) || !record.mfa.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const m = entry as Record<string, unknown>;
    return (m.method === "totp" || m.method === "sms_otp")
      && typeof m.isPrimary === "boolean"
      && (m.phoneE164 === null || typeof m.phoneE164 === "string")
      && (m.totpSecret === null || typeof m.totpSecret === "string");
  })) return false;
  if (!Array.isArray(record.recoveryCodes) || !record.recoveryCodes.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const c = entry as Record<string, unknown>;
    return typeof c.codeHash === "string" && (c.usedAt === null || typeof c.usedAt === "string");
  })) return false;
  return true;
}

function isPinRecord(value: unknown): value is ReplicatedPin {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.membershipId === "string" && UUID.test(record.membershipId)
    && typeof record.pinHash === "string" && record.pinHash.length > 0;
}

/**
 * The site's gate on `/api/iam/login-credentials`. A payload that is shaped
 * like garbage must be a *visible* credential-stage failure, never something
 * that half-applies: applyReplicatedPins() and applyLoginCredentials() each
 * write rows, so the response is validated in full before either runs.
 */
export function validateLoginCredentialPayload(raw: unknown): {
  ok: true;
  credentials: ReplicatedLoginCredential[];
  pins: ReplicatedPin[];
  /** Issue #850: the cloud's staff-PIN roster, when it advertises authority. */
  staffPinMemberships: string[];
  staffPinsAuthoritative: boolean;
  /**
   * Issue #948 P0-1 — "canonical" when every record names its cloud global
   * identity ID (contract v2); "legacy" when the payload predates the field
   * and identity binding falls back to the v1 email rules.
   */
  identityContract: "canonical" | "legacy";
} | { ok: false; code: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "payload_not_object" };
  const body = raw as { credentials?: unknown; pins?: unknown; staffPins?: unknown };
  const credentials = body.credentials ?? [];
  const pins = body.pins ?? [];
  if (!Array.isArray(credentials)) return { ok: false, code: "credentials_not_array" };
  if (!Array.isArray(pins)) return { ok: false, code: "pins_not_array" };
  // An old cloud may legitimately omit `pins`; once the list exists its
  // entries must be usable.
  if (!pins.every(isPinRecord)) return { ok: false, code: "invalid_pin_record" };
  if (!credentials.every(isCredentialRecord)) return { ok: false, code: "invalid_credential_record" };
  // A payload that names the canonical identity ID on some records and drops
  // it on others has no coherent contract to apply — refusing it whole is the
  // visible failure, never a half-bind of one member and not another.
  const withId = (credentials as ReplicatedLoginCredential[]).filter((c) => c.platformUserId !== undefined).length;
  if (withId !== 0 && withId !== credentials.length) return { ok: false, code: "mixed_identity_contract" };

  // Issue #850 — the optional authoritative staff-PIN block. A cloud that does
  // not send it keeps the pre-#850 behaviour: a member the cloud has no PIN for
  // retains the site's own. It is accepted only as a complete, well-formed
  // pair (the flag and the roster): a half-sent block is an invalid payload
  // rather than a licence to delete PINs.
  const staffPins = body.staffPins;
  const identityContract: "canonical" | "legacy" = withId === 0 ? "legacy" : "canonical";
  if (staffPins === undefined || staffPins === null) {
    return { ok: true, credentials: credentials as ReplicatedLoginCredential[], pins: pins as ReplicatedPin[], staffPinMemberships: [], staffPinsAuthoritative: false, identityContract };
  }
  if (typeof staffPins !== "object" || Array.isArray(staffPins)) return { ok: false, code: "staff_pins_not_object" };
  const block = staffPins as { authoritative?: unknown; memberships?: unknown };
  if (block.authoritative !== true) return { ok: false, code: "staff_pins_not_authoritative" };
  if (!Array.isArray(block.memberships)) return { ok: false, code: "staff_pins_memberships_not_array" };
  if (!block.memberships.every((id) => typeof id === "string" && UUID.test(id))) return { ok: false, code: "invalid_staff_pin_membership" };
  return {
    ok: true,
    credentials: credentials as ReplicatedLoginCredential[],
    pins: pins as ReplicatedPin[],
    staffPinMemberships: block.memberships as string[],
    staffPinsAuthoritative: true,
    identityContract,
  };
}

/**
 * A member's quick-login PIN as the cloud holds it. The bcrypt hash is as
 * portable as a password hash, and the cloud is where staff are created and
 * given a PIN, so a paired desktop takes it from here. Travels next to the
 * global credentials on the same site-authenticated endpoint; a PIN-only
 * cashier has no `platform_users` identity, which is why it is its own list.
 */
export interface ReplicatedPin {
  membershipId: string;
  pinHash: string;
}

/** What the site holds today for one member: its role and its active PIN, if any. */
export interface LocalPinState {
  membershipId: string;
  role: string;
  pinHash: string | null;
}

/**
 * Issue #885 L13 — derived from the canonical list in `@/lib/roles` rather
 * than restated. This spelling escaped the `roles.test.ts` guard only because
 * that guard matches array literals and not `new Set([...])`; the duplication
 * was the same either way.
 */
const STAFF_PIN_ROLES: ReadonlySet<string> = new Set(PIN_ROLES);

/**
 * Which members' site PIN to replace with the cloud's. Pure.
 *
 * - Staff roles (cashier/waiter/kitchen) sign in with a PIN on the cloud too,
 *   so the cloud's PIN is authoritative: a different local one is put back.
 * - An owner/manager's PIN is the offline door the pairing wizard asks for on
 *   the desktop itself; the cloud's only fills it in when the site has none,
 *   and never overrides the one the owner chose at the till.
 * - A member the cloud has no PIN for keeps whatever the site has; a member the
 *   site has not replicated yet is skipped until the IAM snapshot creates it.
 */
export function planPinReplication(
  cloud: readonly ReplicatedPin[],
  local: readonly LocalPinState[],
): ReplicatedPin[] {
  const byId = new Map(local.map((row) => [row.membershipId, row]));
  return cloud.filter((pin) => {
    const here = byId.get(pin.membershipId);
    if (!here || !pin.pinHash) return false;
    if (here.pinHash === pin.pinHash) return false;
    return STAFF_PIN_ROLES.has(here.role) || here.pinHash === null;
  });
}

/**
 * Issue #850 — whose site PIN the cloud's *absence* may remove. Pure.
 *
 * A staff PIN deleted on the cloud has to stop working here, but absence from
 * `pins` cannot mean that on its own: it also covers a member the cloud has
 * never seen (created after the last snapshot), a legacy cloud, and every
 * password-role member, whose PIN is this device's own offline door. So the
 * cloud must say two things explicitly — that it owns staff PINs
 * (`staffPinsAuthoritative`) and which memberships it means (`memberships`) —
 * and only then does "a listed staff member with no PIN in the payload" mean
 * "remove the local one".
 *
 * Still restricted to the PIN roles (cashier/waiter/kitchen): a password-role
 * member is never removed by this path, whatever the cloud lists, because the
 * owner/manager PIN belongs to the device and not to the cloud.
 */
export function planPinRemoval(
  cloud: { pins: readonly ReplicatedPin[]; memberships: readonly string[]; authoritative: boolean },
  local: readonly LocalPinState[],
): string[] {
  if (!cloud.authoritative) return [];
  const hasPin = new Set(cloud.pins.map((pin) => pin.membershipId));
  return local
    .filter((row) => STAFF_PIN_ROLES.has(row.role) && row.pinHash !== null
      && cloud.memberships.includes(row.membershipId) && !hasPin.has(row.membershipId))
    .map((row) => row.membershipId);
}

/**
 * Issue #948 P0-1 — how one membership's local `platform_users` row is bound
 * to the cloud's canonical global identity. Pure; the DB half
 * (`applyLoginCredentials`) executes the plan.
 *
 * Facts in, decision out:
 *
 * - `platformUserId` — the cloud's canonical ID (contract v2), or `null` for a
 *   legacy payload that names none. When present, *it* decides the row ID:
 *   an existing row with that ID is the identity; a row found only by unique
 *   email is the same person under a pre-v2 local UUID and is re-keyed; with
 *   no row at all the identity is created under the canonical ID. The site
 *   never mints a fresh local UUID for an identity the cloud named.
 * - `emailRowId` — `platform_users.email` is UNIQUE, so a row matching the
 *   credential's email is the same global person (or nobody's duplicate).
 *   Preferring it over the membership's current link is what stops one user's
 *   credentials from being written onto another user's row.
 * - `linkedPlatformUserId` — the membership's current link. Used for binding
 *   repair (the caller relinks to the planned row) and, on legacy payloads
 *   only, as the v1 fallback when no email match exists.
 *
 * Deliberately *not* decided here: what to write on the row (the cloud
 * payload is authoritative), what to do with a competing row that holds the
 * credential's email while a different row holds the canonical ID (the caller
 * reports `identity_email_conflict` and leaves both alone), and whether the
 * membership exists at all (the caller skips unknown memberships).
 */
export interface IdentityBindingPlan {
  /** Row to write the cloud's fields onto / insert. */
  platformUserId: string | null;
  /** Set when a legacy local UUID must be migrated onto the canonical ID. */
  rekeyFrom: string | null;
  insert: boolean;
}

export function planIdentityBinding(input: {
  /** The cloud global identity this membership signs in through. */
  platformUserId: string | null;
  /** The membership's current local platform identity link, if any. */
  linkedPlatformUserId: string | null;
  /** A local row whose ID equals the canonical cloud ID already exists. */
  canonicalRowExists: boolean;
  /** The ID of the (unique) local row holding the credential's email. */
  emailRowId: string | null;
}): IdentityBindingPlan {
  const canonical = normalizeIdentityId(input.platformUserId);
  const emailRowId = input.emailRowId ? normalizeIdentityId(input.emailRowId) : null;
  const linked = input.linkedPlatformUserId ? normalizeIdentityId(input.linkedPlatformUserId) : null;

  if (canonical) {
    if (input.canonicalRowExists) return { platformUserId: canonical, rekeyFrom: null, insert: false };
    if (emailRowId && emailRowId !== canonical) {
      // Same person, pre-v2 local UUID: migrate the row onto the canonical ID
      // (references move with it), preserving password/MFA/token version.
      return { platformUserId: canonical, rekeyFrom: emailRowId, insert: false };
    }
    // No row for this person yet — or the membership is linked to a row that
    // is *not* this person (its email is not the credential's). Create the
    // canonical identity and relink; never overwrite the other row, which may
    // serve someone else's membership.
    return { platformUserId: canonical, rekeyFrom: null, insert: true };
  }

  // Legacy payload (contract v1): no canonical ID to bind to. Same person by
  // unique email first, else today's linked row, else a plain insert.
  if (emailRowId) return { platformUserId: emailRowId, rekeyFrom: null, insert: false };
  if (linked) return { platformUserId: linked, rekeyFrom: null, insert: false };
  return { platformUserId: null, rekeyFrom: null, insert: true };
}
