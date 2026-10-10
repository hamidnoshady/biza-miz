/**
 * «دفتر روزنامه» — what a journal *query* is, with no database and no React.
 *
 * The journal is a book an accountant searches, and three different places
 * have to agree on what a search means: the list route, the export route (the
 * same route with `?format=`) and the screen that builds the query string and
 * keeps it in the URL. Per this repo's convention a DB-touching module has no
 * direct unit test, so the rules worth asserting — which parameters are
 * acceptable, how a page boundary is addressed, how an exact BIGINT total is
 * summed — live here, and `journal-filters.test.ts` is their test.
 *
 * Three things in particular are stated once here rather than re-derived:
 *
 *  - **Dates are calendar dates.** `2026-02-31` matches the ISO *shape* and is
 *    not a day; the route used to hand it to PostgreSQL and get a cast error
 *    instead of a controlled `invalid_date`. The rule is `iso-date.ts`'s
 *    `isValidIsoDate`, the repo's one definition of a calendar date.
 *  - **Pagination is keyset, not offset.** A journal is live: documents are
 *    posted while somebody is reading page one, and `OFFSET n` over
 *    `entry_date DESC, posted_at DESC, id DESC` then skips or repeats rows. A
 *    cursor is that exact ordering tuple, so "the next page" means "everything
 *    strictly after this document" however many are posted meanwhile.
 *  - **Money never becomes a JS `number`.** `journal_lines.debit/credit` are
 *    BIGINT and arrive as strings; summing them through `Number` silently
 *    rounds past 2^53 rial. Totals are `BigInt` here and decimal strings on
 *    the wire, for `money.formatText()` to render.
 */

import { isValidIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import { DIMENSION_KINDS, type DimensionKind } from "./accounting-dimensions";

/** One page of the journal. Deliberately smaller than the old 100: the list is compact and keyset-paged, so «بیشتر» is cheap. */
export const JOURNAL_PAGE_SIZE = 50;
export const JOURNAL_MAX_LIMIT = 200;
/**
 * The hard ceiling on one export request. An export ignores pagination by
 * design (that is the whole point — the complete filtered result, not the
 * rows that happen to be on screen), so it needs its own bound or a filterless
 * export of a ten-year-old ledger builds the whole book in memory.
 */
export const JOURNAL_EXPORT_ROW_CAP = 20_000;

/** Which side of a reversal a document is on. */
export const JOURNAL_REVERSAL_STATES = ["any", "none", "reversed", "reversal"] as const;
export type JournalReversalState = (typeof JOURNAL_REVERSAL_STATES)[number];

/** Hand-typed documents versus everything the posting engine wrote. */
export const JOURNAL_ENTRY_KINDS = ["any", "manual", "system"] as const;
export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number];

/** The export formats the journal speaks, following the platform's data-transfer codecs. */
export const JOURNAL_EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type JournalExportFormat = (typeof JOURNAL_EXPORT_FORMATS)[number];

/**
 * A page boundary: the ordering tuple of the last document already shown.
 * `postedAt` is the raw timestamptz text the row carried, never re-formatted —
 * it is compared against the same column it came from.
 */
export interface JournalCursor {
  entryDate: string;
  postedAt: string;
  id: string;
}

/** The URL parameter each dimension kind is filtered by on the journal (issue #868). */
export const JOURNAL_DIMENSION_PARAMS: Record<DimensionKind, string> = {
  cost_center: "costCenter",
  profit_center: "profitCenter",
  department: "department",
  detail: "detail",
};

