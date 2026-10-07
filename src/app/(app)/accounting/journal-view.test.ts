/**
 * Issue #821 — the «دفتر روزنامه» screen's own rules.
 *
 * Three of them were defects a reader actually met:
 *
 *  - «برگشت سند» was drawn for anyone looking at an eligible manual document,
 *    while the API required `ledger.approve` — so a manager pressed a live
 *    destructive accounting control and collected a 403;
 *  - the filters lived in React state, so a filtered journal could not be
 *    bookmarked, shared, or returned to with the Back button;
 *  - with `hasMore` the screen printed «۱۰۰ سند در این فیلتر», which is the
 *    number of *loaded* rows presented as the number of matches.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_JOURNAL_FILTERS,
  activeJournalFilterCount,
  canReverseJournalEntry,
  hasActiveJournalFilters,
  journalCountLabel,
  journalCounterpartEntryId,
  journalDetailId,
  journalErrorMessage,
  journalFilterParams,
  journalFiltersFromParams,
  journalReversalBadge,
  journalRowId,
  rialTextToAmountInput,
  type JournalFilterState,
} from "./journal-view";

const MANUAL = { sourceType: "manual", reversesEntryId: null, reversedAt: null };

describe("canReverseJournalEntry — the reversal permission, same on both sides", () => {
  it("lets a member holding ledger.approve reverse an eligible manual document", () => {
    expect(canReverseJournalEntry(MANUAL, true)).toBe(true);
  });

  it("hides the action from a member who does not hold ledger.approve", () => {
    // The regression this test exists for: a manager may open the journal but
    // may not approve, and the button used not to ask.
    expect(canReverseJournalEntry(MANUAL, false)).toBe(false);
  });

  it("draws it when the page could not read the member's permissions, leaving the API as the gate", () => {
    expect(canReverseJournalEntry(MANUAL, undefined)).toBe(true);
  });

  it("never offers it for an auto-posted document, whatever the permission", () => {
    for (const canApprove of [true, false, undefined]) {
      expect(canReverseJournalEntry({ ...MANUAL, sourceType: "retail_invoice" }, canApprove)).toBe(false);
      expect(canReverseJournalEntry({ ...MANUAL, sourceType: null }, canApprove)).toBe(false);
    }
  });

  it("never offers it for a reversal, or for an already-reversed document", () => {
    expect(canReverseJournalEntry({ ...MANUAL, reversesEntryId: "x" }, true)).toBe(false);
    expect(canReverseJournalEntry({ ...MANUAL, reversedAt: "2026-01-01T00:00:00Z" }, true)).toBe(false);
  });
});

describe("reversal pair", () => {
  it("badges each side of the pair", () => {
    expect(journalReversalBadge({ reversesEntryId: "a", reversedAt: null })).toBe("reversal");
    expect(journalReversalBadge({ reversesEntryId: null, reversedAt: "t" })).toBe("reversed");
    expect(journalReversalBadge({ reversesEntryId: null, reversedAt: null })).toBeNull();
  });

  it("points a reversal at its original and an original at its reversal", () => {
    expect(journalCounterpartEntryId({ reversesEntryId: "orig", reversedByEntryId: null })).toEqual({
      id: "orig",
      direction: "original",
    });
    expect(journalCounterpartEntryId({ reversesEntryId: null, reversedByEntryId: "rev" })).toEqual({
      id: "rev",
      direction: "reversal",
    });
    expect(journalCounterpartEntryId({ reversesEntryId: null, reversedByEntryId: null })).toBeNull();
  });

  it("names the row and its detail panel one way", () => {
    expect(journalRowId("abc")).toBe("journal-entry-abc");
    expect(journalDetailId("abc")).toBe("journal-entry-detail-abc");
  });
});

describe("filters ⇄ URL", () => {
  const filled: JournalFilterState = {
    dateFrom: "2026-01-01",
    dateTo: "2026-03-31",
    sourceType: "manual",
    q: "  اجاره  ",
    location: "11111111-1111-4111-8111-111111111111",
    account: "22222222-2222-4222-8222-222222222222",
    creator: "33333333-3333-4333-8333-333333333333",
    project: "44444444-4444-4444-8444-444444444444",
    reversal: "reversed",
    kind: "manual",
    amountMin: "100",
    amountMax: "900",
  };

  it("round-trips every filter through the query string", () => {
    const restored = journalFiltersFromParams(journalFilterParams(filled));
    expect(restored).toEqual({ ...filled, q: "اجاره" });
  });

  it("writes nothing for an unfiltered journal, so the clean URL stays clean", () => {
    expect(journalFilterParams(EMPTY_JOURNAL_FILTERS).toString()).toBe("");
    expect(hasActiveJournalFilters(EMPTY_JOURNAL_FILTERS)).toBe(false);
    expect(activeJournalFilterCount(EMPTY_JOURNAL_FILTERS)).toBe(0);
  });

  it("omits the «any» vocabularies rather than spelling out a default", () => {
    const params = journalFilterParams({ ...EMPTY_JOURNAL_FILTERS, reversal: "any", kind: "any" });
    expect(params.has("reversal")).toBe(false);
    expect(params.has("kind")).toBe(false);
  });

  it("counts how many filters are narrowing the book", () => {
    expect(activeJournalFilterCount(filled)).toBe(12);
    expect(activeJournalFilterCount({ ...EMPTY_JOURNAL_FILTERS, q: "rent" })).toBe(1);
  });

  it("falls back to «any» for a vocabulary value a link got wrong, instead of breaking the screen", () => {
    const restored = journalFiltersFromParams(new URLSearchParams("reversal=maybe&kind=robot"));
    expect(restored.reversal).toBe("any");
    expect(restored.kind).toBe("any");
  });

  it("reads an empty query string as the unfiltered journal", () => {
    expect(journalFiltersFromParams(new URLSearchParams(""))).toEqual(EMPTY_JOURNAL_FILTERS);
  });

  it("ignores query keys the journal does not own (a ?party= or ?entry= passer-by)", () => {
    const restored = journalFiltersFromParams(new URLSearchParams("entry=abc&party=xyz&q=rent"));
    expect(restored).toEqual({ ...EMPTY_JOURNAL_FILTERS, q: "rent" });
  });
});

describe("journalCountLabel — never presents a loaded page as the total", () => {
  it("states the real total when everything matching is on screen", () => {
    expect(journalCountLabel({ loaded: 7, totalCount: 7, hasMore: false, filtered: true })).toBe(
      "۷ سند در این فیلتر",
    );
  });

  it("says how many of the total are shown when more remain", () => {
    expect(journalCountLabel({ loaded: 50, totalCount: 1203, hasMore: true, filtered: true })).toBe(
      "۵۰ از ۱٬۲۰۳ سند در این فیلتر نمایش داده شده",
    );
  });

  it("only ever claims «نمایش داده شده» when the server gave no total", () => {
    expect(journalCountLabel({ loaded: 100, totalCount: null, hasMore: true, filtered: true })).toBe(
      "۱۰۰ سند نمایش داده شده",
    );
  });

  it("says the book is empty rather than printing a zero count", () => {
    expect(journalCountLabel({ loaded: 0, totalCount: 0, hasMore: false, filtered: false })).toBe(
      "سندی در دفتر نیست",
    );
  });
});

describe("rialTextToAmountInput", () => {
  it("converts to the business's display unit with BigInt, not Number", () => {
    expect(rialTextToAmountInput("90071992547409930", "toman")).toBe("9007199254740993");
    expect(rialTextToAmountInput("90071992547409930", "rial")).toBe("90071992547409930");
  });

  it("shows an empty field for an empty or malformed bound", () => {
    expect(rialTextToAmountInput("", "toman")).toBe("");
    expect(rialTextToAmountInput("abc", "toman")).toBe("");
    expect(rialTextToAmountInput("-5", "rial")).toBe("");
  });
});

describe("journalErrorMessage", () => {
  it("translates the journal's own rejections", () => {
    expect(journalErrorMessage("invalid_date")).toContain("تقویم");
    expect(journalErrorMessage("invalid_date_range")).toContain("بازهٔ تاریخ");
    expect(journalErrorMessage("invalid_amount_range")).toContain("بازهٔ مبلغ");
  });

  it("falls back to a usable sentence for an unknown code", () => {
    expect(journalErrorMessage("something_new")).toContain("دوباره تلاش کنید");
    expect(journalErrorMessage(undefined)).toContain("دوباره تلاش کنید");
  });
});
