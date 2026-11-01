/**
 * §D's gross-versus-net choice, as arithmetic a test can hold still.
 *
 * The account map is the reason this file exists rather than the normalisers. A
 * mis-stated presentation does not look wrong on screen — the row saves, the entry
 * balances, the invoice prints — it moves money between *cost of sales* and *a claim
 * on a client*, and the only symptom is a margin report that is quietly wrong in both
 * directions at once. So the four combinations are pinned here by account code, and a
 * change to any of them is a change to the trade's books that has to be made
 * deliberately.
 */
import { describe, expect, it } from "vitest";
import { WELL_KNOWN_CODES } from "./coa-template";
import {
  AGENCY_COST_AMOUNT_MAX,
  AGENCY_COST_DATE_YEAR_MAX,
  AGENCY_COST_DATE_YEAR_MIN,
  AGENCY_COST_DESCRIPTION_LIMIT,
  AGENCY_COST_SETTLEMENTS,
  AGENCY_PASS_THROUGH_PRESENTATIONS,
  AGENCY_PASS_THROUGH_PRESENTATION_HINTS,
  AGENCY_PASS_THROUGH_PRESENTATION_LABELS,
  COST_NUMBER_PREFIX,
  isAgencyCostSettlement,
  isAgencyPassThroughPresentation,
  isPassThroughToClient,
  isReimbursableCostPosted,
  normalizeAgencyCostAmount,
  normalizeAgencyCostDate,
  normalizeAgencyCostOptionalText,
  normalizeAgencyCostText,
  reimbursableCostAccounts,
} from "./agency-reimbursable-cost";

describe("the two accounts one reimbursable cost lands in", () => {
  it("debits 1270 on net and 5197 on gross — and that is the whole of §D's choice", () => {
    // The account a pass-through is *for*. Wave 1 seeded it and nothing could reach
    // it for eight waves; this is the line that makes it reachable.
    expect(WELL_KNOWN_CODES.agencyReimbursableClientCost).toBe("1270");
    expect(WELL_KNOWN_CODES.agencyMediaCost).toBe("5197");

    expect(
      reimbursableCostAccounts({ presentation: "net", settledBy: "payable" }).debitCode,
    ).toBe("1270");
    expect(
      reimbursableCostAccounts({ presentation: "gross", settledBy: "payable" }).debitCode,
    ).toBe("5197");
  });

  it("credits the settlement account, and 2140 for the default", () => {
    expect(reimbursableCostAccounts({ presentation: "net", settledBy: "cash" }).creditCode).toBe(
      WELL_KNOWN_CODES.cash,
    );
    expect(reimbursableCostAccounts({ presentation: "net", settledBy: "bank" }).creditCode).toBe(
      WELL_KNOWN_CODES.bankClearing,
    );
    // The seam §D's vendor chain will settle through: 2140 is already classified as
    // a trade payable, so a purchase order arriving later pays *this* row rather
    // than becoming a second way to book the same media buy.
    expect(reimbursableCostAccounts({ presentation: "net", settledBy: "payable" }).creditCode).toBe(
      "2140",
    );
  });

  it("covers all four combinations, so no third treatment can be invented", () => {
    const pairs = AGENCY_PASS_THROUGH_PRESENTATIONS.flatMap((presentation) =>
      AGENCY_COST_SETTLEMENTS.map((settledBy) => ({ presentation, settledBy })),
    );
    expect(pairs).toHaveLength(6);
    for (const pair of pairs) {
      const accounts = reimbursableCostAccounts(pair);
      // Debit and credit are never the same account: an entry that credits what it
      // debited is a nullity that would still balance and still be wrong.
      expect(accounts.debitCode, JSON.stringify(pair)).not.toBe(accounts.creditCode);
      expect(accounts.debitCode).toMatch(/^[0-9]{4}$/);
      expect(accounts.creditCode).toMatch(/^[0-9]{4}$/);
    }
  });

  it("returns no VAT and no revenue account, because a cost is not a sale", () => {
    const accounts = reimbursableCostAccounts({ presentation: "net", settledBy: "payable" });
    expect(Object.keys(accounts).sort()).toEqual(["creditCode", "debitCode"]);
  });

  it("answers «is this the client's money?» from one predicate", () => {
    expect(isPassThroughToClient("net")).toBe(true);
    expect(isPassThroughToClient("gross")).toBe(false);
    // §D's reporting question — how much did we spend on clients' behalf that is not
    // our own cost of sales — is a filter over this predicate rather than a second
    // copy of the account codes somewhere in a report.
    expect(isPassThroughToClient("net") && reimbursableCostAccounts({ presentation: "net", settledBy: "cash" }).debitCode === "1270").toBe(true);
  });
});

