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
 * What the preview renders with, resolved from the config that *produced* the
 * rows rather than from the controls that are on screen now (issue #819).
 *
 * The builder used to read `currentMetric?.money` and `currentView?.label` —
 * live draft state — while the rows underneath came from `loadedConfig`. Switch
 * the measure from «جمع فروش» (Rial) to «تعداد سفارش» (a count) without
 * previewing and the *old* loaded rows were reformatted through the money
 * formatter: 1,250,000 Rial rendered as «۱۲۵٬۰۰۰ تومان» for a metric that is
 * not money at all. Nothing on screen indicated the number or the label had
 * changed meaning.
 *
 * So the metadata is resolved once, when the result lands, and stored beside
 * the rows. Nothing about the preview is read from the draft.
 */
export interface PreviewMeta {
  /** The loaded source's own label — what the tiles and the file are titled. */
  label: string;
  /** Whether the loaded metric is money, i.e. whether to format through the unit. */
  money: boolean;
  /** The loaded config's visualization, so switching the picker cannot re-draw old rows. */
  chartType: ChartType;
}

/** The slice of the engine catalogue `previewMetadata` needs — `/api/reports/views`. */
export interface PreviewCatalogueView {
  key: string;
  label: string;
  metrics: { key: string; label: string; money: boolean }[];
  dimensions: { key: string; label: string }[];
}

/**
 * The rendering facts for a config, resolved against the engine's own catalogue.
 *
 * `null` config (nothing loaded yet) and an unknown view both answer `null`, so
 * a caller renders nothing rather than guessing a formatter for rows it cannot
 * describe. An unknown metric on a known view keeps the view's label but
 * answers `money: false` — a count is the safe reading of "not an amount".
 */
export function previewMetadata(
  config: ReportConfig | null,
  catalogue: readonly PreviewCatalogueView[] | null,
): PreviewMeta | null {
  if (!config) return null;
  const view = catalogue?.find((item) => item.key === config.view);
  if (!view) return null;
  return {
    label: view.label,
    money: view.metrics.find((metric) => metric.key === config.metric)?.money ?? false,
    chartType: config.visualization ?? "bar",
  };
}

/**
 * True when the form no longer describes the previewed result (issue #819).
 *
 * The builder used to keep whatever result was on screen while the controls
 * moved on, so Export produced a file for a report the reader had never seen.
 * Comparing the config the form *would* submit against the config the rows were
 * produced from is exact, and needs no per-control bookkeeping: any query
 * affecting change — metric, aggregation, dimension, dates, filters, sort,
 * limit — makes the two objects differ.
 */
export function previewIsStale(draft: ReportConfig, loaded: ReportConfig | null): boolean {
  return loaded !== null && queryShape(draft) !== queryShape(loaded);
}

/**
 * The part of a config that decides what the database returns. The chosen
 * visualization is a rendering preference — switching a bar to a pie cannot
 * make the numbers on screen wrong — so it is deliberately excluded, and
 * `JSON.stringify` drops the `undefined` it is replaced with.
 */
function queryShape(config: ReportConfig): string {
  const filters = config.filters;
  const normalizedFilters = {
    ...(filters?.dateFrom ? { dateFrom: filters.dateFrom } : {}),
    ...(filters?.dateTo ? { dateTo: filters.dateTo } : {}),
    ...(filters?.equals && Object.keys(filters.equals).length > 0 ? { equals: filters.equals } : {}),
  };
  return JSON.stringify({
    ...config,
    visualization: undefined,
    // A legacy report may omit filters entirely while the controlled form
    // rebuilds an empty object (`{}`); those are the same query, not an edit.
    filters: Object.keys(normalizedFilters).length > 0 ? normalizedFilters : undefined,
  });
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
