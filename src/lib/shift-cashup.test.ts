/**
 * Issue #933 — the cash-up rules, without a database.
 *
 * Three behaviours here are the ones the audit called out as financially
 * dangerous, so they are pinned rather than left to the service:
 *
 *   * "unresolved" is not zero variance (item 2/10),
 *   * expected cash includes cash movements, not only sales (item 3),
 *   * tender buckets explain the gross, SnapFood and cheque included (item 9).
 */
import { describe, expect, it } from "vitest";
import {
  applyVarianceAdjustment,
  cashInDrawerFromSales,
  emptyTenderTotals,
  parseShiftCloseInput,
  reconcileDrawer,
  tallyTenders,
  tenderClassForMethod,
  tenderTieOut,
} from "./shift-cashup";

describe("tallyTenders", () => {
  it("puts every settlement in its own bucket and totals them", () => {
    const totals = tallyTenders([
      { method: "cash", amount: 1_000_000 },
      { method: "card", amount: 2_000_000 },
      { method: "card_to_card", amount: 300_000 },
      { method: "online", amount: "400000" },
      { method: "credit", amount: 500_000 },
      { method: "snappfood", amount: 600_000 },
      { method: "cheque", amount: 700_000 },
    ]);
    expect(totals).toEqual({
      cash: 1_000_000,
      card: 2_000_000,
      cardToCard: 300_000,
      online: 400_000,
      credit: 500_000,
      snappfood: 600_000,
      cheque: 700_000,
      other: 0,
      total: 5_500_000,
    });
    // Only cash is drawer money — a cheque and a tab are not.
    expect(cashInDrawerFromSales(totals)).toBe(1_000_000);
  });

  it("keeps a refund row's negative amount, so a reversal reduces the shift", () => {
    const totals = tallyTenders([
      { method: "cash", amount: 1_000_000 },
      { method: "cash", amount: -300_000 },
    ]);
    expect(totals.cash).toBe(700_000);
    expect(totals.total).toBe(700_000);
  });

  it("ignores a value that is not an integer Rial instead of poisoning the total", () => {
    const totals = tallyTenders([
      { method: "cash", amount: 1_000_000 },
      { method: "cash", amount: 1.5 },
      { method: "cash", amount: Number.NaN },
    ]);
    expect(totals.cash).toBe(1_000_000);
  });

  it("maps an unknown method to `other` rather than dropping it", () => {
    expect(tenderClassForMethod("crypto")).toBe("other");
    expect(tenderClassForMethod("card_to_card")).toBe("cardToCard");
    expect(tallyTenders([{ method: "crypto", amount: 10 }]).other).toBe(10);
  });
});

describe("reconcileDrawer", () => {
  it("is unresolved — not zero — when nobody counted", () => {
    const result = reconcileDrawer({ openingFloat: 500_000, cashSales: 1_300_000, countedCash: null });
    expect(result).toEqual({ expectedCash: 1_800_000, variance: null, status: "unresolved" });
  });

  it("is unresolved when the shift never tracked an opening float", () => {
    const result = reconcileDrawer({ openingFloat: null, cashSales: 1_300_000, countedCash: 1_300_000 });
    expect(result.expectedCash).toBeNull();
    expect(result.variance).toBeNull();
    expect(result.status).toBe("unresolved");
  });

  it("includes cash in and out in the expectation (#933 item 3)", () => {
    const result = reconcileDrawer({
      openingFloat: 500_000,
      cashSales: 1_300_000,
      cashIn: 200_000,
      cashOut: 450_000,
      countedCash: 1_550_000,
    });
    expect(result.expectedCash).toBe(1_550_000);
    expect(result.variance).toBe(0);
    expect(result.status).toBe("balanced");
  });

  it("reports a short and an over drawer", () => {
    expect(reconcileDrawer({ openingFloat: 0, cashSales: 1_000_000, countedCash: 900_000 })).toEqual({
      expectedCash: 1_000_000,
      variance: -100_000,
      status: "variance",
    });
    expect(reconcileDrawer({ openingFloat: 0, cashSales: 1_000_000, countedCash: 1_100_000 }).variance).toBe(100_000);
  });

  it("treats a zero count as a real count, not as missing", () => {
    const result = reconcileDrawer({ openingFloat: 0, cashSales: 0, countedCash: 0 });
    expect(result.status).toBe("balanced");
    expect(result.variance).toBe(0);
  });
});

