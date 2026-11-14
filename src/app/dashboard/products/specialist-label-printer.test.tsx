// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SpecialistLabelPrinter } from "./specialist-label-printer";
const apiMock = vi.fn();
const print = vi.fn();
vi.mock("../ui", async (original) => ({ ...await original<typeof import("../ui")>(), api: (...args: unknown[]) => apiMock(...args) }));
vi.mock("@/lib/printing/client", () => ({ printLabel: (...args: unknown[]) => print(...args) }));
beforeEach(() => {
  apiMock.mockReset(); print.mockReset();
  apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url.includes("?itemId=") ? { barcodes: [{ id: "b1", itemId: "i1", code: "2000000000015" }] } : { items: [{ id: "i1", name: "ساعت", sku: "W-1" }] } }));
  print.mockResolvedValue({ ok: true });
});
afterEach(cleanup);
async function select() { fireEvent.click(await screen.findByRole("button", { name: "انتخاب ساعت W-1" })); return screen.findByRole("button", { name: "چاپ برچسب ساعت 2000000000015" }); }

describe("native specialist labels", () => {
  it("prints a persisted barcode through the existing item-label pipeline", async () => {
    render(<SpecialistLabelPrinter industry="watch" canPrint canAssign={false} locationId="branch" />);
    expect(document.body.textContent).toContain("تنها کدی که با شماره‌سریال ثبت‌شده منطبق باشد");
    fireEvent.click(await select());
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(print).toHaveBeenCalledWith(null, { itemId: "i1", code: "2000000000015" }, expect.objectContaining({ requestId: expect.stringMatching(/^product-label:/) }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(apiMock.mock.calls.map(([url]) => url)).toEqual(["/api/watch/items", "/api/barcodes?itemId=i1"]);
  });
  it("blocks a repeat after uncertain delivery until explicitly checked", async () => {
    print.mockResolvedValue({ ok: false, ambiguous: true });
    render(<SpecialistLabelPrinter industry="watch" canPrint canAssign={false} locationId="branch" />);
    fireEvent.click(await select());
    expect((await screen.findByRole("alert")).textContent).toContain("نامشخص");
    const button = screen.getByRole("button", { name: "چاپ برچسب ساعت 2000000000015" });
    expect((button as HTMLButtonElement).closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "نتیجه را بررسی کردم" }));
    expect((button as HTMLButtonElement).closest("fieldset")?.disabled).toBe(false);
    expect(print).toHaveBeenCalledTimes(1);
  });
  it("does not print a mismatched code returned for another item", async () => {
    apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url.includes("?itemId=") ? { barcodes: [{ id: "b2", itemId: "other", code: "2000000000015" }] } : { items: [{ id: "i1", name: "ساعت", sku: "W-1" }] } }));
    render(<SpecialistLabelPrinter industry="watch" canPrint canAssign={false} locationId="branch" />);
    fireEvent.click(await screen.findByRole("button", { name: "انتخاب ساعت W-1" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(print).not.toHaveBeenCalled();
  });
  it("shows an empty state rather than inventing a code", async () => {
    apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url.includes("?itemId=") ? { barcodes: [] } : { items: [{ id: "i1", name: "ساعت", sku: "W-1" }] } }));
    render(<SpecialistLabelPrinter industry="jewelry" canPrint canAssign={false} locationId="branch" />);
    fireEvent.click(await screen.findByRole("button", { name: "انتخاب ساعت W-1" }));
    expect(await screen.findByText(/بارکدی ثبت نشده/)).toBeTruthy();
    expect(print).not.toHaveBeenCalled();
  });
  it("assigns a checked EAN code using the original branch without requiring print permission", async () => {
    apiMock.mockImplementation(async (url: string, init?: RequestInit) => init?.method === "POST" ? { ok: true, data: { ok: true } } : { ok: true, data: url.includes("?itemId=") ? { barcodes: [] } : { items: [{ id: "i1", name: "ساعت", sku: "W-1" }] } });
    render(<SpecialistLabelPrinter industry="watch" canPrint={false} canAssign locationId="branch" />);
    fireEvent.click(await screen.findByRole("button", { name: "انتخاب ساعت W-1" }));
    fireEvent.change(screen.getByLabelText("ثبت بارکد ۱۲ یا ۱۳ رقمی"), { target: { value: "۲۰۰۰۰۰۰۰۰۰۰۱۵" } });
    fireEvent.click(screen.getByRole("button", { name: "ثبت بارکد کالا" }));
    await waitFor(() => expect(apiMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = apiMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1].body)).toEqual({ itemId: "i1", code: "2000000000015", expectedLocationId: "branch" });
    expect(print).not.toHaveBeenCalled();
  });
  it("does not submit an invalid code or hide an uncertain write", async () => {
    apiMock.mockImplementation(async (url: string, init?: RequestInit) => init?.method === "POST" ? { ok: false, data: {} } : { ok: true, data: url.includes("?itemId=") ? { barcodes: [] } : { items: [{ id: "i1", name: "ساعت", sku: "W-1" }] } });
    render(<SpecialistLabelPrinter industry="watch" canPrint={false} canAssign locationId="branch" />);
    fireEvent.click(await screen.findByRole("button", { name: "انتخاب ساعت W-1" }));
    fireEvent.change(screen.getByLabelText("ثبت بارکد ۱۲ یا ۱۳ رقمی"), { target: { value: "2000000000016" } });
    fireEvent.click(screen.getByRole("button", { name: "ثبت بارکد کالا" }));
    expect(apiMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.change(screen.getByLabelText("ثبت بارکد ۱۲ یا ۱۳ رقمی"), { target: { value: "2000000000015" } });
    fireEvent.click(screen.getByRole("button", { name: "ثبت بارکد کالا" }));
    expect((await screen.findByRole("alert")).textContent).toContain("نتیجه مشخص نیست");
    expect((screen.getByRole("button", { name: "ثبت بارکد کالا" }) as HTMLButtonElement).closest("fieldset")?.disabled).toBe(true);
  });
  it("never offers a text-only legacy code as scannable bars", async () => {
    apiMock.mockImplementation(async (url: string) => ({ ok: true, data: url.includes("?itemId=") ? { barcodes: [{ id: "b1", itemId: "i1", code: "LEGACY" }] } : { items: [{ id: "i1", name: "ساعت", sku: "W-1" }] } }));
    render(<SpecialistLabelPrinter industry="watch" canPrint canAssign={false} locationId="branch" />);
    fireEvent.click(await screen.findByRole("button", { name: "انتخاب ساعت W-1" }));
    expect(await screen.findByText(/میلهٔ قابل اسکن ندارد/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /چاپ برچسب ساعت/ })).toBeNull();
  });
});
