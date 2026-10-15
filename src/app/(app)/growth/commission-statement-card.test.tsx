// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/app/dashboard/ui";
import { MoneyProvider, useMoney } from "@/components/money/money-context";
import { CommissionStatementCard } from "./commission-run-detail";

vi.mock("@/app/dashboard/ui", async (original) => ({ ...await original<typeof import("@/app/dashboard/ui")>(), api: vi.fn() }));
const request = vi.mocked(api);
const ID = "be2df188-7ebd-43a3-ae35-077752363edd";
const PAYROLL = "33d904ec-a3d5-4530-9042-b91f42a2ece3";
const statement = {
  employee: { id: "seller", fullName: "فروشنده" },
  totals: { accrued: "6000", paidThroughPayroll: "0", paidThroughRuns: "4000", unpaid: "2000" },
  accruals: [{ id: "accrual", amount: "1000", saleDate: "2026-10-15", sourceLabel: "فروش", payrollRunId: PAYROLL, settledRef: "حقوق مهر", settlementRunId: null, entryId: null }],
  payouts: [], runs: [{ runId: ID, runNumber: 1 }], page: { hasMoreAccruals: false, hasMorePayouts: false },
};
function Card() { return <CommissionStatementCard employeeId="seller" money={useMoney()} onClose={() => {}} />; }
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("statement selection ownership", () => {
  it("keeps run choices while hiding old financial rows during a filter request", async () => {
    request.mockResolvedValueOnce({ ok: true, status: 200, data: statement, aborted: false });
    let complete!: (value: { ok: boolean; status: number; data: typeof statement; aborted: boolean }) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    render(<MoneyProvider unit="rial"><Card /></MoneyProvider>);
    const select = await screen.findByRole("combobox", { name: "دوره تسویه" });
    await waitFor(() => expect(screen.getByRole("option", { name: "دورهٔ ۱" })).toBeTruthy());
    fireEvent.change(select, { target: { value: ID } });
    expect(screen.getByRole("option", { name: "دورهٔ ۱" })).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe(ID);
    expect(screen.queryByRole("table", { name: "ردیف‌های پورسانت فروشنده" })).toBeNull();
    await act(async () => complete({ ok: true, status: 200, data: { ...statement, accruals: [] }, aborted: false }));
    expect(await screen.findByRole("table", { name: "ردیف‌های پورسانت فروشنده" })).toBeTruthy();
    expect(request.mock.calls.at(-1)?.[0]).toContain(`runId=${ID}`);
  });

  it("links a payroll-held row to its exact authorized source instead of the workspace only", async () => {
    request.mockResolvedValue({ ok: true, status: 200, data: statement, aborted: false });
    render(<MoneyProvider unit="rial"><Card /></MoneyProvider>);
    expect((await screen.findByRole("link", { name: "حقوق مهر" })).getAttribute("href")).toBe(`/accounting/payroll?run=${PAYROLL}`);
  });
});
