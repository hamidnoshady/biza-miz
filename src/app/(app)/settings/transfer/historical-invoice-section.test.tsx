/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/app/dashboard/ui", async (original) => ({ ...(await original<typeof import("@/app/dashboard/ui")>()), api: mocks.api }));
import { HistoricalInvoiceSection } from "./historical-invoice-section";

const job = { jobId: "123", fileName: "source.csv", rowCount: 1, status: "pending", createdAt: "2024-01-01T00:00:00Z",
  sourceKey: "old", provider: "generic", currency: "rial", calendar: "jalali", columns: ["شناسه", "تاریخ", "کد", "مبلغ"], structure: "flat", lineColumns: null };
const successful = (data: unknown) => ({ ok: true, status: 200, data, aborted: false });
const preview = { totalInvoices: 1, matchedCustomers: 0, reviewNeeded: 1, conflicts: 0, invalid: 0, toCreate: 0, alreadyImported: 0, summaryOnly: 1,
  documents: [{ externalInvoiceId: "inv-1", outcome: "review", totalRial: "100", errors: [], warnings: [], rows: [{ externalCustomerCode: "C1" }] }],
  hasMoreDocuments: false, orphanLineCount: 0, orphanLines: [], hasMoreOrphans: false, reconciliation: { totalRial: "100", paidRial: "0", balanceRial: "100" } };

beforeEach(() => {
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === "search-customer") return successful({ customers: [{ id: "p1", name: "مشتری فعلی", phoneLast4: "1234" }] });
    if (body.action === "list") return successful({ jobs: [job], hasMore: false });
    if (body.action === "get") return successful({ job });
    if (body.action === "preview") return successful({ preview, executionAvailable: false });
    if (body.action === "review-customer") return successful({ review: { externalCustomerCode: "C1", targetCustomer: { partyId: "p1", name: "مشتری فعلی", phoneLast4: "1234" },
      sourceNames: ["مشتری قدیم"], sourcePhones: ["0912"], rows: [{ externalInvoiceId: "inv-1" }], matchingRows: 1, truncated: false, evidenceTruncated: false, existingIdentity: null, reviewToken: "abc" } });
    if (body.action === "confirm-customer") return successful({ result: "created" });
    throw new Error(`unexpected command: ${body.action}`);
  });
});
afterEach(cleanup);

