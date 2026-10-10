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
  dimensionOptionsFor,
  dimensionFilterOptionsFor,
  enabledDimensionKinds,
  enabledKindLabel,
  historicalKinds,
  loadDimensionCatalog,
  type DimensionCatalog,
  type DimensionCatalogLoadResult,
  type DimensionDraft,
} from "./dimension-catalog";

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
  const valuesList = mode === "historical" ? catalog.allValues : catalog.postableValues;
  return (
    <div className="grid gap-3 sm:grid-cols-2" id={idPrefix}>
      {enabled.map((kind) => {
        const label = enabledKindLabel(catalog.settings, kind);
        const name = rowLabel ? `${label} ${rowLabel}` : label;
        const options =
          mode === "historical"
            ? dimensionFilterOptionsFor(valuesList, kind)
            : dimensionOptionsFor(valuesList, kind, locationId);
        return (
          <label key={kind} className="block min-w-0">
            <span className="mb-1.5 block text-sm font-medium text-foreground">{name}</span>
            <SearchableSelect
              value={value[kind] ?? ""}
              onChange={(next) => onChange({ ...value, [kind]: next || undefined })}
              options={[{ value: "", label: `بدون ${label}` }, ...options]}
              ariaLabel={name}
              searchPlaceholder="کد یا نام…"
              emptyText={mode === "historical" ? "موردی یافت نشد." : "موردی برای این شعبه نیست."}
              disabled={disabled}
            />
          </label>
        );
      })}
    </div>
  );
}
