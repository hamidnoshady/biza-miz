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
import { createHash } from "node:crypto";
import { stable } from "./reconciliation";

export interface ReplicatedLoginCredential {
  /** The membership (`users.id`) the identity signs in as. */
  membershipId: string;
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
 */
export function loginCredentialsFingerprint(credentials: readonly ReplicatedLoginCredential[]): string {
  const canonical = [...credentials]
    .sort((a, b) => a.membershipId.localeCompare(b.membershipId))
    .map((c) => ({
      ...c,
      email: c.email.trim().toLowerCase(),
      tokenVersion: c.tokenVersion ?? 1,
      mfa: [...c.mfa].sort((a, b) => a.method.localeCompare(b.method)),
      recoveryCodes: [...c.recoveryCodes]
        .sort((a, b) => a.codeHash.localeCompare(b.codeHash))
        .map((code) => ({ codeHash: code.codeHash, spent: code.usedAt !== null })),
    }));
  return createHash("sha256").update(stable(canonical)).digest("hex");
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
} | { ok: false; code: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "payload_not_object" };
  const body = raw as { credentials?: unknown; pins?: unknown };
  const credentials = body.credentials ?? [];
  const pins = body.pins ?? [];
  if (!Array.isArray(credentials)) return { ok: false, code: "credentials_not_array" };
  if (!Array.isArray(pins)) return { ok: false, code: "pins_not_array" };
  // An old cloud may legitimately omit `pins`; once the list exists its
  // entries must be usable.
  if (!pins.every(isPinRecord)) return { ok: false, code: "invalid_pin_record" };
  if (!credentials.every(isCredentialRecord)) return { ok: false, code: "invalid_credential_record" };
  return { ok: true, credentials: credentials as ReplicatedLoginCredential[], pins: pins as ReplicatedPin[] };
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

const STAFF_PIN_ROLES: ReadonlySet<string> = new Set(["cashier", "waiter", "kitchen"]);

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