describe("the vocabularies", () => {
  it("are closed lists with a label and an explanation for every member", () => {
    expect([...AGENCY_PASS_THROUGH_PRESENTATIONS]).toEqual(["net", "gross"]);
    expect([...AGENCY_COST_SETTLEMENTS]).toEqual(["cash", "bank", "payable"]);
    for (const presentation of AGENCY_PASS_THROUGH_PRESENTATIONS) {
      expect(AGENCY_PASS_THROUGH_PRESENTATION_LABELS[presentation]).toBeTruthy();
      // The hint is what makes the choice a choice rather than a toggle: a member
      // who cannot tell the two apart will pick one, and the books will carry it.
      expect(AGENCY_PASS_THROUGH_PRESENTATION_HINTS[presentation]).toBeTruthy();
    }
    // And the label names the account it lands in, so the picker and the ledger
    // agree without either restating a code in prose.
    expect(AGENCY_PASS_THROUGH_PRESENTATION_LABELS.net).toContain("۱۲۷۰");
    expect(AGENCY_PASS_THROUGH_PRESENTATION_LABELS.gross).toContain("۵۱۹۷");
  });

  it("recognise their own members and nothing else", () => {
    expect(isAgencyPassThroughPresentation("net")).toBe(true);
    expect(isAgencyPassThroughPresentation("gross")).toBe(true);
    expect(isAgencyPassThroughPresentation("hybrid")).toBe(false);
    expect(isAgencyPassThroughPresentation("")).toBe(false);
    expect(isAgencyPassThroughPresentation(null)).toBe(false);
    expect(isAgencyPassThroughPresentation(1)).toBe(false);

    expect(isAgencyCostSettlement("payable")).toBe(true);
    expect(isAgencyCostSettlement("barter")).toBe(false);
    expect(isAgencyCostSettlement(undefined)).toBe(false);
  });

  it("numbers costs RC-, like every other agency register has its own prefix", () => {
    expect(COST_NUMBER_PREFIX).toBe("RC");
  });
});

describe("posted, and therefore frozen", () => {
  it("reads the entry id, not a status column", () => {
    // A locked fiscal period routes an auto-posted entry to the human-approval queue
    // rather than refusing the spend, so "recorded but not yet posted" is a real
    // state — and everything 0280 freezes keys off this one fact.
    expect(isReimbursableCostPosted("2f0f0f0f-0000-0000-0000-000000000000")).toBe(true);
    expect(isReimbursableCostPosted(null)).toBe(false);
    expect(isReimbursableCostPosted(undefined)).toBe(false);
    expect(isReimbursableCostPosted("")).toBe(false);
  });
});

describe("the amount", () => {
  it("accepts an integer rial from a number or a string of digits", () => {
    expect(normalizeAgencyCostAmount(5_000_000)).toBe(5_000_000);
    expect(normalizeAgencyCostAmount("5000000")).toBe(5_000_000);
    expect(normalizeAgencyCostAmount(1)).toBe(1);
  });

  it("refuses zero and anything negative", () => {
    // A zero-rial pass-through is not a claim on anybody, and it would sit in 1270 as
    // a row that can never clear.
    expect(normalizeAgencyCostAmount(0)).toBeNull();
    expect(normalizeAgencyCostAmount("0")).toBeNull();
    expect(normalizeAgencyCostAmount(-1)).toBeNull();
    expect(normalizeAgencyCostAmount("-5000")).toBeNull();
  });

  it("refuses a fraction rather than rounding it", () => {
    // Silently rounding a figure that is about to be posted to the ledger is how a
    // register and its books start to disagree.
    expect(normalizeAgencyCostAmount(1000.5)).toBeNull();
    expect(normalizeAgencyCostAmount("1000.5")).toBeNull();
    expect(normalizeAgencyCostAmount("1٬000")).toBeNull();
  });

  it("refuses the unusable and the absent", () => {
    for (const value of [undefined, null, "", "   ", "abc", {}, [], Number.NaN, Infinity]) {
      expect(normalizeAgencyCostAmount(value), String(value)).toBeNull();
    }
  });

  it("stays inside the bigint column, at the bound and past it", () => {
    // The bound is exactly representable as a double (9e15 is below
    // Number.MAX_SAFE_INTEGER), so it is accepted from either spelling — and one
    // rial past it is refused rather than wrapped.
    expect(normalizeAgencyCostAmount("9000000000000000")).toBe(Number(AGENCY_COST_AMOUNT_MAX));
    expect(normalizeAgencyCostAmount(Number(AGENCY_COST_AMOUNT_MAX))).toBe(9_000_000_000_000_000);
    expect(normalizeAgencyCostAmount("9000000000000001")).toBeNull();
  });
});

