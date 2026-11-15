// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SpecialistAttributes } from "./specialist-attributes";

const apiMock = vi.fn();
vi.mock("../ui", async (original) => ({ ...await original<typeof import("../ui")>(), api: (...args: unknown[]) => apiMock(...args) }));
const model = { id: "m1", name: "ساعت آبی", sku: "W-1", isActive: true, attributes: { referenceNo: "R77", movement: "quartz", caseDiameterMm: 40.5, caseDimensionsMm: [40.5, 12.2], waterResistanceM: 0, braceletColor: "آبی", claspType: "پروانه‌ای", caseColor: "طلایی", caseShape: "گرد" } };
const jewelry = { id: "j1", name: "انگشتر", sku: "J-1", purity: "18", netWeight: "3.2", grossWeight: "3.5" };
const car = { serialId: "v1", displayName: "پژو", stockNumber: "C-1", locationId: "b1" };
const list = { vehicles: [car], total: 1, activeLocationId: "b1", locations: [{ id: "b1", name: "مرکزی" }] };
const vehicle = { ...car, condition: "used", vehicleYearCalendar: "jalali", modelYear: 1402, productionYear: null, bodyType: "sedan", transmission: "manual", fuelType: "petrol", mileageKm: 0 };
beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url === "/api/watch/items" ? { items: [model] } : url === "/api/jewelry/items" ? { items: [jewelry] } : url.startsWith("/api/jewelry/items/") ? { item: { id: "j1" }, stones: [{ id: "s1", stoneType: "الماس", carat: "0.25" }] } : url.includes("?") ? list : { vehicle } }));
});
afterEach(cleanup);

describe("specialist product attributes", () => {
  it("reads all watch model specifications, with fractional dimensions and zero, without fetching units or writing", async () => {
    render(<SpecialistAttributes industry="watch" />);
    fireEvent.click(await screen.findByRole("button", { name: "مشخصات ساعت آبی W-1" }));
    expect(screen.getByText("۴۰٫۵ × ۱۲٫۲ میلی‌متر")).toBeTruthy();
    expect(screen.getByText("۰ متر")).toBeTruthy();
    expect(screen.getByText("پروانه‌ای")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "جستجوی مشخصات محصول" }), { target: { value: "R77" } });
    expect(screen.getByText("ساعت آبی")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /ذخیره|ثبت/ })).toBeNull();
  });
  it("reads jewelry weights and its stones from the native piece detail", async () => {
    render(<SpecialistAttributes industry="jewelry" />);
    fireEvent.click(await screen.findByRole("button", { name: "مشخصات انگشتر J-1" }));
    expect(await screen.findByText(/الماس/)).toBeTruthy();
    expect(screen.getByText(/وزن خالص/).textContent).toContain("۳٫۲");
    expect(screen.getByText(/الماس/).textContent).toContain("۰٫۲۵");
    expect(apiMock.mock.calls.map(([url]) => url)).toEqual(["/api/jewelry/items", "/api/jewelry/items/j1"]);
  });
  it("loads automotive detail from the selected branch and displays its native technical fields", async () => {
    render(<SpecialistAttributes industry="automotive" />);
    expect(await screen.findByText("شعبهٔ فعال: مرکزی")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "مشخصات پژو C-1" }));
    expect(await screen.findByText("کارکرده")).toBeTruthy();
    expect(screen.getByText("دنده‌ای")).toBeTruthy();
    expect(screen.getByText("۱۴۰۲")).toBeTruthy();
    expect(screen.getByText("۰ کیلومتر")).toBeTruthy();
    expect(apiMock.mock.calls.map(([url]) => url)).toEqual(["/api/automotive/vehicles?limit=20&offset=0&q=", "/api/automotive/vehicles/v1"]);
  });
  it("refuses automotive detail from a different branch", async () => {
    apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url.includes("?") ? list : { vehicle: { ...vehicle, locationId: "b2" } } }));
    render(<SpecialistAttributes industry="automotive" />);
    fireEvent.click(await screen.findByRole("button", { name: "مشخصات پژو C-1" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("کارکرده")).toBeNull();
  });
  it("reports failed requests rather than showing false empty data and offers retry", async () => {
    apiMock.mockResolvedValueOnce({ ok: false, data: {} });
    render(<SpecialistAttributes industry="watch" />);
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "تلاش دوباره" }));
    expect(await screen.findByText("ساعت آبی")).toBeTruthy();
  });
  it("does not present Gregorian years as Shamsi or invent an exact conversion", async () => {
    apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url.includes("?") ? list : { vehicle: { ...vehicle, vehicleYearCalendar: "gregorian", modelYear: 2024 } } }));
    render(<SpecialistAttributes industry="automotive" />);
    fireEvent.click(await screen.findByRole("button", { name: "مشخصات پژو C-1" }));
    expect(await screen.findByText("سال شمسی ثبت نشده")).toBeTruthy();
    expect(document.body.textContent).not.toContain("۲۰۲۴");
  });
});
