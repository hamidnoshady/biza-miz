// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VendorPaymentControls, type VendorPaymentCost } from "./vendor-payment-controls";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const cost: VendorPaymentCost = {
  id: "cost-a", costNumber: "RC-001", vendorName: "رسانه", amountRial: 5000000,
  posted: true, settledBy: "payable", settled: false,
};
function mockApi(data: unknown) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));
  vi.stubGlobal("fetch", fetcher); return fetcher;
}

describe("vendor payment controls", () => {
  it("offers only posted unpaid payables with a named payee", () => {
    render(<VendorPaymentControls costs={[cost, { ...cost, id: "cash", costNumber: "cash", settledBy: "cash" },
      { ...cost, id: "pending", costNumber: "pending", posted: false },
      { ...cost, id: "blank", costNumber: "blank", vendorName: "" }]} onChanged={() => {}} />);
    const choices = screen.getByLabelText("هزینهٔ قابل پرداخت") as HTMLSelectElement;
    expect(choices.options).toHaveLength(2);
    expect(choices.options[1].value).toBe(cost.id);
  });
  it("sends the selected cost, date and method without inventing another expense", async () => {
    const fetcher = mockApi({ settlement: { settlementNumber: "VS-001" } }); const changed = vi.fn();
    render(<VendorPaymentControls costs={[cost]} onChanged={changed} />);
    fireEvent.change(screen.getByLabelText("تاریخ پرداخت یا برگشت"), { target: { value: "2026-11-06" } });
    fireEvent.change(screen.getByLabelText("هزینهٔ قابل پرداخت"), { target: { value: cost.id } });
    fireEvent.click(screen.getByRole("button", { name: "ثبت پرداخت به فروشنده" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ costIds: [cost.id], method: "bank", paidOn: "2026-11-06" });
  });
  it("requires confirmation that the whole payment is reversed", async () => {
    const fetcher = mockApi({ reversal: { reversalEntryId: "entry" } });
    render(<VendorPaymentControls costs={[{ ...cost, settled: true, settlementId: "pay-a", settlementNumber: "VS-001" }]} onChanged={() => {}} />);
    fireEvent.change(screen.getByLabelText("تاریخ پرداخت یا برگشت"), { target: { value: "2026-11-06" } });
    fireEvent.change(screen.getByLabelText("پرداخت برای برگشت"), { target: { value: "pay-a" } });
    const button = screen.getByRole("button", { name: "برگشت کل پرداخت" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(button);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls[0][0]).toBe("/api/agency/vendor-settlements/pay-a/reverse");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ reversedOn: "2026-11-06" });
  });
});
