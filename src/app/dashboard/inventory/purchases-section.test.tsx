/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../ui";
import { PurchasesSection } from "./purchases-section";
import type { InvoiceOcrApplyPayload } from "./invoice-ocr-panel";
import type { SupplierInvoiceDraft } from "./supplier-invoice-fields";

vi.mock("../ui", async original => ({ ...await original<typeof import("../ui")>(), api: vi.fn() }));
vi.mock("./invoice-ocr-panel", () => ({ InvoiceOcrPanel: ({ onApply }: { onApply: (payload: InvoiceOcrApplyPayload) => void }) =>
  <button onClick={() => onApply({ supplierId: "", purchaseDate: "2026-10-01", note: "", lines: [], invoiceAssetId: null, invoiceNumber: "OCR-915", invoiceDate: "2026-10-01" })}>apply scan</button> }));
vi.mock("./supplier-invoice-fields", async original => ({ ...await original<typeof import("./supplier-invoice-fields")>(),
  SupplierInvoiceFields: ({ value, onChange }: { value: SupplierInvoiceDraft; onChange: (v: SupplierInvoiceDraft) => void }) =>
    <><input aria-label="invoice-number" value={value.invoiceNumber} onChange={e => onChange({ ...value, invoiceNumber: e.target.value })} /><span>{value.invoiceDate}</span></> }));
const row = { id: "p1", status: "draft", total: "100", note: null, supplier_id: "s1", supplier_name: "supplier", purchase_date: "2026-10-01" };
const props = { items: [], suppliers: [], busy: false, run: vi.fn() };
const reply = (data: object, ok = true) => ({ ok, data, status: ok ? 200 : 503, aborted: false });
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(api).mockResolvedValue(reply({ purchases: [row], count: 1, total: "100" }) as never);
});
afterEach(cleanup);

describe("#915 purchase permissions, detail recovery and OCR metadata", () => {
  it("keeps draft history readable without any mutation or OCR controls", async () => {
    render(<PurchasesSection {...props} canManage={false} />);
    await screen.findByText(/supplier/);
    for (const text of ["ثبت پیش‌نویس خرید", "ثبت سفارش", "دریافت کالا", "لغو", "حذف", "apply scan"]) {
      expect(screen.queryByRole("button", { name: text })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "مشاهده جزئیات" })).toBeTruthy();
  });
  it("offers detail retry instead of leaving a permanent loading skeleton", async () => {
    vi.mocked(api).mockImplementation(async url => url.endsWith("/p1") ? reply({}, false) : reply({ purchases: [row], count: 1, total: "100" }) as never);
    render(<PurchasesSection {...props} canManage />);
    fireEvent.click(await screen.findByRole("button", { name: "مشاهده جزئیات" }));
    await screen.findByText("خواندن جزئیات خرید ناموفق بود.");
    vi.mocked(api).mockResolvedValue(reply({ purchase: row, items: [] }) as never);
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await waitFor(() => expect(screen.queryByText("خواندن جزئیات خرید ناموفق بود.")).toBeNull());
    await screen.findByRole("button", { name: "ویرایش" });
  });
  it("explains periodic returns instead of offering an action guaranteed to fail", async () => {
    vi.mocked(api).mockImplementation(async url => url.endsWith("/p1")
      ? reply({ purchase: { ...row, status: "received" }, items: [] })
      : reply({ purchases: [{ ...row, status: "received" }], count: 1, total: "100" }) as never);
    render(<PurchasesSection {...props} canManage inventorySystem="periodic" />);
    fireEvent.click(await screen.findByRole("button", { name: "مشاهده جزئیات" }));
    await screen.findByText(/برگشت خرید ادواری در این فرم پشتیبانی نمی‌شود/);
    expect(screen.queryByRole("button", { name: "برگشت به تأمین‌کننده" })).toBeNull();
  });
  it("applies editable OCR invoice number/date without overwriting an intentional number", async () => {
    render(<PurchasesSection {...props} canManage />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "apply scan" })); });
    expect((screen.getByLabelText("invoice-number") as HTMLInputElement).value).toBe("OCR-915");
    fireEvent.change(screen.getByLabelText("invoice-number"), { target: { value: "MANUAL" } });
    fireEvent.click(screen.getByRole("button", { name: "apply scan" }));
    expect((screen.getByLabelText("invoice-number") as HTMLInputElement).value).toBe("MANUAL");
  });
});
