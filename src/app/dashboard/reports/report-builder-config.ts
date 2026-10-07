/**
 * Report Builder ⇄ `ReportConfig` conversion — the framework-free half of the
 * builder (issue #819).
 *
 * The builder used to assemble its stored config inline and read it back field
 * by field, so anything it forgot on either side was silently lost: filters
 * other than the two dates, the sort direction, Top-N, and the chosen
 * visualization all disappeared on save-and-reopen. Keeping both directions in
 * one tested pair of functions is what makes "load → save loses no field" a
 * property of the code rather than a hope.
 */
import type { Aggregation, ChartType, ReportConfig } from "@/lib/reports";

export type SortBy = "dimension" | "metric";
export type SortDir = "asc" | "desc";

/** The form's own state, including the empty strings a controlled input needs. */
export interface BuilderState {
  view: string;
  metric: string;
  aggregation: Aggregation;
  dimension: string;
  dateFrom: string;
  dateTo: string;
  /** Engine-supported equality filters, keyed by the view's filter key. */
  equals: Record<string, string>;
  /** "" means "the source's own order" — no `sort` is stored. */
  sortBy: "" | SortBy;
  sortDir: SortDir;
  /** Kept as the input's string; "" means no Top-N. */
  limit: string;
  chartType: ChartType;
}

/** A stored report as editable form state. */
export function builderStateFromConfig(config: ReportConfig): BuilderState {
  return {
    view: config.view,
    metric: config.metric,
    aggregation: config.aggregation,
    dimension: config.dimension,
    dateFrom: config.filters?.dateFrom ?? "",
    dateTo: config.filters?.dateTo ?? "",
    equals: { ...(config.filters?.equals ?? {}) },
    sortBy: config.sort?.by ?? "",
    sortDir: config.sort?.dir ?? "desc",
    limit: config.limit === undefined ? "" : String(config.limit),
    // Bar is what a report without a stored chart has always rendered as, so
    // the first save of such a report records that rather than changing it.
    chartType: config.visualization ?? "bar",
  };
}

/**
 * The form state as a report config — the same object feeds the preview, the
 * save/update body, the export and the pin.
 *
 * `viewFilterKeys` is the selected source's own filter list: a value typed for
 * one source must not ride into another source's config, where validation
 * would reject the whole report. Blank values and empty sort/limit are dropped
 * rather than stored as `""`/NaN.
 */
export function builderConfigFromState(
  state: BuilderState,
  viewFilterKeys: readonly string[],
): ReportConfig {
  const equals = Object.fromEntries(
    Object.entries(state.equals).filter(
      ([key, value]) => value !== "" && viewFilterKeys.includes(key),
    ),
  );
  const parsedLimit = Number(state.limit);
  return {
    view: state.view,
    metric: state.metric,
    aggregation: state.aggregation,
    dimension: state.dimension,
    filters: {
      dateFrom: state.dateFrom || undefined,
      dateTo: state.dateTo || undefined,
      ...(Object.keys(equals).length > 0 ? { equals } : {}),
    },
    ...(state.sortBy ? { sort: { by: state.sortBy, dir: state.sortDir } } : {}),
    ...(Number.isInteger(parsedLimit) && parsedLimit > 0 ? { limit: parsedLimit } : {}),
    visualization: state.chartType,
  };
}
