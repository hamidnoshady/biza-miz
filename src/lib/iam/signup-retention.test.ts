/**
 * ESH-200 / #1385 — the pure half of signup-proof retention.
 *
 * The sweep itself is covered against a real database in
 * `integration/phone-first-signup.integration.test.ts`; this file pins the
 * policy numbers and the cutoff arithmetic that decides what it may touch.
 */
import { describe, expect, it } from "vitest";
import {
  SIGNUP_EXPIRED_REQUEST_GRACE_HOURS,
  SIGNUP_REQUEST_RETENTION_DAYS,
  signupRetentionCutoffs,
} from "./signup-retention";

describe("signup request retention", () => {
  it("keeps consumed proofs for a support window, not forever", () => {
    expect(SIGNUP_REQUEST_RETENTION_DAYS).toBe(30);
    expect(SIGNUP_EXPIRED_REQUEST_GRACE_HOURS).toBe(24);
  });

  it("marks an expired request only after the grace period", () => {
    const now = new Date("2026-11-22T12:00:00.000Z");
    const cutoffs = signupRetentionCutoffs(now);
    expect(cutoffs.expiredBefore.toISOString()).toBe("2026-11-21T12:00:00.000Z");
    expect(cutoffs.deleteBefore.toISOString()).toBe("2026-10-23T12:00:00.000Z");
  });
});
