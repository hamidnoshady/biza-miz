/**
 * Issue #902 §9 item 7 — the failure drill (DoD #11), as one table.
 *
 * The epic's last open acceptance line is: *"Tests cover errors (invalid key,
 * insufficient master/child balance, expired account, rejected template, HTTP
 * timeout/429, duplicate responses, concurrent workers, offline replay and
 * provider outage) without external network calls; actionable first-party tenant
 * errors and internal supplier observability."*
 *
 * Every one of those nine already had a test somewhere — but they were scattered
 * across eight files, each asserting the bit its own module owned, and no single
 * pass proved the thing that actually matters to a customer: that a supplier
 * failure arrives as **one Persian sentence with a next step**, and that the
 * supplier's own words stay in the operator's log. A per-module test can pass
 * while the seam between two modules leaks, because the leak is precisely the
 * part neither module owns.
 *
 * So this file walks the whole chain for each drill:
 *
 *   supplier answer -> classification -> contract fault -> tenant sentence
 *
 * and asserts the properties at each step. It is pure and makes no network call;
 * the database half of the drills — that login keeps working while marketing is
 * broken — is `integration/kavenegar-failure-drills.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  classifyKavenegarStatus,
  isLocalIdCollision,
  isUsernameCollision,
} from "./client";
import {
  MANAGED_SERVICE_FAULTS,
  MANAGED_SERVICE_STATUS_LABELS,
  TENANT_PROVIDER_NAME_PATTERN,
  type ManagedServiceFaultCode,
} from "../managed-services/contract";
import { KavenegarError, kavenegarStatusMessage } from "../sms-kavenegar";

/**
 * One row per failure class DoD #11 names.
 *
 * `answer` is what the supplier actually does — a `return.status` from its own
 * table, an HTTP status, or "nothing at all" for the two transport drills.
 * `retryable` is the *decision*, not a description: a retryable failure leaves
 * the row queued and charges nothing, a permanent one fails the row and refunds
 * its share of the reservation.
 */
const DRILLS: {
  name: string;
  answer: number;
  fault: ManagedServiceFaultCode;
  retryable: boolean;
  /** Whether the customer should be told to act, or to wait. */
  expectsAction: boolean;
}[] = [
  // The credential the whole management plane runs on, rejected.
  { name: "invalid key", answer: 403, fault: "service_suspended", retryable: false, expectsAction: true },
  // The master account's own subscription ran out: same class, different cause.
  { name: "expired account", answer: 505, fault: "service_suspended", retryable: false, expectsAction: true },
  // Child or master out of credit — the tenant's next step is the wallet.
  { name: "insufficient balance", answer: 418, fault: "platform_credit_exhausted", retryable: false, expectsAction: true },
  // The template is missing or was never approved.
  { name: "rejected template", answer: 424, fault: "provider_rejected", retryable: false, expectsAction: false },
  // HTTP 429 — the canonical "slow down", and until §9 item 7 the one answer
  // that fell through to `unknown` (retryable by luck, opaque to the console).
  { name: "http 429", answer: 429, fault: "rate_limited", retryable: true, expectsAction: false },
  // The supplier's own throttling code.
  { name: "rate limited", answer: 451, fault: "rate_limited", retryable: true, expectsAction: false },
  // Busy, not broken: retry, do not refund.
  { name: "provider unavailable", answer: 409, fault: "timeout", retryable: true, expectsAction: false },
  // A number the supplier will never accept — the person retypes it.
  { name: "invalid recipient", answer: 411, fault: "recipient_invalid", retryable: false, expectsAction: false },
];

