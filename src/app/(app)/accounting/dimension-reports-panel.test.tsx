// @vitest-environment jsdom

/**
 * The dimension reports as the browser draws them (issue #868).
 *
 * What a person can get wrong while the API is right is the link behind a
 * figure: a matrix cell that opens the wrong journal lines, or lines for another
 * period than the one the report shows. So what is asserted here is only that:
 * the one non-zero value cell links to its own account and value, over the same
 * period the report request asked for, and the cells that have nothing to drill
 * into do not link.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DimensionValueRecord } from "@/lib/accounting-dimensions";
import { DimensionReportsPanel } from "./dimension-reports-panel";
import { journalFiltersFromParams } from "./journal-view";

const HQ = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_RENT = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_WAGES = "77777777-7777-4777-8777-777777777777";

const VALUES: DimensionValueRecord[] = [
  {
    id: HQ,
    kind: "cost_center",
    code: "CC-HQ",
    name: "Head office",
    parentId: null,
    parentCode: null,
    parentName: null,
    locationId: null,
    locationName: null,
    effectiveFrom: null,
    effectiveTo: null,
    isActive: true,
    hasChildren: false,
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
  },
];

/** Rent sits on the head office; wages sit only in the unassigned column. */
const MATRIX = {
  columns: [
    { valueId: HQ, code: "CC-HQ", name: "Head office", isActive: true },
    { valueId: null, code: null, name: "بدون بُعد", isActive: true },
  ],
  rows: [
    { accountId: ACCOUNT_RENT, code: "5200", name: "اجاره", type: "expense", cells: { [HQ]: 1200000 }, total: 1200000 },
    { accountId: ACCOUNT_WAGES, code: "6100", name: "حقوق", type: "expense", cells: { unassigned: 500 }, total: 500 },
  ],
  columnTotals: { [HQ]: 1200000, unassigned: 500 },
  grandTotal: 1200500,
  reconciled: true,
};

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function stubFetch() {
  const reportUrls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const target = String(url);
      if (target.startsWith("/api/ledger/accounts")) return json({ accounts: [] });
      if (target.startsWith("/api/ledger/dimension-reports?")) {
        reportUrls.push(target);
        return json(MATRIX);
      }
      return json({});
    }),
  );
  return reportUrls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the matrix report's drill-down", () => {
  it("links the one non-zero value cell to its account and value, over the period the report asked for", async () => {
    const reportUrls = stubFetch();
    render(
      <DimensionReportsPanel enabledKinds={["cost_center"]} kindLabel={() => "مرکز هزینه"} values={VALUES} />,
    );

    const links = await waitFor(() => {
      const found = screen.getAllByRole("link");
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    // Rent on the head office is the only figure with lines behind it in a value column.
    expect(links).toHaveLength(1);

    const href = links[0].getAttribute("href") ?? "";
    expect(href.startsWith("/accounting/entries?")).toBe(true);
    const state = journalFiltersFromParams(new URLSearchParams(href.split("?")[1]));
    expect(state.account).toBe(ACCOUNT_RENT);
    expect(state.dimensions).toEqual({ cost_center: HQ });

    // The link carries the same period the report request carried, so the journal
    // shows the lines behind the figure on screen and not those of the current form.
    const requested = new URLSearchParams(reportUrls[0].split("?")[1]);
    expect(state.dateFrom).toBe(requested.get("dateFrom"));
    expect(state.dateTo).toBe(requested.get("dateTo"));
  });
});
