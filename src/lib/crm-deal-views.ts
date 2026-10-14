/**
 * The deals screen's filters — one vocabulary, parsed once, in one place.
 *
 * ## The promise this module keeps
 *
 * `crm_saved_views` stores a *set of filter keys per entity*, and its docstring
 * makes a promise: a saved view is "exactly a set of the filters that screen
 * already supports". The leads list kept that promise — it declares its
 * controls, hands them to `SavedViewsBar`, and applies back only what it has.
 * The board did not: `deals` declared seven keys (`q, stageId, pipelineId,
 * owner, open, minValue, maxValue`) and honoured one of them, so a view saved
 * against a deal was stored faithfully and *applied partially* — the shape
 * `docs/crm-relationship-os.md` calls a lie. A shared view that says «مذاکره‌های
 * بزرگ» and then shows every deal is worse than no view at all, because somebody
 * will trust it.
 *
 * So the deals filters now live here: a pure, client-safe document with a
 * parser, a serialiser, a counter and a set of Persian descriptions. The API
 * route parses the query with the same function the screen serialises with, so
 * there is no second opinion about what `owner=mine` means, and the screen can
 * label the filters without asking the server what it decided.
 *
 * Pure on purpose: no `db`, no `next/*`, no clock. That is what makes it usable
 * from a client component, from the route, and from a test with no DOM.
 *
 * ## Amounts are Toman in the vocabulary and Rial in the database
 *
 * The control a person types into shows Toman (like every other amount in this
 * product), so a view stores Toman — and `dealViewRialBounds` converts at the
 * boundary with the same `tomanToRial` the rest of the app uses. A stored
 * threshold in the wrong unit is a filter that silently matches nothing, which
 * is the failure mode nobody reports.
 *
 * ## Reserved keys are refused rather than invented
 *
 * A key outside the vocabulary is *ignored* (a mixed-version deployment must
 * not break an older tab) but a key inside it with an impossible value — a
 * non-uuid `stageId`, a negative amount, a minimum above its maximum — is
 * refused with the field named, because a filter the screen cannot honour is a
 * screen that lies about what it is showing.
 */

import { isUuid } from "./uuid";
import { toLatinDigits } from "./digits";
import { tomanToRial } from "./money";

/**
 * The keys `crm_saved_views` accepts for `deals`.
 *
 * Kept beside the parser so the vocabulary and its implementation cannot drift:
 * `crm-saved-views-service.ts` imports this list for its own table rather than
 * repeating it.
 */
export const DEAL_VIEW_FILTER_KEYS = [
  "q",
  "stageId",
  "pipelineId",
  "owner",
  "open",
  "minValue",
  "maxValue",
] as const;

export interface DealViewFilters {
  /** Free text over the deal's title and its customer's name. */
  q: string;
  /** A canonical stage row id; `""` means every stage. */
  stageId: string;
  /** A pipeline row id; `""` means the default pipeline. */
  pipelineId: string;
  /** `""` = anybody, `"none"` = nobody, `"mine"` = the reader, else a member id. */
  owner: string;
  /** Only deals that have not reached a terminal stage. */
  openOnly: boolean;
  /** Bounds in **Toman**, the unit the control shows. `null` = unbounded. */
  minToman: number | null;
  maxToman: number | null;
}

export const EMPTY_DEAL_VIEW_FILTERS: DealViewFilters = {
  q: "",
  stageId: "",
  pipelineId: "",
  owner: "",
  openOnly: false,
  minToman: null,
  maxToman: null,
};

/** What `URLSearchParams` and a plain record both offer this module. */
export interface DealViewSource {
  get(key: string): string | null;
}

export interface DealViewParseResult {
  filters: DealViewFilters;
  /**
   * The field that made the request impossible, or `null`. Named so the screen
   * can point at the control rather than showing a generic failure.
   */
  error: string | null;
}

const OWNER_SENTINELS = new Set(["", "none", "mine"]);

/** Latin digits only, no grouping punctuation — «۱۰٬۰۰۰٬۰۰۰» → `10000000`. */
function parseToman(raw: string): number | null {
  const cleaned = toLatinDigits(raw).replace(/[٬,\s]/g, "");
  if (!cleaned) return null;
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Read the deals filters out of a query string (or any `get`-shaped source).
 *
 * Unknown keys pass through untouched and unknown *values* are refused, which
 * is the asymmetry the docstring above argues for.
 */
export function parseDealViewFilters(source: DealViewSource): DealViewParseResult {
  const filters: DealViewFilters = { ...EMPTY_DEAL_VIEW_FILTERS };
  const text = (key: string) => (source.get(key) ?? "").trim();

  filters.q = text("q").slice(0, 120);

  const stageId = text("stageId");
  if (stageId && !isUuid(stageId)) return { filters: EMPTY_DEAL_VIEW_FILTERS, error: "stageId" };
  filters.stageId = stageId;

  const pipelineId = text("pipelineId");
  if (pipelineId && !isUuid(pipelineId)) {
    return { filters: EMPTY_DEAL_VIEW_FILTERS, error: "pipelineId" };
  }
  filters.pipelineId = pipelineId;

  const owner = text("owner");
  if (!OWNER_SENTINELS.has(owner) && !isUuid(owner)) {
    return { filters: EMPTY_DEAL_VIEW_FILTERS, error: "owner" };
  }
  filters.owner = owner;

  filters.openOnly = text("open") === "1";

  const min = text("minValue");
  if (min) {
    const parsed = parseToman(min);
    if (parsed === null) return { filters: EMPTY_DEAL_VIEW_FILTERS, error: "minValue" };
    filters.minToman = parsed;
  }

  const max = text("maxValue");
  if (max) {
    const parsed = parseToman(max);
    if (parsed === null) return { filters: EMPTY_DEAL_VIEW_FILTERS, error: "maxValue" };
    filters.maxToman = parsed;
  }

  if (filters.minToman !== null && filters.maxToman !== null && filters.minToman > filters.maxToman) {
    // Refused rather than silently swapped: the person typed both numbers, and
    // "no deals" would be the wrong explanation for an impossible range.
    return { filters: EMPTY_DEAL_VIEW_FILTERS, error: "minValue" };
  }

  return { filters, error: null };
}

/** The filters as query parameters — only the ones that are set. */
export function dealViewQuery(filters: DealViewFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.q.trim()) query.q = filters.q.trim();
  if (filters.stageId) query.stageId = filters.stageId;
  if (filters.pipelineId) query.pipelineId = filters.pipelineId;
  if (filters.owner) query.owner = filters.owner;
  if (filters.openOnly) query.open = "1";
  if (filters.minToman !== null) query.minValue = String(filters.minToman);
  if (filters.maxToman !== null) query.maxValue = String(filters.maxToman);
  return query;
}

