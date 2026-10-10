import { describe, expect, it } from "vitest";
import { AP_SOURCE_ATTRIBUTION_CONTRACT, apAttributionStatus } from "./ap-attribution";

describe("A/P source attribution contract", () => {
  it("enumerates every A/P-capable journal source and classifies its ownership", () => {
    const expectedSources = [
      "purchase",
      "supplier_return",
      "item_purchase",
      "item_supplier_return",
      "expense",
      "ap_payment",
      "ap_payment_reversal",
      "cheque",
      "installment_interest",
      "manual",
      "manual_adjustment",
      "opening",
      "holoo_import",
    ].sort();
    expect(Object.keys(AP_SOURCE_ATTRIBUTION_CONTRACT).sort()).toEqual(expectedSources);

    for (const [sourceType, contract] of Object.entries(AP_SOURCE_ATTRIBUTION_CONTRACT)) {
      expect(contract.path, `${sourceType} must document how it is attributed`).not.toBe("");
      const expectedStatus = contract.mode === "intentional_unknown"
        ? "intentional_unknown"
        : contract.mode === "conditional"
          ? "conditional_missing"
          : "automatic_missing";
      expect(apAttributionStatus(sourceType, null), sourceType).toBe(expectedStatus);
      expect(apAttributionStatus(sourceType, "supplier-alias-id"), sourceType).toBe("attributed");
    }
  });

  it("keeps retail return attribution conditional on A/P settlement in the shared SQL", () => {
    expect(AP_SOURCE_ATTRIBUTION_CONTRACT.item_purchase.path).toContain("item_purchases.supplier_id");
    expect(AP_SOURCE_ATTRIBUTION_CONTRACT.item_supplier_return.path).toContain("accounts_payable");
    expect(AP_SOURCE_ATTRIBUTION_CONTRACT.supplier_return.path).toContain("accounts_payable");
  });

  it("classifies any future unregistered automatic source as unclassified, not silently unknown", () => {
    expect(apAttributionStatus("new_automatic_source", null)).toBe("unclassified");
    expect(apAttributionStatus(null, null)).toBe("unclassified");
  });
});

it("generates broad and indexed named reads from exactly the registered attributed sources", async () => {
  const { apSupplierAttributionSql, AP_SUPPLIER_ATTRIBUTION_SQL } = await import("./ap-attribution");
  const named = apSupplierAttributionSql("$3::uuid");
  expect(AP_SUPPLIER_ATTRIBUTION_SQL).toBe(apSupplierAttributionSql());
  for (const [type, contract] of Object.entries(AP_SOURCE_ATTRIBUTION_CONTRACT)) {
    const marker = `'${type}'::text AS source_type`;
    expect(named.includes(marker), type).toBe(contract.mode !== "intentional_unknown");
    expect(AP_SUPPLIER_ATTRIBUTION_SQL.includes(marker), type).toBe(contract.mode !== "intentional_unknown");
  }
  expect(named.match(/ = \$3::uuid/g)).toHaveLength(9);
  expect(AP_SUPPLIER_ATTRIBUTION_SQL).not.toContain("$3");
});
