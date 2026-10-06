import { describe, expect, it } from "vitest";
import {
  loginCredentialsFingerprint,
  planPinRemoval,
  planPinReplication,
  validateLoginCredentialPayload,
  type ReplicatedLoginCredential,
} from "./login-credentials";

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

describe("planPinReplication", () => {
  const cloud = [
    { membershipId: "cashier", pinHash: "$cloud-cashier" },
    { membershipId: "owner", pinHash: "$cloud-owner" },
  ];

  it("gives a cloud-made cashier with no PIN on the desktop the cloud's", () => {
    expect(planPinReplication(cloud, [{ membershipId: "cashier", role: "cashier", pinHash: null }]))
      .toEqual([{ membershipId: "cashier", pinHash: "$cloud-cashier" }]);
  });

  it("puts a staff PIN changed on the desktop back to the cloud's", () => {
    expect(planPinReplication(cloud, [{ membershipId: "cashier", role: "waiter", pinHash: "$local" }]))
      .toEqual([{ membershipId: "cashier", pinHash: "$cloud-cashier" }]);
  });

  it("keeps the owner's own offline PIN, and fills it only when the desktop has none", () => {
    expect(planPinReplication(cloud, [{ membershipId: "owner", role: "owner", pinHash: "$wizard" }])).toEqual([]);
    expect(planPinReplication(cloud, [{ membershipId: "owner", role: "owner", pinHash: null }]))
      .toEqual([{ membershipId: "owner", pinHash: "$cloud-owner" }]);
  });

  it("writes nothing when equal, and skips members not replicated yet", () => {
    expect(planPinReplication(cloud, [{ membershipId: "cashier", role: "cashier", pinHash: "$cloud-cashier" }])).toEqual([]);
    expect(planPinReplication(cloud, [])).toEqual([]);
  });
});

describe("validateLoginCredentialPayload", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const credential = { ...owner, membershipId: id };

  it("accepts a well-formed payload", () => {
    const result = validateLoginCredentialPayload({ credentials: [credential], pins: [{ membershipId: id, pinHash: "$2b$pin" }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials).toHaveLength(1);
      expect(result.pins).toHaveLength(1);
    }
  });

  it("treats missing lists as empty — an older cloud may omit `pins`", () => {
    expect(validateLoginCredentialPayload({ credentials: [] })).toMatchObject({ ok: true, pins: [] });
  });

  it("refuses anything that is not a payload object", () => {
    expect(validateLoginCredentialPayload(null)).toEqual({ ok: false, code: "payload_not_object" });
    expect(validateLoginCredentialPayload("[]")).toEqual({ ok: false, code: "payload_not_object" });
  });

  it("refuses malformed records instead of applying half of them", () => {
    expect(validateLoginCredentialPayload({ credentials: {}, pins: [] })).toEqual({ ok: false, code: "credentials_not_array" });
    expect(validateLoginCredentialPayload({ credentials: [] })).toEqual({
      ok: true,
      credentials: [],
      pins: [],
      staffPinMemberships: [],
      staffPinsAuthoritative: false,
    });
    expect(validateLoginCredentialPayload({ pins: [{ membershipId: "not-a-uuid", pinHash: "h" }] }))
      .toEqual({ ok: false, code: "invalid_pin_record" });
    expect(validateLoginCredentialPayload({ pins: [{ membershipId: id, pinHash: "" }] }))
      .toEqual({ ok: false, code: "invalid_pin_record" });
    expect(validateLoginCredentialPayload({ credentials: [{ ...credential, mfa: "totp" }] }))
      .toEqual({ ok: false, code: "invalid_credential_record" });
    expect(validateLoginCredentialPayload({ credentials: [{ ...credential, membershipId: "nope" }] }))
      .toEqual({ ok: false, code: "invalid_credential_record" });
  });

  it("accepts the staff-PIN block only whole, and refuses a half-sent one", () => {
    const cashierId = "11111111-1111-4111-8111-111111111111";
    // Issue #850: the block is what licenses removing a PIN, so a malformed
    // one must be an invalid payload rather than a silent permission.
    expect(validateLoginCredentialPayload({ pins: [], staffPins: { authoritative: true, memberships: [cashierId] } }))
      .toMatchObject({ ok: true, staffPinMemberships: [cashierId], staffPinsAuthoritative: true });
    expect(validateLoginCredentialPayload({ pins: [], staffPins: { authoritative: false, memberships: [cashierId] } }))
      .toEqual({ ok: false, code: "staff_pins_not_authoritative" });
    expect(validateLoginCredentialPayload({ pins: [], staffPins: { authoritative: true } }))
      .toEqual({ ok: false, code: "staff_pins_memberships_not_array" });
    expect(validateLoginCredentialPayload({ pins: [], staffPins: { authoritative: true, memberships: ["not-a-uuid"] } }))
      .toEqual({ ok: false, code: "invalid_staff_pin_membership" });
    expect(validateLoginCredentialPayload({ pins: [], staffPins: [] }))
      .toEqual({ ok: false, code: "staff_pins_not_object" });
  });

  it("removes only staff PINs the authoritative cloud says it has none for", () => {
    const cashierId = "11111111-1111-4111-8111-111111111111";
    const waiterId = "22222222-2222-4222-8222-222222222222";
    const kitchenId = "33333333-3333-4333-8333-333333333333";
    const ownerId = "44444444-4444-4444-8444-444444444444";
    const strangerId = "55555555-5555-4555-8555-555555555555";
    const local = [
      { membershipId: cashierId, role: "cashier", pinHash: "hash" },
      { membershipId: waiterId, role: "waiter", pinHash: "hash" },
      { membershipId: ownerId, role: "owner", pinHash: "hash" },      // device-local door
      { membershipId: strangerId, role: "cashier", pinHash: "hash" }, // cloud has never seen them
      { membershipId: kitchenId, role: "kitchen", pinHash: null },    // nothing to remove
    ];
    // Not authoritative → no removals at all, whatever is missing.
    expect(planPinRemoval({ pins: [], memberships: [cashierId, waiterId, ownerId, strangerId, kitchenId], authoritative: false }, local))
      .toEqual([]);
    // Authoritative: the cashier was listed and has no PIN in the payload.
    expect(planPinRemoval({ pins: [{ membershipId: waiterId, pinHash: "hash" }], memberships: [cashierId, waiterId, ownerId], authoritative: true }, local))
      .toEqual([cashierId]);
    // A password-role member is never removed, whatever the cloud lists...
    expect(planPinRemoval({ pins: [], memberships: [ownerId], authoritative: true }, local)).toEqual([]);
    // ...and only what the cloud *lists* is removable: the unlisted cashier
    // (strangerId) keeps their PIN, and a listed member that already has no
    // PIN (kitchenId) has nothing to remove.
    expect(planPinRemoval({ pins: [], memberships: [cashierId, kitchenId], authoritative: true }, local)).toEqual([cashierId]);
  });
});
