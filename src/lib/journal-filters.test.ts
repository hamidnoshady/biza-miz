/**
 * Issue #821 — «دفتر روزنامه» query rules.
 *
 * The four things this file is the guard for, each of which was a real
 * defect on the journal screen:
 *
 *  - a date parameter that is *shaped* like a date but is not one
 *    (`2026-02-31`) reached PostgreSQL's `::date` cast instead of returning a
 *    controlled `invalid_date`;
 *  - pagination addressed a page by `OFFSET n` over a live book, so a posting
 *    made between two requests duplicated or skipped rows;
 *  - a filter the server could not understand was silently dropped, showing
 *    the reader a different book than the one they asked for;
 *  - BIGINT journal amounts were summed through JS `number`.
 */
import { describe, expect, it } from "vitest";
import {
  decodeJournalCursor,
  encodeJournalCursor,
  hasJournalFilters,
  JOURNAL_PAGE_SIZE,
  JOURNAL_MAX_LIMIT,
  journalEntryTotalText,
  parseJournalFilters,
  parseRialBound,
  sumRialText,
} from "./journal-filters";

function parse(qs: string) {
  return parseJournalFilters(new URLSearchParams(qs));
}

function filtersOf(qs: string) {
  const result = parse(qs);
  if ("error" in result) throw new Error(`expected filters, got ${result.error}`);
  return result.filters;
}

describe("parseJournalFilters — dates", () => {
  it("accepts a real range and keeps both ends", () => {
    const filters = filtersOf("dateFrom=2026-01-01&dateTo=2026-03-31");
    expect(filters.dateFrom).toBe("2026-01-01");
    expect(filters.dateTo).toBe("2026-03-31");
  });

  it("accepts a leap day in a leap year", () => {
    expect(filtersOf("dateFrom=2024-02-29").dateFrom).toBe("2024-02-29");
  });

  it("rejects a well-shaped day that does not exist", () => {
    // The whole point: `^\d{4}-\d{2}-\d{2}$` passes this, a calendar does not.
    expect(parse("dateFrom=2026-02-31")).toEqual({ error: "invalid_date" });
    expect(parse("dateTo=2025-02-29")).toEqual({ error: "invalid_date" });
    expect(parse("dateFrom=2026-13-01")).toEqual({ error: "invalid_date" });
    expect(parse("dateTo=2026-00-10")).toEqual({ error: "invalid_date" });
  });

  it("rejects a malformed date rather than ignoring it", () => {
    expect(parse("dateFrom=banana")).toEqual({ error: "invalid_date" });
    expect(parse("dateTo=1404/04/09")).toEqual({ error: "invalid_date" });
  });

  it("treats an empty date parameter as absent", () => {
    const filters = filtersOf("dateFrom=&dateTo=");
    expect(filters.dateFrom).toBeNull();
    expect(filters.dateTo).toBeNull();
  });

  it("rejects an inverted range", () => {
    expect(parse("dateFrom=2026-03-31&dateTo=2026-01-01")).toEqual({ error: "invalid_date_range" });
  });

  it("accepts a single-day range", () => {
    const filters = filtersOf("dateFrom=2026-03-31&dateTo=2026-03-31");
    expect(filters.dateFrom).toBe(filters.dateTo);
  });
});

describe("parseJournalFilters — the accounting-grade filters", () => {
  it("carries branch, account, creator and project through as uuids", () => {
    const ids = {
      location: "11111111-1111-4111-8111-111111111111",
      account: "22222222-2222-4222-8222-222222222222",
      creator: "33333333-3333-4333-8333-333333333333",
      project: "44444444-4444-4444-8444-444444444444",
    };
    const filters = filtersOf(
      `location=${ids.location}&account=${ids.account}&creator=${ids.creator}&project=${ids.project}`,
    );
    expect(filters.locationId).toBe(ids.location);
    expect(filters.accountId).toBe(ids.account);
    expect(filters.createdBy).toBe(ids.creator);
    expect(filters.projectId).toBe(ids.project);
  });

  it("rejects a non-uuid id instead of handing it to a uuid column", () => {
    expect(parse("location=unknown")).toEqual({ error: "invalid_filter" });
    expect(parse("account=12")).toEqual({ error: "invalid_filter" });
  });

  it("accepts the reversal states and the manual/system split", () => {
    expect(filtersOf("reversal=reversed").reversalState).toBe("reversed");
    expect(filtersOf("reversal=reversal").reversalState).toBe("reversal");
    expect(filtersOf("reversal=none").reversalState).toBe("none");
    expect(filtersOf("kind=manual").entryKind).toBe("manual");
    expect(filtersOf("kind=system").entryKind).toBe("system");
  });

  it("defaults both vocabularies to «any»", () => {
    const filters = filtersOf("");
    expect(filters.reversalState).toBe("any");
    expect(filters.entryKind).toBe("any");
  });

  it("rejects a value outside either vocabulary", () => {
    expect(parse("reversal=maybe")).toEqual({ error: "invalid_filter" });
    expect(parse("kind=robot")).toEqual({ error: "invalid_filter" });
  });

  it("keeps amount bounds as exact strings and normalises leading zeros", () => {
    const filters = filtersOf("amountMin=000500&amountMax=9007199254740993000");
    expect(filters.amountMin).toBe("500");
    // Beyond Number.MAX_SAFE_INTEGER and still exact.
    expect(filters.amountMax).toBe("9007199254740993000");
  });

  it("rejects a non-integer or inverted amount band", () => {
    expect(parse("amountMin=12.5")).toEqual({ error: "invalid_amount" });
    expect(parse("amountMin=-5")).toEqual({ error: "invalid_amount" });
    expect(parse("amountMin=900&amountMax=100")).toEqual({ error: "invalid_amount_range" });
  });

  it("trims the free-text search and drops a blank one", () => {
    expect(filtersOf("q=%20%20").q).toBeNull();
    expect(filtersOf("q=%20cash%20").q).toBe("cash");
  });
});

