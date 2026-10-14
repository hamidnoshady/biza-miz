import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeRunCursor,
  decodePayTermCursor,
  encodeRunCursor,
  encodePayTermCursor,
  pageSize,
  parseListPayrollRunsQuery,
  parsePayTermHistoryQuery,
  type RunCursor,
} from "./payroll-history-query";
import { PayrollError } from "./payroll-errors";

const CURSOR: RunCursor = {
  d: "2026-10-07",
  c: "2026-10-07 11:55:24.123456+00",
  i: "0b9f6a52-3c1e-4c2f-9f0a-7a0a1f4f2f11",
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PayrollError);
    expect((error as PayrollError).status).toBe(400);
    return (error as PayrollError).message;
  }
  return undefined;
}

const query = (qs: string) => parseListPayrollRunsQuery(new URLSearchParams(qs));

describe("run cursor", () => {
  it("round-trips the exact sort key of a row, microseconds included", () => {
    expect(decodeRunCursor(encodeRunCursor(CURSOR))).toEqual(CURSOR);
    const withOffset = { ...CURSOR, c: "2026-10-07 15:25:24.1+03:30" };
    expect(decodeRunCursor(encodeRunCursor(withOffset))).toEqual(withOffset);
  });

  it("is opaque base64url, safe to put in a query string", () => {
    expect(encodeRunCursor(CURSOR)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses anything that was not made by encodeRunCursor", () => {
    const forge = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    for (const raw of [
      "",
      "not-base64-json",
      forge(null),
      forge("string"),
      forge({}),
      forge({ ...CURSOR, d: "2026-02-31" }), // not a calendar date
      forge({ ...CURSOR, d: "tomorrow" }),
      forge({ ...CURSOR, c: "now()" }), // SQL smuggled in as a timestamp
      forge({ ...CURSOR, c: "2026-10-07'; DROP TABLE payroll_runs;--" }),
      forge({ ...CURSOR, i: "1; DELETE FROM users" }),
      forge({ ...CURSOR, i: 7 }),
      forge({ d: CURSOR.d, c: CURSOR.c }),
    ]) {
      expect(codeOf(() => decodeRunCursor(raw)), raw).toBe("invalid_cursor");
    }
  });
});

describe("pageSize", () => {
  it("defaults, clamps, and rejects", () => {
    expect(pageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize(null)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSize(1)).toBe(1);
    expect(pageSize(50)).toBe(50);
    expect(pageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
    expect(pageSize(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
    expect(pageSize(1_000_000)).toBe(MAX_PAGE_SIZE);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(() => pageSize(bad)), String(bad)).toBe("invalid_limit");
    }
  });

  it("keeps the bound below a size that would defeat pagination", () => {
    expect(MAX_PAGE_SIZE).toBeLessThanOrEqual(100);
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });
});

describe("parseListPayrollRunsQuery", () => {
  it("reads nothing from an empty query", () => {
    expect(query("")).toEqual({});
  });

  it("treats a cleared filter box (empty value) as no filter", () => {
    expect(query("status=&from=&to=&period=&limit=&cursor=")).toEqual({});
    expect(query("status=all")).toEqual({});
  });

  it("reads every supported filter", () => {
    const cursor = encodeRunCursor(CURSOR);
    expect(
      query(`limit=5&status=paid&from=2026-01-01&to=2026-12-31&period=${encodeURIComponent("مرداد ۱۴۰۴")}&cursor=${cursor}`),
    ).toEqual({
      limit: 5,
      status: "paid",
      from: "2026-01-01",
      to: "2026-12-31",
      period: "مرداد ۱۴۰۴",
      cursor,
    });
  });

  it("accepts each real status", () => {
    for (const status of ["accrued", "paid", "voided"] as const) {
      expect(query(`status=${status}`)).toEqual({ status });
    }
  });

  it("rejects a malformed filter instead of silently returning the unfiltered list", () => {
    expect(codeOf(() => query("status=banana"))).toBe("invalid_run_status");
    expect(codeOf(() => query("status=PAID"))).toBe("invalid_run_status");
    expect(codeOf(() => query("from=banana"))).toBe("invalid_date");
    expect(codeOf(() => query("to=2026-02-31"))).toBe("invalid_date");
    expect(codeOf(() => query("from=2026-10-05&to=2026-10-01"))).toBe("invalid_date");
    expect(codeOf(() => query("limit=abc"))).toBe("invalid_limit");
    expect(codeOf(() => query("limit=-3"))).toBe("invalid_limit");
    expect(codeOf(() => query("limit=1.5"))).toBe("invalid_limit");
    expect(codeOf(() => query("cursor=garbage"))).toBe("invalid_cursor");
  });

  it("passes an oversized limit through for the service to clamp", () => {
    expect(query("limit=100000")).toEqual({ limit: 100000 });
    expect(pageSize(100000)).toBe(MAX_PAGE_SIZE);
  });
});

describe("pay-term history cursor and query", () => {
  const change = { c: CURSOR.c, i: CURSOR.i };

  it("round-trips, and is not interchangeable with a run cursor", () => {
    expect(decodePayTermCursor(encodePayTermCursor(change))).toEqual(change);
    // A run cursor carries a date a pay-term cursor does not need; a pay-term cursor
    // lacks the date a run cursor requires — each reader refuses the other's.
    expect(codeOf(() => decodeRunCursor(encodePayTermCursor(change)))).toBe("invalid_cursor");
    expect(decodePayTermCursor(encodeRunCursor(CURSOR))).toEqual(change);
  });

  it("refuses a forged pay-term cursor", () => {
    const forge = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    for (const raw of ["", "garbage", forge({}), forge({ c: "now()", i: change.i }), forge({ c: change.c, i: "x" }), forge([change])]) {
      expect(codeOf(() => decodePayTermCursor(raw)), raw).toBe("invalid_cursor");
    }
  });

  it("parses limit and cursor, and rejects what a run query would", () => {
    expect(parsePayTermHistoryQuery(new URLSearchParams(""))).toEqual({});
    expect(parsePayTermHistoryQuery(new URLSearchParams(`limit=10&cursor=${encodePayTermCursor(change)}`))).toEqual({
      limit: 10,
      cursor: encodePayTermCursor(change),
    });
    expect(codeOf(() => parsePayTermHistoryQuery(new URLSearchParams("limit=x")))).toBe("invalid_limit");
    expect(codeOf(() => parsePayTermHistoryQuery(new URLSearchParams("cursor=garbage")))).toBe("invalid_cursor");
  });
});
