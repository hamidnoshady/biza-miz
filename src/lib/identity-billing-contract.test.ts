/**
 * ESH-199 × ESH-193 (GitHub #1384 / #1378) — the shared contract's pinned rules.
 *
 * These tests exist because the two tracks are developed in parallel: each one
 * has to be able to rely on this seam without re-reading the other's code. The
 * behaviours pinned here are the ones a future change must not quietly relax —
 * a synthesised actor for a legacy membership, a verified phone without its
 * stamp, a landline unlocking a purchase, or a database import appearing in the
 * one module both sides are meant to share.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_IDENTITY_READ_FIELDS,
  commercialActorRefusalMessage,
  purchaseBlockerMessage,
  purchaseReadiness,
  purchaseReadinessForAssurance,
  readIdentityAssurance,
  resolveCommercialActor,
  sameGlobalPerson,
  type CommercialActorRefusal,
  type IdentityAssuranceRow,
} from "./identity-billing-contract";

const SESSION = {
  platformUserId: "pu-1",
  businessId: "biz-1",
  membershipId: "mem-1",
  membershipActive: true,
};

function row(overrides: Partial<IdentityAssuranceRow> = {}): IdentityAssuranceRow {
  return {
    phone_e164: "+989121234567",
    phone_verified_at: "2026-01-01T00:00:00.000Z",
    email: "owner@example.com",
    email_verified_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveCommercialActor", () => {
  it("builds the actor from the session's global person and business, nothing else", () => {
    const result = resolveCommercialActor(SESSION);
    expect(result).toEqual({
      ok: true,
      actor: {
        platformUserId: "pu-1",
        businessId: "biz-1",
        membershipId: "mem-1",
      },
    });
  });

  it("refuses a legacy membership with no global identity instead of inventing one", () => {
    // The dual-read window: the membership row exists, the person is not linked
    // yet. Billing must get a clear refusal, not an actor keyed on a phone.
    const result = resolveCommercialActor({
      ...SESSION,
      platformUserId: null,
    });
    expect(result).toEqual({ ok: false, refusal: "no_global_identity" });
  });

  it("reports the missing global identity before anything else", () => {
    // Ordering is load-bearing: this is the answer that tells a caller to finish
    // signup, even on a request that also lacks a business scope.
    expect(
      resolveCommercialActor({
        platformUserId: null,
        businessId: null,
        membershipId: null,
        membershipActive: false,
      }),
    ).toEqual({ ok: false, refusal: "no_global_identity" });
  });

  it("refuses a request with no business or no membership", () => {
    expect(resolveCommercialActor({ ...SESSION, businessId: null })).toEqual({
      ok: false,
      refusal: "no_business_scope",
    });
    expect(resolveCommercialActor({ ...SESSION, membershipId: null })).toEqual({
      ok: false,
      refusal: "no_business_scope",
    });
  });

  it("refuses an inactive membership", () => {
    expect(resolveCommercialActor({ ...SESSION, membershipActive: false })).toEqual({
      ok: false,
      refusal: "membership_inactive",
    });
  });
});

describe("sameGlobalPerson", () => {
  it("treats one person paying for two businesses as one actor identity", () => {
    expect(
      sameGlobalPerson(
        { platformUserId: "pu-1", businessId: "biz-1", membershipId: "mem-1" },
        { platformUserId: "pu-1", businessId: "biz-2", membershipId: "mem-9" },
      ),
    ).toBe(true);
  });

  it("does not confuse two people in the same business", () => {
    expect(
      sameGlobalPerson(
        { platformUserId: "pu-1", businessId: "biz-1", membershipId: "mem-1" },
        { platformUserId: "pu-2", businessId: "biz-1", membershipId: "mem-2" },
      ),
    ).toBe(false);
  });
});

describe("refusal messages", () => {
  const refusals: CommercialActorRefusal[] = [
    "no_global_identity",
    "no_business_scope",
    "membership_inactive",
  ];

  it("gives every refusal its own Persian sentence", () => {
    const messages = refusals.map((refusal) => commercialActorRefusalMessage(refusal));
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(refusals.length);
  });

  it("tells a legacy account to finish its identity, not to change business", () => {
    expect(commercialActorRefusalMessage("no_global_identity")).toContain("هویت سراسری");
  });
});

describe("readIdentityAssurance", () => {
  it("reports a phone as verified only when the value and its stamp are both present", () => {
    expect(readIdentityAssurance(row()).phone).toEqual({
      e164: "+989121234567",
      verified: true,
    });
    expect(readIdentityAssurance(row({ phone_verified_at: null })).phone).toEqual({
      e164: "+989121234567",
      verified: false,
    });
  });

  it("does not carry a stale verification onto a newly typed number", () => {
    // Changing the phone clears the stamp; the row is a legitimate
    // value-without-proof state and must read that way.
    const assurance = readIdentityAssurance(
      row({ phone_e164: "+989129999999", phone_verified_at: null }),
    );
    expect(assurance.phone.e164).toBe("+989129999999");
    expect(assurance.phone.verified).toBe(false);
  });

  it("treats blank values and blank stamps as nothing", () => {
    const assurance = readIdentityAssurance(
      row({ phone_e164: "   ", phone_verified_at: "", email: "", email_verified_at: " " }),
    );
    expect(assurance.phone).toEqual({ e164: null, verified: false });
    expect(assurance.email).toEqual({ address: null, verified: false });
  });

  it("accepts a Date stamp the same way as an ISO string", () => {
    expect(
      readIdentityAssurance(row({ phone_verified_at: new Date("2026-01-01T00:00:00.000Z") }))
        .phone.verified,
    ).toBe(true);
    expect(readIdentityAssurance(row({ phone_verified_at: new Date("nope") })).phone.verified).toBe(
      false,
    );
  });

  it("keeps email verification a separate fact from phone verification", () => {
    const assurance = readIdentityAssurance(row({ phone_verified_at: null }));
    expect(assurance.email.verified).toBe(true);
  });

  it("reads only the four fields the contract names", () => {
    expect([...COMMERCIAL_IDENTITY_READ_FIELDS]).toEqual([
      "phone_e164",
      "phone_verified_at",
      "email",
      "email_verified_at",
    ]);
  });
});

describe("purchaseReadiness", () => {
  it("unlocks a purchase for a verified mobile and returns the canonical E.164 form", () => {
    const readiness = purchaseReadiness(
      readIdentityAssurance(row({ phone_e164: "۰۹۱۲ ۱۲۳ ۴۵۶۷" })),
    );
    expect(readiness).toEqual({ ok: true, phoneE164: "+989121234567" });
  });

  it("blocks an unverified phone and says what proof is missing", () => {
    const readiness = purchaseReadiness(readIdentityAssurance(row({ phone_verified_at: null })));
    expect(readiness).toEqual({
      ok: false,
      blockedBy: ["phone_not_verified"],
      message: purchaseBlockerMessage("phone_not_verified"),
    });
  });

  it("blocks an account with no phone at all", () => {
    const readiness = purchaseReadiness(readIdentityAssurance(row({ phone_e164: null })));
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.blockedBy).toEqual(["phone_not_verified"]);
  });

  it("does not unlock a purchase with a verified landline", () => {
    // Verified is not the same as reachable: a landline cannot receive the SMS.
    const readiness = purchaseReadiness(
      readIdentityAssurance(row({ phone_e164: "02112345678" })),
    );
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.blockedBy).toEqual(["phone_not_mobile"]);
      expect(readiness.message).toContain("موبایل");
    }
  });

  it("blocks an unparsable number rather than passing it through", () => {
    const readiness = purchaseReadiness(readIdentityAssurance(row({ phone_e164: "12345" })));
    expect(readiness.ok).toBe(false);
  });

  it("never unblocks on an email, however verified", () => {
    const readiness = purchaseReadiness(
      readIdentityAssurance(row({ phone_e164: null, phone_verified_at: null })),
    );
    expect(readiness.ok).toBe(false);
  });

  it("fails closed when there is no assurance row at all", () => {
    // A legacy membership with no global identity, or an unknown id, must get
    // the same onboarding blocker rather than a crash or an allowed purchase.
    for (const assurance of [null, undefined]) {
      expect(purchaseReadinessForAssurance(assurance)).toEqual({
        ok: false,
        blockedBy: ["phone_not_verified"],
        message: purchaseBlockerMessage("phone_not_verified"),
      });
    }
  });

  it("passes a real assurance row through unchanged", () => {
    expect(
      purchaseReadinessForAssurance(readIdentityAssurance(row({ phone_e164: "09121234567" }))),
    ).toEqual({ ok: true, phoneE164: "+989121234567" });
  });

  it("gives each blocker its own Persian sentence", () => {
    expect(purchaseBlockerMessage("phone_not_verified")).not.toBe(
      purchaseBlockerMessage("phone_not_mobile"),
    );
  });
});

describe("the seam stays database-free", () => {
  it("imports no database module, so both tracks can build against it in parallel", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/identity-billing-contract.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\/db["']/);
    expect(source).not.toMatch(/\bquery\(/);
  });
});
