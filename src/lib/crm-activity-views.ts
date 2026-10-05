/**
 * The task list's filters — one vocabulary, parsed once.
 *
 * ## Why `activities` needs this as much as the board did
 *
 * `crm_saved_views` has always accepted a `filters` document for `activities`
 * (`q, kind, state, assignee, due`) and the screen honoured **none** of its own
 * keys: the list was read with `open`/`mine`/`due` query parameters built from
 * five hardcoded preset buttons, and its search box then filtered *the rows
 * already loaded* — so a task beyond the page, or one completed a moment ago,
 * was not merely unfound, it looked as though it did not exist. A view stored
 * from this screen would have been a name and nothing else.
 *
 * So the same shape as `crm-deal-views.ts` and `crm-case-views.ts`: one pure
 * document, one parser that refuses impossible values by name, one serialiser,
 * one describer for the chips — and a route that hands every key to the service
 * so a saved view narrows the rows rather than decorating the header.
 *
 * ## Two names for one thing, and why both are read
 *
 * `due` is the key this screen's links and habits shipped with: *«سررسیدشده»* —
 * due today or already late. `state` is the closed vocabulary that replaced the
 * preset buttons. They describe the same rows, so the parser reads `due: "1"` as
 * `state: "due"` when no state was given, and the serialiser **writes only
 * `state`**: every re-save normalises the view, and a view stored under either
 * name still filters exactly as its author meant. Dropping `due` instead would
 * have turned those stored views into names that quietly do nothing, which is
 * the failure this whole series of waves exists to end.
 *
 * The screen's own older parameters — `open=1` and `mine=1`, built by the preset
 * buttons this wave replaced — are read here for the same reason, one step down:
 * they were never in the vocabulary, so no saved view can carry them, but they
 * are sitting in bookmarks and in links already in the wild, and a bookmark that
 * quietly stopped filtering would be a worse answer than one this module
 * understood. Read, never written.
 */

import { ACTIVITY_KINDS, ACTIVITY_KIND_LABELS, type ActivityKind } from "./crm-shared";
import { isUuid } from "./uuid";

/** The keys `crm_saved_views` accepts for `activities`. */
export const ACTIVITY_VIEW_FILTER_KEYS = ["q", "kind", "state", "assignee", "due"] as const;

/**
 * The states a *list* can be in.
 *
 * Deliberately not `ACTIVITY_STATES` from `crm-shared`: that vocabulary answers
 * «what is this one row?» (`done / today / overdue / planned`), while a saved
 * view asks «which rows do I want?» — a question that includes «every unfinished
 * one», which is not a state any single row is ever in.
 */
export const ACTIVITY_VIEW_STATES = ["open", "done", "due", "overdue", "planned"] as const;
export type ActivityViewState = (typeof ACTIVITY_VIEW_STATES)[number];

export const ACTIVITY_VIEW_STATE_LABELS: Record<ActivityViewState, string> = {
  open: "انجام‌نشده",
  done: "انجام‌شده",
  /** Due today *or* already late — the label this screen has always used. */
  due: "سررسیدشده",
  overdue: "عقب‌افتاده",
  planned: "برنامه‌ریزی‌شده",
};

export interface ActivityViewFilters {
  /** Free text over the subject, the note, the assignee's name and the customer. */
  q: string;
  /** An activity kind («تماس», «جلسه»…); `""` means every kind. */
  kind: string;
  /** One of `ACTIVITY_VIEW_STATES`; `""` means every state. */
  state: string;
  /** `""` = anybody, `"none"` = nobody, `"mine"` = the reader, else a member id. */
  assignee: string;
}

export const EMPTY_ACTIVITY_VIEW_FILTERS: ActivityViewFilters = {
  q: "",
  kind: "",
  state: "",
  assignee: "",
};

export interface ActivityViewSource {
  get(key: string): string | null;
}

export interface ActivityViewParseResult {
  filters: ActivityViewFilters;
  error: string | null;
}

const ASSIGNEE_SENTINELS = new Set(["", "none", "mine"]);

