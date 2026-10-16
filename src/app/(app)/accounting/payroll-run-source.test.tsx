// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { api } from "@/app/dashboard/ui";
import type { PayrollRun } from "@/lib/payroll-types";
import { PayrollRunSource } from "./payroll-run-source";

vi.mock("@/app/dashboard/ui", async (original) => ({ ...await original<typeof import("@/app/dashboard/ui")>(), api: vi.fn() }));
const request = vi.mocked(api);
const ID = "24f33456-47dd-44e4-b051-2091853c66a8";
const OTHER = "b89bc60c-ed1b-401e-80fc-559c112dd657";
function source(name = "نام ثبت‌شده فروشنده", id = ID): PayrollRun {
  return { id, periodKey: "1403-12", periodLabel: "اسفند ۱۴۰۳", status: "accrued", totalAmount: "0", netAmount: "0",
    commissionTotal: "21", payableAmount: "21", accrualDate: "2025-03-20", paidDate: null, voidedDate: null,
    createdByName: "حسابدار", lineCount: 1, lines: [{ userId: "seller", fullName: name, role: "cashier", employeeCode: "1",
      amount: "0", baseSalaryRial: "0", taxableAllowancesRial: "0", nonTaxableAllowancesRial: "0", overtimeRial: "0",
      grossRial: "0", insuranceBaseRial: "0", employeeInsuranceRial: "0", employerInsuranceRial: "0",
      unemploymentInsuranceRial: "0", taxableIncomeRial: "0", incomeTaxRial: "0", otherDeductionsRial: "0",
      advanceRecoveryRial: "0", netPayRial: "0", employerCostRial: "0", commissionAmount: "21", payableAmount: "21" }] };
}
function result(run: PayrollRun) { return { ok: true, status: 200, data: { run }, aborted: false }; }
function view(id = ID) { return <MoneyProvider unit="rial"><PayrollRunSource runId={id} /></MoneyProvider>; }
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("payroll source deep links", () => {
  it("loads the exact run even outside history pages, opens its immutable lines, and is read-only", async () => {
    request.mockResolvedValue(result(source()));
    render(view());
    expect(await screen.findByText("نام ثبت‌شده فروشنده")).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(`/api/ledger/payroll/runs/${ID}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByRole("button", { name: "بستن جزئیات" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: "ثبت پرداخت حقوق" })).toBeNull();
    expect(screen.queryByRole("button", { name: /ابطال تعهد/ })).toBeNull();
    expect(screen.getByRole("link", { name: "بستن لیست پیوندشده" }).getAttribute("href")).toBe("/accounting/payroll");
    expect(document.body.textContent).not.toContain("2025-03-20");
  });

  it("aborts and ignores an older run response when the source URL changes", async () => {
    let resolveOld!: (value: ReturnType<typeof result>) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    request.mockResolvedValueOnce(result(source("فروشنده جدید", OTHER)));
    const page = render(view());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const signal = request.mock.calls[0][1]?.signal;
    page.rerender(view(OTHER));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText("فروشنده جدید")).toBeTruthy();
    await act(async () => resolveOld(result(source("پاسخ قدیمی"))));
    expect(screen.queryByText("پاسخ قدیمی")).toBeNull();
    expect(screen.getByText("فروشنده جدید")).toBeTruthy();
  });

  it.each([403, 404])("keeps a %i refusal visible and retries without falling back to an unrelated run", async (status) => {
    request.mockResolvedValueOnce({ ok: false, status, data: { error: status === 404 ? "run_not_found" : "forbidden" }, aborted: false });
    request.mockResolvedValueOnce(result(source()));
    render(view());
    const retry = await screen.findByRole("button", { name: "تلاش دوباره" });
    expect(screen.queryByText("نام ثبت‌شده فروشنده")).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByText("نام ثبت‌شده فروشنده")).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
