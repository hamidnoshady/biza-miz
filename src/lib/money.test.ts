import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatMoneyText,
  formatRial,
  formatRialText,
  formatToman,
  formatTomanText,
  moneyFromInput,
  moneyInputProblemMessage,
  moneyToInput,
  moneyToInputText,
  parseMoneyToRial,
  parseToRial,
  isWholeRial,
  parseToRialText,
  rialToToman,
  sumRialText,
  tomanToRial,
  tryParseToRial,
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

  it("converts input text per unit without going through Number", () => {
    expect(moneyToInputText("1250000", "toman")).toBe("125000");
    expect(moneyToInputText("1250000", "rial")).toBe("1250000");
    // Beyond 2^53 a Number would round these; the text stays exact both ways.
    expect(moneyToInputText("900719925474099312340", "toman")).toBe("90071992547409931234");
    expect(moneyToInputText("900719925474099312345", "rial")).toBe("900719925474099312345");
    expect(parseToRialText(moneyToInputText("900719925474099312340", "toman"), "toman")).toBe("900719925474099312340");
    // Leading zeros are normalised, a bare "0" survives.
    expect(moneyToInputText("0", "toman")).toBe("0");
    expect(moneyToInputText("0012", "rial")).toBe("12");
    expect(() => moneyToInputText("-5", "rial")).toThrow();
    expect(() => moneyToInputText("1.5", "rial")).toThrow();
    expect(() => moneyToInputText("", "rial")).toThrow();
  });
});

describe("sumRialText", () => {
  it("sums integer text exactly, past Number.MAX_SAFE_INTEGER", () => {
    expect(sumRialText([])).toBe("0");
    expect(sumRialText(["30000000", "20000000"])).toBe("50000000");
    const nearMax = "9007199254740991";
    expect(sumRialText([nearMax, nearMax, nearMax])).toBe("27021597764222973");
    // The naive Number sum rounds — the bug the exact path avoids.
    expect(String(Number(nearMax) * 3)).not.toBe("27021597764222973");
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

describe("exact signed export text", () => {
  it("preserves the final Rial digit and amounts beyond Number's range", async () => {
    const { moneyToExportText } = await import("./money");
    expect(moneyToExportText("90071992547409931", "toman")).toBe("9007199254740993.1");
    expect(moneyToExportText("-21", "toman")).toBe("-2.1");
    expect(moneyToExportText("-1", "toman")).toBe("-0.1");
    expect(moneyToExportText("-20", "toman")).toBe("-2");
    expect(moneyToExportText("-21", "rial")).toBe("-21");
    expect(moneyToExportText("-0", "toman")).toBe("0");
    expect(() => moneyToExportText("1.5", "rial")).toThrow();
  });
});

/*
 * Issue #911 — the user-reported crash: clearing the price box before typing
 * a replacement is ordinary editing, and `parseToRial` throws for every
 * intermediate state of it («», «-», «.»). A money field parses through this
 * helper instead, which reports the state rather than raising out of a
 * render.
 */
describe("tryParseToRial — a money field mid-edit", () => {
  it("reports an emptied or half-typed field instead of throwing", () => {
    // The exact field states a person produces on the way from one price to
    // the next; each of these threw before.
    expect(tryParseToRial("")).toEqual({ ok: false, problem: "empty" });
    expect(tryParseToRial("   ")).toEqual({ ok: false, problem: "empty" });
    expect(tryParseToRial("٬")).toEqual({ ok: false, problem: "empty" });
    expect(tryParseToRial("-")).toEqual({ ok: false, problem: "incomplete" });
    expect(tryParseToRial(".")).toEqual({ ok: false, problem: "incomplete" });
    expect(tryParseToRial("-.")).toEqual({ ok: false, problem: "incomplete" });
    expect(() => parseToRial("")).toThrow();
  });

  it("accepts zero — an item can be free, or priced later", () => {
    expect(tryParseToRial("0")).toEqual({ ok: true, rial: 0 });
    expect(tryParseToRial("۰")).toEqual({ ok: true, rial: 0 });
    expect(tryParseToRial("000")).toEqual({ ok: true, rial: 0 });
    expect(tryParseToRial("0", "rial")).toEqual({ ok: true, rial: 0 });
  });

  it("parses complete amounts in either display unit", () => {
    expect(tryParseToRial("۱۲۵٬۰۰۰")).toEqual({ ok: true, rial: 1_250_000 });
    expect(tryParseToRial("125000", "toman")).toEqual({ ok: true, rial: 1_250_000 });
    expect(tryParseToRial("1,250,000", "toman")).toEqual({ ok: true, rial: 12_500_000 });
    expect(tryParseToRial("۱٬۲۵۰٬۰۰۰", "rial")).toEqual({ ok: true, rial: 1_250_000 });
  });

  it("names negative, fractional, non-numeric and unsafe input as problems", () => {
    expect(tryParseToRial("-500")).toEqual({ ok: false, problem: "negative" });
    expect(tryParseToRial("-۵۰۰", "rial")).toEqual({ ok: false, problem: "negative" });
    expect(tryParseToRial("abc")).toEqual({ ok: false, problem: "invalid" });
    expect(tryParseToRial("12a")).toEqual({ ok: false, problem: "invalid" });
    // A fraction is fine when it lands on a whole Rial, and refused when it
    // does not — the same rule isWholeRial applies everywhere else.
    expect(tryParseToRial("12.5")).toEqual({ ok: true, rial: 125 });
    expect(tryParseToRial("12.53")).toEqual({ ok: false, problem: "fractional" });
    expect(tryParseToRial("12.5", "rial")).toEqual({ ok: false, problem: "fractional" });
    expect(tryParseToRial("900719925474099300")).toEqual({ ok: false, problem: "unsafe" });
    expect(tryParseToRial("9".repeat(80))).toEqual({ ok: false, problem: "unsafe" });
  });

  it("gives every problem a Persian sentence to show inline", () => {
    const problems = ["empty", "incomplete", "invalid", "negative", "fractional", "unsafe"] as const;
    for (const problem of problems) {
      expect(moneyInputProblemMessage(problem)).toMatch(/[\u0600-\u06FF]/);
      expect(moneyInputProblemMessage(problem, "rial")).toMatch(/[\u0600-\u06FF]/);
    }
    expect(moneyInputProblemMessage("fractional", "rial")).toContain("ریال");
  });
});
