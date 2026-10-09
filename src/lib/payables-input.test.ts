import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  isVoucherMethod,
  normalizeBankReference,
  parseExpenseSettlement,
  parseSupplierInvoice,
  PayablesInputError,
  purchasePayableRial,
  resolvePaymentDueDate,
  supplierReturnVatReversal,
  vatAmountForRate,
  VOUCHER_METHOD_LABELS,
  voucherAccountChoices,
  voucherDefaultAccountCode,
  voucherMethodForRole,
  optionalBodyText,
} from "./payables-input";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof PayablesInputError) return err.code;
    throw err;
  }
  return "no_error";
}

describe("parseExpenseSettlement", () => {
  it("defaults to a paid expense and drops a supplier/due date on it", () => {
    expect(parseExpenseSettlement({})).toEqual({ settlement: "paid", supplierId: null, dueDate: null });
    expect(parseExpenseSettlement({ settlement: "paid", supplierId: "s1", dueDate: "2026-11-01" })).toEqual({
      settlement: "paid",
      supplierId: null,
      dueDate: null,
    });
  });

  it("requires a supplier for «پرداخت بعدی», since only a supplier's payable can be settled by the A/P payment", () => {
    expect(codeOf(() => parseExpenseSettlement({ settlement: "credit" }))).toBe("supplier_required");
    expect(codeOf(() => parseExpenseSettlement({ settlement: "credit", supplierId: "  " }))).toBe("supplier_required");
  });

  it("accepts a credit expense with an optional real due date", () => {
    expect(parseExpenseSettlement({ settlement: "credit", supplierId: " s1 " })).toEqual({
      settlement: "credit",
      supplierId: "s1",
      dueDate: null,
    });
    expect(parseExpenseSettlement({ settlement: "credit", supplierId: "s1", dueDate: "2026-11-30" }).dueDate).toBe("2026-11-30");
    expect(codeOf(() => parseExpenseSettlement({ settlement: "credit", supplierId: "s1", dueDate: "2026-02-30" }))).toBe(
      "invalid_due_date",
    );
  });

  it("rejects an unknown settlement", () => {
    expect(codeOf(() => parseExpenseSettlement({ settlement: "later" }))).toBe("invalid_settlement");
  });
});

describe("parseSupplierInvoice", () => {
  it("is empty and VAT-free when omitted — the server never guesses a rate", () => {
    expect(parseSupplierInvoice(undefined)).toEqual({
      invoiceNumber: null,
      invoiceDate: null,
      vatAmount: 0,
      paymentTermsDays: null,
      dueDate: null,
    });
  });

  it("normalises Persian digits and keeps integer Rial", () => {
    expect(
      parseSupplierInvoice({
        invoiceNumber: " ف-۱۲۳ ",
        invoiceDate: "2026-10-01",
        vatAmount: "۱۰۰۰۰۰",
        paymentTermsDays: "۳۰",
        dueDate: "",
      }),
    ).toEqual({ invoiceNumber: "ف-123", invoiceDate: "2026-10-01", vatAmount: 100_000, paymentTermsDays: 30, dueDate: null });
  });

  it("names each malformed field", () => {
    expect(codeOf(() => parseSupplierInvoice({ vatAmount: -1 }))).toBe("invalid_vat_amount");
    expect(codeOf(() => parseSupplierInvoice({ vatAmount: 12.5 }))).toBe("invalid_vat_amount");
    expect(codeOf(() => parseSupplierInvoice({ invoiceDate: "2026-13-01" }))).toBe("invalid_invoice_date");
    expect(codeOf(() => parseSupplierInvoice({ paymentTermsDays: 4000 }))).toBe("invalid_payment_terms");
    expect(codeOf(() => parseSupplierInvoice({ invoiceNumber: "x".repeat(65) }))).toBe("invalid_invoice_number");
    expect(codeOf(() => parseSupplierInvoice("nope"))).toBe("invalid_supplier_invoice");
  });
});