export interface JournalFilters {
  dateFrom: string | null;
  dateTo: string | null;
  sourceType: string | null;
  q: string | null;
  locationId: string | null;
  accountId: string | null;
  createdBy: string | null;
  projectId: string | null;
  /**
   * Issue #868: dimension values to match, all on ONE line. A document matches
   * when a single line carries every value named here, which is the same AND the
   * reports apply — never a match of one line for one kind and another line for
   * the other. Empty when no dimension is filtered.
   */
  dimensions: Partial<Record<DimensionKind, string>>;
  /**
   * One document by id — the deep link the reports drill-down renders
   * («بازکردن سند»), which must open the journal *on that document* rather
   * than at the top of the book.
   */
  entryId: string | null;
  reversalState: JournalReversalState;
  entryKind: JournalEntryKind;
  /** Inclusive bounds on the document's total debit, as exact Rial decimal strings. */
  amountMin: string | null;
  amountMax: string | null;
  limit: number;
  cursor: JournalCursor | null;
}

export type JournalFilterProblem =
  | "invalid_date"
  | "invalid_date_range"
  | "invalid_cursor"
  | "invalid_filter"
  | "invalid_entry_id"
  | "invalid_amount"
  | "invalid_amount_range";

export type JournalFilterResult = { filters: JournalFilters } | { error: JournalFilterProblem };

/** The query-string keys the journal owns, so the screen and the route cannot drift. */
export const JOURNAL_FILTER_PARAM_KEYS = [
  "dateFrom",
  "dateTo",
  "sourceType",
  "q",
  "location",
  "account",
  "creator",
  "project",
  "reversal",
  "kind",
  "amountMin",
  "amountMax",
  "entryId",
] as const;

function trimmed(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

/** A whole, non-negative Rial amount as a decimal string — never a JS number. */
export function parseRialBound(value: string | null | undefined): string | null | undefined {
  const text = trimmed(value);
  if (text === null) return null;
  if (!/^\d{1,19}$/.test(text)) return undefined;
  // Strip leading zeros so two spellings of the same bound compare equal.
  return BigInt(text).toString();
}

/**
 * `entryDate|postedAt|id` — opaque to the screen, which only ever echoes it
 * back. Deliberately *not* base64: this module is imported by the client
 * component too (it owns the query-string keys and the reversal vocabulary),
 * and `Buffer` is not a browser global.
 */
export function encodeJournalCursor(cursor: JournalCursor): string {
  return `${cursor.entryDate}|${cursor.postedAt}|${cursor.id}`;
}

export function decodeJournalCursor(value: string | null | undefined): JournalCursor | null | undefined {
  const text = trimmed(value);
  if (text === null) return null;
  const parts = text.split("|");
  if (parts.length !== 3) return undefined;
  const [entryDate, postedAt, id] = parts;
  if (!isValidIsoDate(entryDate)) return undefined;
  if (!postedAt || Number.isNaN(Date.parse(postedAt))) return undefined;
  if (!isUuid(id)) return undefined;
  return { entryDate, postedAt, id };
}

/**
 * The filters a request is asking for, or the first thing wrong with it.
 *
 * Every rejection is a named code the screen can translate; nothing is
 * silently ignored, because a filter the server drops shows the reader a
 * different book than the one they asked for.
 */
export function parseJournalFilters(params: URLSearchParams): JournalFilterResult {
  const dateFrom = isoDateFilter(params.get("dateFrom"));
  const dateTo = isoDateFilter(params.get("dateTo"));
  if (dateFrom === undefined || dateTo === undefined) return { error: "invalid_date" };
  if (dateFrom && dateTo && dateFrom > dateTo) return { error: "invalid_date_range" };

  const locationId = uuidFilter(params.get("location"));
  const accountId = uuidFilter(params.get("account"));
  const createdBy = uuidFilter(params.get("creator"));
  const projectId = uuidFilter(params.get("project"));
  if (locationId === undefined || accountId === undefined || createdBy === undefined || projectId === undefined) {
    return { error: "invalid_filter" };
  }
  const dimensions: Partial<Record<DimensionKind, string>> = {};
  for (const kind of DIMENSION_KINDS) {
    const value = uuidFilter(params.get(JOURNAL_DIMENSION_PARAMS[kind]));
    if (value === undefined) return { error: "invalid_filter" };
    if (value) dimensions[kind] = value;
  }

  // Its own code rather than `invalid_filter`: this one arrives from a link
  // somebody followed, not from a control they set, so the screen has a
  // different thing to say about it.
  const entryId = uuidFilter(params.get("entryId"));
  if (entryId === undefined) return { error: "invalid_entry_id" };

  const reversalState = enumFilter(params.get("reversal"), JOURNAL_REVERSAL_STATES);
  const entryKind = enumFilter(params.get("kind"), JOURNAL_ENTRY_KINDS);
  if (reversalState === undefined || entryKind === undefined) return { error: "invalid_filter" };

  const amountMin = parseRialBound(params.get("amountMin"));
  const amountMax = parseRialBound(params.get("amountMax"));
  if (amountMin === undefined || amountMax === undefined) return { error: "invalid_amount" };
  if (amountMin !== null && amountMax !== null && BigInt(amountMin) > BigInt(amountMax)) {
    return { error: "invalid_amount_range" };
  }

  const cursor = decodeJournalCursor(params.get("cursor"));
  if (cursor === undefined) return { error: "invalid_cursor" };

  const requestedLimit = Number(params.get("limit"));
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, JOURNAL_MAX_LIMIT)
      : JOURNAL_PAGE_SIZE;

  return {
    filters: {
      dateFrom,
      dateTo,
      sourceType: trimmed(params.get("sourceType")),
      q: trimmed(params.get("q")),
      locationId,
      accountId,
      createdBy,
      projectId,
      dimensions,
      entryId,
      reversalState: reversalState ?? "any",
      entryKind: entryKind ?? "any",
      amountMin,
      amountMax,
      limit,
      cursor,
    },
  };
}