export function parseActivityViewFilters(source: ActivityViewSource): ActivityViewParseResult {
  const filters: ActivityViewFilters = { ...EMPTY_ACTIVITY_VIEW_FILTERS };
  const text = (key: string) => (source.get(key) ?? "").trim();

  filters.q = text("q").slice(0, 120);

  const kind = text("kind");
  if (kind && !(ACTIVITY_KINDS as readonly string[]).includes(kind)) {
    return { filters: EMPTY_ACTIVITY_VIEW_FILTERS, error: "kind" };
  }
  filters.kind = kind;

  const state = text("state");
  if (state && !(ACTIVITY_VIEW_STATES as readonly string[]).includes(state)) {
    return { filters: EMPTY_ACTIVITY_VIEW_FILTERS, error: "state" };
  }
  // The legacy name for the same rows, read but never written — see the module
  // comment. An explicit `state` wins when a link carries both.
  filters.state = state || (text("due") === "1" ? "due" : "");

  if (!filters.state && text("open") === "1") filters.state = "open";

  const assignee = text("assignee");
  if (!ASSIGNEE_SENTINELS.has(assignee) && !isUuid(assignee)) {
    return { filters: EMPTY_ACTIVITY_VIEW_FILTERS, error: "assignee" };
  }
  filters.assignee = assignee || (text("mine") === "1" ? "mine" : "");

  return { filters, error: null };
}

export function activityViewQuery(filters: ActivityViewFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.q.trim()) query.q = filters.q.trim();
  if (filters.kind) query.kind = filters.kind;
  if (filters.state) query.state = filters.state;
  if (filters.assignee) query.assignee = filters.assignee;
  return query;
}

export function activityViewSearchParams(filters: ActivityViewFilters): URLSearchParams {
  return new URLSearchParams(activityViewQuery(filters));
}

export function activityViewFilterCount(filters: ActivityViewFilters): number {
  return Object.keys(activityViewQuery(filters)).length;
}

export function hasActivityViewFilters(filters: ActivityViewFilters): boolean {
  return activityViewFilterCount(filters) > 0;
}

/** `mine` is only meaningful with somebody to be — the session's member id. */
export function activityViewAssigneeUserId(
  filters: ActivityViewFilters,
  viewerId: string | null,
): string | null {
  if (filters.assignee === "mine") return viewerId;
  if (filters.assignee === "none") return null;
  return isUuid(filters.assignee) ? filters.assignee : null;
}

/** Whether the assignee filter asks for work nobody owns. */
export function activityViewUnownedOnly(filters: ActivityViewFilters): boolean {
  return filters.assignee === "none";
}

export interface ActivityViewLookups {
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
export function describeActivityView(
  filters: ActivityViewFilters,
  lookups: ActivityViewLookups = {},
): string[] {
  const parts: string[] = [];
  if (filters.q.trim()) parts.push(`جست‌وجو: «${filters.q.trim()}»`);
  if (filters.kind) {
    const kind = filters.kind as ActivityKind;
    parts.push(`نوع: ${ACTIVITY_KIND_LABELS[kind] ?? filters.kind}`);
  }
  if (filters.state) {
    const state = filters.state as ActivityViewState;
    parts.push(`وضعیت: ${ACTIVITY_VIEW_STATE_LABELS[state] ?? filters.state}`);
  }
  if (filters.assignee === "none") parts.push("بدون مسئول");
  else if (filters.assignee === "mine") parts.push("کارهای من");
  else if (filters.assignee) {
    parts.push(`مسئول: ${lookups.memberName?.(filters.assignee) ?? filters.assignee.slice(0, 8)}`);
  }
  return parts;
}

export const ACTIVITY_VIEW_ERRORS: Record<string, string> = {
  kind: "نوع انتخاب‌شده معتبر نیست.",
  state: "وضعیت انتخاب‌شده معتبر نیست.",
  assignee: "مسئول انتخاب‌شده معتبر نیست.",
};

export function activityViewErrorLine(error: string): string {
  return ACTIVITY_VIEW_ERRORS[error] ?? "فیلترهای این نما معتبر نیستند.";
}
