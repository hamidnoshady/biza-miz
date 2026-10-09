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
 */
import { useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api } from "@/app/dashboard/ui";
import type { DimensionKind } from "@/lib/accounting-dimensions";
import {
  dimensionOptionsFor,
  enabledDimensionKinds,
  enabledKindLabel,
  loadDimensionCatalog,
  type DimensionCatalog,
  type DimensionDraft,
} from "./dimension-catalog";

/** The catalogue, read once when a screen mounts. Empty until it arrives, and `loaded` says when it has. */
export function useDimensionCatalog(): DimensionCatalog & { loaded: boolean } {
  const [catalog, setCatalog] = useState<DimensionCatalog>({ settings: [], values: [] });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadDimensionCatalog(async (url) => {
      const result = await api<unknown>(url);
      return { ok: result.ok, data: result.data };
    }).then((next) => {
      if (cancelled) return;
      setCatalog(next);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { ...catalog, loaded };
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

export function DimensionFields({
  idPrefix,
  catalog,
  locationId,
  value,
  onChange,
  rowLabel,
  disabled = false,
  kinds,
}: {
  idPrefix: string;
  /** The hook's result. `loaded: false` shows the placeholder rather than nothing. */
  catalog: DimensionCatalog & { loaded?: boolean };
  /** The branch the document posts to; a branch-restricted value is offered only there. */
  locationId: string | null;
  value: DimensionDraft;
  onChange: (next: DimensionDraft) => void;
  /** Appended to each label and the accessible name, to tell repeated rows apart («ردیف ۲»). */
  rowLabel?: string;
  disabled?: boolean;
  /** Restrict to these kinds (a filter may offer fewer than the form does). Defaults to every enabled kind. */
  kinds?: readonly DimensionKind[];
}) {
  if (catalog.loaded === false) return <DimensionFieldsSkeleton />;
  const enabled = kinds ?? enabledDimensionKinds(catalog.settings);
  if (enabled.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2" id={idPrefix}>
      {enabled.map((kind) => {
        const label = enabledKindLabel(catalog.settings, kind);
        const name = rowLabel ? `${label} ${rowLabel}` : label;
        const options = dimensionOptionsFor(catalog.values, kind, locationId);
        return (
          <label key={kind} className="block min-w-0">
            <span className="mb-1.5 block text-sm font-medium text-foreground">{name}</span>
            <SearchableSelect
              value={value[kind] ?? ""}
              onChange={(next) => onChange({ ...value, [kind]: next || undefined })}
              options={[{ value: "", label: `بدون ${label}` }, ...options]}
              ariaLabel={name}
              searchPlaceholder="کد یا نام…"
              emptyText="موردی برای این شعبه نیست."
              disabled={disabled}
            />
          </label>
        );
      })}
    </div>
  );
}
