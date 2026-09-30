import { describe, expect, it } from "vitest";
import { loginCredentialsFingerprint, type ReplicatedLoginCredential } from "./login-credentials";

const owner: ReplicatedLoginCredential = {
  membershipId: "b",
  email: "owner@example.com",
  fullName: "حمید",
  passwordHash: "$2b$10$hash",
  isActive: true,
  mfa: [
    { method: "totp", isPrimary: true, phoneE164: null, totpSecret: "JBSWY3DPEHPK3PXP" },
    { method: "sms_otp", isPrimary: false, phoneE164: "+989121234567", totpSecret: null },
  ],
  recoveryCodes: [{ codeHash: "h2", usedAt: null }, { codeHash: "h1", usedAt: null }],
};
const manager: ReplicatedLoginCredential = { ...owner, membershipId: "a", email: "m@example.com", mfa: [], recoveryCodes: [] };

describe("loginCredentialsFingerprint", () => {
  it("ignores ordering, so an unchanged cloud never rewrites the desktop", () => {
    const reordered = { ...owner, mfa: [...owner.mfa].reverse(), recoveryCodes: [...owner.recoveryCodes].reverse() };
    expect(loginCredentialsFingerprint([owner, manager])).toBe(loginCredentialsFingerprint([manager, reordered]));
  });

  it("treats a code spent on both replicas as equal whatever moment each stamped", () => {
    const at = (usedAt: string) => ({ ...owner, recoveryCodes: [{ codeHash: "h1", usedAt }, { codeHash: "h2", usedAt: null }] });
    expect(loginCredentialsFingerprint([at("2026-09-30T08:00:00.000Z")]))
      .toBe(loginCredentialsFingerprint([at("2026-09-30T09:15:00.000Z")]));
  });

  it("changes when a password, second factor or recovery code changes", () => {
    const base = loginCredentialsFingerprint([owner]);
    expect(loginCredentialsFingerprint([{ ...owner, passwordHash: "$2b$10$other" }])).not.toBe(base);
    expect(loginCredentialsFingerprint([{ ...owner, mfa: [] }])).not.toBe(base);
    expect(loginCredentialsFingerprint([{ ...owner, recoveryCodes: [{ codeHash: "h1", usedAt: "2026-09-30T00:00:00.000Z" }] }])).not.toBe(base);
  });
});
