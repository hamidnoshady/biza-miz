/**
 * The service desk's filters — one vocabulary, parsed once.
 *
 * ## The same promise the deals screen makes
 *
 * `crm_saved_views` stores a set of filter keys per entity and calls a view
 * "exactly a set of the filters that screen already supports". `cases` declared
 * six keys (`q, status, priority, assignee, open, breached`) and the screen
 * honoured two (`open`, and «تیکت‌های من» as `mine`), so a shared view named
 * «فوری‌های معوق» opened with no priority filter and no breach filter and
 * looked perfectly normal. `crm-deal-views.ts` fixed that class of bug for the
 * board; this is the same fix for the desk, and the shape is deliberately
 * identical so a reader who has seen one has seen both: a pure document, a
 * parser, a serialiser, a counter, and Persian descriptions of what is in force.
 *
 * ## `breached` is the SLA rule, not a second one
 *
 * The interesting key here is `breached`. A ticket's lateness is decided by
 * `crm-case-clock.ts` — one rule, used by the row's badge, the summary panel and
 * this filter — and `listCases` narrows on it with a SQL predicate that
 * `integration/crm-case-views` proves agrees with that rule. Before this, the
 * badge compared raw age and the summary subtracted customer-wait, so the same
 * ticket could read late in its row and fine in the panel above it.
 *
 * ## Ownership, again
 *
 * `assignee` accepts `""` (anybody), `"none"` (nobody — an unclaimed ticket is
 * the one that rots), `"mine"` (resolved from the session, never from the query
 * string) or a member id. A name is refused: two colleagues can share one, and
 * a filter that guesses is how somebody else's tickets end up in your list.
 */

import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  isCasePriority,
  isCaseStatus,
  type CasePriority,
  type CaseStatus,
} from "./crm-shared";
import { toPersianDigits } from "./digits";
import { isUuid } from "./uuid";

/** The keys `crm_saved_views` accepts for `cases`. */
export const CASE_VIEW_FILTER_KEYS = [
  "q",
  "status",
  "priority",
  "assignee",
  "open",
  "breached",
] as const;

export interface CaseViewFilters {
  /** Free text over the subject, the body and the customer's name. */
  q: string;
  /** A case status; `""` means every status. */
  status: string;
  /** A case priority; `""` means every priority. */
  priority: string;
  /** `""` = anybody, `"none"` = nobody, `"mine"` = the reader, else a member id. */
  assignee: string;
  /** Only cases that are still running: not resolved, not closed. */
  openOnly: boolean;
  /** Only cases that have missed their priority's target. */
  breachedOnly: boolean;
}

export const EMPTY_CASE_VIEW_FILTERS: CaseViewFilters = {
  q: "",
  status: "",
  priority: "",
  assignee: "",
  openOnly: false,
  breachedOnly: false,
};

export interface CaseViewSource {
  get(key: string): string | null;
}

export interface CaseViewParseResult {
  filters: CaseViewFilters;
  error: string | null;
}

const ASSIGNEE_SENTINELS = new Set(["", "none", "mine"]);

export function parseCaseViewFilters(source: CaseViewSource): CaseViewParseResult {
  const filters: CaseViewFilters = { ...EMPTY_CASE_VIEW_FILTERS };
  const text = (key: string) => (source.get(key) ?? "").trim();

  filters.q = text("q").slice(0, 120);

  const status = text("status");
  if (status && !(CASE_STATUSES as readonly string[]).includes(status)) {
    return { filters: EMPTY_CASE_VIEW_FILTERS, error: "status" };
  }
  filters.status = status;

  const priority = text("priority");
  if (priority && !(CASE_PRIORITIES as readonly string[]).includes(priority)) {
    return { filters: EMPTY_CASE_VIEW_FILTERS, error: "priority" };
  }
  filters.priority = priority;

  const assignee = text("assignee");
  if (!ASSIGNEE_SENTINELS.has(assignee) && !isUuid(assignee)) {
    return { filters: EMPTY_CASE_VIEW_FILTERS, error: "assignee" };
  }
  filters.assignee = assignee;

  filters.openOnly = text("open") === "1";
  filters.breachedOnly = text("breached") === "1";

  return { filters, error: null };
}

export function caseViewQuery(filters: CaseViewFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.q.trim()) query.q = filters.q.trim();
  if (filters.status) query.status = filters.status;
  if (filters.priority) query.priority = filters.priority;
  if (filters.assignee) query.assignee = filters.assignee;
  if (filters.openOnly) query.open = "1";
  if (filters.breachedOnly) query.breached = "1";
  return query;
}

export function caseViewSearchParams(filters: CaseViewFilters): URLSearchParams {
  return new URLSearchParams(caseViewQuery(filters));
}

export function caseViewFilterCount(filters: CaseViewFilters): number {
  return Object.keys(caseViewQuery(filters)).length;
}

export function hasCaseViewFilters(filters: CaseViewFilters): boolean {
  return caseViewFilterCount(filters) > 0;
}

/** `mine` is only meaningful with somebody to be — the session's member id. */
export function caseViewAssigneeUserId(
  filters: CaseViewFilters,
  viewerId: string | null,
): string | null {
  if (filters.assignee === "mine") return viewerId;
  if (filters.assignee === "none") return null;
  return isUuid(filters.assignee) ? filters.assignee : null;
}