/** The same document as a `URLSearchParams`, for a link or the address bar. */
export function dealViewSearchParams(filters: DealViewFilters): URLSearchParams {
  return new URLSearchParams(dealViewQuery(filters));
}

/** How many filters are narrowing the list — the honest "۳ فیلتر" count. */
export function dealViewFilterCount(filters: DealViewFilters): number {
  return Object.keys(dealViewQuery(filters)).length;
}

export function hasDealViewFilters(filters: DealViewFilters): boolean {
  return dealViewFilterCount(filters) > 0;
}

/**
 * The bounds in Rial, the unit the database speaks.
 *
 * The `>=`/`<=` comparison happens in SQL against `value_rial`; converting here
 * once means the route, the service and the test all agree on the unit.
 */
export function dealViewRialBounds(filters: DealViewFilters): {
  minValueRial: number | null;
  maxValueRial: number | null;
} {
  return {
    minValueRial: filters.minToman === null ? null : tomanToRial(filters.minToman),
    maxValueRial: filters.maxToman === null ? null : tomanToRial(filters.maxToman),
  };
}

/** `mine` is only meaningful with somebody to be — the session's member id. */
export function dealViewOwnerUserId(filters: DealViewFilters, viewerId: string | null): string | null {
  if (filters.owner === "mine") return viewerId;
  if (filters.owner === "none") return null;
  return isUuid(filters.owner) ? filters.owner : null;
}

/** Whether the owner filter asks for records nobody owns. */
export function dealViewUnownedOnly(filters: DealViewFilters): boolean {
  return filters.owner === "none";
}

export interface DealViewLookups {
  stageName?: (id: string) => string | null;
  pipelineName?: (id: string) => string | null;
  memberName?: (id: string) => string | null;
}

/**
 * The applied filters, in words — the chips under the controls.
 *
 * Derived from the same document that is sent to the server, so a chip can only
 * ever describe a filter that is really in force. Anything the lookups cannot
 * name falls back to the id's short form rather than disappearing: a filter
 * nobody can see is a filter nobody can remove.
 */
export function describeDealView(filters: DealViewFilters, lookups: DealViewLookups = {}): string[] {
  const parts: string[] = [];
  const short = (id: string) => id.slice(0, 8);
  if (filters.q.trim()) parts.push(`جست‌وجو: «${filters.q.trim()}»`);
  if (filters.stageId) {
    parts.push(`مرحله: ${lookups.stageName?.(filters.stageId) ?? short(filters.stageId)}`);
  }
  if (filters.pipelineId) {
    parts.push(`قیف: ${lookups.pipelineName?.(filters.pipelineId) ?? short(filters.pipelineId)}`);
  }
  if (filters.owner === "none") parts.push("بدون مسئول");
  else if (filters.owner === "mine") parts.push("معامله‌های من");
  else if (filters.owner) {
    parts.push(`مسئول: ${lookups.memberName?.(filters.owner) ?? short(filters.owner)}`);
  }
  if (filters.openOnly) parts.push("فقط بازها");
  if (filters.minToman !== null) parts.push(`از ${formatTomanShort(filters.minToman)} تومان`);
  if (filters.maxToman !== null) parts.push(`تا ${formatTomanShort(filters.maxToman)} تومان`);
  return parts;
}

/** Grouped, Persian digits, no unit — the chip and the input agree. */
function formatTomanShort(toman: number): string {
  return new Intl.NumberFormat("fa-IR").format(toman);
}

/** The error each refused field produces for a reader. */
export const DEAL_VIEW_ERRORS: Record<string, string> = {
  stageId: "مرحلهٔ انتخاب‌شده معتبر نیست.",
  pipelineId: "قیف انتخاب‌شده معتبر نیست.",
  owner: "مسئول انتخاب‌شده معتبر نیست.",
  minValue: "کمترین مبلغ معتبر نیست.",
  maxValue: "بیشترین مبلغ معتبر نیست.",
};

/** The one line a refused filter set shows. */
export function dealViewErrorLine(error: string): string {
  return DEAL_VIEW_ERRORS[error] ?? "فیلترهای این نما معتبر نیستند.";
}
