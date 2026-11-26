// @vitest-environment jsdom
//
// GH #1567 Phase 6E — the advisory report view shows the advice, the numbers
// and the rule behind each row, says it is advisory, and offers no action.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildAdvice } from "@/lib/fashion-merchandising-advice";
import { FashionAdviceView } from "./fashion-advice-view";
import { TradeReportBody } from "./trade-report-body";

afterEach(cleanup);

const report = buildAdvice(
  [
    { itemId: "m", styleId: "st", styleName: "مانتو", variantLabel: "مشکی / M", soldUnits: 16, onHand: 4, unitCostRial: 100_000 },
    { itemId: "s", styleId: "st", styleName: "مانتو", variantLabel: "مشکی / S", soldUnits: 0, onHand: 0, unitCostRial: 100_000 },
    { itemId: "d", styleId: "old", styleName: "کت", variantLabel: "طوسی / L", soldUnits: 0, onHand: 6, unitCostRial: 250_000 },
  ],
  { from: "2026-09-01", to: "2026-10-26" },
  { generatedAt: "2026-10-26T12:00:00.000Z", excludedConsigned: 1 },
);

describe("FashionAdviceView", () => {
  it("lists each suggestion with its quantity, numbers and the rule behind it", () => {
    render(<FashionAdviceView report={report} />);
    const table = screen.getAllByRole("table", { name: "پیشنهادهای مشورتی خرید و چیدمان" })[0];
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("سفارش دوباره")).toBeTruthy();
    expect(within(rows[0]).getByText("۱۲")).toBeTruthy();
    expect(within(rows[1]).getByText("تکمیل سری سایز")).toBeTruthy();
    expect(within(rows[2]).getByText("بررسی تخفیف")).toBeTruthy();
    const basis = within(rows[0]).getByLabelText("مبنای پیشنهاد مشکی / M");
    expect(basis.textContent).toContain("ceil(2 × 8 − 4)");
  });

  it("says it is advisory, names its sources and the excluded consigned goods, and offers no action", () => {
    render(<FashionAdviceView report={report} />);
    expect(screen.getByRole("note").textContent).toContain("هیچ خرید، ثبت انبار، تغییر قیمت یا پیامی");
    expect(screen.getByText(/منابع:/).textContent).toContain("item_stock");
    expect(screen.getByText(/تنوع امانی کنار گذاشته شد/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("is what the standard report screen renders for the fashion_advice shape", () => {
    render(<TradeReportBody shape="fashion_advice" payload={report as unknown as Record<string, unknown>} />);
    expect(screen.getByRole("note")).toBeTruthy();
    render(<FashionAdviceView report={{ ...report, rows: [], totalCount: 0 }} />);
    expect(screen.getAllByText("در این بازه پیشنهادی نیست.").length).toBeGreaterThan(0);
  });
});
