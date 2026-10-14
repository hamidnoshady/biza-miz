import { describe, expect, it } from "vitest";
import {
  INVALID_DRAFT,
  MAX_JSON_AMOUNT,
  dirtyTerms,
  draftDisplayText,
  draftRial,
  exceedsJsonAmount,
  isDraftDirty,
  isTermDirty,
  termDisplayText,
  termsBody,
  type AmountDraft,
  type TermDrafts,
} from "./payroll-amount-drafts";
import type { StaffWage } from "./payroll-types";

const rialDraft = (text: string): AmountDraft => ({ text, unit: "rial" });
const tomanDraft = (text: string): AmountDraft => ({ text, unit: "toman" });

describe("draftRial — the amount is read through the unit it was typed in", () => {
  it("reads Rial text as Rial and Toman text as ten times as many Rial", () => {
    expect(draftRial(rialDraft("10000000"))).toBe("10000000");
    expect(draftRial(tomanDraft("1000000"))).toBe("10000000");
  });

  it("treats an empty box as «nothing entered» and anything non-numeric as invalid", () => {
    expect(draftRial(rialDraft(""))).toBeNull();
    expect(draftRial(tomanDraft("   "))).toBeNull();
    for (const text of ["-", "-5", "1.5", "abc", "1e3", "0x10"]) {
      expect(draftRial(rialDraft(text)), text).toBe(INVALID_DRAFT);
    }
  });

  it("accepts Persian digits and separators (as pasted) and never rounds a large amount", () => {
    expect(draftRial(rialDraft("۱۰٬۰۰۰٬۰۰۰"))).toBe("10000000");
    expect(draftRial(tomanDraft("90071992547409931234"))).toBe("900719925474099312340");
  });
});

describe("draftDisplayText — a unit switch converts the amount, not the digits", () => {
  it("shows exactly what was typed while the unit has not changed", () => {
    expect(draftDisplayText(rialDraft("10000000"), "rial")).toBe("10000000");
    expect(draftDisplayText(tomanDraft("1000000"), "toman")).toBe("1000000");
  });

  it("Rial → Toman: 10,000,000 Rial typed, then the unit becomes Toman, shows 1,000,000", () => {
    const draft = rialDraft("10000000");
    expect(draftDisplayText(draft, "toman")).toBe("1000000");
    // …and the amount it saves is still 10,000,000 Rial, not 100,000,000.
    expect(draftRial(draft)).toBe("10000000");
  });

  it("Toman → Rial: 1,000,000 Toman typed, then the unit becomes Rial, shows 10,000,000", () => {
    const draft = tomanDraft("1000000");
    expect(draftDisplayText(draft, "rial")).toBe("10000000");
    expect(draftRial(draft)).toBe("10000000");
  });

  it("a round trip returns to the text that was typed", () => {
    expect(draftDisplayText({ text: draftDisplayText(rialDraft("30000000"), "toman"), unit: "toman" }, "rial")).toBe(
      "30000000",
    );
  });

  it("keeps an empty box empty and an unparseable one as typed", () => {
    expect(draftDisplayText(rialDraft(""), "toman")).toBe("");
    expect(draftDisplayText(rialDraft("1.5"), "toman")).toBe("1.5");
  });

  it("is exact beyond JavaScript's safe integers", () => {
    expect(draftDisplayText(rialDraft("900719925474099312340"), "toman")).toBe("90071992547409931234");
    expect(draftDisplayText(tomanDraft("90071992547409931234"), "rial")).toBe("900719925474099312340");
  });
});

describe("isDraftDirty — compared as Rial, not as text", () => {
  it("is clean without a draft", () => {
    expect(isDraftDirty(undefined, "30000000")).toBe(false);
    expect(isDraftDirty(undefined, null)).toBe(false);
  });

  it("is clean when the typed amount equals what is saved, whatever the unit or formatting", () => {
    expect(isDraftDirty(rialDraft("30000000"), "30000000")).toBe(false);
    expect(isDraftDirty(tomanDraft("3000000"), "30000000")).toBe(false);
    expect(isDraftDirty(rialDraft("030000000"), "30000000")).toBe(false);
    expect(isDraftDirty(rialDraft(""), null)).toBe(false);
  });

  it("is dirty when the amount differs, when a wage is being cleared, or when the text is malformed", () => {
    expect(isDraftDirty(rialDraft("30000001"), "30000000")).toBe(true);
    expect(isDraftDirty(tomanDraft("30000000"), "30000000")).toBe(true); // the 10× slip
    expect(isDraftDirty(rialDraft(""), "30000000")).toBe(true);
    expect(isDraftDirty(rialDraft("500"), null)).toBe(true);
    expect(isDraftDirty(rialDraft("abc"), "30000000")).toBe(true);
    expect(isDraftDirty(rialDraft("abc"), null)).toBe(true);
  });
});

