import { describe, expect, it } from "vitest";
import {
  actionNeedsConfirmation,
  actionRequiresReason,
  actionVariant,
  allocationsFromForm,
  eventLabel,
  lineKindLabel,
  parsePaymentChoice,
  payoutKindLabel,
  runStatusTone,
  shamsiDate,
} from "./commission-run-view";
import { COMMISSION_RUN_STATUSES } from "@/lib/commission-settlement-lifecycle";

describe("how a status looks", () => {
  it("gives every status a tone, and paid is positive, voided is danger", () => {
    for (const status of COMMISSION_RUN_STATUSES) expect(["active", "positive", "neutral", "danger"]).toContain(runStatusTone(status));
    expect(runStatusTone("paid")).toBe("positive");
    expect(runStatusTone("voided")).toBe("danger");
    expect(runStatusTone("draft")).toBe("neutral");
  });
});

describe("how an action behaves", () => {
  it("makes the steps that undo work destructive, and the forward steps primary", () => {
    expect(actionVariant("void")).toBe("destructive");
    expect(actionVariant("reject")).toBe("destructive");
    expect(actionVariant("reverse_payout")).toBe("destructive");
    expect(actionVariant("approve")).toBe("default");
    expect(actionVariant("pay")).toBe("default");
    expect(actionVariant("review")).toBe("outline");
  });

  it("asks for a reason to void, and a confirmation before anything that cannot be taken back from the screen", () => {
    expect(actionRequiresReason("void")).toBe(true);
    expect(actionRequiresReason("reject")).toBe(false);
    for (const action of ["void", "reject", "release", "close", "reverse_payout"] as const) {
      expect(actionNeedsConfirmation(action), action).toBe(true);
    }
    expect(actionNeedsConfirmation("approve")).toBe(false);
    expect(actionNeedsConfirmation("review")).toBe(false);
  });
});

describe("words for events, lines and payouts", () => {
  it("names every event the trail can record", () => {
    for (const action of ["create", "calculate", "review", "approve", "reject", "release", "payout", "payout_reversal", "close", "void"]) {
      expect(eventLabel(action), action).not.toBe(action);
    }
    expect(eventLabel("something_else")).toBe("something_else");
  });

  it("says what a payout and a line are", () => {
    expect(payoutKindLabel("payout")).toBe("پرداخت");
    expect(payoutKindLabel("reversal")).toBe("ابطال پرداخت");
    expect(lineKindLabel("accrual")).toBe("پورسانت");
    expect(lineKindLabel("carry_forward")).toBe("مانده دورهٔ قبل");
  });

  it("shows a Shamsi date, and a dash for none", () => {
    expect(shamsiDate("2026-10-09")).toMatch(/۱۴۰۵/);
    expect(shamsiDate(null)).toBe("—");
  });
});

describe("the payout form", () => {
  it("reads the account choice into what the request carries", () => {
    expect(parsePaymentChoice("account:acc-1")).toEqual({ paymentAccountId: "acc-1", method: null });
    expect(parsePaymentChoice("method:cash")).toEqual({ paymentAccountId: null, method: "cash" });
    expect(parsePaymentChoice("method:bank")).toEqual({ paymentAccountId: null, method: "bank" });
    expect(parsePaymentChoice("nonsense")).toEqual({ paymentAccountId: null, method: null });
  });

  it("sends «everything owed» as a flag, never as a converted amount", () => {
    const toRial = (text: string) => `${Number(text) * 10}`;
    expect(
      allocationsFromForm(
        {
          a: { all: true, text: "999" },
          b: { all: false, text: "5" },
          c: { all: false, text: "" },
        },
        toRial,
      ),
    ).toEqual([
      { employeeId: "a", all: true },
      { employeeId: "b", amount: "50" },
    ]);
  });

  it("lets a conversion error reach the caller, which reports it", () => {
    expect(() =>
      allocationsFromForm({ a: { all: false, text: "x" } }, () => {
        throw new Error("Not a valid amount: x");
      }),
    ).toThrow("Not a valid amount");
  });
});
