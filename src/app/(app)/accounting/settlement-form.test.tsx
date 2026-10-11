// @vitest-environment jsdom
/**
 * Issue #829 completion — one settlement form: the shared voucher controller
 * behind the «دریافت و پرداخت» register dialog and both subledger settle
 * dialogs. The dialogs keep their own chrome (party picker vs preselected
 * party + balance), but validation, the POST body and the retry-key
 * discipline live here once — this pins all three.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEffect } from "react";
import { parseMoneyToRial } from "@/lib/money";
import {
  buildVoucherBody,
  useVoucherSubmission,
  validateVoucherAmount,
} from "./settlement-form";

const rialMoney = { parse: (input: string) => parseMoneyToRial(input, "rial") };

describe("validateVoucherAmount", () => {
  it("accepts a positive amount in either digit set", () => {
    expect(validateVoucherAmount(rialMoney, "1500000")).toEqual({ ok: true, rial: 1500000 });
    expect(validateVoucherAmount(rialMoney, "۱۵۰۰۰۰۰")).toEqual({ ok: true, rial: 1500000 });
  });

  it("rejects garbage, zero and negatives with the dialog's Persian message", () => {
    for (const amount of ["", "abc", "۰", "0", "-500"]) {
      expect(validateVoucherAmount(rialMoney, amount)).toEqual({ ok: false, error: "مبلغ معتبر نیست." });
    }
  });
});

describe("buildVoucherBody", () => {
  it("shapes a receipt body with the customer field and the stable dialog key", () => {
    expect(
      buildVoucherBody({
        side: "receipt",
        partyId: "customer-1",
        rial: 1500000,
        method: "bank",
        cashAccountId: "acct-1",
        bankReference: " 1404-777 ",
        date: "2026-10-04",
        memo: "بابت فاکتور",
        idempotencyKey: "key-1",
      }),
    ).toEqual({
      amount: 1500000,
      method: "bank",
      memo: "بابت فاکتور",
      cashAccountId: "acct-1",
      bankReference: "1404-777",
      customerId: "customer-1",
      receiptDate: "2026-10-04",
      idempotencyKey: "key-1",
    });
  });

  it("shapes a payment body with the supplier field and the intent key", () => {
    expect(
      buildVoucherBody({
        side: "payment",
        partyId: "supplier-1",
        rial: 2000000,
        method: "cash",
        cashAccountId: "",
        date: "",
        memo: "",
        clientRequestId: "req-1",
      }),
    ).toEqual({
      amount: 2000000,
      method: "cash",
      memo: undefined,
      cashAccountId: undefined,
      bankReference: undefined,
      supplierId: "supplier-1",
      paymentDate: undefined,
      clientRequestId: "req-1",
    });
  });
});

function KeyProbe({
  side,
  intent,
  onKeys,
}: {
  side: "receipt" | "payment";
  intent: Record<string, unknown>;
  onKeys: (keys: { idempotencyKey?: string; clientRequestId?: string }) => void;
}) {
  const submission = useVoucherSubmission(side);
  useEffect(() => {
    onKeys(submission.keyFor(intent));
  }, [submission, intent, onKeys]);
  return null;
}

describe("useVoucherSubmission", () => {
  it("hands every receipt attempt the one stable dialog key", () => {
    const seen: (string | undefined)[] = [];
    const intent = { partyId: "c-1", amount: 100 };
    const { rerender } = render(<KeyProbe side="receipt" intent={intent} onKeys={(k) => seen.push(k.idempotencyKey)} />);
    rerender(<KeyProbe side="receipt" intent={{ ...intent, amount: 200 }} onKeys={(k) => seen.push(k.idempotencyKey)} />);
    expect(seen).toHaveLength(2);
    // Even a corrected amount keeps the dialog's key: the server answers a
    // changed fingerprint with 409 rather than a second voucher.
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBeTruthy();
  });

  it("replays the payment key for an unchanged retry and rotates it on a material edit", () => {
    const seen: (string | undefined)[] = [];
    const intent = { partyId: "s-1", amount: 100, method: "cash" };
    const { rerender } = render(<KeyProbe side="payment" intent={intent} onKeys={(k) => seen.push(k.clientRequestId)} />);
    rerender(<KeyProbe side="payment" intent={{ ...intent }} onKeys={(k) => seen.push(k.clientRequestId)} />);
    rerender(
      <KeyProbe side="payment" intent={{ ...intent, amount: 200 }} onKeys={(k) => seen.push(k.clientRequestId)} />,
    );
    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[0]);
  });
});
