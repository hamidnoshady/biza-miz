/**
 * «دفتر روزنامه» — the screen's rules, with no React.
 *
 * `entries-section.tsx` is a client component; the decisions it makes that are
 * worth being sure about are not. They live here so `journal-view.test.ts` can
 * assert them directly:
 *
 *  - **who may reverse** — the journal's one destructive action. The API is
 *    gated on `ledger.approve`; the button used to be gated only on "is this a
 *    manual, un-reversed, non-reversal entry", so a manager saw a live
 *    destructive accounting control and learned otherwise from a 403. Same
 *    rule, both sides.
 *  - **the filter state ⇄ URL mapping** — a filtered journal has to be a link
 *    somebody can send, a bookmark, and a Back button that returns to the
 *    slice you were reading.
 *  - **what the result count may claim.** With `hasMore`, «۱۰۰ سند در این
 *    فیلتر» was a loaded-page count presented as a total. The server returns a
 *    real `totalCount` now; when it cannot, the copy says «نمایش داده شده».
 */
import {
  JOURNAL_ENTRY_KINDS,
  JOURNAL_REVERSAL_STATES,
  type JournalEntryKind,
  type JournalReversalState,
} from "@/lib/journal-filters";
import { formatPersianNumber } from "@/lib/digits";
import type { MoneyUnit } from "@/lib/money";

/** The journal document as the screen receives it from `/api/ledger/entries`. */
export interface JournalLineView {
  entryId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  /** Exact Rial as a decimal string — never converted through `Number`. */
  debit: string;
  credit: string;
}

export interface JournalEntryView {
  id: string;
  entryDate: string;
  postedAt: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  locationId: string | null;
  locationName: string | null;
  projectId: string | null;
  projectName: string | null;
  createdBy: string | null;
  createdByName: string | null;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  reversedByName: string | null;
  totalDebit: string;
  lines: JournalLineView[];
}

/**
 * May this member reverse this document?
 *
 * `canApprove === undefined` means the page could not read the member's
 * effective permissions; the control is drawn and the API stays the gate,
 * which is how `AccountingManager` already treats the same gap for the
 * manual-entry review queue. `false` is a definite no and hides it.
 */
export function canReverseJournalEntry(
  entry: Pick<JournalEntryView, "sourceType" | "reversesEntryId" | "reversedAt">,
  canApprove: boolean | undefined,
): boolean {
  if (canApprove === false) return false;
  if (entry.sourceType !== "manual") return false;
  if (entry.reversesEntryId) return false;
  if (entry.reversedAt) return false;
  return true;
}

/** Where a document sits in a reversal pair — the badge the list shows. */
export function journalReversalBadge(
  entry: Pick<JournalEntryView, "reversesEntryId" | "reversedAt">,
): "reversal" | "reversed" | null {
  if (entry.reversesEntryId) return "reversal";
  if (entry.reversedAt) return "reversed";
  return null;
}

/** The other half of a reversal pair, in whichever direction this document points. */
export function journalCounterpartEntryId(
  entry: Pick<JournalEntryView, "reversesEntryId" | "reversedByEntryId">,
): { id: string; direction: "original" | "reversal" } | null {
  if (entry.reversesEntryId) return { id: entry.reversesEntryId, direction: "original" };
  if (entry.reversedByEntryId) return { id: entry.reversedByEntryId, direction: "reversal" };
  return null;
}

// ---------------------------------------------------------------------------
// Filters ⇄ URL
// ---------------------------------------------------------------------------

export interface JournalFilterState {
  dateFrom: string;
  dateTo: string;
  sourceType: string;
  q: string;
  location: string;
  account: string;
  creator: string;
  project: string;
  reversal: JournalReversalState;
  kind: JournalEntryKind;
  /** Exact Rial decimal strings — the screen converts from the business's display unit at the input boundary. */
  amountMin: string;
  amountMax: string;
}

export const EMPTY_JOURNAL_FILTERS: JournalFilterState = {
  dateFrom: "",
  dateTo: "",
  sourceType: "",
  q: "",
  location: "",
  account: "",
  creator: "",
  project: "",
  reversal: "any",
  kind: "any",
  amountMin: "",
  amountMax: "",
};

function oneOf<T extends readonly string[]>(value: string | null, allowed: T, fallback: T[number]): T[number] {
  const text = (value ?? "").trim();
  return (allowed as readonly string[]).includes(text) ? (text as T[number]) : fallback;
}

/** The filter state a URL describes. Unknown or malformed values fall back to «همه» rather than erroring. */
export function journalFiltersFromParams(params: URLSearchParams): JournalFilterState {
  const text = (key: string) => (params.get(key) ?? "").trim();
  return {
    dateFrom: text("dateFrom"),
    dateTo: text("dateTo"),
    sourceType: text("sourceType"),
    q: text("q"),
    location: text("location"),
    account: text("account"),
    creator: text("creator"),
    project: text("project"),
    reversal: oneOf(params.get("reversal"), JOURNAL_REVERSAL_STATES, "any"),
    kind: oneOf(params.get("kind"), JOURNAL_ENTRY_KINDS, "any"),
    amountMin: text("amountMin"),
    amountMax: text("amountMax"),
  };
}