describe("the day it was spent", () => {
  it("accepts a real Gregorian date", () => {
    expect(normalizeAgencyCostDate("2026-11-01")).toBe("2026-11-01");
    expect(normalizeAgencyCostDate("  2026-02-28  ")).toBe("2026-02-28");
    expect(normalizeAgencyCostDate("2024-02-29")).toBe("2024-02-29");
  });

  it("refuses a date the calendar does not have", () => {
    // `Date.parse` finiteness would accept both of these: 2027-02-30 rolls over to
    // 1 March, and a shape regex alone accepts the second.
    expect(normalizeAgencyCostDate("2027-02-30")).toBeNull();
    expect(normalizeAgencyCostDate("2026-13-01")).toBeNull();
    expect(normalizeAgencyCostDate("2023-02-29")).toBeNull();
  });

  it("refuses a Jalali year, which a shape check would accept", () => {
    // `isValidIsoDate` is calendar-aware about days but shape-based about the year,
    // so 1406-03-01 passes it. The bounds are what make this a date a member meant.
    expect(normalizeAgencyCostDate("1406-03-01")).toBeNull();
    expect(AGENCY_COST_DATE_YEAR_MIN).toBe(1970);
    expect(AGENCY_COST_DATE_YEAR_MAX).toBe(2200);
  });

  it("refuses what is not a date at all", () => {
    for (const value of [undefined, null, "", "   ", "2026-11-1", "01/11/2026", 20261101, {}]) {
      expect(normalizeAgencyCostDate(value), String(value)).toBeNull();
    }
  });
});

describe("free text", () => {
  it("trims a required field and refuses a blank one", () => {
    expect(normalizeAgencyCostText("  خرید فضا  ", 300)).toEqual({
      present: true,
      value: "خرید فضا",
      tooLong: false,
    });
    expect(normalizeAgencyCostText("   ", 300).present).toBe(false);
    expect(normalizeAgencyCostText(undefined, 300).present).toBe(false);
    expect(normalizeAgencyCostText(42, 300).present).toBe(false);
  });

  it("reports over-long rather than truncating", () => {
    // Truncating a description that is about to appear on a client's invoice would
    // quietly change what they are being asked to pay for.
    const long = "ا".repeat(AGENCY_COST_DESCRIPTION_LIMIT + 1);
    const result = normalizeAgencyCostText(long, AGENCY_COST_DESCRIPTION_LIMIT);
    expect(result.tooLong).toBe(true);
    expect(result.value).toBe(long);
  });

  it("counts characters, not UTF-16 units", () => {
    // Persian text is BMP, but an emoji in a vendor name is not, and `.length` would
    // refuse one a member is allowed to type.
    const withEmoji = "پلتفرم 🎬".repeat(1);
    expect(normalizeAgencyCostText(withEmoji, 200).tooLong).toBe(false);
    expect([...withEmoji].length).toBeLessThan(withEmoji.length);
  });

  it("treats an empty optional field as a clear, not a refusal", () => {
    // The distinction a PATCH depends on: absent leaves the field alone, an empty
    // string empties it, and neither is an error.
    expect(normalizeAgencyCostOptionalText(undefined, 4000).present).toBe(false);
    expect(normalizeAgencyCostOptionalText(null, 4000).present).toBe(false);
    expect(normalizeAgencyCostOptionalText("", 4000)).toEqual({ present: true, value: "", tooLong: false });
    expect(normalizeAgencyCostOptionalText("   ", 4000)).toEqual({ present: true, value: "", tooLong: false });
  });
});