describe("tenderTieOut", () => {
  it("explains a gross made of several tenders", () => {
    const totals = tallyTenders([
      { method: "cash", amount: 400 },
      { method: "snappfood", amount: 600 },
    ]);
    const tieOut = tenderTieOut(1_000, totals);
    expect(tieOut.explainsGross).toBe(true);
    expect(tieOut.lines).toEqual([
      { method: "cash", amount: 400 },
      { method: "snappfood", amount: 600 },
    ]);
  });

  it("states an unexplained difference instead of hiding it", () => {
    const tieOut = tenderTieOut(1_000, tallyTenders([{ method: "cash", amount: 700 }]));
    expect(tieOut.difference).toBe(300);
    expect(tieOut.explainsGross).toBe(false);
  });

  it("omits empty buckets from the displayed lines", () => {
    expect(tenderTieOut(0, emptyTenderTotals()).lines).toEqual([]);
  });
});

describe("parseShiftCloseInput", () => {
  it("treats an empty body as 'closed without a count'", () => {
    expect(parseShiftCloseInput({})).toEqual({
      ok: true,
      value: { countedCash: null, mode: "unresolved", reason: null },
    });
  });

  it("accepts both countedCash and the legacy closingFloat name", () => {
    expect(parseShiftCloseInput({ countedCash: 123 })).toMatchObject({ ok: true, value: { countedCash: 123, mode: "counted" } });
    expect(parseShiftCloseInput({ closingFloat: 123 })).toMatchObject({ ok: true, value: { countedCash: 123 } });
    expect(parseShiftCloseInput({ closingFloat: 123, countedCash: 123 })).toMatchObject({ ok: true });
  });

  it("refuses two different counts in one body", () => {
    expect(parseShiftCloseInput({ closingFloat: 1, countedCash: 2 })).toEqual({ ok: false, error: "bad_request" });
  });

  it("accepts zero as a count", () => {
    expect(parseShiftCloseInput({ countedCash: 0 })).toMatchObject({ ok: true, value: { countedCash: 0, mode: "counted" } });
  });

  it("refuses negative, fractional, unsafe and non-numeric amounts", () => {
    for (const bad of [-1, 1.5, 1e21, "1000", null]) {
      const result = parseShiftCloseInput({ countedCash: bad, withoutCount: bad === null });
      if (bad === null) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toEqual({ ok: false, error: "invalid_amount" });
      }
    }
    expect(parseShiftCloseInput({ countedCash: 1e21 })).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("refuses arrays and primitives outright (#933 item 13)", () => {
    for (const bad of [[], [1], "x", 42, true]) {
      expect(parseShiftCloseInput(bad)).toEqual({ ok: false, error: "bad_request" });
    }
  });

  it("treats 'close without count' as explicit, and refuses it alongside a count", () => {
    expect(parseShiftCloseInput({ withoutCount: true, reason: "فراموش شد" })).toEqual({
      ok: true,
      value: { countedCash: null, mode: "unresolved", reason: "فراموش شد" },
    });
    expect(parseShiftCloseInput({ withoutCount: true, countedCash: 500 })).toEqual({ ok: false, error: "bad_request" });
    expect(parseShiftCloseInput({ withoutCount: "yes" })).toEqual({ ok: false, error: "bad_request" });
  });

  it("requires a reason for a supervisor's uncounted close, but not a member's own", () => {
    expect(parseShiftCloseInput({}, { requireReasonWhenUncounted: true })).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(
      parseShiftCloseInput({ reason: "دستگاه خراب شد" }, { requireReasonWhenUncounted: true }),
    ).toMatchObject({ ok: true, value: { mode: "unresolved", reason: "دستگاه خراب شد" } });
    expect(parseShiftCloseInput({}, {})).toMatchObject({ ok: true });
  });

  it("trims and length-limits the reason", () => {
    expect(parseShiftCloseInput({ countedCash: 1, reason: "  یادداشت  " })).toMatchObject({
      ok: true,
      value: { reason: "یادداشت" },
    });
    expect(parseShiftCloseInput({ countedCash: 1, reason: "x".repeat(501) })).toEqual({
      ok: false,
      error: "bad_request",
    });
    expect(parseShiftCloseInput({ countedCash: 1, reason: 7 })).toEqual({ ok: false, error: "bad_request" });
  });

  it("honours requireCount when a caller genuinely needs one", () => {
    expect(parseShiftCloseInput({}, { requireCount: true })).toEqual({ ok: false, error: "count_required" });
  });
});

describe("applyVarianceAdjustment", () => {
  it("moves the variance by the delta and keeps the before value", () => {
    expect(applyVarianceAdjustment(-200_000, 50_000)).toEqual({
      beforeVariance: -200_000,
      afterVariance: -150_000,
      delta: 50_000,
    });
  });

  it("does not invent a variance for an unresolved cash-up", () => {
    expect(applyVarianceAdjustment(null, 50_000)).toEqual({
      beforeVariance: null,
      afterVariance: null,
      delta: 50_000,
    });
  });
});
