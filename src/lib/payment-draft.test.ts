import { describe, expect, it } from "vitest";
import {
  draftDifference,
  draftNeedsCustomer,
  draftOpensDrawer,
  draftReceiptPayments,
  draftReceivedRial,
  draftRemaining,
  draftRequiresCustomer,
  draftRowRial,
  draftTotal,
  draftUsesManualAmount,
  emptyPaymentDraft,
  newDraftRow,
  paymentDraftBody,
  type PaymentDraft,
} from "./payment-draft";
import type { PaymentMethodView } from "./payment-methods";

function method(over: Partial<PaymentMethodView> & { id: string }): PaymentMethodView {
  return {
    code: over.id,
    name: over.id,
    settlement: "card",
    sortOrder: 10,
    isActive: true,
    isBuiltin: false,
    opensDrawer: false,
    requiresReference: false,
    ...over,
  };
}

const CASH = method({ id: "cash", name: "نقدی", settlement: "cash", opensDrawer: true, isBuiltin: true });
const CARD = method({ id: "card", name: "پوز ملت", settlement: "card", isBuiltin: true, sortOrder: 20 });
const CREDIT = method({ id: "credit", name: "نسیه", settlement: "credit", isBuiltin: true, sortOrder: 30 });
const TRANSFER = method({ id: "transfer", name: "کارت‌به‌کارت", settlement: "card_to_card", requiresReference: true });
const METHODS = [CASH, CARD, CREDIT, TRANSFER];

const DUE = 5_000_000; // ۵۰۰٬۰۰۰ تومان

function split(rows: { methodId: string; amount: string; reference?: string }[]): PaymentDraft {
  return {
    split: true,
    methodId: rows[0]?.methodId ?? "",
    rows: rows.map((row) => ({ ...newDraftRow(row.methodId, row.amount), reference: row.reference ?? "" })),
  };
}

describe("emptyPaymentDraft", () => {
  it("opens on the first way offered, not split", () => {
    const draft = emptyPaymentDraft(METHODS);
    expect(draft).toMatchObject({ split: false, methodId: "cash" });
    expect(draft.rows).toHaveLength(1);
  });

  it("survives a business with no ways configured", () => {
    expect(emptyPaymentDraft([]).methodId).toBe("");
  });
});

describe("draftRowRial", () => {
  it("reads Toman, Persian digits and separators alike", () => {
    expect(draftRowRial(newDraftRow("cash", "200000"))).toBe(2_000_000);
    expect(draftRowRial(newDraftRow("cash", "۲۰۰٬۰۰۰"))).toBe(2_000_000);
    expect(draftRowRial(newDraftRow("cash", "200,000"))).toBe(2_000_000);
  });

  it("reads Rial when the business chose Rial", () => {
    expect(draftRowRial(newDraftRow("cash", "200000"), "rial")).toBe(200_000);
  });

  it("is null while the box is empty, junk, zero or negative", () => {
    expect(draftRowRial(newDraftRow("cash", ""))).toBeNull();
    expect(draftRowRial(newDraftRow("cash", "  "))).toBeNull();
    expect(draftRowRial(newDraftRow("cash", "abc"))).toBeNull();
    expect(draftRowRial(newDraftRow("cash", "0"))).toBeNull();
    expect(draftRowRial(newDraftRow("cash", "-5"))).toBeNull();
  });
});

describe("draftRemaining", () => {
  it("is zero for an unsplit bill, whatever the total", () => {
    expect(draftRemaining(emptyPaymentDraft(METHODS), DUE)).toBe(0);
  });

  it("counts down as the rows are typed, and goes negative on an overshoot", () => {
    expect(draftRemaining(split([{ methodId: "cash", amount: "200000" }]), DUE)).toBe(3_000_000);
    expect(
      draftRemaining(split([{ methodId: "cash", amount: "200000" }, { methodId: "card", amount: "300000" }]), DUE),
    ).toBe(0);
    expect(draftRemaining(split([{ methodId: "cash", amount: "600000" }]), DUE)).toBe(-1_000_000);
  });

  it("treats a half-typed row as nothing yet, not as an error", () => {
    expect(
      draftRemaining(split([{ methodId: "cash", amount: "200000" }, { methodId: "card", amount: "" }]), DUE),
    ).toBe(3_000_000);
  });
});