/**
 * The query string for a filter state — only the parts that narrow anything,
 * so an unfiltered journal is a clean `/accounting/entries` and two equivalent
 * filters produce the same link.
 */
export function journalFilterParams(state: JournalFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.dateFrom) params.set("dateFrom", state.dateFrom);
  if (state.dateTo) params.set("dateTo", state.dateTo);
  if (state.sourceType) params.set("sourceType", state.sourceType);
  if (state.q.trim()) params.set("q", state.q.trim());
  if (state.location) params.set("location", state.location);
  if (state.account) params.set("account", state.account);
  if (state.creator) params.set("creator", state.creator);
  if (state.project) params.set("project", state.project);
  if (state.reversal && state.reversal !== "any") params.set("reversal", state.reversal);
  if (state.kind && state.kind !== "any") params.set("kind", state.kind);
  if (state.amountMin) params.set("amountMin", state.amountMin);
  if (state.amountMax) params.set("amountMax", state.amountMax);
  return params;
}

export function hasActiveJournalFilters(state: JournalFilterState): boolean {
  return journalFilterParams(state).toString().length > 0;
}

/** How many of the journal's filters are narrowing it — the count beside «فیلترها». */
export function activeJournalFilterCount(state: JournalFilterState): number {
  return [...journalFilterParams(state).keys()].length;
}

// ---------------------------------------------------------------------------
// Amount inputs
// ---------------------------------------------------------------------------

/**
 * An exact Rial bound → the number the amount field shows in the business's
 * display unit.
 *
 * `BigInt`, not `rialToToman`'s `Math.trunc`: this is still ledger money, and
 * the whole point of the issue's precision item is that a journal amount never
 * passes through a JS `number`. An empty or malformed bound shows an empty
 * field rather than «NaN».
 */
export function rialTextToAmountInput(rialText: string, unit: MoneyUnit): string {
  const text = rialText.trim();
  if (!/^\d+$/.test(text)) return "";
  const value = BigInt(text);
  return (unit === "rial" ? value : value / 10n).toString();
}

// ---------------------------------------------------------------------------
// DOM ids
// ---------------------------------------------------------------------------

/**
 * The row and detail element ids, so «مشاهدهٔ سند اصلی» can scroll to its
 * target and the expander can name the panel it controls. One spelling,
 * because two would silently stop matching.
 */
export function journalRowId(entryId: string): string {
  return `journal-entry-${entryId}`;
}

export function journalDetailId(entryId: string): string {
  return `journal-entry-detail-${entryId}`;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * The line under the filters.
 *
 * It may never present the number of loaded rows as the number of matches.
 * With a server `totalCount` it states the total and, when more are still
 * unloaded, how many of them are on screen. Without one it only ever claims
 * «نمایش داده شده».
 */
export function journalCountLabel(params: {
  loaded: number;
  totalCount: number | null;
  hasMore: boolean;
  filtered: boolean;
}): string {
  const { loaded, totalCount, hasMore, filtered } = params;
  const scope = filtered ? "در این فیلتر" : "در دفتر";
  if (totalCount === null) {
    return `${formatPersianNumber(loaded)} سند نمایش داده شده`;
  }
  if (totalCount === 0) return `سندی ${scope} نیست`;
  if (!hasMore && loaded >= totalCount) return `${formatPersianNumber(totalCount)} سند ${scope}`;
  return `${formatPersianNumber(loaded)} از ${formatPersianNumber(totalCount)} سند ${scope} نمایش داده شده`;
}

/** The journal's own 400s, in the reader's language. */
export function journalErrorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    invalid_date: "یکی از تاریخ‌ها یک روز واقعی در تقویم نیست.",
    invalid_date_range: "بازهٔ تاریخ نامعتبر است؛ تاریخ شروع باید قبل از تاریخ پایان باشد.",
    invalid_amount: "مبلغ واردشده معتبر نیست؛ فقط عدد صحیح وارد کنید.",
    invalid_amount_range: "بازهٔ مبلغ نامعتبر است؛ کمترین مبلغ باید از بیشترین مبلغ کمتر باشد.",
    invalid_filter: "یکی از فیلترها معتبر نیست؛ فیلترها را پاک کنید و دوباره تلاش کنید.",
    invalid_cursor: "ادامهٔ فهرست معتبر نیست؛ صفحه را تازه کنید.",
    invalid_format: "قالب خروجی پشتیبانی نمی‌شود.",
    forbidden: "دسترسی به دفتر روزنامه مجاز نیست.",
    unauthorized: "وارد نشده‌اید.",
  };
  return map[code ?? ""] ?? "بارگذاری دفتر روزنامه ناموفق بود. دوباره تلاش کنید.";
}
