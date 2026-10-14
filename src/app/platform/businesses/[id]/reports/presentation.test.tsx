/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MoneyProvider } from "@/components/money/money-context";
import { formatMoney } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";
import { OverviewPanel, WebsitesPanel, HealthPanel, type Overview } from "./panels";
import { StructuredReportBody } from "@/app/dashboard/reports/structured-report-body";
import { ChartPreview } from "@/app/dashboard/reports/chart-preview";
const data: Overview = {
  sales: { data: { from: null, to: null, consolidated: { orderCount: 10, subtotal: 1200000, cogs: 0, wasteCost: 0, total: 1230000, discount: 10000, tax: 20000 }, branches: [] }, error: null },
  accounting: null,
  activity: { data: { orders: 10, locations: 1, menuItems: 0, journalEntries: 0, openOrders: 3, members: 1, lastActivity: "2026-03-21T09:00:00Z" }, error: null },
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("platform report presentation", () => {
  it.each(["rial", "toman"] as const)("uses the selected tenant's %s formatter, not the platform fallback", (unit) => {
    render(<MoneyProvider unit={unit}><OverviewPanel data={data} locationId="" /></MoneyProvider>);
    expect(screen.getByText(formatMoney(1230000, unit))).toBeTruthy();
    expect(screen.getByText(formatJalali("2026-03-21T09:00:00Z"))).toBeTruthy();
    expect(screen.queryByText("2026-03-21T09:00:00Z")).toBeNull();
  });
  it("shows every WP overview counter, including connector type, taxonomy and inbound backlog", () => {
    render(<WebsitesPanel data={{ wp: { error: null, data: {
      connections: { total: 3, active: 2, plugin: 1, rest: 2 }, products: 4, orders: 5,
      customers: 6, terms: 7, content: { posts: 8, pages: 9, media: 10 },
      pendingJobs: 11, failedJobs: 12, deadJobs: 13, pendingInboxEvents: 14, failedInboxEvents: 15,
    } } }} />);
    for (const label of ["اتصال افزونه", "اتصال REST", "دسته‌ها و برچسب‌ها", "رویداد ورودی در انتظار"])
      expect(screen.getByText(label)).toBeTruthy();
    for (const count of ["۷", "۱۴", "۱۵"]) expect(screen.getByText(count)).toBeTruthy();
  });
  it("renders release warnings and Jalali telemetry dates without update controls", () => {
    render(<HealthPanel data={{ sync: { data: null, error: "report_unavailable" }, backup: { data: null, error: "report_unavailable" }, devices: { error: null, data: [{
      id: "device-a", name: "صندوق", location: "تهران", status: "active", hasError: false,
      lastSeenAt: null, lastSuccessfulPushAt: null, lastSuccessfulPullAt: null,
      installedVersion: "1.0.0", targetVersion: "1.2.0", minimumSupportedVersion: "1.1.0",
      compliance: "unsupported", connectivity: "online", channel: "stable", lastReportAt: "2026-03-21T09:00:00Z",
    }] } }} />);
    expect(screen.getAllByText("پشتیبانی‌نشده")).toHaveLength(2);
    expect(screen.getAllByText("۱.۰.۰")).toHaveLength(2); expect(screen.getAllByText("۱.۲.۰")).toHaveLength(2);
    expect(screen.getAllByText(formatJalali("2026-03-21T09:00:00Z"))).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /به‌روزرسانی/ })).toBeNull();
  });
  it("does not expose tenant-authenticated drill-down buttons or fetch on read-only statements", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<MoneyProvider unit="rial"><StructuredReportBody readOnly shape="profit_and_loss" payload={{
      revenue: [{ accountCode: "4100", accountName: "فروش", amount: 1230000 }], expenses: [],
      totalRevenue: 1230000, totalExpenses: 0, netIncome: 1230000, costOfSales: 0, grossProfit: 1230000,
      laborCost: 0, primeCost: 0, operatingExpenses: 0,
    }} /></MoneyProvider>);
    expect(screen.queryByRole("button", { name: /فروش/ })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not turn a negative measure into a positive pie slice", () => {
    const { container } = render(<ChartPreview chartType="pie" label="سود و زیان" data={[{ label: "زیان", value: -100 }, { label: "سود", value: 300 }]} />);
    expect(screen.getByRole("figure", { name: "سود و زیان" })).toBeTruthy();
    expect(container.querySelector("svg path")).toBeNull();
    const loss = screen.getByTitle(/زیان: /);
    expect(loss.getAttribute("style")).toContain("left: 0%");
    expect(loss.getAttribute("style")).toContain("width: 25%");
    expect(screen.getByTitle(/سود: /).getAttribute("style")).toContain("left: 25%");
  });
});
