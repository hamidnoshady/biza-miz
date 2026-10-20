import { describe, expect, it } from "vitest";
import {
  isDefaultLedgerOverviewFilters,
  ledgerOverviewApiQuery,
  ledgerOverviewUrlParams,
  parseLedgerOverviewFilters,
} from "./ledger-overview-filters";

const YEAR = "11111111-1111-4111-8111-111111111111";

describe("ledger overview filters (#912 item 13)", () => {
  it("defaults to business-today and the covering fiscal year", () => {
    const { filters, droppedInvalid } = parseLedgerOverviewFilters(new URLSearchParams());
    expect(filters).toEqual({ asOf: null, period: "auto" });
    expect(droppedInvalid).toBe(false);
    expect(isDefaultLedgerOverviewFilters(filters)).toBe(true);
    expect(ledgerOverviewApiQuery(filters)).toBe("");
    expect(ledgerOverviewUrlParams(filters).toString()).toBe("");
  });

  it("round-trips a shared link through the URL and the API query", () => {
    const shared = new URLSearchParams(`asOf=2025-12-31&period=${YEAR}`);
    const { filters, droppedInvalid } = parseLedgerOverviewFilters(shared);
    expect(droppedInvalid).toBe(false);
    expect(ledgerOverviewUrlParams(filters).toString()).toBe(shared.toString());
    expect(ledgerOverviewApiQuery(filters)).toBe(`?asOf=2025-12-31&fiscalYear=${YEAR}`);
  });

  it("maps the all-periods selection to the API's explicit fiscalYear=all", () => {
    const { filters } = parseLedgerOverviewFilters(new URLSearchParams("period=all"));
    expect(ledgerOverviewApiQuery(filters)).toBe("?fiscalYear=all");
    expect(ledgerOverviewUrlParams(filters).toString()).toBe("period=all");
  });

  it("drops invalid dates and period ids instead of forwarding them", () => {
    for (const raw of ["asOf=2025-02-31", "asOf=banana", "period=not-a-year", "period=123"]) {
      const { filters, droppedInvalid } = parseLedgerOverviewFilters(new URLSearchParams(raw));
      expect(droppedInvalid, raw).toBe(true);
      expect(filters).toEqual({ asOf: null, period: "auto" });
    }
  });
});
