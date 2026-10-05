import { describe, expect, it } from "vitest";
import {
  validateItemKindParent,
  validateSerialNumber,
  validateSerialStatusTransition,
  validateVariantAttributes,
  validateWeightItemStatusTransition,
} from "./items";

describe("validateItemKindParent", () => {
  it("requires a parent for a variant_child", () => {
    expect(validateItemKindParent("variant_child", null)).not.toBeNull();
    expect(validateItemKindParent("variant_child", "parent-id")).toBeNull();
  });

  it("rejects a parent on a non-variant_child item", () => {
    expect(validateItemKindParent("simple", "parent-id")).not.toBeNull();
    expect(validateItemKindParent("variant_parent", "parent-id")).not.toBeNull();
  });

  it("accepts a simple or variant_parent item with no parent", () => {
    expect(validateItemKindParent("simple", null)).toBeNull();
    expect(validateItemKindParent("variant_parent", null)).toBeNull();
  });
});

describe("validateVariantAttributes", () => {
  it("requires at least one attribute", () => {
    expect(validateVariantAttributes([])).toHaveLength(1);
  });

  it("rejects a blank name or value", () => {
    expect(validateVariantAttributes([{ name: "  ", value: "قرمز" }]).length).toBeGreaterThan(0);
    expect(validateVariantAttributes([{ name: "رنگ", value: "  " }]).length).toBeGreaterThan(0);
  });

  it("rejects a duplicate attribute name", () => {
    const errors = validateVariantAttributes([
      { name: "رنگ", value: "قرمز" },
      { name: "رنگ", value: "آبی" },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a well-formed attribute set", () => {
    expect(
      validateVariantAttributes([
        { name: "رنگ", value: "قرمز" },
        { name: "سایز", value: "M" },
      ]),
    ).toHaveLength(0);
  });
});

describe("validateSerialNumber", () => {
  it("rejects blank", () => {
    expect(validateSerialNumber("")).not.toBeNull();
    expect(validateSerialNumber("   ")).not.toBeNull();
  });

  it("accepts non-blank", () => {
    expect(validateSerialNumber("SN-001")).toBeNull();
  });
});

describe("validateSerialStatusTransition", () => {
  it("refuses to move a sold unit to any other status", () => {
    expect(validateSerialStatusTransition("sold", "in_stock")).not.toBeNull();
    expect(validateSerialStatusTransition("sold", "reserved")).not.toBeNull();
  });

  it("allows sold -> sold (no-op) and every other transition", () => {
    expect(validateSerialStatusTransition("sold", "sold")).toBeNull();
    expect(validateSerialStatusTransition("in_stock", "reserved")).toBeNull();
    expect(validateSerialStatusTransition("reserved", "sold")).toBeNull();
    expect(validateSerialStatusTransition("in_stock", "in_repair")).toBeNull();
  });

  it("treats supplier_returned as terminal (issue #795)", () => {
    expect(validateSerialStatusTransition("supplier_returned", "in_stock")).not.toBeNull();
    expect(validateSerialStatusTransition("supplier_returned", "sold")).not.toBeNull();
    expect(validateSerialStatusTransition("supplier_returned", "supplier_returned")).toBeNull();
  });

  it("treats written_off as terminal and only enterable by the return workflow (issue #795)", () => {
    expect(validateSerialStatusTransition("written_off", "in_stock")).not.toBeNull();
    expect(validateSerialStatusTransition("written_off", "written_off")).toBeNull();
    expect(validateSerialStatusTransition("in_stock", "written_off")).not.toBeNull();
    expect(validateSerialStatusTransition("in_repair", "written_off")).not.toBeNull();
  });

  it("only an in-stock unit can go back to the supplier", () => {
    expect(validateSerialStatusTransition("in_stock", "supplier_returned")).toBeNull();
    expect(validateSerialStatusTransition("reserved", "supplier_returned")).not.toBeNull();
    expect(validateSerialStatusTransition("in_repair", "supplier_returned")).not.toBeNull();
    expect(validateSerialStatusTransition("sold", "supplier_returned")).not.toBeNull();
  });
});

describe("validateWeightItemStatusTransition", () => {
  it("refuses to move a sold piece to any other status", () => {
    expect(validateWeightItemStatusTransition("sold", "in_stock")).not.toBeNull();
    expect(validateWeightItemStatusTransition("sold", "reserved")).not.toBeNull();
  });

  it("allows sold -> sold (no-op) and every other transition", () => {
    expect(validateWeightItemStatusTransition("sold", "sold")).toBeNull();
    expect(validateWeightItemStatusTransition("in_stock", "reserved")).toBeNull();
    expect(validateWeightItemStatusTransition("reserved", "sold")).toBeNull();
  });
});
