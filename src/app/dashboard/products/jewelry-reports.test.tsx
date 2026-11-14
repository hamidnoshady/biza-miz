// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MoneyProvider } from "@/components/money/money-context";
import { JewelryReports } from "./jewelry-reports";

const apiMock = vi.fn();
vi.mock("../ui", async (original) => ({ ...await original<typeof import("../ui")>(), api: (...args: unknown[]) => apiMock(...args) }));
const count = { id: "count-1", countDate: "2026-10-10", purity: "18", countedWeight: "4.5", systemWeight: "5", variance: "-0.5", variancePercent: -10 };
const summary = { consignorId: "c1", name: "امانت‌گذار", itemsOnHand: 2, totalOwed: 5000, totalPaid: 2000, balance: 3000 };
const counts = { reconciliation: [{ purity: "18", systemWeight: "5", pieces: 2, lastCount: count }], counts: [count] };
beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url.includes("weight-counts") ? counts : { summaries: [summary] } }));
});
afterEach(cleanup);
function show() { return render(<MoneyProvider unit="rial"><JewelryReports /></MoneyProvider>); }

describe("jewelry report projection", () => {
  it("renders branch weight and business-wide consignor data without mutation actions", async () => {
    show();
    expect(await screen.findByText("امانت‌گذار")).toBeTruthy();
    expect(screen.getByText("تطبیق وزنی شعبهٔ فعال")).toBeTruthy();
    expect(screen.getByText(/شامل همهٔ شعب/)).toBeTruthy();
    expect(screen.getByText(/آخرین شمارش/).textContent).toContain("۴٫۵");
    expect(screen.getByText(/پرداخت ۲٬۰۰۰/).textContent).toContain("۳٬۰۰۰");
    expect(screen.queryByRole("button", { name: /ثبت شمارش|پرداخت/ })).toBeNull();
    expect(apiMock.mock.calls.map(([url]) => url).sort()).toEqual(["/api/jewelry/reports/consignors", "/api/jewelry/reports/weight-counts"]);
  });
  it("shows an error on a partial failure rather than empty or misleading results, and retries", async () => {
    let fail = true;
    apiMock.mockImplementation(async (url: string) => url.includes("consignors") && fail
      ? { ok: false, data: {} }
      : { ok: true, data: url.includes("weight-counts") ? counts : { summaries: [summary] } });
    show();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("امانت‌گذار")).toBeNull();
    expect(screen.queryByText("کالای وزنی موجودی ثبت نشده است.")).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    expect(await screen.findByText("امانت‌گذار")).toBeTruthy();
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(4));
  });
});
