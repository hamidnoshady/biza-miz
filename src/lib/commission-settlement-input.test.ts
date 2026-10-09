import { describe, expect, it } from "vitest";
import { CommissionSettlementError } from "./commission-settlement-errors";
import {
  MAX_SETTLEMENT_AMOUNT,
  parseCreateRunBody,
  parseEmployeeParam,
  parseIdempotencyKey,
  parseNoteBody,
  parsePayoutBody,
  parseRialAmount,
  parseRunLinesQuery,
  parseRunListQuery,
  parseVoidBody,
} from "./commission-settlement-input";

const EMP = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const LOC = "3b4c5d6e-7f8a-4b9c-8d0e-2f3a4b5c6d7e";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof CommissionSettlementError) return err.message;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("money in a request", () => {
  it("accepts a positive integer as a number or as digits", () => {
    expect(parseRialAmount(1_500_000)).toBe(1_500_000n);
    expect(parseRialAmount("1500000")).toBe(1_500_000n);
    expect(parseRialAmount(" 42 ")).toBe(42n);
  });

  it("refuses zero, negatives, decimals, text, and anything past the bound", () => {
    for (const bad of [0, -1, 1.5, "0", "-5", "1.5", "12,000", "abc", null, undefined, true, [1]]) {
      expect(codeOf(() => parseRialAmount(bad))).toBe("invalid_amount");
    }
    expect(codeOf(() => parseRialAmount(MAX_SETTLEMENT_AMOUNT.toString() + "0"))).toBe("invalid_amount");
    expect(parseRialAmount(MAX_SETTLEMENT_AMOUNT.toString())).toBe(MAX_SETTLEMENT_AMOUNT);
  });
});

describe("creating a run", () => {
  it("reads a period, optional branch, members and title", () => {
    expect(parseCreateRunBody({ periodFrom: "2026-10-01", periodTo: "2026-10-09", locationId: LOC, employeeIds: [EMP], title: " مهر " })).toEqual({
      periodFrom: "2026-10-01",
      periodTo: "2026-10-09",
      locationId: LOC,
      employeeIds: [EMP],
      title: "مهر",
    });
  });

  it("defaults the optional fields to none", () => {
    expect(parseCreateRunBody({ periodFrom: "2026-10-01", periodTo: "2026-10-01" })).toEqual({
      periodFrom: "2026-10-01",
      periodTo: "2026-10-01",
      locationId: null,
      employeeIds: [],
      title: null,
    });
  });

  it("refuses a date that does not exist, a range that runs backwards, and a body that is not an object", () => {
    expect(codeOf(() => parseCreateRunBody({ periodFrom: "2026-02-31", periodTo: "2026-03-01" }))).toBe("invalid_period");
    expect(codeOf(() => parseCreateRunBody({ periodFrom: "2026-10-09", periodTo: "2026-10-01" }))).toBe("invalid_period_range");
    expect(codeOf(() => parseCreateRunBody(["x"]))).toBe("bad_request");
    expect(codeOf(() => parseCreateRunBody(null))).toBe("bad_request");
  });

  it("refuses a member listed twice, a malformed member, and a title past its limit", () => {
    expect(codeOf(() => parseCreateRunBody({ periodFrom: "2026-10-01", periodTo: "2026-10-01", employeeIds: [EMP, EMP] }))).toBe(
      "invalid_employee_ids",
    );
    expect(codeOf(() => parseCreateRunBody({ periodFrom: "2026-10-01", periodTo: "2026-10-01", employeeIds: ["x"] }))).toBe(
      "invalid_employee_ids",
    );
    expect(codeOf(() => parseCreateRunBody({ periodFrom: "2026-10-01", periodTo: "2026-10-01", title: "x".repeat(121) }))).toBe(
      "invalid_title",
    );
  });
});