describe("vatAmountForRate", () => {
  it("rounds half-up to the Rial from the business's own rate", () => {
    expect(vatAmountForRate(1_000_000, 10)).toBe(100_000);
    expect(vatAmountForRate("1234567", 9)).toBe(111_111); // 111111.03
    expect(vatAmountForRate(5, 10)).toBe(1); // 0.5 rounds up
    expect(vatAmountForRate(1_000_000, 9.5)).toBe(95_000);
  });

  it("is zero for an exempt business, a zero total or an unusable rate", () => {
    expect(vatAmountForRate(1_000_000, 0)).toBe(0);
    expect(vatAmountForRate(0, 10)).toBe(0);
    expect(vatAmountForRate(1_000_000, Number.NaN)).toBe(0);
  });

  it("stays exact past float precision", () => {
    expect(vatAmountForRate("90071992547409910", 10)).toBe(Number(9007199254740991n));
  });
});

describe("purchasePayableRial / due dates", () => {
  it("adds the VAT to the goods value exactly", () => {
    expect(purchasePayableRial("1000000", 100_000)).toBe(1_100_000n);
    expect(purchasePayableRial("1000000", "0")).toBe(1_000_000n);
  });

  it("derives the due date from terms over the invoice date, else the purchase date; an explicit date wins", () => {
    expect(addDaysIso("2026-01-31", 30)).toBe("2026-03-02");
    expect(resolvePaymentDueDate({ dueDate: null, paymentTermsDays: 30, invoiceDate: "2026-10-01", purchaseDate: "2026-10-05" })).toBe(
      "2026-10-31",
    );
    expect(resolvePaymentDueDate({ dueDate: null, paymentTermsDays: 10, invoiceDate: null, purchaseDate: "2026-10-05" })).toBe(
      "2026-10-15",
    );
    expect(resolvePaymentDueDate({ dueDate: "2026-12-01", paymentTermsDays: 10, invoiceDate: "2026-10-01", purchaseDate: null })).toBe(
      "2026-12-01",
    );
    expect(resolvePaymentDueDate({ dueDate: null, paymentTermsDays: null, invoiceDate: "2026-10-01", purchaseDate: null })).toBeNull();
  });
});

describe("voucher accounts", () => {
  it("maps cash/petty cash to «نقدی», bank to «بانکی» and card clearing to «در جریان وصول», nothing else", () => {
    expect(voucherMethodForRole("cash")).toBe("cash");
    expect(voucherMethodForRole("petty_cash")).toBe("cash");
    expect(voucherMethodForRole("bank")).toBe("bank");
    expect(voucherMethodForRole("payment_clearing")).toBe("clearing");
    expect(voucherMethodForRole("trade_receivable")).toBeNull();
    expect(voucherMethodForRole("vat_receivable")).toBeNull();
    expect(voucherMethodForRole(null)).toBeNull();
  });

  it("accepts exactly the cash/bank/clearing methods", () => {
    expect(isVoucherMethod("cash")).toBe(true);
    expect(isVoucherMethod("bank")).toBe(true);
    expect(isVoucherMethod("clearing")).toBe(true);
    expect(isVoucherMethod("cheque")).toBe(false);
    expect(isVoucherMethod("")).toBe(false);
    expect(isVoucherMethod(undefined)).toBe(false);
  });

  it("labels the three methods for the register and the pickers", () => {
    expect(VOUCHER_METHOD_LABELS).toEqual({ cash: "نقدی", bank: "بانکی", clearing: "در جریان وصول" });
  });

  it("defaults bank to 1110 and clearing to 1120 (issue #829: bank is no longer clearing)", () => {
    expect(voucherDefaultAccountCode("cash")).toBe("1100");
    expect(voucherDefaultAccountCode("bank")).toBe("1110");
    expect(voucherDefaultAccountCode("clearing")).toBe("1120");
  });

  it("lists a custom bank sub-account under its parent's method, and never a receivable or VAT account", () => {
    const choices = voucherAccountChoices([
      { id: "a1", code: "1100", name: "صندوق", type: "asset", parent_code: null },
      { id: "a2", code: "1110", name: "بانک", type: "asset", parent_code: null },
      { id: "a3", code: "1119", name: "بانک ملت", type: "asset", parent_code: "1110" },
      { id: "a4", code: "1200", name: "دریافتنی", type: "asset", parent_code: null },
      { id: "a5", code: "1220", name: "مالیات خرید", type: "asset", parent_code: null },
      { id: "a6", code: "5200", name: "اجاره", type: "expense", parent_code: null },
      { id: "a7", code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parent_code: null },
    ]);
    expect(choices.map((c) => [c.id, c.method])).toEqual([
      ["a1", "cash"],
      ["a2", "bank"],
      ["a3", "bank"],
      ["a7", "clearing"],
    ]);
  });

  it("normalises a bank reference and bounds its length", () => {
    expect(normalizeBankReference(" ۱۲۳۴۵۶ ")).toBe("123456");
    expect(normalizeBankReference("")).toBeNull();
    expect(normalizeBankReference(undefined)).toBeNull();
    expect(codeOf(() => normalizeBankReference("9".repeat(65)))).toBe("invalid_bank_reference");
    expect(codeOf(() => normalizeBankReference(42))).toBe("invalid_bank_reference");
  });
});