describe("limits", () => {
  it("flags an amount the API's JSON number would round", () => {
    expect(MAX_JSON_AMOUNT).toBe(9007199254740991n);
    expect(exceedsJsonAmount("9007199254740991")).toBe(false);
    expect(exceedsJsonAmount("9007199254740992")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A member's four standing terms
// ---------------------------------------------------------------------------

const member = (overrides: Partial<StaffWage> = {}): StaffWage => ({
  id: "u1",
  fullName: "Staff A",
  role: "cashier",
  monthlyWage: "30000000",
  taxableAllowance: "0",
  nonTaxableAllowance: "0",
  fixedDeduction: "0",
  advanceOutstanding: "0",
  ...overrides,
});

describe("isTermDirty / dirtyTerms — each term is compared as Rial against what is saved", () => {
  it("is clean without a draft, and when the typed amount equals the saved one in any unit", () => {
    expect(isTermDirty("monthlyWage", undefined, member())).toBe(false);
    expect(isTermDirty("monthlyWage", tomanDraft("3000000"), member())).toBe(false);
    expect(dirtyTerms(undefined, member())).toEqual([]);
    expect(dirtyTerms({ monthlyWage: rialDraft("30000000"), taxableAllowance: rialDraft("") }, member())).toEqual([]);
  });

  it("treats an empty box on an allowance or deduction as zero — not a change when none is saved", () => {
    for (const term of ["taxableAllowance", "nonTaxableAllowance", "fixedDeduction"] as const) {
      expect(isTermDirty(term, rialDraft(""), member()), term).toBe(false);
      expect(isTermDirty(term, rialDraft("0"), member()), term).toBe(false);
      expect(isTermDirty(term, rialDraft("5"), member()), term).toBe(true);
      // Clearing a saved allowance is a change to zero.
      expect(isTermDirty(term, rialDraft(""), member({ [term]: "5" })), term).toBe(true);
    }
  });

  it("lets an empty wage box mean «clear the wage», which is a change only when one is saved", () => {
    expect(isTermDirty("monthlyWage", rialDraft(""), member())).toBe(true);
    expect(isTermDirty("monthlyWage", rialDraft(""), member({ monthlyWage: null }))).toBe(false);
    expect(isTermDirty("monthlyWage", rialDraft("0"), member({ monthlyWage: null }))).toBe(true);
  });

  it("is dirty for malformed text on any term, and names the dirty terms in screen order", () => {
    expect(isTermDirty("fixedDeduction", rialDraft("abc"), member())).toBe(true);
    const drafts: TermDrafts = {
      fixedDeduction: rialDraft("7"),
      monthlyWage: tomanDraft("3000001"),
      nonTaxableAllowance: rialDraft(""),
    };
    expect(dirtyTerms(drafts, member())).toEqual(["monthlyWage", "fixedDeduction"]);
  });

  it("catches the 10× slip on a term: the same digits in the other unit are a different amount", () => {
    expect(isTermDirty("taxableAllowance", tomanDraft("500000"), member({ taxableAllowance: "500000" }))).toBe(true);
    expect(isTermDirty("taxableAllowance", tomanDraft("50000"), member({ taxableAllowance: "500000" }))).toBe(false);
  });
});

describe("termDisplayText — what a term's box shows", () => {
  it("shows the saved amount in the current unit, and a zero allowance (or an unset wage) as an empty box", () => {
    expect(termDisplayText("monthlyWage", undefined, member(), "rial")).toBe("30000000");
    expect(termDisplayText("monthlyWage", undefined, member(), "toman")).toBe("3000000");
    expect(termDisplayText("monthlyWage", undefined, member({ monthlyWage: null }), "rial")).toBe("");
    expect(termDisplayText("taxableAllowance", undefined, member(), "rial")).toBe("");
    expect(termDisplayText("taxableAllowance", undefined, member({ taxableAllowance: "40" }), "toman")).toBe("4");
  });

  it("converts a draft from the unit it was typed in to the one the screen is in now", () => {
    expect(termDisplayText("fixedDeduction", rialDraft("10000000"), member(), "toman")).toBe("1000000");
    expect(termDisplayText("fixedDeduction", tomanDraft("1000000"), member(), "rial")).toBe("10000000");
  });
});

describe("termsBody — only what changed, from the digits", () => {
  it("writes just the changed terms, so saving one cannot overwrite another with a stale value", () => {
    const body = termsBody({ taxableAllowance: rialDraft("5000000"), monthlyWage: rialDraft("30000000") }, member());
    expect(body).toEqual({ ok: true, json: '{"taxableAllowance":5000000}', terms: ["taxableAllowance"] });
  });

  it("writes the wage as null when its box is cleared, and the others as 0", () => {
    expect(termsBody({ monthlyWage: rialDraft("") }, member())).toMatchObject({ ok: true, json: '{"monthlyWage":null}' });
    expect(termsBody({ fixedDeduction: rialDraft("") }, member({ fixedDeduction: "9" }))).toMatchObject({
      ok: true,
      json: '{"fixedDeduction":0}',
    });
  });

  it("converts a Toman draft to the Rial it stands for", () => {
    expect(termsBody({ monthlyWage: tomanDraft("4000000") }, member())).toMatchObject({ ok: true, json: '{"monthlyWage":40000000}' });
  });

  it("writes every changed term in screen order", () => {
    const body = termsBody(
      { fixedDeduction: rialDraft("1"), nonTaxableAllowance: rialDraft("2"), taxableAllowance: rialDraft("3"), monthlyWage: rialDraft("4") },
      member(),
    );
    expect(body).toMatchObject({
      ok: true,
      json: '{"monthlyWage":4,"taxableAllowance":3,"nonTaxableAllowance":2,"fixedDeduction":1}',
    });
  });

  it("refuses a malformed amount, and one a JSON number would round, naming the term", () => {
    expect(termsBody({ taxableAllowance: rialDraft("1.5") }, member())).toEqual({ ok: false, term: "taxableAllowance", reason: "invalid" });
    expect(termsBody({ monthlyWage: rialDraft("9007199254740992") }, member())).toEqual({
      ok: false,
      term: "monthlyWage",
      reason: "too_large",
    });
    expect(termsBody({ monthlyWage: rialDraft("9007199254740991") }, member())).toMatchObject({ ok: true });
  });

  it("is an empty object when nothing changed", () => {
    expect(termsBody({ monthlyWage: rialDraft("30000000") }, member())).toEqual({ ok: true, json: "{}", terms: [] });
  });
});
