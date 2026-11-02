/**
 * Issue #902 — the provisioning state machine and eligibility rules.
 *
 * These are the guarantees the issue's acceptance criteria rest on:
 *   * activation moves forward exactly once and never re-creates an active
 *     child,
 *   * a lost response lands in `retry_pending` (read-before-write), never in a
 *     second create,
 *   * a lapse suspends without deleting anything,
 *   * the platform's policy/availability wins over the business's entitlement.
 */
import { describe, expect, it } from "vitest";
import {
  buildChildProvisioningRequest,
  decideProvisionAction,
  generatePanelPassword,
  isProvisionUsable,
  needsProviderReadFirst,
  provisionRetryDelayMs,
  provisioningLocalId,
  provisioningUsername,
  transitionProvisionState,
  ProvisionTransitionError,
} from "./provisioning";

const now = new Date("2026-10-26T10:00:00.000Z");
const businessId = "0d5f4c7e-2e63-4e1f-9c8e-6e0f6f4a9b11";

describe("transitionProvisionState", () => {
  it("walks the happy path once: pending → provisioning → active", () => {
    const requested = transitionProvisionState("not_provisioned", "request_provision");
    expect(requested).toMatchObject({ state: "pending", enqueue: true });

    const claimed = transitionProvisionState("pending", "claim");
    expect(claimed.state).toBe("provisioning");

    const done = transitionProvisionState("provisioning", "succeeded");
    expect(done.state).toBe("active");
    expect(done.enqueue).toBe(false);
  });

  it("has no transition from active back to pending on a second activation", () => {
    // This is what stops simultaneous activation from re-provisioning: the
    // second caller's `request_provision` is rejected, not applied.
    expect(() => transitionProvisionState("active", "request_provision")).toThrow(ProvisionTransitionError);
  });

  it("turns an unknown outcome into read-before-write, not a failure", () => {
    const retry = transitionProvisionState("provisioning", "outcome_unknown");
    expect(retry).toMatchObject({ state: "retry_pending", reason: "outcome_unknown", enqueue: true });
    expect(needsProviderReadFirst(retry.state)).toBe(true);
    expect(transitionProvisionState("retry_pending", "recovered").state).toBe("active");
  });

  it("recovers a duplicate local id without ever retrying the create", () => {
    // The provider answered 503 duplicate localid: the child exists.
    const retry = transitionProvisionState("provisioning", "outcome_unknown");
    expect(retry.state).toBe("retry_pending");
    const recovered = transitionProvisionState(retry.state, "recovered");
    expect(recovered).toMatchObject({ state: "active", reason: "recovered_after_unknown_outcome" });
  });

  it("retries a username collision with a new name, and gives up after the cap", () => {
    expect(transitionProvisionState("provisioning", "username_collision")).toMatchObject({
      state: "retry_pending",
      reason: "username_collision",
    });
    expect(transitionProvisionState("retry_pending", "attempts_exhausted")).toMatchObject({
      state: "attention_required",
      reason: "attempts_exhausted",
    });
  });

  it("suspends and reactivates without deleting state", () => {
    expect(transitionProvisionState("active", "suspend")).toMatchObject({
      state: "suspended",
      enqueue: false,
    });
    expect(transitionProvisionState("suspended", "reactivate")).toMatchObject({
      state: "pending",
      enqueue: true,
    });
    // A suspended child is never usable, even though it still exists.
    expect(isProvisionUsable("suspended")).toBe(false);
  });

  it("requires an operator for attention_required", () => {
    expect(() => transitionProvisionState("attention_required", "claim")).toThrow(ProvisionTransitionError);
  });

  it("rejects an illegal pair instead of silently doing nothing", () => {
    expect(() => transitionProvisionState("not_provisioned", "succeeded")).toThrowError(
      "illegal_provision_transition:not_provisioned->succeeded",
    );
  });
});

