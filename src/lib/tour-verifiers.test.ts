/**
 * Issue #972 phase 2 — the verifier whitelist is a contract between three
 * places that must not drift: the tour validator (`validateTours`), the
 * console's step picker, and the domain endpoint that records the evidence.
 *
 * A key with no writer would make a published tour unfinishable, which is the
 * worst outcome this feature can produce — a member does the work and the tour
 * still says "not done". So the endpoints named here are asserted against the
 * source: each `recordedBy` path must mention its own verifier key.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOUR_VERIFIERS, TOUR_VERIFIER_KEYS, isTourVerifier, tourVerifierDefinition } from "./tour-verifiers";

describe("the verifier whitelist", () => {
  it("keys are dotted lowercase identifiers", () => {
    for (const key of TOUR_VERIFIER_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
    expect(new Set(TOUR_VERIFIER_KEYS).size).toBe(TOUR_VERIFIER_KEYS.length);
    expect(TOUR_VERIFIER_KEYS.length).toBeGreaterThan(0);
  });

  it("every entry explains itself to the member in Persian", () => {
    for (const key of TOUR_VERIFIER_KEYS) {
      const definition = TOUR_VERIFIERS[key];
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.label).toMatch(/[\u0600-\u06FF]/);
      expect(definition.promise).toMatch(/[\u0600-\u06FF]/);
      expect(definition.promise).not.toContain(key);
    }
  });

  it("every entry points at an endpoint that really records that key", () => {
    for (const key of TOUR_VERIFIER_KEYS) {
      const { recordedBy } = TOUR_VERIFIERS[key];
      const route = recordedBy.replace(/^POST /, "").replace(/^\/api\//, "src/app/api/") + "/route.ts";
      const source = readFileSync(route, "utf8");
      expect(source, `${recordedBy} must record ${key}`).toContain("recordTourEvidence");
      expect(source, `${recordedBy} must record ${key}`).toContain(`verifier: "${key}"`);
    }
  });

  it("recognises only registered keys", () => {
    expect(isTourVerifier("product.created")).toBe(true);
    expect(isTourVerifier("product.deleted")).toBe(false);
    expect(isTourVerifier(undefined)).toBe(false);
    expect(tourVerifierDefinition("party.created")?.label).toContain("مشتری");
    expect(tourVerifierDefinition("nope.nope")).toBeNull();
  });
});
