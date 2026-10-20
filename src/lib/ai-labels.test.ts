import { describe, expect, it } from "vitest";
import {
  labelFor,
  labelled,
  moneyFields,
  tomanText,
  WASTE_REASON_LABELS,
  ORDER_STATUS_LABELS,
  STOCK_MOVEMENT_LABELS,
} from "./ai-labels";

describe("enum labels", () => {
  it("translates every waste reason the database can store", () => {
    // Mirrors the waste_reason enum. A new reason must arrive with its label,
    // or the assistant starts showing raw English to a Persian-speaking owner.
    for (const code of ["spoilage", "prep_error", "customer_return", "staff_meal", "other"]) {
      expect(WASTE_REASON_LABELS[code], code).toBeTruthy();
      expect(/^[a-z_]+$/.test(WASTE_REASON_LABELS[code]), code).toBe(false);
    }
  });

  it("covers the other enums the tools surface", () => {
    for (const code of ["open", "held", "completed", "voided"]) {
      expect(ORDER_STATUS_LABELS[code], code).toBeTruthy();
    }
    for (const code of ["purchase", "sale", "waste", "adjustment"]) {
      expect(STOCK_MOVEMENT_LABELS[code], code).toBeTruthy();
    }
  });

  it("falls back to the raw value rather than inventing a translation", () => {
    expect(labelFor(WASTE_REASON_LABELS, "a_reason_from_the_future")).toBe("a_reason_from_the_future");
    expect(labelFor(WASTE_REASON_LABELS, null)).toBe("نامشخص");
  });

  it("returns the code alongside the label, so a tool result carries both", () => {
    expect(labelled(WASTE_REASON_LABELS, "spoilage")).toEqual({
      code: "spoilage",
      label: "فساد و ماندگی",
    });
  });
});

describe("money", () => {
  it("converts integer Rial to the Toman an owner speaks in", () => {
    expect(moneyFields(1_011_642)).toMatchObject({ rial: 1_011_642, toman: 101_164 });
    expect(moneyFields(0).toman).toBe(0);
  });

  it("rounds rather than truncates, so 5 Rial does not vanish", () => {
    expect(moneyFields(15).toman).toBe(2);
    expect(moneyFields(14).toman).toBe(1);
  });

  it("formats with Persian digits and separators", () => {
    const text = tomanText(1_011_642);
    expect(text).toContain("تومان");
    // Persian digits, not ASCII — this string goes straight into a reply.
    expect(/[0-9]/.test(text.replace("تومان", ""))).toBe(false);
  });

  it("formats large exact Rial strings without IEEE-754 rounding", () => {
    expect(tomanText("9007199254740993")).toBe("۹۰۰٬۷۱۹٬۹۲۵٬۴۷۴٬۰۹۹ تومان");
  });
});
