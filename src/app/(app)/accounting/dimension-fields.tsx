"use client";

/**
 * The attribution picker, shared by every form that can carry a dimension: a
 * manual journal line, an expense, and the filters on the journal and the trial
 * balance. One component, one set of rules (`dimension-catalog.ts`), so the
 * same kind is labelled and offered the same way wherever it appears.
 *
 * Each enabled kind gets one searchable selector. A kind the business has not
 * switched on renders nothing at all — a tenant that does not use cost centres
 * never sees a cost-centre field.
 *
 * A load failure is shown visibly with a retry button rather than silently
 * rendering empty fields (issue #868): an accountant must notice that their
 * cost-centre picker failed to load before posting an unattributed document.
 */
import { useCallback, useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ErrorBox, SecondaryButton as ErrorRetryButton, api } from "@/app/dashboard/ui";
import type { DimensionKind } from "@/lib/accounting-dimensions";
import {
  enabledDimensionKinds,
  enabledKindLabel,
  historicalKinds,
  loadDimensionCatalog,
  type DimensionCatalog,
  type DimensionCatalogLoadResult,
  type DimensionDraft,
} from "./dimension-catalog";
import { useDimensionSearch } from "./dimension-search";

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; catalog: DimensionCatalog }
  | { status: "error"; error: string };

/** The catalogue, read once when a screen mounts. Supports retry on failure. */
export function useDimensionCatalog(): {
  catalog: DimensionCatalog | null;
  loaded: boolean;
  error: string | null;
  retry: () => void;
} {
  const [state, setState] = useState<CatalogState>({ status: "loading" });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void loadDimensionCatalog(async (url) => {
      const result = await api<unknown>(url);
      return { ok: result.ok, data: result.data, status: result.status };
    }).then((next: DimensionCatalogLoadResult) => {
      if (cancelled) return;
      if (next.ok) {
        setState({ status: "ready", catalog: next.catalog });
      } else {
        setState({ status: "error", error: next.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [retryCount]);

  const retry = useCallback(() => setRetryCount((n) => n + 1), []);

  return {
    catalog: state.status === "ready" ? state.catalog : null,
    loaded: state.status === "ready",
    error: state.status === "error" ? state.error : null,
    retry,
  };
}

/**
 * The placeholder while the catalogue is in flight: it reserves the one row the
 * fields will occupy, so the form does not change shape when they arrive.
 */
export function DimensionFieldsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label="در حال بارگذاری ابعاد حسابداری">
      <div className="h-10 rounded-lg bg-muted" />
    </div>
  );
}

/** Visible error card with retry, instead of silently empty fields. */
export function DimensionCatalogError({ error: _error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div role="alert">
      <ErrorBox>بارگذاری فهرست ابعاد حسابداری انجام نشد.</ErrorBox>
      <ErrorRetryButton onClick={onRetry} type="button">
        تلاش دوباره
      </ErrorRetryButton>
    </div>
  );
}

/**
 * One kind's selector. Factored out so each selector can own its own
 * `useDimensionSearch` remote-search state (per-kind debounce, selected-id
 * label resolution, stale-response cancellation and retry).
 */
function DimensionSelect({
  name,
  kind,
  label,
  catalog,
  locationId,
  value,
  onChange,
  disabled,
  mode,
}: {
  name: string;
  kind: DimensionKind;
  label: string;
  catalog: DimensionCatalog;
  locationId: string | null;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  disabled: boolean;
  mode: "postable" | "historical";
}) {
  const noneOption = { value: "", label: `بدون ${label}` };
  const search = useDimensionSearch(catalog, {
    kind,
    locationId,
    selectedId: value ?? null,
    mode,
    noneOption,
  });
  const localEmptyText = mode === "historical" ? "موردی یافت نشد." : "موردی برای این شعبه نیست.";
  const emptyText = search.error ? "جستجو انجام نشد؛ دوباره تلاش کنید." : localEmptyText;
  return (
    <div className="min-w-0">
      <SearchableSelect
        value={value ?? ""}
        onChange={(next) => onChange(next || undefined)}
        options={search.options}
        ariaLabel={name}
        searchPlaceholder="کد یا نام…"
        emptyText={emptyText}
        disabled={disabled}
        loading={search.loading}
        onQueryChange={search.onQueryChange}
      />
      {search.truncated ? (
        <p className="mt-1 text-xs text-muted-foreground">
          نتایج بیشتری وجود دارد؛ برای محدود کردن جستجو، بخش بیشتری از کد یا نام را تایپ کنید.
        </p>
      ) : null}
      {search.error ? (
        <button
          type="button"
          onClick={search.retry}
          className="mt-1 text-xs font-medium text-sky-700 hover:underline dark:text-sky-300"
        >
          تلاش دوباره
        </button>
      ) : null}
    </div>
  );
}

export function DimensionFields({
  idPrefix,
  catalog,
  locationId,
  value,
  onChange,
  rowLabel,
  disabled = false,
  kinds,
  mode = "postable",
}: {
  idPrefix: string;
  /** The hook's result. `loaded: false` shows the placeholder rather than nothing. */
  catalog: DimensionCatalog | null;
  /** The branch the document posts to; a branch-restricted value is offered only there. */
  locationId: string | null;
  value: DimensionDraft;
  onChange: (next: DimensionDraft) => void;
  /** Appended to each label and the accessible name, to tell repeated rows apart («ردیف ۲»). */
  rowLabel?: string;
  disabled?: boolean;
  /** Restrict to these kinds (a filter may offer fewer than the form does). Defaults to every enabled kind. */
  kinds?: readonly DimensionKind[];
  /** "postable" for new documents (active leaves only); "historical" for filters/reports (includes archived). */
  mode?: "postable" | "historical";
}) {
  if (!catalog) return <DimensionFieldsSkeleton />;
  const enabled =
    kinds ??
    (mode === "historical" ? historicalKinds(catalog.settings, catalog.allValues) : enabledDimensionKinds(catalog.settings));
  if (enabled.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2" id={idPrefix}>
      {enabled.map((kind) => {
        const label = enabledKindLabel(catalog.settings, kind);
        const name = rowLabel ? `${label} ${rowLabel}` : label;
        return (
          <label key={kind} className="block min-w-0">
            <span className="mb-1.5 block text-sm font-medium text-foreground">{name}</span>
            <DimensionSelect
              name={name}
              kind={kind}
              label={label}
              catalog={catalog}
              locationId={locationId}
              value={value[kind]}
              onChange={(next) => onChange({ ...value, [kind]: next })}
              disabled={disabled}
              mode={mode}
            />
          </label>
        );
      })}
    </div>
  );
}
