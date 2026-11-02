/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "@/app/dashboard/ui";
import { MoneyProvider } from "@/components/money/money-context";
import type { MoneyUnit } from "@/lib/money";
import { printWooOrder } from "@/lib/printing/client";
import { CONNECTION, JOB, REVISION, wooDetail } from "@/lib/printing/__fixtures__/woo-order";
import { WooOrderDetailModal } from "./woo-order-detail-modal";

vi.mock("@/app/dashboard/ui", async original => ({ ...await original<typeof import("@/app/dashboard/ui")>(), api: vi.fn() }));
vi.mock("@/lib/printing/client", () => ({ printWooOrder: vi.fn() }));
let source = wooDetail();
let canPrint = true;
const close = vi.fn();
const response = () => ({ detail: source, canPrint, printing: { jobs: [], plans: { shipping_label: { ok: false, error: "printer_not_configured" }, woo_invoice: { ok: false, error: "printer_not_configured" } }, printers: [], templates: [] } });
const open = async (unit: MoneyUnit = "toman") => { render(<MoneyProvider unit={unit}><WooOrderDetailModal connectionId={CONNECTION} remoteId="1042" onClose={close} /></MoneyProvider>); await screen.findByRole("button", { name: "چاپ فاکتور" }); };
const printTab = () => fireEvent.click(screen.getByRole("tab", { name: "چاپ" }));
beforeEach(() => {
  vi.clearAllMocks();
  source = wooDetail(); canPrint = true;
  vi.mocked(api).mockImplementation((async (url: string) => ({ ok: true, status: 200, aborted: false, data: url.includes("preview") ? { imageBase64: "AAAA", paper: { key: "label100x150", widthMm: 100, heightMm: 150 }, templateName: "قالب تست", printerName: "چاپگر تست" } : response() })) as never);
  vi.mocked(printWooOrder).mockResolvedValue({ ok: true, jobId: JOB });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("responsive RTL Woo detail overlay", () => {
  it("provides six accessible tabs and closes without changing the list route/filter state", async () => {
    const before = location.href;
    await open();
    expect(screen.getAllByRole("tab")).toHaveLength(6);
    expect(screen.getByRole("dialog").getAttribute("dir")).toBe("rtl");
    expect(screen.getByText("ثبت نشده — چاپ همچنان ممکن است")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "مشتری و ارسال" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("سارا احمدی");
    fireEvent.click(screen.getByRole("button", { name: "بستن" }));
    expect(close).toHaveBeenCalledOnce();
    expect(location.href).toBe(before);
  });
  it("opens on a summary with the status, customer, totals and recent lines before any technical detail", async () => {
    await open();
    const selected = screen.getByRole("tab", { selected: true });
    expect(selected.textContent).toBe("خلاصه");
    expect(screen.getByRole("tabpanel").textContent).toContain("سارا احمدی");
    // pending → its Persian label sits beside the order number, and the totals strip is labelled.
    expect(screen.getByRole("dialog").textContent).toContain("در انتظار پرداخت");
    expect(screen.getByRole("group", { name: "خلاصهٔ مبالغ سفارش" }) ?? screen.getByLabelText("خلاصهٔ مبالغ سفارش")).toBeTruthy();
    // The source/version record is the second-to-last tab, not the first one.
    expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["خلاصه", "اقلام و مبالغ", "مشتری و ارسال", "پرداخت و وضعیت", "سوابق و منبع", "چاپ"]);
  });
  it("changes the status from the modal, offering the store's custom statuses, and reloads", async () => {
    const onChange = vi.fn().mockResolvedValue(true);
    render(<MoneyProvider unit="toman"><WooOrderDetailModal connectionId={CONNECTION} remoteId="1042" onClose={close}
      statusChoices={["pending", "processing", "completed", "shipped"]} onChangeStatus={onChange} /></MoneyProvider>);
    await screen.findByRole("button", { name: "چاپ فاکتور" });
    const select = screen.getByRole("combobox", { name: "تغییر وضعیت سفارش" });
    expect([...select.querySelectorAll("option")].map(option => option.value)).toContain("shipped");
    const calls = vi.mocked(api).mock.calls.length;
    fireEvent.change(select, { target: { value: "shipped" } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("shipped"));
    await screen.findByText(/تغییر وضعیت به «shipped» در صف قرار گرفت/);
    expect(vi.mocked(api).mock.calls.length).toBeGreaterThan(calls);
  });
  it.each([
    ["IRR", "toman", "۲٫۴۴۵ تومان"],
    ["IRT", "rial", "۲۴۴٫۵ ریال"],
    ["USD", "toman", "۲۴٫۴۵ USD"],
    ["AED", "rial", "۲۴٫۴۵ AED"],
  ] as const)("honors business %s → %s presentation without changing source money", async (currency, unit, expected) => {
    source = wooDetail({ currency });
    await open(unit);
    fireEvent.click(screen.getByRole("tab", { name: "اقلام و مبالغ" }));
    expect(screen.getByRole("tabpanel").textContent).toContain(expected);
    expect(source.order.currency).toBe(currency);
    expect(source.order.total).toBe("24.45");
    fireEvent.click(screen.getByRole("tab", { name: "پرداخت و وضعیت" }));
    expect(screen.getByRole("tabpanel").textContent).toContain(expected);
  });
  it("returns keyboard focus to the originating list action on close", async () => {
    function List() {
      const [opened, setOpened] = useState(false);
      return <><button onClick={() => setOpened(true)}>جزئیات ردیف</button>{opened ? <WooOrderDetailModal connectionId={CONNECTION} remoteId="1042" onClose={() => setOpened(false)} /> : null}</>;
    }
    render(<List />);
    const opener = screen.getByRole("button", { name: "جزئیات ردیف" });
    opener.focus(); fireEvent.click(opener);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "بستن" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  it("allows a pending remote-only invoice without a local UUID; sends identity/allowed overrides only", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "چاپ فاکتور" }));
    await waitFor(() => expect(printWooOrder).toHaveBeenCalledOnce());
    expect(printWooOrder).toHaveBeenCalledWith({ kind: "woo-order-invoice", connectionId: CONNECTION, remoteId: "1042", snapshotId: REVISION }, expect.objectContaining({ printerId: null, templateId: null, templateKey: null, requestId: expect.any(String) }));
    expect(JSON.stringify(vi.mocked(printWooOrder).mock.calls)).not.toContain("09121234567");
    expect(JSON.stringify(vi.mocked(printWooOrder).mock.calls)).not.toContain("24.45");
    expect(source.localOrderId).toBeNull();
  });
  it("lists missing shipping fields and disables only shipping actions, not the invoice", async () => {
    source = wooDetail({ shipping: {} });
    await open();
    expect(screen.getByRole("button", { name: "چاپ برچسب ارسال" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "چاپ هر دو" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "چاپ فاکتور" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/نام گیرنده، نشانی، شهر، کد پستی، کشور/)).toBeTruthy();
  });
  it("does not offer hardware actions without printing.execute", async () => {
    canPrint = false;
    await open();
    fireEvent.click(screen.getByRole("button", { name: "چاپ فاکتور" }));
    expect(printWooOrder).not.toHaveBeenCalled();
  });
  it("guards double clicks synchronously and prevents closing while a job is pending", async () => {
    let finish!: (result: { ok: true; jobId: string }) => void;
    vi.mocked(printWooOrder).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await open();
    const button = screen.getByRole("button", { name: "چاپ فاکتور" });
    fireEvent.click(button); fireEvent.click(button);
    expect(printWooOrder).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "بستن" }).hasAttribute("disabled")).toBe(true);
    finish({ ok: true, jobId: JOB });
    await waitFor(() => expect(screen.getByRole("button", { name: "بستن" }).hasAttribute("disabled")).toBe(false));
  });
  it("distinguishes two packages from two copies, orders documents explicitly and gives every job its own correlation", async () => {
    await open(); printTab();
    fireEvent.change(screen.getByLabelText("تعداد نسخه از هر سند"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("تعداد بسته (برچسب جدا برای هر بسته)"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("ترتیب چاپ هر دو"), { target: { value: "invoice" } });
    fireEvent.click(screen.getByRole("button", { name: "چاپ انتخاب‌شده" }));
    await waitFor(() => expect(printWooOrder).toHaveBeenCalledTimes(6));
    const calls = vi.mocked(printWooOrder).mock.calls;
    expect(calls.slice(0, 2).every(([ref]) => ref.kind === "woo-order-invoice")).toBe(true);
    expect(calls.slice(2).map(([ref]) => [ref.packageIndex, ref.packageCount])).toEqual([[1, 2], [1, 2], [2, 2], [2, 2]]);
    expect(new Set(calls.map(([, options]) => options?.requestId)).size).toBe(6);
    expect(calls.every(([, options]) => options!.requestId!.length <= 120)).toBe(true);
    expect(vi.mocked(api).mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true); // one-off choices are never persisted
  });
  it("stops a partial batch after its first failed document and never repeats successful work automatically", async () => {
    vi.mocked(printWooOrder).mockResolvedValueOnce({ ok: true, jobId: JOB }).mockResolvedValueOnce({ ok: false, error: "printer_offline" });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "چاپ هر دو" }));
    await waitFor(() => expect(screen.getByText(/فقط سند ناموفق را مجدداً انتخاب کنید/)).toBeTruthy());
    expect(printWooOrder).toHaveBeenCalledTimes(2);
  });
  it("requires explicit confirmation after an ambiguous handoff, including the top-level print action", async () => {
    vi.mocked(printWooOrder).mockResolvedValue({ ok: false, error: "job_timeout", ambiguous: true });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "چاپ فاکتور" }));
    await screen.findByText(/وضعیت تحویل نامشخص است/);
    await waitFor(() => expect(screen.getByRole("button", { name: "چاپ فاکتور" }).hasAttribute("disabled")).toBe(false));
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "چاپ فاکتور" }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(printWooOrder).toHaveBeenCalledOnce();
  });
  it("requires an explicit choice for multi-shipment orders", async () => {
    source = wooDetail({ shipments: [{ tracking_number: "1111" }, { tracking_number: "2222" }] });
    await open();
    expect(screen.getByRole("button", { name: "چاپ برچسب ارسال" }).hasAttribute("disabled")).toBe(true);
    printTab();
    fireEvent.change(screen.getByLabelText("مرسوله (انتخاب الزامی)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "چاپ برچسب ارسال" }));
    await waitFor(() => expect(printWooOrder).toHaveBeenCalledWith(expect.objectContaining({ shipmentIndex: 1 }), expect.anything()));
  });
  it("previews through the first-party authorized renderer, with no browser HTML/window.print", async () => {
    await open(); printTab();
    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش" }));
    const image = await screen.findByAltText("پیش‌نمایش برچسب ارسال");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    const body = JSON.parse(String(vi.mocked(api).mock.calls.find(([url]) => url === "/api/printing/preview")?.[1]?.body));
    expect(body.document).toEqual({ kind: "woo-order-shipping-label", connectionId: CONNECTION, remoteId: "1042", snapshotId: REVISION, packageIndex: 1, packageCount: 1 });
    expect(body).not.toHaveProperty("html");
    expect(printWooOrder).not.toHaveBeenCalled();
  });
});
