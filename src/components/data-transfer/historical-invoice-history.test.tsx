// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/app/dashboard/ui", async (importOriginal) => ({ ...await importOriginal<typeof import("@/app/dashboard/ui")>(), api: mocks.api }));
import { HistoricalInvoiceHistory } from "./historical-invoice-history";

const invoice = {
  id: "one", partyId: "customer-a", invoiceNumber: "17", externalId: "external-17", sourceKey: "old-system",
  invoiceDate: "2024-03-20", sourceStatus: "paid", totalRial: "9007199254740991", paidRial: "1", balanceRial: null, summaryOnly: true,
};
beforeEach(() => mocks.api.mockReset().mockResolvedValue({ ok: true, aborted: false, data: { invoices: [invoice], hasMore: true } }));
afterEach(cleanup);

describe("historical customer invoices", () => {
  it("labels archive evidence and displays dates and large amounts without rounding", async () => {
    render(<HistoricalInvoiceHistory customerId="customer-a" />);
    expect(await screen.findByText(/شناسهٔ اصلی: external-17/)).toBeTruthy();
    expect(screen.getByText(/در دفتر رسمی، ماندهٔ بدهی و آمار فروش سامانه ثبت نشده/)).toBeTruthy();
    expect(screen.getByText("واردشده از نرم‌افزار قبلی / سابقه تاریخی")).toBeTruthy();
    expect(screen.getByText("فقط خلاصه، بدون ردیف کالا")).toBeTruthy();
    expect(screen.getByText(/۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۱ ریال/)).toBeTruthy();
    expect(screen.getByText(/پرداختی در منبع: ۱ ریال/)).toBeTruthy();
    expect(screen.getByText(/۱۴۰۳\/۰۱\/۰۱/)).toBeTruthy();
  });
  it("sends search and pagination to the server", async () => {
    render(<HistoricalInvoiceHistory customerId="customer-a" />);
    await screen.findByText(/external-17/);
    fireEvent.change(screen.getByLabelText("جست‌وجوی فاکتورهای قبلی"), { target: { value: "old source" } });
    fireEvent.click(screen.getByRole("button", { name: "جست‌وجو" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("q=old+source"), expect.anything()));
    fireEvent.click(await screen.findByRole("button", { name: "صفحهٔ بعد" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("offset=50"), expect.anything()));
  });
  it("does not report an error as an empty history and allows retry", async () => {
    mocks.api.mockResolvedValueOnce({ ok: false, aborted: false, data: {} });
    render(<HistoricalInvoiceHistory customerId="customer-a" />);
    expect(await screen.findByText("بارگذاری فاکتورهای تاریخی ناموفق بود.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    expect(await screen.findByText(/external-17/)).toBeTruthy();
  });
  it("fetches a bounded line page only when requested and preserves source unit", async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, aborted: false, data: { invoices: [{ ...invoice, summaryOnly: false, sourceCurrency: "toman" }], hasMore: false } });
    mocks.api.mockResolvedValueOnce({ ok: true, aborted: false, data: { lines: [{ rowNumber: 2, lineName: "کالا", quantity: "1.5", unitPrice: "10.2" }], hasMore: false } });
    render(<HistoricalInvoiceHistory customerId="customer-a" />);
    fireEvent.click(await screen.findByRole("button", { name: "نمایش ردیف‌های فاکتور" }));
    expect(await screen.findByText(/تعداد: 1.5 · قیمت واحد: 10.2 تومان/)).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("/customer-a/historical-invoices/one?offset=0"), expect.anything());
  });
  it("uses the accounting endpoint when not scoped to one customer", async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, aborted: false, data: { invoices: [{ ...invoice, partyId: "party-1", externalCustomerCode: "C1" }], hasMore: false } });
    render(<HistoricalInvoiceHistory />);
    expect(await screen.findByText(/شناسهٔ مشتری: party-1/)).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("/api/accounting/historical-invoices?"), expect.anything());
  });

  it("labels history retained on an earlier merged customer", async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, aborted: false, data: { invoices: [{ ...invoice, partyId: "previous-customer" }], hasMore: false } });
    render(<HistoricalInvoiceHistory customerId="customer-a" />);
    expect(await screen.findByText("پروندهٔ قبلی ادغام‌شده")).toBeTruthy();
  });

});
