import { describe, expect, it } from "vitest";
import { API_FEATURE_PREFIXES, PAGE_FEATURE_PREFIXES } from "./features";
import { FEATURE_RELATIONS, assessRelation, relationForGateKey } from "./feature-catalogue";
import { BILLING_DECLARATIONS } from "./billing/catalog/declarations";

describe("FEATURE_RELATIONS", () => {
  it("names the six look-alike pairs of the live catalogue, each key once", () => {
    expect(FEATURE_RELATIONS.map((r) => [r.gateKey, r.commercialKey])).toEqual([
      ["inventory", "accounting.inventory"],
      ["ledger", "accounting.ledger"],
      ["reporting", "accounting.reports"],
      ["api_platform", "integrations.api"],
      ["ai_assistant", "ai"],
      ["integrations", "website_service"],
    ]);
    const keys = FEATURE_RELATIONS.flatMap((r) => [r.gateKey, r.commercialKey]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("explains every pair in Persian so the console never shows a bare duplicate", () => {
    for (const relation of FEATURE_RELATIONS) {
      expect(relation.explanation).toMatch(/[؀-ۿ]/);
      expect(relation.explanation).toContain(relation.gateKey);
      expect(relation.explanation).toContain(relation.commercialKey);
    }
  });

  it("keeps the gate key on the side the request gate actually refuses on", () => {
    const gated = new Set<string>([
      ...API_FEATURE_PREFIXES.map(([, flag]) => flag),
      ...PAGE_FEATURE_PREFIXES.map(([, flag]) => flag),
      // Gated by name at the call site rather than by a path prefix.
      "api_platform",
    ]);
    for (const relation of FEATURE_RELATIONS) {
      expect(gated.has(relation.gateKey), `${relation.gateKey} gates nothing`).toBe(true);
    }
  });

  it("never lets a path prefix gate on a commercial-side key", () => {
    const commercial = new Set(FEATURE_RELATIONS.map((r) => r.commercialKey));
    for (const [prefix, flag] of [...API_FEATURE_PREFIXES, ...PAGE_FEATURE_PREFIXES]) {
      expect(commercial.has(flag), `${prefix} gates on ${flag}`).toBe(false);
    }
  });

  it("looks a pair up by its gate key", () => {
    expect(relationForGateKey("ledger")?.commercialKey).toBe("accounting.ledger");
    expect(relationForGateKey("nope")).toBeNull();
  });

  it("agrees with the capability declarations on the fixed capabilities it pairs", () => {
    const declared = new Set(BILLING_DECLARATIONS.map((d) => d.capabilityKey));
    for (const key of ["accounting.inventory", "accounting.ledger", "accounting.reports", "integrations.api"]) {
      expect(declared.has(key), `${key} is not a declared capability`).toBe(true);
    }
  });
});

describe("assessRelation", () => {
  it("is consistent when both sides agree", () => {
    expect(assessRelation({ gateEnabled: true, commercialPriced: true, commercialEntitled: true })).toBe("consistent");
    expect(assessRelation({ gateEnabled: false, commercialPriced: false, commercialEntitled: false })).toBe("consistent");
    expect(assessRelation({ gateEnabled: false, commercialPriced: true, commercialEntitled: false })).toBe("consistent");
  });

  it("flags access granted outside the plan — the ai_assistant / integrations override shape", () => {
    expect(assessRelation({ gateEnabled: true, commercialPriced: false, commercialEntitled: false })).toBe(
      "gate_on_without_plan_row",
    );
  });

  it("flags a plan that includes a capability the gate keeps off — the api_platform shape", () => {
    expect(assessRelation({ gateEnabled: false, commercialPriced: true, commercialEntitled: true })).toBe(
      "plan_row_without_gate",
    );
  });

  it("flags a gate that is on while the priced counterpart is not entitled", () => {
    expect(assessRelation({ gateEnabled: true, commercialPriced: true, commercialEntitled: false })).toBe(
      "gate_on_commercial_denied",
    );
  });
});