/** Whether the assignee filter asks for tickets nobody owns. */
export function caseViewUnownedOnly(filters: CaseViewFilters): boolean {
  return filters.assignee === "none";
}

/**
 * The document, translated into the query `listCases` takes.
 *
 * This is the one step between «what the reader asked for» and «what the server
 * runs», so it lives with the vocabulary rather than inside the route: the queue
 * cards (`crm-queue-views.ts`) emit documents and claim they are the same rows,
 * and a test can only hold that claim if both sides read the same translation.
 * The route keeps what is *not* translation — permissions, limits, legacy query
 * parameters.
 */
export interface CaseViewListOptions {
  q?: string;
  /** Already narrowed to the vocabulary's own union, so nothing casts later. */
  status?: CaseStatus;
  priority?: CasePriority;
  openOnly: boolean;
  breachedOnly: boolean;
  assigneeUserId?: string;
  unowned: boolean;
}

export function caseViewListOptions(
  filters: CaseViewFilters,
  viewerId: string | null,
): CaseViewListOptions {
  // `mine` becomes the session's member id, never a query-string value. A
  // caller with no member id who asked for `mine` gets nothing, not everything:
  // the safe direction for a filter about ownership.
  const assigneeUserId = caseViewAssigneeUserId(filters, viewerId);
  return {
    q: filters.q || undefined,
    // Narrowed, not cast: the parser refused anything outside the vocabulary, so
    // these guards cannot fail — and if one ever does, the filter is dropped
    // rather than handed to SQL as an unknown string.
    status: isCaseStatus(filters.status) ? filters.status : undefined,
    priority: isCasePriority(filters.priority) ? filters.priority : undefined,
    openOnly: filters.openOnly,
    breachedOnly: filters.breachedOnly,
    assigneeUserId: assigneeUserId ?? undefined,
    unowned: caseViewUnownedOnly(filters) || (filters.assignee === "mine" && !assigneeUserId),
  };
}

export interface CaseViewLookups {
  memberName?: (id: string) => string | null;
}

/**
 * The applied filters, in words.
 *
 * Described from the same document the request was built from, so a chip can
 * only ever name a filter that is really in force — and anything a lookup
 * cannot name falls back to the id's short form rather than disappearing, since
 * a filter nobody can see is a filter nobody can remove.
 */
export function describeCaseView(filters: CaseViewFilters, lookups: CaseViewLookups = {}): string[] {
  const parts: string[] = [];
  if (filters.q.trim()) parts.push(`جست‌وجو: «${filters.q.trim()}»`);
  if (filters.status) {
    // The parser already refused anything the vocabulary does not carry, so the
    // lookup cannot miss — the `??` is for a stored view from a newer build.
    const status = filters.status as keyof typeof CASE_STATUS_LABELS;
    parts.push(`وضعیت: ${CASE_STATUS_LABELS[status] ?? filters.status}`);
  }
  if (filters.priority) {
    const priority = filters.priority as keyof typeof CASE_PRIORITY_LABELS;
    parts.push(`اولویت: ${CASE_PRIORITY_LABELS[priority] ?? filters.priority}`);
  }
  if (filters.assignee === "none") parts.push("بدون مسئول");
  else if (filters.assignee === "mine") parts.push("تیکت‌های من");
  else if (filters.assignee) {
    parts.push(`مسئول: ${lookups.memberName?.(filters.assignee) ?? filters.assignee.slice(0, 8)}`);
  }
  if (filters.openOnly) parts.push("فقط بازها");
  if (filters.breachedOnly) parts.push("فقط معوق‌ها");
  return parts;
}

/**
 * A response time as a short Persian phrase, for the SLA panel.
 *
 * Lives here rather than inside the screen because it is a *reading of the
 * backend's own figure* — `caseSlaSummary().medianFirstResponseSeconds` — and a
 * formatter that rounds 90 minutes into «۱ ساعت» would quietly turn the desk's
 * median response into a better number than it is.
 */
export function caseViewDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 3600) {
    return `${toPersianDigits(String(Math.max(1, Math.round(seconds / 60))))} دقیقه`;
  }
  const hours = seconds / 3600;
  if (hours < 48) return `${toPersianDigits(trimZero(hours.toFixed(1)))} ساعت`;
  return `${toPersianDigits(trimZero((hours / 24).toFixed(1)))} روز`;
}

function trimZero(text: string): string {
  return text.replace(/\.0$/, "");
}

export const CASE_VIEW_ERRORS: Record<string, string> = {
  status: "وضعیت انتخاب‌شده معتبر نیست.",
  priority: "اولویت انتخاب‌شده معتبر نیست.",
  assignee: "مسئول انتخاب‌شده معتبر نیست.",
};

export function caseViewErrorLine(error: string): string {
  return CASE_VIEW_ERRORS[error] ?? "فیلترهای این نما معتبر نیستند.";
}

// The labels come from `crm-shared` — the same map the row's badge renders —
// imported rather than re-declared, because a second copy is how the chip and
// the badge start disagreeing about what «waiting» is called.
