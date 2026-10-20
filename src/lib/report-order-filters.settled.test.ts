import { describe, expect, it } from "vitest";
import { parseReportOrderFilters } from "./report-order-filters";
describe("settled-since drill-down (#912)", () => {
  it("parses the dashboard's settled window", () => {
    const r = parseReportOrderFilters(new URLSearchParams("settledSince=2026-01-01T00:00:00.000Z&status=completed"));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.filters.settledSince).toBe("2026-01-01T00:00:00.000Z"); expect(r.filters.shiftId).toBeNull(); }
  });
  it("rejects an invalid settled window", () => {
    expect(parseReportOrderFilters(new URLSearchParams("settledSince=nope")).ok).toBe(false);
  });
});
