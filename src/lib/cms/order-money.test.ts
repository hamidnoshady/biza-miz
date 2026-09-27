import { describe, expect, it } from "vitest";
import { cmsMinorToRial } from "./order-money";

describe("cmsMinorToRial", () => {
  it("converts Toman minor units to Rial", () => {
    expect(cmsMinorToRial(1000, "IRT")).toBe(10000n);
  });

  it("keeps Rial minor units as Rial", () => {
    expect(cmsMinorToRial(50000, "IRR")).toBe(50000n);
  });

  it("refuses unsupported currencies", () => {
    expect(() => cmsMinorToRial(10, "USD")).toThrow("unsupported_currency");
  });
});
