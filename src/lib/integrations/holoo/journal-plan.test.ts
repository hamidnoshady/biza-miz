import { describe, expect, it } from "vitest";
import { normalizeLine, normalizeVoucher, planJournalImport, type HolooVoucher } from "./journal-plan";

describe("normalizeLine", () => {
  it("nets a two-sided line to a single side", () => {
    expect(normalizeLine({ accountCode: "1100", debitRial: 100n, creditRial: 30n })).toEqual({
      accountCode: "1100",
      debit: 70n,
      credit: 0n,
    });
    expect(normalizeLine({ accountCode: "2100", debitRial: 30n, creditRial: 100n })).toEqual({
      accountCode: "2100",
      debit: 0n,
      credit: 70n,
    });
  });
});

describe("normalizeVoucher", () => {
  it("flags a balanced voucher", () => {
    const v: HolooVoucher = {
      remoteId: "1",
      entryDate: "2024-01-01",
      lines: [
        { accountCode: "1100", debitRial: 100n },
        { accountCode: "2100", creditRial: 100n },
      ],
    };
    const n = normalizeVoucher(v);
    expect(n.balanced).toBe(true);
    expect(n.difference).toBe(0n);
  });

  it("flags an unbalanced voucher with the difference", () => {
    const v: HolooVoucher = {
      remoteId: "2",
      entryDate: "2024-01-01",
      lines: [
        { accountCode: "1100", debitRial: 100n },
        { accountCode: "2100", creditRial: 90n },
      ],
    };
    const n = normalizeVoucher(v);
    expect(n.balanced).toBe(false);
    expect(n.difference).toBe(10n);
  });

  it("preserves exact Rial above Number.MAX_SAFE_INTEGER and rejects unsafe numeric inputs", () => {
    const exact = "9007199254740993";
    const voucher: HolooVoucher = {
      remoteId: "exact",
      entryDate: "2024-01-01",
      lines: [
        { accountCode: "1100", debitRial: exact },
        { accountCode: "2100", creditRial: exact },
      ],
    };
    expect(normalizeVoucher(voucher).lines[0].debit).toBe(9007199254740993n);
    expect(() => normalizeLine({ accountCode: "1100", debitRial: Number.MAX_SAFE_INTEGER + 1 })).toThrow("invalid_holoo_amount");
    expect(() => normalizeLine({ accountCode: "1100", debitRial: -1n })).toThrow("invalid_holoo_amount");
    expect(() => normalizeVoucher({ ...voucher, entryDate: "2024-02-30" })).toThrow("invalid_holoo_date");
    expect(() => planJournalImport([voucher, { ...voucher }])).toThrow("duplicate_holoo_remote_id:journal");
  });
});

describe("planJournalImport", () => {
  it("splits balanced from unbalanced — the unbalanced is a discrepancy, never auto-offset", () => {
    const plan = planJournalImport([
      { remoteId: "ok", entryDate: "2024-01-01", lines: [{ accountCode: "1100", debitRial: 50n }, { accountCode: "2100", creditRial: 50n }] },
      { remoteId: "bad", entryDate: "2024-01-02", lines: [{ accountCode: "1100", debitRial: 50n }] },
    ]);
    expect(plan.balanced.map((v) => v.remoteId)).toEqual(["ok"]);
    expect(plan.unbalanced.map((v) => v.remoteId)).toEqual(["bad"]);
  });
});
