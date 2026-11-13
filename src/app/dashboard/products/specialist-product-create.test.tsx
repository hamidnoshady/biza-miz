// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MoneyProvider } from "@/components/money/money-context";
import { SpecialistProductCreate } from "./specialist-product-create";

const apiMock = vi.fn();
vi.mock("../ui", async (original) => ({ ...await original<typeof import("../ui")>(), api: (...args: unknown[]) => apiMock(...args) }));
function show(industry: "watch" | "jewelry", scope = "business:user:branch", unit: "rial" | "toman" = "toman") {
  return render(<MoneyProvider unit={unit}><SpecialistProductCreate industry={industry} draftScope={scope} locationId="branch" locationName="مرکزی" /></MoneyProvider>);
}
function change(label: string | RegExp, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
beforeEach(() => { localStorage.clear(); apiMock.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("native specialist product creation", () => {
  it("validates a jewelry piece and submits its exact per-gram cost in Rial", async () => {
    apiMock.mockResolvedValue({ ok: true, status: 200, data: { ok: true, id: "gold-1" } });
    show("jewelry");
    await screen.findByLabelText("نام کالا"); change("نام کالا", "انگشتر");
    change("وزن ناخالص (گرم)", "2.5");
    change("وزن خالص (گرم)", "3");
    fireEvent.click(screen.getByRole("button", { name: "ثبت محصول" }));
    expect(screen.getByRole("alert").textContent).toContain("وزن خالص نمی‌تواند");
    expect(apiMock).not.toHaveBeenCalled();
    change("وزن خالص (گرم)", "2.2");
    change(/بهای هر گرم/, "12.5");
    fireEvent.click(screen.getByRole("button", { name: "ثبت محصول" }));
    await screen.findByRole("status");
    const [url, init] = apiMock.mock.calls[0];
    expect(url).toBe("/api/jewelry/items");
    expect(JSON.parse(init.body)).toMatchObject({ name: "انگشتر", purity: "18", grossWeight: "2.5", netWeight: "2.2", unitCostPerGram: "125", expectedLocationId: "branch" });
    expect((screen.getByLabelText("نام کالا") as HTMLInputElement).value).toBe("");
  });

  it("keeps separate watch model facts and prevents a double submit", async () => {
    let finish!: (value: unknown) => void;
    apiMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    show("watch");
    await screen.findByLabelText("نام کالا"); change("نام کالا", "مدل آبی");
    change("شماره رفرنس (اختیاری)", "REF-1");
    change("نوع موتور", "quartz");
    change("فاصلهٔ سرویس (ماه، اختیاری)", "12");
    change("جنس قاب (اختیاری)", "استیل");
    change("قطر قاب (میلی‌متر، اختیاری)", "40.5");
    change("مقاومت در برابر آب (متر، اختیاری)", "50");
    change("دسته‌بندی جنسیتی", "unisex");
    const button = screen.getByRole("button", { name: "ثبت محصول" });
    fireEvent.click(button);
    fireEvent.submit(button.closest("form")!);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(apiMock.mock.calls[0][1].body)).toMatchObject({ name: "مدل آبی", serviceIntervalMonths: 12, attributes: { referenceNo: "REF-1", movement: "quartz", caseMaterial: "استیل", caseDiameterMm: 40.5, waterResistanceM: 50, gender: "unisex" }, expectedLocationId: "branch" });
    finish({ ok: true, status: 200, data: { ok: true, item: { id: "watch-1" } } });
    await screen.findByRole("status");
  });

  it("retains a rejected draft for correction and scopes it to the member and branch", async () => {
    apiMock.mockResolvedValue({ ok: false, status: 400, data: { error: "missing_fields", message: "خطای اعتبارسنجی" } });
    const view = show("watch");
    await screen.findByLabelText("نام کالا"); change("نام کالا", "مدل ذخیره‌شده");
    fireEvent.click(screen.getByRole("button", { name: "ثبت محصول" }));
    expect((await screen.findByRole("alert")).textContent).toContain("خطای اعتبارسنجی");
    view.unmount();
    const other = show("watch", "business:user:other");
    expect((await screen.findByLabelText("نام کالا") as HTMLInputElement).value).toBe("");
    other.unmount();
    show("watch");
    expect((await screen.findByLabelText("نام کالا") as HTMLInputElement).value).toBe("مدل ذخیره‌شده");
  });

  it("persists an uncertain result across reload and requires explicit verification before retry", async () => {
    apiMock.mockResolvedValue({ ok: false, status: 0, data: { error: "network_error" } });
    const view = show("watch");
    await screen.findByLabelText("نام کالا"); change("نام کالا", "مدل");
    fireEvent.click(screen.getByRole("button", { name: "ثبت محصول" }));
    await screen.findByText(/نتیجهٔ ثبت قبلی مشخص نیست/);
    view.unmount();
    show("watch");
    await screen.findByText(/نتیجهٔ ثبت قبلی مشخص نیست/);
    expect((screen.getByRole("button", { name: "ثبت محصول" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "بررسی فهرست محصولات" }).getAttribute("href")).toBe("/accounting/products");
    fireEvent.click(screen.getByRole("button", { name: "بررسی کردم؛ اجازهٔ تلاش دوباره" }));
    expect((screen.getByRole("button", { name: "ثبت محصول" }) as HTMLButtonElement).disabled).toBe(false);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to submit if the browser cannot persist the uncertain-result marker", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    show("watch");
    await screen.findByLabelText("نام کالا"); change("نام کالا", "مدل");
    fireEvent.click(screen.getByRole("button", { name: "ثبت محصول" }));
    expect(screen.getByText(/برای جلوگیری از ثبت تکراری/)).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText("نام کالا") as HTMLInputElement).value).toBe("مدل");
  });

  it("keeps the draft and reports a branch mismatch without a second write", async () => {
    apiMock.mockResolvedValue({ ok: false, status: 409, data: { error: "location_changed" } });
    show("watch");
    await screen.findByLabelText("نام کالا"); change("نام کالا", "مدل");
    fireEvent.click(screen.getByRole("button", { name: "ثبت محصول" }));
    expect((await screen.findByRole("alert")).textContent).toContain("شعبهٔ فعال تغییر کرده");
    expect((screen.getByLabelText("نام کالا") as HTMLInputElement).value).toBe("مدل");
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a draft changed in another tab while a request was in flight", async () => {
    let finish!: (value: unknown) => void;
    apiMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    show("watch");
    await screen.findByLabelText("نام کالا"); change("نام کالا", "مدل اول");
    fireEvent.click(screen.getByRole("button", { name: "ثبت محصول" }));
    const key = "specialist-product-draft:v1:watch:business:user:branch";
    const other = JSON.parse(localStorage.getItem(key)!);
    other.pending = false;
    other.form.name = "پیش‌نویس دیگر";
    localStorage.setItem(key, JSON.stringify(other));
    finish({ ok: true, status: 200, data: { ok: true, item: { id: "watch-1" } } });
    expect((await screen.findByRole("alert")).textContent).toContain("پیش‌نویس در صفحهٔ دیگری تغییر کرده");
    expect(JSON.parse(localStorage.getItem(key)!).form.name).toBe("پیش‌نویس دیگر");
  });

  it("treats an unclassified watch error as uncertain because it may mask a commit failure", async () => {
    apiMock.mockResolvedValue({ ok: false, status: 400, data: { error: "validation_failed" } });
    show("watch");
    await screen.findByLabelText("نام کالا"); change("نام کالا", "مدل");
    fireEvent.click(screen.getByRole("button", { name: "ثبت محصول" }));
    await screen.findByText(/نتیجهٔ ثبت قبلی مشخص نیست/);
    expect((screen.getByRole("button", { name: "ثبت محصول" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("requires the cost to be re-entered if the business currency changes", async () => {
    const view = show("jewelry");
    await screen.findByLabelText("نام کالا"); change("نام کالا", "قطعه");
    change("وزن ناخالص (گرم)", "2");
    change("وزن خالص (گرم)", "1");
    change(/بهای هر گرم/, "5");
    view.unmount();
    show("jewelry", "business:user:branch", "rial");
    await screen.findByLabelText("نام کالا");
    fireEvent.click(screen.getByRole("button", { name: "ثبت محصول" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("واحد پول"));
    expect(apiMock).not.toHaveBeenCalled();
  });
});
