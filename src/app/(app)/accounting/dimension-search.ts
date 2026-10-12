/**
 * Shared remote-search state for dimension pickers (issue #868).
 *
 * When a business has >2,000 dimension values (long-lived multi-branch setups)
 * the initial capped catalogue cannot contain every label, and the selector
 * must fall back to debounced server search. The same shape of request appears
 * for manual journal lines, expenses, report filters, fixed-asset pickers and
 * the asset edit drawer — one hook keeps the debounce, stale-response
 * cancellation, retry behaviour, and selected-ID resolution in one place.
 *
 * Contract: GET /api/ledger/dimensions?q=…&kind=…&postable=0|1&ids=…&limit=…
 * Returns: { settings, values: DimensionValueRecord[], truncated, truncatedAt }.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SelectOption } from "@/components/ui/searchable-select";
import { api } from "@/app/dashboard/ui";
import type { DimensionKind, DimensionValueRecord } from "@/lib/accounting-dimensions";
import type { DimensionCatalog } from "./dimension-catalog";
import { dimensionFilterOptionsFor, dimensionOptionsFor } from "./dimension-catalog";

const SEARCH_DEBOUNCE_MS = 220;
const BATCH_IDS_LIMIT = 40;

export interface DimensionSearchState {
  options: SelectOption[];
  loading: boolean;
  error: string | null;
  retry: () => void;
  onQueryChange: (q: string) => void;
  truncated: boolean;
}

interface SearchResponse {
  values: DimensionValueRecord[];
  truncated: boolean;
  truncatedAt: number | null;
}

interface OptionsArgs {
  kind: DimensionKind;
  locationId: string | null;
  selectedId: string | null | undefined;
  mode: "postable" | "historical";
  noneOption?: SelectOption;
}

export function useDimensionSearch(
  catalog: DimensionCatalog | null,
  args: OptionsArgs,
): DimensionSearchState {
  const { kind, locationId, selectedId, mode, noneOption } = args;
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [remote, setRemote] = useState<SearchResponse | null>(null);
  const [extraResolved, setExtraResolved] = useState<DimensionValueRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<string>("");
  const seqRef = useRef(0);
  const resolvedRef = useRef<Set<string>>(new Set());
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [searchQuery]);

  // Resolve selectedId label when it is not in the catalogue/remote set.
  useEffect(() => {
    if (!selectedId) {
      setExtraResolved([]);
      return;
    }
    const inCatalog = (catalog?.allValues ?? []).some((v) => v.id === selectedId);
    const inRemote = (remote?.values ?? []).some((v) => v.id === selectedId);
    const alreadyFetched = resolvedRef.current.has(selectedId);
    if (inCatalog) {
      setExtraResolved((prev) => prev.filter((v) => v.id !== selectedId));
      return;
    }
    if (inRemote || alreadyFetched) return;
    resolvedRef.current.add(selectedId);
    let cancelled = false;
    const mySeq = ++seqRef.current;
    setLoading(true);
    setError(null);
    const url = `/api/ledger/dimensions?ids=${encodeURIComponent(selectedId)}&limit=1&postable=0`;
    void api<SearchResponse>(url).then((res) => {
      if (cancelled || mySeq !== seqRef.current) return;
      setLoading(false);
      if (res.ok && res.data && Array.isArray(res.data.values)) {
        setExtraResolved((prev) => {
          const map = new Map(prev.map((v) => [v.id, v]));
          for (const v of res.data.values) map.set(v.id, v);
          return [...map.values()];
        });
      } else {
        setError(res.status ? `http_${res.status}` : "network");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, catalog, remote]);

  useEffect(() => {
    if (!catalog) return;
    const useRemote = debouncedQuery.length >= 2;
    if (!useRemote) {
      setRemote(null);
      setLastKey("");
      setLoading(false);
      setError(null);
      return;
    }
    const postable = mode === "postable" ? 1 : 0;
    const url =
      `/api/ledger/dimensions?q=${encodeURIComponent(debouncedQuery)}` +
      `&kind=${kind}&postable=${postable}&limit=20`;
    const key = `${kind}|${postable}|${debouncedQuery}`;
    if (key === lastKey) return;
    let cancelled = false;
    const mySeq = ++seqRef.current;
    setLoading(true);
    setError(null);
    void api<SearchResponse>(url).then((res) => {
      if (cancelled || mySeq !== seqRef.current) return; // stale
      setLoading(false);
      if (res.ok && res.data && Array.isArray(res.data.values)) {
        setRemote({
          values: res.data.values,
          truncated: res.data.truncated === true,
          truncatedAt: typeof res.data.truncatedAt === "number" ? res.data.truncatedAt : null,
        });
        setLastKey(key);
      } else {
        setRemote(null);
        setError(res.status ? `http_${res.status}` : "network");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [catalog, debouncedQuery, kind, mode, lastKey]);

  const retry = useCallback(() => {
    setLastKey("");
    setError(null);
    setSearchQuery((q) => q + " ");
    setTimeout(() => setSearchQuery((q) => q.trimEnd()), 0);
  }, []);

  const options = useMemo<SelectOption[]>(() => {
    if (!catalog) return noneOption ? [noneOption] : [];
    const baseList = mode === "postable" ? catalog.postableValues : catalog.allValues;
    const merged = new Map<string, DimensionValueRecord>();
    for (const v of baseList) if (v.kind === kind) merged.set(v.id, v);
    for (const v of extraResolved) if (v.kind === kind) merged.set(v.id, v);
    if (remote) for (const v of remote.values) if (v.kind === kind) merged.set(v.id, v);
    const values = [...merged.values()];
    const baseOpts =
      mode === "postable"
        ? dimensionOptionsFor(values, kind, locationId)
        : dimensionFilterOptionsFor(values, kind);
    return noneOption ? [noneOption, ...baseOpts] : baseOpts;
  }, [catalog, mode, kind, locationId, remote, extraResolved, noneOption]);

  return {
    options,
    loading,
    error,
    retry,
    onQueryChange: setSearchQuery,
    truncated: remote?.truncated ?? false,
  };
}

/** Split a list of ids into bounded batches to stay under URL-safe limits. */
export function chunkSelectedIds(ids: readonly string[]): string[][] {
  const clean = ids.filter((id) => id && id.length > 0);
  const out: string[][] = [];
  for (let i = 0; i < clean.length; i += BATCH_IDS_LIMIT) {
    out.push(clean.slice(i, i + BATCH_IDS_LIMIT));
  }
  return out;
}
