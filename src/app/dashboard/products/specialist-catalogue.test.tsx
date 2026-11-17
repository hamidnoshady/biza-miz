// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MoneyProvider } from "@/components/money/money-context";
import { SpecialistCatalogue } from "./specialist-catalogue";

const apiMock = vi.fn();
vi.mock("../ui", async (original) => ({ ...await original<typeof import("../ui")>(), api: (...args: unknown[]) => apiMock(...args) }));
const gold = { id: "gold-1", name: "انگشتر", sku: "JEW-1", isActive: true, purity: "18", netWeight: "3.2", grossWeight: "3.5", status: "in_stock", stoneCost: 0, consignorName: "امانت‌گذار" };
const models = [{ id: "m1", name: "مدل آبی", sku: "W-1", isActive: true, attributes: { referenceNo: "R-77", caseMaterial: "استیل", movement: "quartz", caseDiameterMm: 40.5, caseDimensionsMm: [40.5, 12.2], waterResistanceM: 0, braceletColor: "آبی", gender: "unisex" } }, { id: "m2", name: "مدل قرمز", sku: "W-2", isActive: true, attributes: null }];
const units = [{ id: "u1", itemId: "m1", itemName: "مدل آبی", serialNumber: "SN-22", status: "in_stock", unitCost: 0, warrantyMonths: 12, warrantyEnd: null }, { id: "u2", itemId: "m1", itemName: "مدل آبی", serialNumber: "SN-23", status: "sold", unitCost: null, warrantyMonths: 6, warrantyEnd: null }];
function renderFor(industry: "watch" | "jewelry", canEdit = false) {
  return render(<MoneyProvider unit="rial"><SpecialistCatalogue industry={industry} canEdit={canEdit} /></MoneyProvider>);
}
beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url === "/api/watch/items" ? { items: models } : url === "/api/watch/units" ? { units } : { items: [gold] } }));
});
afterEach(cleanup);

describe("native specialist catalogue", () => {
  it("shows weighted pieces with their native status, purity and branch data without mutation controls to a viewer", async () => {
    renderFor("jewelry");
    expect(await screen.findByText("انگشتر")).toBeTruthy();
    expect(document.body.textContent).toContain("۳٫۲");
    expect(document.body.textContent).toContain("امانت‌گذار");
    expect(screen.queryByRole("link", { name: /مدیریت تخصصی/ })).toBeNull();
    expect(apiMock.mock.calls.map(([url]) => url)).toEqual(["/api/jewelry/items"]);
    fireEvent.change(screen.getByLabelText("جستجوی نام، کد یا امانت‌گذار"), { target: { value: "unknown" } });
    expect(screen.getByText("موردی مطابق جستجو پیدا نشد.")).toBeTruthy();
  });
  it("lists watch models separately from physical units and searches serials", async () => {
    renderFor("watch", true);
    expect(await screen.findByText("مدل آبی")).toBeTruthy();
    expect(screen.getByText("مدل قرمز")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("جستجوی مدل، کد یا سریال"), { target: { value: "SN-22" } });
    expect(screen.queryByText("مدل قرمز")).toBeNull();
    const details = screen.getByText("مشخصات مدل و دستگاه‌ها").parentElement!;
    fireEvent.click(screen.getByText("مشخصات مدل و دستگاه‌ها"));
    expect(within(details).getByText("SN-22")).toBeTruthy();
    expect(within(details).getByText("SN-23")).toBeTruthy();
    expect(details.textContent).toContain("استیل");
    expect(details.textContent).toContain("کوارتز");
    expect(details.textContent).toContain("ابعاد قاب: ۴۰٫۵ × ۱۲٫۲");
    expect(details.textContent).toContain("مقاومت در برابر آب: ۰ متر");
    expect(details.textContent).toContain("یونیسکس");
    expect(details.textContent).toContain("تعیین نشده");
    expect(screen.getByRole("link", { name: "مدیریت تخصصی ساعت" }).getAttribute("href")).toBe("/accounting/watch");
    expect(apiMock.mock.calls.map(([url]) => url).sort()).toEqual(["/api/watch/items", "/api/watch/units"]);
  });
  it("filters watch models by the status of their physical units", async () => {
    renderFor("watch");
    await screen.findByText("مدل آبی");
    fireEvent.change(screen.getByLabelText("وضعیت دستگاه در مدل"), { target: { value: "sold" } });
    expect(screen.queryByText("مدل قرمز")).toBeNull();
    expect(screen.getByText("مدل آبی")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("وضعیت دستگاه در مدل"), { target: { value: "in_repair" } });
    expect(screen.getByText("موردی مطابق جستجو پیدا نشد.")).toBeTruthy();
  });
  it("treats a partial failure as an error, not an empty or incomplete catalogue, and retries", async () => {
    let failed = false;
    apiMock.mockImplementation(async (url: string) => {
      if (url === "/api/watch/units" && !failed) { failed = true; return { ok: false, data: {} }; }
      return { ok: true, data: url === "/api/watch/items" ? { items: models } : { units } };
    });
    renderFor("watch");
    fireEvent.click(await screen.findByRole("button", { name: "تلاش دوباره" }));
    expect(await screen.findByText("مدل آبی")).toBeTruthy();
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(4));
  });
});