describe("draftOpensDrawer / draftNeedsCustomer", () => {
  it("opens the drawer for any cash slice of a split", () => {
    expect(draftOpensDrawer(split([{ methodId: "card", amount: "500000" }]), METHODS)).toBe(false);
    expect(
      draftOpensDrawer(split([{ methodId: "card", amount: "300000" }, { methodId: "cash", amount: "200000" }]), METHODS),
    ).toBe(true);
    expect(draftOpensDrawer(emptyPaymentDraft(METHODS), METHODS)).toBe(true);
  });

  it("needs a customer as soon as one slice is on a tab", () => {
    expect(draftNeedsCustomer(split([{ methodId: "cash", amount: "500000" }]), METHODS)).toBe(false);
    expect(
      draftNeedsCustomer(
        split([{ methodId: "cash", amount: "300000" }, { methodId: "credit", amount: "200000" }]),
        METHODS,
      ),
    ).toBe(true);
  });
});

describe("paymentDraftBody", () => {
  it("sends one way and no amount when the bill is not split", () => {
    expect(paymentDraftBody(emptyPaymentDraft(METHODS), METHODS, DUE)).toEqual({
      ok: true,
      value: [{ methodId: "cash", reference: undefined }],
    });
  });

  it("prices every slice but the last, which takes whatever is left", () => {
    const draft = split([
      { methodId: "cash", amount: "۲۰۰٬۰۰۰" },
      { methodId: "card", amount: "300000" },
    ]);
    expect(paymentDraftBody(draft, METHODS, DUE)).toEqual({
      ok: true,
      value: [
        { methodId: "cash", amount: 2_000_000, reference: undefined },
        { methodId: "card", amount: undefined, reference: undefined },
      ],
    });
  });

  it("refuses a split that does not add up to the bill", () => {
    const draft = split([
      { methodId: "cash", amount: "200000" },
      { methodId: "card", amount: "200000" },
    ]);
    expect(paymentDraftBody(draft, METHODS, DUE)).toEqual({ ok: false, error: "payment_total_mismatch" });
  });

  it("refuses a slice whose amount is still empty", () => {
    const draft = split([{ methodId: "cash", amount: "500000" }, { methodId: "card", amount: "" }]);
    expect(paymentDraftBody(draft, METHODS, DUE)).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("refuses a way that demands a reference until one is typed", () => {
    const draft = split([{ methodId: "transfer", amount: "500000" }]);
    expect(paymentDraftBody(draft, METHODS, DUE)).toEqual({ ok: false, error: "payment_reference_required" });
    const withReference = split([{ methodId: "transfer", amount: "500000", reference: " 5541 " }]);
    expect(paymentDraftBody(withReference, METHODS, DUE)).toEqual({
      ok: true,
      value: [{ methodId: "transfer", amount: undefined, reference: "5541" }],
    });
  });

  it("prices slices in Rial when the business chose Rial", () => {
    const draft = split([
      { methodId: "cash", amount: "300000" },
      { methodId: "card", amount: "200000" },
    ]);
    expect(paymentDraftBody(draft, METHODS, 500_000, "rial")).toEqual({
      ok: true,
      value: [
        { methodId: "cash", amount: 300_000, reference: undefined },
        { methodId: "card", amount: undefined, reference: undefined },
      ],
    });
  });

  it("refuses a way that is no longer offered", () => {
    expect(paymentDraftBody(split([{ methodId: "gone", amount: "500000" }]), METHODS, DUE)).toEqual({
      ok: false,
      error: "invalid_payment_method",
    });
  });

  it("refuses a split with no rows left", () => {
    expect(paymentDraftBody({ split: true, methodId: "cash", rows: [] }, METHODS, DUE)).toEqual({
      ok: false,
      error: "no_payment",
    });
  });
});

describe("draftReceiptPayments", () => {
  it("prints the way's own name and the whole bill when unsplit", () => {
    expect(draftReceiptPayments({ split: false, methodId: "card", rows: [] }, METHODS, DUE)).toEqual([
      { label: "پوز ملت", amount: DUE },
    ]);
  });

  it("prints a line per slice", () => {
    const draft = split([
      { methodId: "cash", amount: "200000" },
      { methodId: "card", amount: "300000" },
    ]);
    expect(draftReceiptPayments(draft, METHODS, DUE)).toEqual([
      { label: "نقدی", amount: 2_000_000 },
      { label: "پوز ملت", amount: 3_000_000 },
    ]);
  });

  it("leaves out a slice that is not a payable amount yet", () => {
    const draft = split([{ methodId: "cash", amount: "200000" }, { methodId: "card", amount: "" }]);
    expect(draftReceiptPayments(draft, METHODS, DUE)).toEqual([{ label: "نقدی", amount: 2_000_000 }]);
  });
});

describe("manual received amount (مبلغ دریافتی)", () => {
  /** The «مبلغ دریافتی» entry opened, with `receivedAmount` typed into it. */
  function manual(receivedAmount: string): PaymentDraft {
    return { ...emptyPaymentDraft(METHODS), manualReceived: true, receivedAmount };
  }

  it("sends no amount when nothing is typed — the ordinary whole-bill sale", () => {
    const result = paymentDraftBody(manual(""), METHODS, DUE);
    expect(result).toMatchObject({ ok: true, value: [{ methodId: "cash", amount: undefined }] });
  });

  it("sends the typed amount explicitly, even when it differs from the bill", () => {
    expect(paymentDraftBody(manual("700000"), METHODS, DUE)).toMatchObject({
      ok: true,
      value: [{ methodId: "cash", amount: 7_000_000 }],
    });
    expect(paymentDraftBody(manual("500000"), METHODS, DUE)).toMatchObject({
      ok: true,
      value: [{ methodId: "cash", amount: 5_000_000 }],
    });
  });

  it("blocks a malformed box instead of charging the whole bill — issue #913", () => {
    // The old contract treated any non-parsing text as "no amount typed",
    // which sent `amount: undefined` and made the SERVER take the whole bill —
    // a silent substitution of somebody else's figure for the cashier's.
    expect(paymentDraftBody(manual("۱۲a"), METHODS, DUE)).toEqual({
      ok: false,
      error: "invalid_received_amount",
    });
  });

  it("blocks zero, negative and overflowing entries just as loudly", () => {
    for (const bad of ["0", "۰", "-5000", "−۵۰۰", "999999999999999999999999"]) {
      expect(paymentDraftBody(manual(bad), METHODS, DUE), bad).toEqual({
        ok: false,
        error: "invalid_received_amount",
      });
      // …and never pretends part of it arrived either.
      expect(draftTotal(manual(bad), DUE), bad).toBe(0);
      expect(draftRemaining(manual(bad), DUE), bad).toBe(DUE);
    }
  });

  it("still lets a half-Typed-yet-valid Persian figure through", () => {
    // ۵۰ تومان → 500 ریال, the same parse every other money input uses.
    expect(paymentDraftBody(manual("۵۰"), METHODS, DUE)).toMatchObject({
      ok: true,
      value: [{ methodId: "cash", amount: 500 }],
    });
  });

  it("reads Persian digits and thousand separators like every money input", () => {
    expect(draftReceivedRial(manual("۷۰۰٬۰۰۰"))).toBe(7_000_000);
    expect(draftReceivedRial(manual("700,000"))).toBe(7_000_000);
  });

  it("is ignored while collapsed — the chosen way covers the whole invoice", () => {
    // The box is closed but still holds text (the cashier typed, then closed
    // it). The ordinary sale must send no amount at all, or that stale figure
    // would silently become a customer debt.
    const collapsed: PaymentDraft = {
      ...emptyPaymentDraft(METHODS),
      manualReceived: false,
      receivedAmount: "400000",
    };
    expect(draftUsesManualAmount(collapsed)).toBe(false);
    expect(draftReceivedRial(collapsed)).toBeNull();
    expect(draftRequiresCustomer(collapsed, METHODS, DUE)).toBe(false);
    expect(paymentDraftBody(collapsed, METHODS, DUE)).toMatchObject({
      ok: true,
      value: [{ methodId: "cash", amount: undefined }],
    });
    expect(draftReceiptPayments(collapsed, METHODS, DUE)).toEqual([
      { label: "نقدی", amount: DUE },
    ]);
  });

  it("and the split are mutually exclusive, so nothing is charged twice", () => {
    const both: PaymentDraft = {
      ...split([
        { methodId: "cash", amount: "200000" },
        { methodId: "card", amount: "300000" },
      ]),
      manualReceived: true,
      receivedAmount: "700000",
    };
    expect(draftUsesManualAmount(both)).toBe(false);
    // Exactly the two slices — the manual figure contributes nothing.
    expect(paymentDraftBody(both, METHODS, DUE)).toMatchObject({
      ok: true,
      value: [
        { methodId: "cash", amount: 2_000_000 },
        { methodId: "card", amount: undefined },
      ],
    });
    expect(draftTotal(both, DUE)).toBe(DUE);
  });

  it("is ignored while splitting — the split's own rows are the amounts", () => {
    const draft = {
      ...split([
        { methodId: "cash", amount: "200000" },
        { methodId: "card", amount: "" },
      ]),
      receivedAmount: "700000",
    };
    expect(draftReceivedRial(draft)).toBeNull();
    // The empty second slice is what the split refuses, not the ignored amount.
    expect(paymentDraftBody(draft, METHODS, DUE)).toMatchObject({ ok: false, error: "invalid_amount" });
  });

  it("splits the difference into debt or credit for the live preview", () => {
    expect(draftDifference(DUE, DUE)).toEqual({ balanceDue: 0, customerCredit: 0 });
    expect(draftDifference(DUE - 1_000_000, DUE)).toEqual({ balanceDue: 1_000_000, customerCredit: 0 });
    expect(draftDifference(DUE + 1_000_000, DUE)).toEqual({ balanceDue: 0, customerCredit: 1_000_000 });
  });

  it("requires a customer once the typed amount differs from the bill", () => {
    // DUE is ۵۰۰٬۰۰۰ Toman (5,000,000 Rial) — the typed box is in Toman too.
    expect(draftRequiresCustomer(manual("400000"), METHODS, DUE)).toBe(true);
    expect(draftRequiresCustomer(manual("600000"), METHODS, DUE)).toBe(true);
    // Exact, empty, or half-typed: the ordinary sale, no customer needed.
    expect(draftRequiresCustomer(manual("500000"), METHODS, DUE)).toBe(false);
    expect(draftRequiresCustomer(manual(""), METHODS, DUE)).toBe(false);
    expect(draftRequiresCustomer(manual("garbage"), METHODS, DUE)).toBe(false);
  });

  it("prints what was actually taken, not the bill, on the receipt", () => {
    expect(draftReceiptPayments(manual("700000"), METHODS, DUE)).toEqual([
      { label: "نقدی", amount: 7_000_000 },
    ]);
  });
});

// Issue #913 items 5 & 7 — the two guarantees the checkout screens lean on.
describe("stale preview and half-typed input (issue #913 items 5 & 7)", () => {
  function manual(receivedAmount: string): PaymentDraft {
    return { ...emptyPaymentDraft(METHODS), manualReceived: true, receivedAmount };
  }

  it("blocks half-typed Persian numerals instead of ever posting a substituted amount", () => {
    // Mid-typing states: a trailing dot, a stray decimal separator, a mixed
    // decimal — none of them parse, and `amount: undefined` (take the whole
    // bill) must never be the fallback for text the cashier DID type.
    for (const halfTyped of ["۱۲.", "۱۲٫", "٫۵۰", "5۰.5", "12."]) {
      expect(paymentDraftBody(manual(halfTyped), METHODS, DUE), halfTyped).toEqual({
        ok: false,
        error: "invalid_received_amount",
      });
      expect(draftTotal(manual(halfTyped), DUE), halfTyped).toBe(0);
    }
  });

  it("refuses a split that adds up against a stale preview once the server total moved (payment_total_mismatch)", () => {
    // The cashier split against the screen's total…
    const staleSplit = split([
      { methodId: "cash", amount: "200000" },
      { methodId: "card", amount: "300000" },
    ]);
    expect(paymentDraftBody(staleSplit, METHODS, DUE)).toMatchObject({ ok: true });
    // …and the server now prices the order differently: the rebuild before
    // charging fails loudly instead of the open last slice absorbing it.
    expect(paymentDraftBody(staleSplit, METHODS, DUE + 500_000)).toEqual({
      ok: false,
      error: "payment_total_mismatch",
    });
  });
});