describe("paying out", () => {
  it("reads allocations as integer Rial, and «all owed» as a flag the server resolves", () => {
    const parsed = parsePayoutBody({
      allocations: [
        { employeeId: EMP, amount: "1500000" },
        { employeeId: LOC, all: true },
      ],
      method: "bank",
      paidDate: "2026-10-09",
      memo: "حقوق مهر",
    });
    expect(parsed).toEqual({
      allocations: [
        { employeeId: EMP, amount: 1_500_000n },
        { employeeId: LOC, amount: null },
      ],
      paymentAccountId: null,
      method: "bank",
      paidDate: "2026-10-09",
      memo: "حقوق مهر",
    });
  });

  it("requires somewhere the money leaves: an account or a method, never a silent default", () => {
    expect(codeOf(() => parsePayoutBody({ allocations: [{ employeeId: EMP, amount: "1" }] }))).toBe("invalid_method");
    expect(codeOf(() => parsePayoutBody({ allocations: [{ employeeId: EMP, amount: "1" }], method: "crypto" }))).toBe("invalid_method");
  });

  it("accepts a named account instead of a method", () => {
    const parsed = parsePayoutBody({ allocations: [{ employeeId: EMP, amount: "1" }], paymentAccountId: LOC });
    expect(parsed.paymentAccountId).toBe(LOC);
    expect(parsed.method).toBeNull();
  });

  it("refuses an empty or oversized allocation list, and a payment date that is not a date", () => {
    expect(codeOf(() => parsePayoutBody({ allocations: [], method: "cash" }))).toBe("no_allocations");
    expect(codeOf(() => parsePayoutBody({ allocations: "x", method: "cash" }))).toBe("no_allocations");
    expect(codeOf(() => parsePayoutBody({ allocations: [{ employeeId: "bad", amount: "1" }], method: "cash" }))).toBe("invalid_allocations");
    expect(codeOf(() => parsePayoutBody({ allocations: [{ employeeId: EMP, amount: "1" }], method: "cash", paidDate: "2026-13-01" }))).toBe(
      "invalid_paid_date",
    );
  });
});

describe("idempotency keys", () => {
  it("takes the header, or the body when there is no header", () => {
    expect(parseIdempotencyKey("payout-key-0001", undefined)).toBe("payout-key-0001");
    expect(parseIdempotencyKey(null, "payout-key-0002")).toBe("payout-key-0002");
    expect(parseIdempotencyKey(null, undefined)).toBeNull();
    expect(parseIdempotencyKey("", "")).toBeNull();
  });

  it("refuses two keys that disagree, a key with a space, and one too short", () => {
    expect(codeOf(() => parseIdempotencyKey("payout-key-0001", "payout-key-0002"))).toBe("idempotency_key_invalid");
    expect(codeOf(() => parseIdempotencyKey("has space in it", null))).toBe("idempotency_key_invalid");
    expect(codeOf(() => parseIdempotencyKey("short", null))).toBe("idempotency_key_invalid");
    expect(codeOf(() => parseIdempotencyKey(null, 12345))).toBe("idempotency_key_invalid");
  });
});

describe("reasons and notes", () => {
  it("requires a reason to void, and keeps an optional note otherwise", () => {
    expect(codeOf(() => parseVoidBody({}))).toBe("void_reason_required");
    expect(codeOf(() => parseVoidBody({ note: "   " }))).toBe("void_reason_required");
    expect(parseVoidBody({ note: "دوره تکراری" })).toBe("دوره تکراری");
    expect(parseNoteBody(undefined)).toBeNull();
    expect(parseNoteBody({ note: "" })).toBeNull();
  });

  it("refuses a note past the limit", () => {
    expect(codeOf(() => parseNoteBody({ note: "x".repeat(501) }))).toBe("note_too_long");
  });
});

describe("lists and exports", () => {
  it("reads the list filter, paging and export format, with safe defaults", () => {
    expect(parseRunListQuery(new URLSearchParams())).toEqual({ status: null, limit: 50, offset: 0, format: "json" });
    expect(parseRunListQuery(new URLSearchParams("status=paid&limit=10&offset=20&format=csv"))).toEqual({
      status: "paid",
      limit: 10,
      offset: 20,
      format: "csv",
    });
  });

  it("refuses an unknown status, a limit out of range, and an unknown format", () => {
    expect(codeOf(() => parseRunListQuery(new URLSearchParams("status=pending")))).toBe("invalid_run_status");
    expect(codeOf(() => parseRunListQuery(new URLSearchParams("limit=0")))).toBe("invalid_limit");
    expect(codeOf(() => parseRunListQuery(new URLSearchParams("limit=500")))).toBe("invalid_limit");
    expect(codeOf(() => parseRunListQuery(new URLSearchParams("offset=-1")))).toBe("invalid_offset");
    expect(codeOf(() => parseRunListQuery(new URLSearchParams("format=xlsx")))).toBe("invalid_format");
  });

  it("reads the line filter by member, and the statement's member, and refuses a malformed id", () => {
    expect(parseRunLinesQuery(new URLSearchParams(`employeeId=${EMP}&limit=100`))).toMatchObject({ employeeId: EMP, limit: 100 });
    expect(codeOf(() => parseRunLinesQuery(new URLSearchParams("employeeId=nope")))).toBe("invalid_employee");
    expect(parseEmployeeParam(new URLSearchParams(`employeeId=${EMP}`))).toBe(EMP);
    expect(codeOf(() => parseEmployeeParam(new URLSearchParams("")))).toBe("employee_required");
  });
});