describe("supplierReturnVatReversal", () => {
  const base = { purchaseVat: 100_000, purchaseGoods: 1_000_000, priorReturnedGoods: 0, priorReversedVat: 0 };

  it("reverses nothing for a purchase without VAT", () => {
    expect(supplierReturnVatReversal({ ...base, purchaseVat: 0, returnedGoods: 400_000 })).toBe(0n);
  });

  it("reverses the proportional share, rounded half-up to the Rial", () => {
    expect(supplierReturnVatReversal({ ...base, returnedGoods: 300_000 })).toBe(30_000n);
    expect(supplierReturnVatReversal({ ...base, purchaseVat: 1, returnedGoods: 500_000 })).toBe(1n);
    expect(supplierReturnVatReversal({ ...base, purchaseVat: 1, returnedGoods: 499_999 })).toBe(0n);
  });

  it("partials that add up to the whole purchase reverse exactly the whole VAT", () => {
    const thirds = { purchaseVat: 100, purchaseGoods: 3 };
    const first = supplierReturnVatReversal({ ...thirds, priorReturnedGoods: 0, returnedGoods: 1, priorReversedVat: 0 });
    const second = supplierReturnVatReversal({ ...thirds, priorReturnedGoods: 1, returnedGoods: 1, priorReversedVat: first });
    const third = supplierReturnVatReversal({ ...thirds, priorReturnedGoods: 2, returnedGoods: 1, priorReversedVat: first + second });
    expect([first, second, third]).toEqual([33n, 34n, 33n]);
    expect(first + second + third).toBe(100n);
  });

  it("a full return reverses the whole VAT, and never more than is left", () => {
    expect(supplierReturnVatReversal({ ...base, returnedGoods: 1_000_000 })).toBe(100_000n);
    expect(supplierReturnVatReversal({ ...base, priorReturnedGoods: 1_000_000, priorReversedVat: 100_000, returnedGoods: 0 })).toBe(0n);
  });
});

describe("optionalBodyText", () => {
  it("trims text, folds blanks and absence to null, and flags wrong types", () => {
    expect(optionalBodyText(" 1404-777 ")).toBe("1404-777");
    expect(optionalBodyText("   ")).toBeNull();
    expect(optionalBodyText(undefined)).toBeNull();
    expect(optionalBodyText(null)).toBeNull();
    expect(optionalBodyText(123)).toBeUndefined();
    expect(optionalBodyText(true)).toBeUndefined();
    expect(optionalBodyText({})).toBeUndefined();
    expect(optionalBodyText(["x"])).toBeUndefined();
  });
});
