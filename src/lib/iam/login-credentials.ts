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