function isoDateFilter(value: string | null): string | null | undefined {
  const text = trimmed(value);
  if (text === null) return null;
  return isValidIsoDate(text) ? text : undefined;
}

function uuidFilter(value: string | null): string | null | undefined {
  const text = trimmed(value);
  if (text === null) return null;
  return isUuid(text) ? text : undefined;
}

function enumFilter<T extends readonly string[]>(
  value: string | null,
  allowed: T,
): T[number] | null | undefined {
  const text = trimmed(value);
  if (text === null) return null;
  return (allowed as readonly string[]).includes(text) ? (text as T[number]) : undefined;
}

/** True when the request narrowed the book at all — the screen's «پاک کردن فیلترها» affordance. */
export function hasJournalFilters(filters: JournalFilters): boolean {
  return !!(
    filters.dateFrom ||
    filters.dateTo ||
    filters.sourceType ||
    filters.q ||
    filters.locationId ||
    filters.accountId ||
    filters.createdBy ||
    filters.projectId ||
    Object.keys(filters.dimensions ?? {}).length > 0 ||
    (filters.reversalState && filters.reversalState !== "any") ||
    (filters.entryKind && filters.entryKind !== "any") ||
    filters.amountMin ||
    filters.amountMax
  );
}

/**
 * The exact sum of a set of Rial strings, as a Rial string.
 *
 * `BigInt`, not `Number`: a journal line is a PostgreSQL BIGINT, and a
 * document whose total passes `Number.MAX_SAFE_INTEGER` (≈۹٬۰۰۷ تریلیون ریال —
 * reachable in a ledger that has been running for years, and trivially
 * reachable in a Rial-denominated opening balance) would otherwise be rendered
 * wrong. Non-numeric input is treated as zero rather than throwing, because a
 * malformed line must not blank the whole page.
 */
export function sumRialText(values: readonly (string | null | undefined)[]): string {
  let total = 0n;
  for (const value of values) {
    if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) continue;
    total += BigInt(value.trim());
  }
  return total.toString();
}

/** A document's total, which by double-entry is the sum of its debit column. */
export function journalEntryTotalText(
  lines: readonly { debit?: string | null }[] | null | undefined,
): string {
  return sumRialText((lines ?? []).map((line) => line.debit ?? "0"));
}
