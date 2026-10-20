import { describe, expect, it } from "vitest";
import {
  ORDER_HISTORY_MAX_PAGE,
  ORDER_HISTORY_MAX_PAGE_SIZE,
  ORDER_HISTORY_PAGE_SIZE,
  parseOrderHistoryFilters,
} from "./order-history";

const TABLE_ID = "11111111-1111-4111-8111-111111111111";
const SHIFT_ID = "22222222-2222-4222-8222-222222222222";

function parse(query = "") {
  return parseOrderHistoryFilters(new URLSearchParams(query));
}

describe("order history filters", () => {
  it("defaults to a bounded first page and trims the search text", () => {
    expect(parse("q=%20%20%DB%B4%DB%B2%20%20")).toEqual({
      ok: true,
      filters: {
        page: 1,
        pageSize: ORDER_HISTORY_PAGE_SIZE,
        search: "۴۲",
        status: null,
        type: null,
        tableId: null,
        shiftId: null,
        from: null,
        to: null,
      },
    });
  });

  it("accepts supported filters and clamps large pagination values", () => {
    const result = parse(
      `page=${ORDER_HISTORY_MAX_PAGE + 10}&pageSize=${ORDER_HISTORY_MAX_PAGE_SIZE + 10}` +
        "&status=held&type=dine_in" +
        `&tableId=${TABLE_ID}&shiftId=${SHIFT_ID}&from=2026-01-01&to=2026-01-31`,
    );
    expect(result).toEqual({
      ok: true,
      filters: {
        page: ORDER_HISTORY_MAX_PAGE,
        pageSize: ORDER_HISTORY_MAX_PAGE_SIZE,
        search: "",
        status: "held",
        type: "dine_in",
        tableId: TABLE_ID,
        shiftId: SHIFT_ID,
        from: "2026-01-01",
        to: "2026-01-31",
      },
    });
  });

  it.each([
    ["page=0", "invalid_pagination"],
    ["page=-1", "invalid_pagination"],
    ["page=1.5", "invalid_pagination"],
    ["pageSize=0", "invalid_pagination"],
    ["page=1&page=2", "invalid_history_filter"],
    ["unexpected=value", "invalid_history_filter"],
    ["status=unknown", "invalid_status"],
    ["type=retail", "invalid_order_type"],
    ["tableId=not-a-uuid", "invalid_table_id"],
    ["shiftId=not-a-uuid", "invalid_shift_id"],
    ["from=2026-02-30", "invalid_date_range"],
    ["from=2026-03-02&to=2026-03-01", "invalid_date_range"],
  ])("rejects malformed query %s", (query, error) => {
    expect(parse(query)).toEqual({ ok: false, error });
  });

  it("rejects an overlong search instead of silently broadening the query", () => {
    const result = parse(`q=${"a".repeat(201)}`);
    expect(result).toEqual({ ok: false, error: "search_too_long" });
  });
});