describe("decideProvisionAction", () => {
  const base = {
    policyEnabled: true,
    entitled: true,
    appAvailable: true,
    existingState: null,
    now,
  } as const;

  it("provisions a new eligible business", () => {
    expect(decideProvisionAction({ ...base }).action).toBe("provision");
  });

  it("never provisions while the platform has not opted in", () => {
    expect(decideProvisionAction({ ...base, policyEnabled: false })).toMatchObject({
      action: "wait",
      reason: "platform_setup_incomplete",
    });
  });

  it("waits when the app is unavailable instead of creating an unusable child", () => {
    expect(decideProvisionAction({ ...base, appAvailable: false })).toMatchObject({
      action: "wait",
      reason: "suspended_by_platform",
    });
  });

  it("suspends an active child when Growth lapses, and does not delete it", () => {
    expect(
      decideProvisionAction({ ...base, entitled: false, existingState: "active" }),
    ).toMatchObject({ action: "suspend", reason: "suspended_by_plan" });
  });

  it("reactivates a suspended child on renewal", () => {
    expect(
      decideProvisionAction({ ...base, existingState: "suspended" }),
    ).toMatchObject({ action: "reactivate", reason: "provisioning" });
  });

  it("honours the retry backoff instead of hot-looping the provider", () => {
    expect(
      decideProvisionAction({
        ...base,
        existingState: "retry_pending",
        lastAttemptAt: new Date(now.getTime() - 1_000),
      }).action,
    ).toBe("wait");
    expect(
      decideProvisionAction({
        ...base,
        existingState: "retry_pending",
        lastAttemptAt: new Date(now.getTime() - 60_000),
      }).action,
    ).toBe("provision");
  });

  it("leaves attention_required to an operator", () => {
    expect(
      decideProvisionAction({ ...base, existingState: "attention_required" }),
    ).toMatchObject({ action: "operator", reason: "needs_support" });
  });

  it("waits while an in-flight state is already progressing", () => {
    expect(decideProvisionAction({ ...base, existingState: "provisioning" }).action).toBe("wait");
    expect(decideProvisionAction({ ...base, existingState: "active" })).toMatchObject({
      action: "wait",
      reason: "ready",
    });
  });
});

describe("request material", () => {
  it("uses the business UUID as the stable local id", () => {
    expect(provisioningLocalId(businessId)).toBe(businessId);
  });

  it("derives a different username per attempt, deterministically", () => {
    expect(provisioningUsername(businessId, 0)).toBe("bm0d5f4c7e2e634e1f");
    expect(provisioningUsername(businessId, 1)).toBe("bm0d5f4c7e2e634e1f1");
    expect(provisioningUsername(businessId, 0)).not.toBe(provisioningUsername(businessId, 2));
    expect(provisioningUsername(businessId, 0)).toMatch(/^[a-z0-9]+$/);
  });

  it("generates a strong password from the injected bytes and keeps character classes", () => {
    const password = generatePanelPassword((size) => Buffer.alloc(size, 3));
    expect(password.startsWith("Aa1")).toBe(true);
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    // Two draws differ: the alphabet mapping is not constant.
    expect(generatePanelPassword()).not.toBe(generatePanelPassword());
  });

  it("creates children with zero credit, panel login disabled and the policy's lines", () => {
    const request = buildChildProvisioningRequest({
      businessId,
      businessName: "کافه نمونه",
      policy: { planId: 1484, minAllowedCreditRial: 100000, senderLines: ["10004346"] },
      usernameAttempt: 0,
      password: "Aa1fixed",
    });
    expect(request).toMatchObject({
      localId: businessId,
      username: "bm0d5f4c7e2e634e1f",
      password: "Aa1fixed",
      fullName: "کافه نمونه",
      planId: 1484,
      minAllowedCreditRial: 100000,
      status: "2",
      lines: ["10004346"],
      initialCreditRial: 0,
    });
  });

  it("falls back to a neutral display name rather than sending an empty one", () => {
    const request = buildChildProvisioningRequest({
      businessId,
      businessName: "   ",
      policy: { planId: null, minAllowedCreditRial: 0, senderLines: [] },
      password: "Aa1fixed",
    });
    expect(request.fullName).toBe("Bizamiz");
    expect(request.planId).toBeNull();
  });

  it("backs retries off exponentially and caps at six hours", () => {
    expect(provisionRetryDelayMs(1)).toBe(30_000);
    expect(provisionRetryDelayMs(2)).toBe(60_000);
    expect(provisionRetryDelayMs(20)).toBe(6 * 60 * 60_000);
  });
});
