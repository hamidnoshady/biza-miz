import { describe, expect, it } from "vitest";
import { usablePaymentAccounts, type ChartAccountRow } from "./payroll-payment-accounts";

const row = (id: string, code: string, name: string, parentId: string | null = null, type: ChartAccountRow["type"] = "asset"): ChartAccountRow => ({
  id,
  code,
  name,
  parentId,
  type,
});

/** A standard small chart: صندوق, بانک, کارت‌خوان, تنخواه, a receivable and the payroll accounts. */
const STANDARD: ChartAccountRow[] = [
  row("a1000", "1000", "دارایی‌ها"),
  row("a1100", "1100", "صندوق", "a1000"),
  row("a1110", "1110", "بانک", "a1000"),
  row("a1120", "1120", "کارت‌خوان (در راه)", "a1000"),
  row("a1130", "1130", "تنخواه", "a1000"),
  row("a1200", "1200", "حساب‌های دریافتنی", "a1000"),
  row("a1300", "1300", "موجودی کالا", "a1000"),
  row("l2300", "2300", "حقوق پرداختنی", null, "liability"),
  row("e5200", "5200", "هزینه حقوق", null, "expense"),
];

describe("usablePaymentAccounts", () => {
  it("offers cash, bank and petty cash — and never card money in transit", () => {
    const offered = usablePaymentAccounts(STANDARD);
    expect(offered.map((a) => a.code)).toEqual(["1100", "1110", "1130"]);
    expect(offered.map((a) => a.role)).toEqual(["cash", "bank", "petty_cash"]);
    expect(offered.find((a) => a.code === "1120")).toBeUndefined();
  });

  it("never offers receivables, inventory, liabilities or expenses", () => {
    const codes = usablePaymentAccounts(STANDARD).map((a) => a.code);
    for (const excluded of ["1200", "1300", "2300", "5200", "1000"]) expect(codes).not.toContain(excluded);
  });

  it("offers a business's own bank accounts opened under بانک, instead of the parent they sit under", () => {
    const chart = [
      ...STANDARD,
      row("a11101", "11101", "بانک ملی", "a1110"),
      row("a11102", "11102", "بانک ملت", "a1110"),
    ];
    const offered = usablePaymentAccounts(chart);
    expect(offered.map((a) => a.code)).toEqual(["1100", "11101", "11102", "1130"]);
    expect(offered.filter((a) => a.role === "bank").map((a) => a.name)).toEqual(["بانک ملی", "بانک ملت"]);
    // 1110 now has children, so it is a heading and not postable.
    expect(offered.find((a) => a.code === "1110")).toBeUndefined();
  });

  it("recognises a custom account in the bank block by its code", () => {
    const offered = usablePaymentAccounts([...STANDARD, row("a1115", "1115", "بانک پاسارگاد", "a1000")]);
    expect(offered.find((a) => a.code === "1115")?.role).toBe("bank");
  });

  it("sorts in chart order — a child code follows its parent, as ORDER BY code does", () => {
    const offered = usablePaymentAccounts([row("x1", "1100", "صندوق"), row("x2", "11101", "بانک ۱", "x3"), row("x3", "1110", "بانک"), row("x4", "1105", "صندوق دوم")]);
    expect(offered.map((a) => a.code)).toEqual(["1100", "1105", "11101"]);
  });

  it("returns nothing for a chart with no cash or bank accounts", () => {
    expect(usablePaymentAccounts([row("l", "2300", "حقوق پرداختنی", null, "liability")])).toEqual([]);
    expect(usablePaymentAccounts([])).toEqual([]);
  });
});
