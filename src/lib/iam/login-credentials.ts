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
  mfa: Array<{
    method: "totp" | "sms_otp";
    isPrimary: boolean;
    phoneE164: string | null;
    totpSecret: string | null;
  }>;
  /** bcrypt hashes — portable between servers as they are. */
  recoveryCodes: Array<{ codeHash: string; usedAt: string | null }>;
}

/** Order-independent digest, so the desktop rewrites identities only when the cloud's changed. */
export function loginCredentialsFingerprint(credentials: readonly ReplicatedLoginCredential[]): string {
  const canonical = [...credentials]
    .sort((a, b) => a.membershipId.localeCompare(b.membershipId))
    .map((c) => ({
      ...c,
      mfa: [...c.mfa].sort((a, b) => a.method.localeCompare(b.method)),
      recoveryCodes: [...c.recoveryCodes].sort((a, b) => a.codeHash.localeCompare(b.codeHash)),
    }));
  return createHash("sha256").update(stable(canonical)).digest("hex");
}
