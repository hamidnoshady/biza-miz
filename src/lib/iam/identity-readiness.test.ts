import { describe, expect, it } from "vitest";
import { cloudLoginIdentityReadiness } from "./identity-readiness";

const CLOUD_ID = "11111111-1111-1111-1111-111111111111";

describe("cloudLoginIdentityReadiness", () => {
  it("accepts a membership converged onto the expected global identity", () => {
    expect(cloudLoginIdentityReadiness({
      expectedPlatformUserId: CLOUD_ID,
      local: { platformUserId: CLOUD_ID, tokenVersion: 7 },
    })).toEqual({ ok: true, bound: true, platformUserId: CLOUD_ID, tokenVersion: 7 });
  });

  it("fails closed when the membership arrived but its credentials did not", () => {
    // The owner-only partial state: membership replicated, platform identity
    // not yet linked. Minting a session here would sit outside the cloud's
    // token-version revocation chain.
    expect(cloudLoginIdentityReadiness({
      expectedPlatformUserId: CLOUD_ID,
      local: { platformUserId: null, tokenVersion: null },
    })).toEqual({ ok: false, issue: "identity_binding_missing" });
  });

  it("fails closed when the local binding points at a different identity", () => {
    expect(cloudLoginIdentityReadiness({
      expectedPlatformUserId: CLOUD_ID,
      local: { platformUserId: "22222222-2222-2222-2222-222222222222", tokenVersion: 3 },
    })).toEqual({ ok: false, issue: "identity_binding_mismatch" });
  });

  it("fails closed when the expected identity has no active token version", () => {
    expect(cloudLoginIdentityReadiness({
      expectedPlatformUserId: CLOUD_ID,
      local: { platformUserId: CLOUD_ID, tokenVersion: null },
    })).toEqual({ ok: false, issue: "identity_inactive" });
  });

  it("reports a missing membership separately from a missing identity", () => {
    expect(cloudLoginIdentityReadiness({ expectedPlatformUserId: CLOUD_ID, local: null }))
      .toEqual({ ok: false, issue: "membership_missing" });
  });

  it("preserves PIN-only memberships the cloud has no platform identity for", () => {
    expect(cloudLoginIdentityReadiness({
      expectedPlatformUserId: null,
      local: { platformUserId: null, tokenVersion: null },
    })).toEqual({ ok: true, bound: false, platformUserId: null, tokenVersion: null });
  });

  it("keeps legacy clouds that do not report an identity working", () => {
    // `undefined` = the redemption answer had no platformUserId field at all.
    expect(cloudLoginIdentityReadiness({
      expectedPlatformUserId: undefined,
      local: { platformUserId: null, tokenVersion: null },
    })).toMatchObject({ ok: true, bound: false });
    expect(cloudLoginIdentityReadiness({
      expectedPlatformUserId: undefined,
      local: { platformUserId: CLOUD_ID, tokenVersion: 4 },
    })).toMatchObject({ ok: true, bound: true, tokenVersion: 4 });
  });
});
