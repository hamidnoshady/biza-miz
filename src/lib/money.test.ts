import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatMoneyText,
  formatRial,
  formatRialText,
  formatToman,
  formatTomanText,
  moneyFromInput,
  moneyToInput,
  parseMoneyToRial,
  parseToRial,
  isWholeRial,
  parseToRialText,
  rialToToman,
  tomanToRial,
} from "./money";

describe("money", () => {
  it("converts between rial and toman", () => {
    expect(rialToToman(1_250_000)).toBe(125_000);
    expect(tomanToRial(125_000)).toBe(1_250_000);
  });

  it("formats integer rial as Toman for display", () => {
    expect(formatToman(1_250_000)).toBe("۱۲۵٬۰۰۰ تومان");
    expect(formatToman(1_250_000, { withUnit: false })).toBe("۱۲۵٬۰۰۰");
    expect(formatToman(0)).toBe("۰ تومان");
  });

  it("formats integer rial as Rial for display", () => {
    expect(formatRial(1_250_000)).toBe("۱٬۲۵۰٬۰۰۰ ریال");
  });

  it("parses user input (Persian digits, separators) to integer rial", () => {
    expect(parseToRial("۱۲۵٬۰۰۰")).toBe(1_250_000); // toman by default
    expect(parseToRial("125000", "toman")).toBe(1_250_000);
    expect(parseToRial("۱٬۲۵۰٬۰۰۰", "rial")).toBe(1_250_000);
    expect(() => parseToRial("abc")).toThrow();
  });
});

describe("string money beyond JavaScript safe integers", () => {
  it("parses and formats without converting through Number", () => {
    expect(parseToRialText("900719925474099312345", "rial")).toBe("900719925474099312345");
    expect(parseToRialText("90071992547409931234", "toman")).toBe("900719925474099312340");
    expect(formatTomanText("900719925474099312340", { withUnit: false })).toHaveLength(26);
  });

  it("formats string rial as Rial without converting through Number", () => {
    expect(formatRialText("900719925474099312345")).toBe("۹۰۰٬۷۱۹٬۹۲۵٬۴۷۴٬۰۹۹٬۳۱۲٬۳۴۵ ریال");
    expect(formatRialText("1250000", { withUnit: false })).toBe("۱٬۲۵۰٬۰۰۰");
  });
});

describe("business display-unit dispatch", () => {
  it("formats and parses in toman or rial from one entry point", () => {
    expect(formatMoney(1_250_000, "toman")).toBe("۱۲۵٬۰۰۰ تومان");
    expect(formatMoney(1_250_000, "rial")).toBe("۱٬۲۵۰٬۰۰۰ ریال");
    expect(formatMoneyText("1250000", "rial")).toBe("۱٬۲۵۰٬۰۰۰ ریال");
    expect(parseMoneyToRial("125000", "toman")).toBe(1_250_000);
    expect(parseMoneyToRial("1250000", "rial")).toBe(1_250_000);
  });

  it("converts input values per unit", () => {
    expect(moneyToInput(1_250_000, "toman")).toBe(125_000);
    expect(moneyToInput(1_250_000, "rial")).toBe(1_250_000);
    expect(moneyFromInput(125_000, "toman")).toBe(1_250_000);
    expect(moneyFromInput(1_250_000, "rial")).toBe(1_250_000);
  });
});

/*
 * The rule every money-accepting channel shares (the expense API, the expense
 * form, the data-transfer engine's `money` field with `validation.integral`).
 * It is asserted here rather than three times out there, because the whole point
 * is that there is one.
 */
describe("isWholeRial", () => {
  it("accepts integers and the float residue of a Toman conversion", () => {
    expect(isWholeRial(1_250_000)).toBe(true);
    expect(isWholeRial(1507.0000000000002)).toBe(true); // ۱۵/۷ تومان × ۱۰
    expect(isWholeRial(0)).toBe(true);                   // whole — sign and range are the caller's business
    expect(isWholeRial(-3_000)).toBe(true);
  });

  it("refuses a real fraction, and everything that is not a finite number", () => {
    expect(isWholeRial(1507.5)).toBe(false);      // ۱۵۰/۷۵ تومان: no such thing in a Rial ledger
    expect(isWholeRial(1507.01)).toBe(false);     // beyond the tolerance
    expect(isWholeRial(NaN)).toBe(false);
    expect(isWholeRial(Infinity)).toBe(false);
    expect(isWholeRial(2 ** 53)).toBe(false);     // whole, but no longer safe to hand to a JS number
  });
});
