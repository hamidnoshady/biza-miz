import { describe, expect, it } from "vitest";
import { normalizeCustomerQuery, normalizeReportOrderNumber, parseReportOrderFilters } from "./report-order-filters";

describe("report order filters", () => {
  it.each(["1234", "#1234", "۱۲۳۴", "#۱۲۳۴", "# ١٢٣٤"])("normalizes localized order number %s without Number conversion", (value) => {
    expect(normalizeReportOrderNumber(value)).toBe("1234");
  });

  it("normalizes Persian/Arabic customer spelling for database search", () => {
    expect(normalizeCustomerQuery("  علي رضايي  ")).toBe("علی رضایی");
  });

  it("parses combinable all-shifts, date, status and paging filters", () => {
    const result = parseReportOrderFilters(new URLSearchParams("allShifts=1&from=2026-09-01&to=2026-09-30&status=completed&type=dine_in&page=2&pageSize=50"));
    expect(result).toEqual({ ok: true, filters: expect.objectContaining({ shiftId: null, dateFrom: "2026-09-01", dateTo: "2026-09-30", status: "completed", type: "dine_in", page: 2, pageSize: 50 }) });
  });

  it("parses the outside-every-shift view as all shifts, unassigned only", () => {
    expect(parseReportOrderFilters(new URLSearchParams("shiftId=unassigned&type=retail"))).toEqual({
      ok: true,
      filters: expect.objectContaining({ shiftId: null, unassigned: true, type: "retail" }),
    });
  });

  it.each(["from=2026-02-31", "from=2026-09-02&to=2026-09-01", "pageSize=500", "shiftId=foreign"])("rejects malformed query: %s", (query) => {
    expect(parseReportOrderFilters(new URLSearchParams(query)).ok).toBe(false);
  });
});
