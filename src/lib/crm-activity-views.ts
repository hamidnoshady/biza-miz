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

import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABELS,
  isActivityKind,
  type ActivityKind,
} from "./crm-shared";
import { isUuid } from "./uuid";

/** The keys `crm_saved_views` accepts for `activities`. */
export const ACTIVITY_VIEW_FILTER_KEYS = ["q", "kind", "state", "assignee", "due"] as const;

/**
 * The states a *list* can be in.
 *
 * A superset of `ACTIVITY_STATES` from `crm-shared` — the four row states
 * (`done / today / overdue / planned`) *plus* two a list can be in and a row
 * cannot: `open` («every unfinished one») and `due` («سررسیدشده» — today *or*
 * already late, which is the label this screen has always used and the meaning
 * the declared `due` key has always had).
 *
 * The overlap is deliberate rather than sloppy: `ACTIVITY_STATES` answers «what
 * is this one row?» and is rendered as a badge, while this answers «which rows
 * do I want?» and becomes a `WHERE` clause. A queue that says «کارهای امروز»
 * needs `today` exactly, so the two vocabularies share the word and the label.
 */
export const ACTIVITY_VIEW_STATES = [
  "open",
  "done",
  "today",
  "overdue",
  "planned",
  "due",
] as const;
export type ActivityViewState = (typeof ACTIVITY_VIEW_STATES)[number];

export const ACTIVITY_VIEW_STATE_LABELS: Record<ActivityViewState, string> = {
  open: "انجام‌نشده",
  done: "انجام‌شده",
  /** Exactly the shop's today — the «کارهای امروز» queue, and the row badge. */
  today: "امروز",
  overdue: "عقب‌افتاده",
  planned: "برنامه‌ریزی‌شده",
  /** Today *or* already late — the label this screen has always used. */
  due: "سررسیدشده",
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

/**
 * The day after a business date, so `planned` can mean «due tomorrow or later».
 *
 * Returns `undefined` for a date the server could not parse, which drops the
 * filter rather than sending a nonsense bound: a filter that silently matches
 * nothing is worse than one that is visibly not applied.
 */
export function nextIsoDate(iso: string): string | undefined {
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The document, translated into the query `listActivities` takes.
 *
 * What the reader asked for becomes dates here, and the dates are the *shop's*
 * day: `due` is today or already late, `today` needs both ends (`>= today` and
 * `< tomorrow`), `planned` starts tomorrow. No two of these can disagree with
 * the row badges, because both read the same date — the one `businessToday`
 * resolved for the branch.
 *
 * It lives with the vocabulary rather than in the route because the queue cards
 * emit documents and claim they are the same rows; a test can hold that claim
 * only if the link and the list read the same translation.
 */
export interface ActivityViewListOptions {
  /** Already narrowed to the vocabulary's own union, so nothing casts later. */
  kind?: ActivityKind;
  q?: string;
  openOnly: boolean;
  completedOnly: boolean;
  assigneeUserId?: string;
  unowned: boolean;
  dueOnOrBefore?: string;
  dueBefore?: string;
  dueOnOrAfter?: string;
}

export function activityViewListOptions(
  filters: ActivityViewFilters,
  context: { viewerId: string | null; today: string },
): ActivityViewListOptions {
  const { viewerId, today } = context;
  // `mine` becomes the caller's own id, never the query string: a
  // `?assignee=<someone-else>` with no member id to be resolves to nobody,
  // never to everybody.
  const assigneeUserId = activityViewAssigneeUserId(filters, viewerId);
  // The date-bounded states are the row badges' own words, and a badge never
  // says «عقب‌افتاده» about finished work: `activityState` answers «انجام‌شده»
  // the moment there is a `completedAt`. So a date bound also asks for the
  // undone rows — otherwise a queue card's «دیدن همه» would list completed
  // calls the card above it does not count. `planned` is the one direction this
  // cannot fully express: a task with no due date is «برنامه‌ریزی‌شده» on its
  // row but has no date for this bound to catch, and the vocabulary has no
  // «undated» key to say so.
  const bounded =
    filters.state === "overdue" ||
    filters.state === "due" ||
    filters.state === "today" ||
    filters.state === "planned";
  return {
    // Narrowed, not cast: the parser refused anything outside the vocabulary.
    kind: isActivityKind(filters.kind) ? filters.kind : undefined,
    q: filters.q || undefined,
    openOnly: filters.state === "open" || bounded,
    completedOnly: filters.state === "done",
    assigneeUserId: assigneeUserId ?? undefined,
    unowned:
      activityViewUnownedOnly(filters) || (filters.assignee === "mine" && !assigneeUserId),
    dueOnOrBefore: filters.state === "due" || filters.state === "today" ? today : undefined,
    dueBefore: filters.state === "overdue" ? today : undefined,
    dueOnOrAfter:
      filters.state === "today"
        ? today
        : filters.state === "planned"
          ? nextIsoDate(today)
          : undefined,
  };
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
