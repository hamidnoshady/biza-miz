/**
 * «ابعاد حسابداری» — what the screens need to know about the dimension catalogue,
 * as pure functions. The forms (manual entry, expenses) and the filters (the
 * journal, the trial balance) all ask the same three questions: which kinds are
 * on, which values may be picked here, and what a selection looks like on the
 * wire. Answering them in one place is what keeps a picker from offering a value
 * the server would refuse.
 *
 * The server stays the authority: it re-checks every choice (kind, active, leaf,
 * branch, effective date). Filtering the list here is a courtesy that spares a
 * person a refusal, never the only check.
 *
 * Two catalogues (issue #868):
 *   - **postable** catalogue (active leaf values of enabled kinds) for forms and
 *     new postings — never offers an archived or disabled value.
 *   - **historical** catalogue (every value, archived included, for every kind
 *     the business has ever used) for filters, reports and historical drill-down
 *     so a past report keeps showing after archive or kind-disable.
 *
 * A load failure is surfaced rather than silently swallowed: the caller shows
 * an error with a retry button instead of rendering an empty catalogue that
 * pretends every business has no dimensions.
 */
import {
  DIMENSION_KINDS,
  dimensionKindLabel,
  type DimensionKind,
  type DimensionSettingRecord,
  type DimensionValueRecord,
  type LineDimensions,
} from "@/lib/accounting-dimensions";
import type { SelectOption } from "@/components/ui/searchable-select";
import { isoDateToJalali, todayJalali, toGregorian } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";

export interface DimensionCatalog {
  settings: DimensionSettingRecord[];
  /** Active values only: a form offers nothing that the posting guard would refuse for being archived. */
  postableValues: DimensionValueRecord[];
  /** All values (archived included) for historical filters and reports. */
  allValues: DimensionValueRecord[];
}

export type DimensionCatalogLoadResult =
  | { ok: true; catalog: DimensionCatalog }
  | { ok: false; error: string };

/** The kinds the business has switched on, in product order. Empty for a business that never has. */
export function enabledDimensionKinds(settings: readonly DimensionSettingRecord[] | undefined): DimensionKind[] {
  const on = new Set((settings ?? []).filter((s) => s.isEnabled).map((s) => s.kind));
  return DIMENSION_KINDS.filter((kind) => on.has(kind));
}

/**
 * The kinds the business has EVER used — enabled now OR has any value
 * (including archived), so a historical report keeps its filter even after the
 * kind is switched off.
 */
export function historicalKinds(
  settings: readonly DimensionSettingRecord[] | undefined,
  values: readonly DimensionValueRecord[] | undefined,
): DimensionKind[] {
  const kinds = new Set<DimensionKind>();
  for (const s of settings ?? []) if (s.isEnabled) kinds.add(s.kind);
  for (const v of values ?? []) kinds.add(v.kind);
  return DIMENSION_KINDS.filter((kind) => kinds.has(kind));
}

/** The name a kind is shown with on a screen, honouring the business's own name for the detail kind. */
export function enabledKindLabel(settings: readonly DimensionSettingRecord[] | undefined, kind: DimensionKind): string {
  const setting = (settings ?? []).find((s) => s.kind === kind);
  return dimensionKindLabel(kind, setting?.label ?? null);
}

/**
 * The values a picker offers for one kind at one branch.
 *
 * Only LEAF values are offered: a parent is a rollup and the server refuses it
 * as a posting target. A value restricted to another branch is left out, and a
 * business-wide value is always offered. The list is sorted by code, which is
 * how the chart and the reports sort their rows.
 *
 * Uses the POSTABLE (active-only) list.
 */
export function dimensionOptionsFor(
  values: readonly DimensionValueRecord[] | undefined,
  kind: DimensionKind,
  locationId: string | null,
): SelectOption[] {
  return (values ?? [])
    .filter((v) => v.kind === kind && v.isActive && !v.hasChildren)
    .filter((v) => v.locationId === null || v.locationId === locationId)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((v) => ({
      value: v.id,
      label: `${toPersianDigits(v.code)} · ${v.name}`,
      searchString: `${v.code} ${v.name}`,
    }));
}

/**
 * The values a FILTER offers for one kind. A filter reads the whole book, so it
 * must include archived values and values of currently-disabled kinds (so past
 * reports remain readable). Archived values are suffixed «(بایگانی)» and
 * disabled-kind values are still listed (filtering by them still works — the
 * kind was on when the line was posted).
 */