describe("historical invoice review", () => {
  it("shows a loading state instead of an empty history while the request is pending", async () => {
    let resolve!: (value: unknown) => void;
    mocks.api.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(<HistoricalInvoiceSection />);
    expect(screen.getByRole("status", { name: "در حال بارگذاری فایل‌های تاریخی" })).toBeTruthy();
    expect(screen.queryByText("فایلی برای نمایش نیست.")).toBeNull();
    resolve(successful({ jobs: [], hasMore: false }));
    expect(await screen.findByText("فایلی برای نمایش نیست.")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "در حال بارگذاری فایل‌های تاریخی" })).toBeNull();
  });
  it("reports a failed history request instead of saying it is empty", async () => {
    mocks.api.mockResolvedValueOnce({ ok: false, status: 503, data: { error: "service_unavailable" }, aborted: false });
    render(<HistoricalInvoiceSection />);
    expect(await screen.findByText("بارگذاری فایل‌ها ممکن نشد.")).toBeTruthy();
    expect(screen.queryByText("فایلی برای نمایش نیست.")).toBeNull();
  });
  it("requires explicit mapping and customer review, and never offers invoice execution", async () => {
    render(<HistoricalInvoiceSection />);
    expect(screen.getByText(/اجرای ورود هنوز فعال نیست/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /source.csv/ }));
    await screen.findByText(/نگاشت ستون‌ها: source.csv/);
    fireEvent.change(screen.getByLabelText("شناسهٔ فاکتور در مبدأ (الزامی)"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("تاریخ فاکتور (الزامی)"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("کد مشتری در مبدأ (الزامی)"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("مبلغ کل (الزامی)"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش بدون ثبت" }));
    await screen.findByText(/inv-1/);
    expect(screen.queryByRole("button", { name: /اجرای ورود/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "بررسی مشتری این فاکتور" }));
    fireEvent.change(screen.getByLabelText("جست‌وجوی مشتری موجود"), { target: { value: "مشتری" } });
    fireEvent.click(screen.getByRole("button", { name: "جست‌وجو" }));
    fireEvent.click(await screen.findByRole("button", { name: /مشتری فعلی/ }));
    expect(mocks.api.mock.calls.filter(([, init]) => JSON.parse(String(init?.body ?? "{}"))?.action === "confirm-customer")).toHaveLength(0);
    const baseline = mocks.api.getMockImplementation()!;
    let firstReview = true;
    mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.action === "review-customer" && firstReview) {
        firstReview = false;
        return successful({ review: { externalCustomerCode: "C1", targetCustomer: { partyId: "p1", name: "مشتری فعلی", phoneLast4: "1234" },
          sourceNames: ["مشتری قدیم"], sourcePhones: ["0912"], rows: [{ externalInvoiceId: "inv-1" }], matchingRows: 100,
          truncated: true, evidenceTruncated: true, existingIdentity: null, reviewToken: "abc" } });
      }
      return baseline(url, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "نمایش جزئیات پیوند" }));
    const section = await screen.findByRole("region", { name: "پیوند مشتری موجود" });
    const disabled = await within(section).findByRole("button", { name: "تأیید پیوند همین مشتری" });
    expect((disabled as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(section).getByRole("button", { name: "نمایش جزئیات پیوند" }));
    await waitFor(() => expect((within(section).getByRole("button", { name: "تأیید پیوند همین مشتری" }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(section).getByText(/مشتری قدیم/)).toBeTruthy();
    expect(within(section).getByText(/0912/)).toBeTruthy();
    fireEvent.change(within(section).getByLabelText("کد مشتری در فایل"), { target: { value: "C2" } });
    expect(within(section).queryByRole("button", { name: "تأیید پیوند همین مشتری" })).toBeNull();
    fireEvent.change(within(section).getByLabelText("کد مشتری در فایل"), { target: { value: "C1" } });
    fireEvent.click(within(section).getByRole("button", { name: "نمایش جزئیات پیوند" }));
    fireEvent.click(await within(section).findByRole("button", { name: "تأیید پیوند همین مشتری" }));
    await screen.findByText(/پیوند مشتری با تأیید شما ثبت شد/);
    const calls = mocks.api.mock.calls.filter(([, init]) => init?.body).map(([, init]) => JSON.parse(String(init.body)));
    expect(calls.find((call) => call.action === "preview").mapping.columns).toEqual([
      { field: "externalInvoiceId", column: 0 }, { field: "invoiceDate", column: 1 }, { field: "externalCustomerCode", column: 2 }, { field: "total", column: 3 },
    ]);
    expect(calls.find((call) => call.action === "confirm-customer")).toMatchObject({ partyId: "p1", externalCustomerCode: "C1", reviewToken: "abc", confirmed: true });
    expect(calls.some((call) => ["run", "execute", "approve"].includes(call.action))).toBe(false);
    await waitFor(() => expect(screen.queryByRole("button", { name: "تأیید پیوند همین مشتری" })).toBeNull());
  });
  it("sends only explicit CSV text to staging and does not accept XLSX", async () => {
    const baseline = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.headers as Record<string, string>)?.["Content-Type"] === "application/vnd.bizamiz.historical-invoice+json") {
        return successful({ staged: { jobId: job.jobId }, executionAvailable: false });
      }
      return baseline(url, init);
    });
    render(<HistoricalInvoiceSection />);
    await screen.findByRole("button", { name: /source.csv/ });
    fireEvent.change(screen.getByLabelText(/شناسهٔ ثابت سامانهٔ مبدأ/), { target: { value: "old" } });
    const file = new File(["id,total\n001,9007199254740993"], "old.csv", { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("\uFEFFid,total\n001,9007199254740993").buffer });
    fireEvent.change(screen.getByLabelText("فایل CSV یا JSON با کدگذاری UTF-8"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ فایل برای بررسی" }));
    await screen.findByText(/فایل برای بررسی ذخیره شد/);
    const upload = mocks.api.mock.calls.find(([, init]) => init?.headers?.["Content-Type"] === "application/vnd.bizamiz.historical-invoice+json");
    expect(JSON.parse(String(upload![1].body))).toMatchObject({ fileName: "old.csv", format: "csv", content: "\uFEFFid,total\n001,9007199254740993", sourceKey: "old" });
    const xlsx = new File(["not excel"], "bad.xlsx");
    fireEvent.change(screen.getByLabelText("فایل CSV یا JSON با کدگذاری UTF-8"), { target: { files: [xlsx] } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ فایل برای بررسی" }));
    expect(await screen.findByText(/فعلاً فقط فایل CSV یا JSON پذیرفته می‌شود/)).toBeTruthy();
    expect(mocks.api.mock.calls.filter(([, init]) => init?.headers?.["Content-Type"] === "application/vnd.bizamiz.historical-invoice+json")).toHaveLength(1);
  });

});
