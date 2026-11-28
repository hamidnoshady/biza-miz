// @vitest-environment jsdom
//
// GH #1567 Phase 6.3 — the subcontract section of the production order sheet.
//   - a stage is assigned to one of the branch's canonical suppliers with a
//     per-piece rate (entered in the business's money unit, sent in Rial);
//   - approval is only offered to a member with «تأیید سند حسابداری»;
//   - a delivery is recorded as accepted / rework / scrapped / missing in one
//     action; custody material is shown and can be returned;
//   - a dispute freezes «ارسال» and «بستن» and offers «حل اختلاف» with a chargeback;
//   - without permission to act nothing mutating is shown.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubcontractsSection, type Subcontract } from "./subcontracts-section";

const STAGES = [{ code: "cut", label: "برش" }, { code: "sew", label: "دوخت" }, { code: "finish", label: "تکمیل و اتو" }];
const MATERIALS = [{ materialItemId: "fabric", name: "پارچه کرپ", unit: "متر" }];
const SUPPLIERS = [{ id: "sup-1", name: "خیاطی سارا" }];

function subcontract(overrides: Partial<Subcontract> = {}): Subcontract {
  return {
    id: "sc-1", reference: "SUB-1", supplierId: "sup-1", supplierName: "خیاطی سارا", stageCode: "sew", ratePerUnitRial: 150_000,
    status: "approved", approvedByName: "مدیر", sentQuantity: "10", acceptedQuantity: "6", scrappedQuantity: "1", shortageQuantity: "1",
    reworkQuantity: "2", heldQuantity: "2", accruedRial: 900_000, chargebackRial: 0, disputeNote: null,
    custody: [{ materialItemId: "fabric", name: "پارچه کرپ", unit: "متر", sentQuantity: "20", returnedQuantity: "0",
      consumedQuantity: "14", lostQuantity: "2", heldQuantity: "4" }],
    ...overrides,
  };
}

function renderSection(props: Partial<Parameters<typeof SubcontractsSection>[0]> = {}) {
  const onAct = vi.fn(async () => true);
  const onError = vi.fn();
  render(
    <SubcontractsSection subcontracts={[]} suppliers={SUPPLIERS} stages={STAGES} materials={MATERIALS} orderStatus="in_progress"
      canAct canApprove busy={false} onAct={onAct} onError={onError} {...props} />,
  );
  return { onAct, onError };
}

afterEach(() => {
  cleanup();
});

describe("subcontracted stages (GH #1567 6.3)", () => {
  it("assigns a stage to a branch supplier with the per-piece rate in Rial", async () => {
    const { onAct } = renderSection();
    expect(screen.getByText("مرحله‌ای به پیمانکار سپرده نشده")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "پیمانکار" }));
    fireEvent.click(await screen.findByRole("option", { name: "خیاطی سارا" }));
    fireEvent.change(screen.getByLabelText(/اجرت هر عدد پذیرفته‌شده/), { target: { value: "15000" } });
    fireEvent.click(screen.getByRole("button", { name: "ثبت پیمانکار" }));
    // The default unit is toman: 15,000 toman = 150,000 Rial; the sewing stage is preselected.
    await waitFor(() => expect(onAct).toHaveBeenCalledWith({ action: "subcontract_create", supplierId: "sup-1", stage: "sew", ratePerUnitRial: 150_000 }));
  });

  it("offers approval only with ledger approval permission", () => {
    renderSection({ subcontracts: [subcontract({ status: "draft", sentQuantity: "0", acceptedQuantity: "0", scrappedQuantity: "0",
      shortageQuantity: "0", reworkQuantity: "0", heldQuantity: "0", accruedRial: 0, custody: [] })], canApprove: false });
    expect(screen.queryByRole("button", { name: "تأیید قرارداد" })).toBeNull();
    expect(screen.getByText(/به دسترسی «تأیید سند حسابداری» نیاز دارد/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ارسال" })).toBeNull();
  });

  it("records a mixed delivery in one action and shows what the subcontractor still holds", async () => {
    const { onAct } = renderSection({ subcontracts: [subcontract()] });
    const card = screen.getByRole("listitem", { name: "قرارداد SUB-1" });
    expect(within(card).queryByText("در انتظار تأیید")).toBeNull();
    expect(within(card).getByText(/نزد پیمانکار ۴/)).toBeTruthy();
    fireEvent.change(within(card).getByLabelText("پذیرفته"), { target: { value: "۱" } });
    fireEvent.change(within(card).getByLabelText("برگشت برای دوباره‌کاری"), { target: { value: "1" } });
    fireEvent.click(within(card).getByRole("button", { name: "ثبت تحویل" }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith({
      action: "subcontract_receive", subcontractId: "sc-1", accepted: "1", rework: "1", scrapped: null, shortage: null,
    }));
  });

  it("returns custody material to stock", async () => {
    const { onAct } = renderSection({ subcontracts: [subcontract()] });
    fireEvent.click(screen.getByRole("button", { name: "مادهٔ برگشتی" }));
    fireEvent.click(await screen.findByRole("option", { name: /پارچه کرپ/ }));
    fireEvent.change(screen.getByLabelText("مقدار برگشتی"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "برگشت به انبار" }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith({
      action: "subcontract_return_materials", subcontractId: "sc-1", lines: [{ materialItemId: "fabric", quantity: "4" }],
    }));
  });

  it("freezes sending and closing during a dispute and settles it with a chargeback", async () => {
    const { onAct } = renderSection({ subcontracts: [subcontract({ status: "disputed", disputeNote: "یک پیراهن گم شده" })] });
    expect(screen.getByText("اختلاف: یک پیراهن گم شده")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ارسال" })).toBeNull();
    expect(screen.queryByRole("button", { name: "بستن قرارداد" })).toBeNull();
    fireEvent.change(screen.getByLabelText("یادداشت برای SUB-1"), { target: { value: "توافق شد" } });
    fireEvent.change(screen.getByLabelText(/کسر خسارت/), { target: { value: "10000" } });
    fireEvent.click(screen.getByRole("button", { name: "حل اختلاف" }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith({
      action: "subcontract_resolve", subcontractId: "sc-1", note: "توافق شد", chargebackRial: 100_000,
    }));
  });

  it("closes with the remaining custody declared lost", async () => {
    const { onAct } = renderSection({ subcontracts: [subcontract({ heldQuantity: "0" })] });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "بستن قرارداد" }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith({
      action: "subcontract_close", subcontractId: "sc-1", declareRemainingLost: true, chargebackRial: null,
    }));
  });

  it("shows figures but no mutating control without permission to act", () => {
    renderSection({ subcontracts: [subcontract()], canAct: false });
    expect(screen.getByText("خیاطی سارا")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ثبت تحویل" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ثبت پیمانکار" })).toBeNull();
  });
});
