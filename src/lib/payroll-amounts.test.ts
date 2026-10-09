import { describe, expect, it } from "vitest";
import { MAX_RIAL } from "./inventory-exact";
import { PayrollError } from "./payroll-errors";
import { parseRialInput } from "./payroll-amounts";

function code(value: unknown): string {
  try {
    parseRialInput(value);
    return "accepted";
  } catch (err) {
    return err instanceof PayrollError ? err.message : `unexpected: ${String(err)}`;
  }
}

describe("parseRialInput", () => {
  it("reads a safe-integer number and integer text as the same exact bigint", () => {
    expect(parseRialInput(0)).toBe(0n);
    expect(parseRialInput(30_000_000)).toBe(30_000_000n);
    expect(parseRialInput(Number.MAX_SAFE_INTEGER)).toBe(9_007_199_254_740_991n);
    expect(parseRialInput("30000000")).toBe(30_000_000n);
    expect(parseRialInput("0")).toBe(0n);
  });

  it("is exact for text past 2^53, where a Number would round", () => {
    expect(parseRialInput("9007199254740993")).toBe(9_007_199_254_740_993n);
    expect(parseRialInput(MAX_RIAL.toString())).toBe(MAX_RIAL);
  });

  it("refuses everything that is not a non-negative whole amount as invalid_amount", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, Number.MAX_SAFE_INTEGER + 1]) {
      expect(code(value), String(value)).toBe("invalid_amount");
    }
    for (const value of ["", " ", "-5", "1.5", "1e3", "abc", "0x10", "12 ", "٣٠٠"]) {
      expect(code(value), JSON.stringify(value)).toBe("invalid_amount");
    }
    for (const value of [true, false, null, undefined, [], [5], {}, { amount: 5 }, 10n]) {
      expect(code(value), JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))).toBe("invalid_amount");
    }
  });

  it("refuses an amount the ledger column cannot hold as amount_out_of_range, not as a database error", () => {
    expect(code((MAX_RIAL + 1n).toString())).toBe("amount_out_of_range");
    expect(code("99999999999999999999999")).toBe("amount_out_of_range");
  });
});
