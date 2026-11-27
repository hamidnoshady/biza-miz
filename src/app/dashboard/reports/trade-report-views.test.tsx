// @vitest-environment jsdom
//
// GH #1567 C6 — a sales row that nets a pre-0328 return (whose revenue share
// was never recorded per line) is marked «ناقص», and the report explains why;
// a fully known report shows no marker and no note.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandSalesView, INCOMPLETE_REVENUE_NOTE, VariantSalesView } from "./trade-report-views";

afterEach(cleanup);

const known = {
  itemId: "m", itemName: "پیراهن تازه", parentName: null, attributes: [],
  quantitySold: "1", netRevenue: 100_000, cogs: 50_000, margin: 50_000, unknownReturnQuantity: "0", revenueComplete: true,
};
const legacy = {
  itemId: "l", itemName: "پیراهن قدیمی", parentName: null, attributes: [],
  quantitySold: "1", netRevenue: 200_000, cogs: 50_000, margin: 150_000, unknownReturnQuantity: "1", revenueComplete: false,
};

describe("incomplete revenue (GH #1567 C6)", () => {
  it("marks only the variant rows that include an unknown-amount return, and explains it once", () => {
    render(<VariantSalesView report={{ rows: [known, legacy] }} />);
    expect(screen.getByRole("note").textContent).toBe(INCOMPLETE_REVENUE_NOTE);
    // ReportTable renders a table and a card layout; every marker belongs to the legacy row.
    const markers = screen.getAllByText("ناقص");
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(marker.parentElement?.getAttribute("title")).toBe("۱ عدد مرجوعی با مبلغ نامعلوم");
    }
  });

  it("a fully known report has no marker and no note", () => {
    render(<VariantSalesView report={{ rows: [known] }} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText("ناقص")).toBeNull();
  });

  it("the brand total that covers a legacy return is marked too", () => {
    render(
      <BrandSalesView
        report={{ rows: [{ brandId: null, brandName: null, quantitySold: "2", netRevenue: 300_000, cogs: 100_000, margin: 200_000, unknownReturnQuantity: "1", revenueComplete: false }] }}
      />,
    );
    expect(screen.getByRole("note")).toBeTruthy();
    expect(screen.getAllByText("ناقص").length).toBeGreaterThan(0);
  });
});