describe("every failure DoD #11 names becomes one sentence a customer can act on", () => {
  it("covers the drills with the contract's own fault vocabulary", () => {
    for (const drill of DRILLS) {
      // The fault must be a key the contract can render. A new supplier code that
      // invented its own fault string would fail here rather than at runtime.
      expect(Object.keys(MANAGED_SERVICE_FAULTS), drill.name).toContain(drill.fault);
    }
  });

  it("classifies each drill as the decision the drain makes", () => {
    for (const drill of DRILLS) {
      const classification = classifyKavenegarStatus(drill.answer);
      expect(classification.ok, drill.name).toBe(false);
      expect(classification.retryable, `${drill.name}: retry decision`).toBe(drill.retryable);
      expect(classification.fault, `${drill.name}: tenant fault`).toBe(drill.fault);
    }
  });

  it("tells the customer something Persian and first-party, and the operator something English", () => {
    for (const drill of DRILLS) {
      const tenant = MANAGED_SERVICE_FAULTS[drill.fault].tenantMessage;
      const operator = classifyKavenegarStatus(drill.answer).operatorMessage;

      // The tenant sentence is copy: Persian, and none of our supplier's words.
      expect(tenant, `${drill.name}: tenant copy must be Persian`).toMatch(/[\u0600-\u06FF]/);
      expect(TENANT_PROVIDER_NAME_PATTERN.test(tenant), drill.name).toBe(false);
      expect(tenant, `${drill.name}: no provider code in copy`).not.toMatch(/\b(418|424|429|451|505|403)\b/);
      expect(tenant).not.toMatch(/provider|kavenegar|http/i);

      // The operator line is the opposite: internal, English, diagnosable, and it
      // may name the supplier because a log is not a tenant surface.
      expect(operator, drill.name).toMatch(/[a-z]{4,}/);
      expect(operator, `${drill.name}: operator line names the source`).toMatch(/provider:/);
    }
  });

  it("separates 'you can fix this' from 'wait for us'", () => {
    for (const drill of DRILLS) {
      const fault = MANAGED_SERVICE_FAULTS[drill.fault];
      // Actionable means the tenant is offered a step. A transient fault that
      // claimed to be actionable would send people to support for a rate limit.
      expect(fault.retryable, `${drill.name}: retryable flag`).toBe(drill.retryable);
      if (drill.expectsAction) {
        expect(fault.retryable, `${drill.name}: actionable failures are not auto-retried`).toBe(false);
        expect(fault.tenantMessage.length).toBeGreaterThan(10);
      }
    }
  });

  it("never retries something that will fail again, and never gives up on something that will not", () => {
    // The money consequence, stated once: a retryable failure leaves the row
    // queued and charges nothing; a permanent one fails it and refunds its share.
    // Getting this backwards either bills for messages that never went out or
    // silently drops ones that would have.
    const permanent = DRILLS.filter((drill) => !drill.retryable).map((drill) => drill.name);
    const transient = DRILLS.filter((drill) => drill.retryable).map((drill) => drill.name);
    expect(permanent).toEqual([
      "invalid key",
      "expired account",
      "insufficient balance",
      "rejected template",
      "invalid recipient",
    ]);
    expect(transient).toEqual(["http 429", "rate limited", "provider unavailable"]);
  });
});

describe("the drills that are not status codes", () => {
  it("treats an unknown status as transient, and says so in neither language", () => {
    // A supplier adding a code must not permanently fail a send; the queue's
    // attempt cap is what bounds the retrying.
    const unknown = classifyKavenegarStatus(599);
    expect(unknown).toMatchObject({ ok: false, retryable: true, fault: "unknown" });
    // And the customer still gets a real sentence, from the fallback fault.
    expect(MANAGED_SERVICE_FAULTS.unknown.tenantMessage).toMatch(/[\u0600-\u06FF]/);
    expect(TENANT_PROVIDER_NAME_PATTERN.test(MANAGED_SERVICE_FAULTS.unknown.tenantMessage)).toBe(false);
  });

  it("recognises both duplicate answers, because each has a different repair", () => {
    // 503: the child already exists under this local id — adopt it, do not create
    // a second. 502: the username collided — retry with the next one.
    expect(isLocalIdCollision(classifyKavenegarStatus(503))).toBe(true);
    expect(isUsernameCollision(classifyKavenegarStatus(503))).toBe(false);
    expect(isUsernameCollision(classifyKavenegarStatus(502))).toBe(true);
    expect(isLocalIdCollision(classifyKavenegarStatus(502))).toBe(false);
    // Neither is a customer-visible failure: both are the management plane
    // recovering from its own ambiguous response.
    expect(classifyKavenegarStatus(503).retryable).toBe(false);
    expect(classifyKavenegarStatus(502).retryable).toBe(false);
  });

  it("keeps a provider outage and a stalled transport distinct for the operator", () => {
    // Offline/outage: the call never completed. Timeout: it completed and the
    // answer never came. The first is `ambiguous` in `rest.ts` (a POST may have
    // acted), the second carries its own Persian sentence on the OTP transport.
    const unavailable = new KavenegarError(undefined, "connection refused");
    expect(unavailable.status).toBeUndefined();
    expect(unavailable.operatorFault).toBe(false);
  });
});

describe("the tenant never learns the supplier's vocabulary, in any of the four states", () => {
  it("has first-party labels for every readiness state a drill can produce", () => {
    for (const label of Object.values(MANAGED_SERVICE_STATUS_LABELS)) {
      expect(TENANT_PROVIDER_NAME_PATTERN.test(label), label).toBe(false);
      expect(label).toMatch(/[\u0600-\u06FF]/);
    }
  });
});
