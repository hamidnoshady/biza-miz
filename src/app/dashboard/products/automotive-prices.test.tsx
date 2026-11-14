// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MoneyProvider } from "@/components/money/money-context";
import { AutomotivePrices } from "./automotive-prices";

const apiMock = vi.fn();
vi.mock("../ui", async (original) => ({ ...await original<typeof import("../ui")>(), api: (...args: unknown[]) => apiMock(...args) }));
const car = { serialId: "car-1", stockNumber: "AUTO-1", displayName: "پژو", state: "in_stock", askingPriceRial: 1000 };
const listing = { vehicles: [car], total: 1, locations: [{ id: "b1", name: "مرکزی" }], activeLocationId: "b1" };
const detail = { vehicle: { ...car, locationId: "b1", priceRevision: "4" }, canSeeCost: false, canSeePriceHistory: true, priceHistory: [{ id: "h1", changedAt: "2026-10-10 08:30:00+00", previousAskingPriceRial: 800, askingPriceRial: 1000, reason: "بازار" }] };
function show(canEdit: boolean) { return render(<MoneyProvider unit="toman"><AutomotivePrices canEdit={canEdit} /></MoneyProvider>); }
async function open() { fireEvent.click(await screen.findByRole("button", { name: "جزئیات قیمت AUTO-1" })); await screen.findByText(/قیمت پیشنهادی فعلی/); }
beforeEach(() => { apiMock.mockReset(); apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url.includes("?") ? listing : detail })); });
afterEach(cleanup);

describe("native automotive price workspace", () => {
  it("shows the asking price read-only without hidden cost or mutation controls", async () => {
    show(false); await open();
    expect(screen.getByText(/شعبهٔ فعال: مرکزی/)).toBeTruthy();
    expect(screen.queryByLabelText(/قیمت پیشنهادی جدید/)).toBeNull();
    expect(screen.queryByText(/^بهای خرید:/)).toBeNull();
    expect(screen.getByText("تاریخچهٔ قیمت")).toBeTruthy();
    expect(apiMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it("previews one asking-price change and sends the exact native revision", async () => {
    apiMock.mockImplementation(async (url: string, init?: RequestInit) => init?.method === "POST" ? { ok: true, data: { ok: true } } : { ok: true, data: url.includes("?") ? listing : detail });
    show(true); await open();
    fireEvent.change(screen.getByLabelText(/قیمت پیشنهادی جدید/), { target: { value: "125.5" } });
    fireEvent.change(screen.getByLabelText("دلیل تغییر (اختیاری)"), { target: { value: "بازبینی" } });
    fireEvent.click(screen.getByRole("button", { name: "بررسی تغییر" }));
    expect(screen.getByRole("group", { name: "بازبینی تغییر قیمت" }).textContent).toContain("سایر قیمت‌ها");
    fireEvent.click(screen.getByRole("button", { name: "تأیید و ثبت قیمت" }));
    await waitFor(() => expect(apiMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = apiMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe("/api/automotive/vehicles/car-1/price");
    expect(JSON.parse(post[1].body)).toEqual({ askingPriceRial: 1255, expectedPriceRevision: "4", expectedLocationId: "b1", reason: "بازبینی" });
    expect(await screen.findByRole("status")).toBeTruthy();
  });
  it("preserves the proposed price on a conflict and requires a fresh read before another preview", async () => {
    apiMock.mockImplementation(async (url: string, init?: RequestInit) => init?.method === "POST" ? { ok: false, data: { error: "price_conflict" } } : { ok: true, data: url.includes("?") ? listing : detail });
    show(true); await open();
    fireEvent.change(screen.getByLabelText(/قیمت پیشنهادی جدید/), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "بررسی تغییر" }));
    fireEvent.click(screen.getByRole("button", { name: "تأیید و ثبت قیمت" }));
    expect((await screen.findByRole("alert")).textContent).toContain("تغییر کرده است");
    expect((screen.getByRole("button", { name: "بررسی تغییر" }) as HTMLButtonElement).closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "دریافت قیمت و تاریخچهٔ فعلی" }));
    await screen.findByText(/قیمت پیشنهادی فعلی/);
    expect((screen.getByLabelText(/قیمت پیشنهادی جدید/) as HTMLInputElement).value).toBe("۱۲۰");
    expect(screen.queryByRole("button", { name: "تأیید و ثبت قیمت" })).toBeNull();
  });
  it("does not blindly retry an uncertain response and preserves the draft", async () => {
    apiMock.mockImplementation(async (url: string, init?: RequestInit) => init?.method === "POST" ? { ok: false, data: {} } : { ok: true, data: url.includes("?") ? listing : detail });
    show(true); await open();
    fireEvent.change(screen.getByLabelText(/قیمت پیشنهادی جدید/), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "بررسی تغییر" }));
    fireEvent.click(screen.getByRole("button", { name: "تأیید و ثبت قیمت" }));
    expect((await screen.findByRole("alert")).textContent).toContain("نتیجه مشخص نیست");
    expect((screen.getByRole("button", { name: "بررسی تغییر" }) as HTMLButtonElement).closest("fieldset")?.disabled).toBe(true);
    expect(apiMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "دریافت قیمت و تاریخچهٔ فعلی" }));
    await screen.findByText(/قیمت پیشنهادی فعلی/);
    expect((screen.getByLabelText(/قیمت پیشنهادی جدید/) as HTMLInputElement).value).toBe("۱۲۰");
  });
  it("refuses a vehicle detail from a different branch", async () => {
    apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url.includes("?") ? listing : { ...detail, vehicle: { ...detail.vehicle, locationId: "other" } } }));
    show(true);
    fireEvent.click(await screen.findByRole("button", { name: "جزئیات قیمت AUTO-1" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByLabelText(/قیمت پیشنهادی جدید/)).toBeNull();
  });
  it("does not let a missing revision or a failed list appear usable", async () => {
    apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url.includes("?") ? listing : { ...detail, vehicle: car } }));
    show(true);
    fireEvent.click(await screen.findByRole("button", { name: "جزئیات قیمت AUTO-1" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByLabelText(/قیمت پیشنهادی جدید/)).toBeNull();
  });
});