export function dimensionFilterOptionsFor(
  values: readonly DimensionValueRecord[] | undefined,
  kind: DimensionKind,
): SelectOption[] {
  // Parents are never posting targets, so they never appear as line
  // attributions. They group leaves in rollup reports, but a filter on a parent
  // would mean "sum every child" which is rollup, not a single-value filter —
  // that is deferred (ISSUE_868_PLAN.md §7).
  return (values ?? [])
    .filter((v) => v.kind === kind && !v.hasChildren)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((v) => ({
      value: v.id,
      label: `${toPersianDigits(v.code)} · ${v.name}${v.isActive ? "" : " (بایگانی)"}`,
      searchString: `${v.code} ${v.name}`,
    }));
}

/** A picker's state for one line or one form: a value id per kind, or «» for none. */
export type DimensionDraft = Partial<Record<DimensionKind, string>>;

/** A draft as the API takes it: only the kinds that carry a value, or `undefined` when none do. */
export function dimensionPayload(draft: DimensionDraft | undefined): LineDimensions | undefined {
  if (!draft) return undefined;
  const out: LineDimensions = {};
  for (const kind of DIMENSION_KINDS) {
    const id = draft[kind];
    if (id) out[kind] = id;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Whether a draft names at least one value. */
export function hasDimensionDraft(draft: DimensionDraft | undefined): boolean {
  return dimensionPayload(draft) !== undefined;
}

/**
 * Reads the catalogue from the API. A failure returns `ok: false` so the caller
 * can surface a visible error with a retry button instead of silently rendering
 * every business as having no dimensions.
 */
export async function loadDimensionCatalog(
  fetcher: (url: string) => Promise<{ ok: boolean; data: unknown; status?: number }>,
): Promise<DimensionCatalogLoadResult> {
  let result: { ok: boolean; data: unknown; status?: number };
  try {
    result = await fetcher("/api/ledger/dimensions?includeArchived=true");
  } catch {
    return { ok: false, error: "network" };
  }
  if (!result.ok) {
    return { ok: false, error: `http_${result.status ?? "unknown"}` };
  }
  if (!result.data || typeof result.data !== "object") {
    return { ok: false, error: "bad_shape" };
  }
  const data = result.data as { settings?: unknown; values?: unknown };
  if (!Array.isArray(data.settings) || !Array.isArray(data.values)) {
    return { ok: false, error: "bad_shape" };
  }
  const allValues = data.values as DimensionValueRecord[];
  return {
    ok: true,
    catalog: {
      settings: data.settings as DimensionSettingRecord[],
      postableValues: allValues.filter((v) => v.isActive),
      allValues,
    },
  };
}

/** The first day of the current Shamsi month, as ISO: the period a business reads by default. */
export function currentJalaliMonthStartIso(): string {
  const jalali = todayJalali();
  const { gy, gm, gd } = toGregorian(jalali.jy, jalali.jm, 1);
  return `${gy}-${String(gm).padStart(2, "0")}-${String(gd).padStart(2, "0")}`;
}

/** An ISO day as «۱۴۰۵/۰۷/۱۳» text, for the period line above a report. */
export function isoToJalaliText(iso: string): string {
  const jalali = isoDateToJalali(iso);
  if (!jalali) return iso;
  return `${jalali.jy}/${String(jalali.jm).padStart(2, "0")}/${String(jalali.jd).padStart(2, "0")}`;
}

/**
 * The values a management list shows: one kind, optionally narrowed by a search
 * over code and name, and with archived values left out unless asked for.
 * Sorted by code, the order the chart and the reports use.
 */
export function filterDimensionValues(
  values: readonly DimensionValueRecord[],
  options: { kind: DimensionKind; search: string; includeArchived: boolean },
): DimensionValueRecord[] {
  const needle = options.search.trim().toLowerCase();
  return values
    .filter((v) => v.kind === options.kind)
    .filter((v) => options.includeArchived || v.isActive)
    .filter((v) => !needle || `${v.code} ${v.name}`.toLowerCase().includes(needle))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Resolves a value's display label, preserving historical names after rename by
 * joining the report's id set against the catalogue. An unknown id (deleted
 * without cascade) falls back to the id so a report never renders blank.
 */
export function dimensionValueLabel(
  values: readonly DimensionValueRecord[] | undefined,
  id: string | null | undefined,
): string {
  if (!id) return "—";
  const v = (values ?? []).find((candidate) => candidate.id === id);
  if (!v) return id;
  return `${toPersianDigits(v.code)} · ${v.name}${v.isActive ? "" : " (بایگانی)"}`;
}
