import { describe, expect, it } from "vitest";
import { SERVICE_STATES, SERVICE_STATE_META } from "./catalog";
import {
  SERVICE_GATE_ERROR,
  SERVICE_GATE_STATUS,
  serviceGateBlocks,
  serviceGateDecision,
} from "./app-gate";

describe("the paid-activation guard for app APIs (issue #1041 §C)", () => {
  it("never blocks a business that has no activation row", () => {
    // The load-bearing case: shipping this feature must not lock an existing
    // customer out of an app they are already using. "No row" is "no opinion".
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(serviceGateDecision({ method, app: "accounting", state: null })).toBeNull();
      expect(serviceGateDecision({ method, app: "accounting", state: undefined })).toBeNull();
    }
  });

  it("blocks a deliberate customer disable, for writes only", () => {
    const blocked = serviceGateDecision({ method: "POST", app: "crm", state: "disabled_retained" });
    expect(blocked).toEqual({
      error: SERVICE_GATE_ERROR,
      status: SERVICE_GATE_STATUS,
      app: "crm",
      state: "disabled_retained",
    });
    // Reads and export must keep working until the retention deadline passes.
    expect(serviceGateDecision({ method: "GET", app: "crm", state: "disabled_retained" })).toBeNull();
  });

  it("does not treat auto-suspension or a legal hold as a customer disable", () => {
    // The issue's rule: low credit, an outage, maintenance and a legal hold
    // must never masquerade as a disable — so they must not lock the app
    // either. Billing already stops the clock and refuses to run up debt.
    for (const state of ["suspended_insufficient_credit", "platform_unavailable", "legal_hold"]) {
      expect(serviceGateBlocks(state), state).toBe(false);
      expect(serviceGateDecision({ method: "POST", app: "growth", state }), state).toBeNull();
    }
  });

  it("blocks every state the catalogue marks as a customer disable, and only those", () => {
    for (const state of SERVICE_STATES) {
      expect(serviceGateBlocks(state), state).toBe(SERVICE_STATE_META[state].customerDisabled);
    }
    expect(SERVICE_STATE_META.active.customerDisabled).toBe(false);
  });

  it("answers 'no app' before anything else, so it can never be a global guard", () => {
    expect(serviceGateDecision({ method: "POST", app: null, state: "disabled_retained" })).toBeNull();
  });
});