describe("parseJournalFilters — the page window", () => {
  it("defaults to one journal page", () => {
    expect(filtersOf("").limit).toBe(JOURNAL_PAGE_SIZE);
  });

  it("caps an oversized limit rather than honouring it", () => {
    expect(filtersOf("limit=100000").limit).toBe(JOURNAL_MAX_LIMIT);
  });

  it("ignores a nonsense limit", () => {
    expect(filtersOf("limit=0").limit).toBe(JOURNAL_PAGE_SIZE);
    expect(filtersOf("limit=-3").limit).toBe(JOURNAL_PAGE_SIZE);
    expect(filtersOf("limit=abc").limit).toBe(JOURNAL_PAGE_SIZE);
  });
});

describe("journal cursor", () => {
  const cursor = {
    entryDate: "2026-02-14",
    postedAt: "2026-02-14T09:30:00.000Z",
    id: "55555555-5555-4555-8555-555555555555",
  };

  it("round-trips the whole ordering tuple", () => {
    expect(decodeJournalCursor(encodeJournalCursor(cursor))).toEqual(cursor);
  });

  it("survives a URL round trip, which is how it actually travels", () => {
    const params = new URLSearchParams();
    params.set("cursor", encodeJournalCursor(cursor));
    expect(decodeJournalCursor(new URLSearchParams(params.toString()).get("cursor"))).toEqual(cursor);
  });

  it("reads an absent cursor as the first page, not as an error", () => {
    expect(decodeJournalCursor(null)).toBeNull();
    expect(decodeJournalCursor("")).toBeNull();
    expect(filtersOf("").cursor).toBeNull();
  });

  it("rejects a tampered or truncated cursor", () => {
    expect(decodeJournalCursor("nonsense")).toBeUndefined();
    expect(decodeJournalCursor("2026-02-14|2026-02-14T09:30:00Z")).toBeUndefined();
    expect(decodeJournalCursor(`2026-02-31|${cursor.postedAt}|${cursor.id}`)).toBeUndefined();
    expect(decodeJournalCursor(`${cursor.entryDate}|not-a-time|${cursor.id}`)).toBeUndefined();
    expect(decodeJournalCursor(`${cursor.entryDate}|${cursor.postedAt}|42`)).toBeUndefined();
  });

  it("surfaces a bad cursor as a named rejection from the parser", () => {
    expect(parse("cursor=nonsense")).toEqual({ error: "invalid_cursor" });
  });
});

describe("hasJournalFilters", () => {
  it("is false for an unfiltered journal", () => {
    expect(hasJournalFilters(filtersOf(""))).toBe(false);
    expect(hasJournalFilters(filtersOf("reversal=any&kind=any"))).toBe(false);
  });

  it("is true as soon as anything narrows the book", () => {
    expect(hasJournalFilters(filtersOf("q=rent"))).toBe(true);
    expect(hasJournalFilters(filtersOf("kind=manual"))).toBe(true);
    expect(hasJournalFilters(filtersOf("amountMin=1"))).toBe(true);
  });
});

describe("exact BIGINT money", () => {
  it("sums past Number.MAX_SAFE_INTEGER without losing a rial", () => {
    // 9007199254740993 is the first integer a JS number cannot represent.
    expect(sumRialText(["9007199254740992", "1"])).toBe("9007199254740993");
    expect(Number("9007199254740992") + Number("1")).toBe(9007199254740992); // the bug, for the record
  });

  it("totals a document from its debit column", () => {
    const total = journalEntryTotalText([
      { debit: "12345678901234567890" },
      { debit: "0" },
      { debit: "9876543210" },
    ]);
    expect(total).toBe("12345678911111111100");
  });

  it("treats a missing or malformed amount as zero rather than blanking the page", () => {
    expect(journalEntryTotalText([{ debit: null }, { debit: "abc" }, { debit: "10" }])).toBe("10");
    expect(journalEntryTotalText(null)).toBe("0");
    expect(journalEntryTotalText([])).toBe("0");
  });
});

describe("parseRialBound", () => {
  it("reads an absent bound as none and a malformed one as a rejection", () => {
    expect(parseRialBound(null)).toBeNull();
    expect(parseRialBound("  ")).toBeNull();
    expect(parseRialBound("۱۰۰")).toBeUndefined();
    expect(parseRialBound("1e6")).toBeUndefined();
  });
});
