/**
 * Shared remote-search state for dimension pickers (issue #868).
 *
 * One hook owns two independent network lifecycles so a slow selected-label
 * fetch can never clobber search results, or vice versa:
 *
 *   - search:    debounced remote query (>=2 chars), cancellable per keystroke,
 *                with its own loading/error/retry state.
 *   - lookup:    selected-ID resolution for ids outside the catalogue, also
 *                cancellable, also with its own error flag surfaced as a retry
 *                button next to the selector.
 *
 * Contract: GET /api/ledger/dimensions?q=&kind=&postable=0|1&ids=&limit=&locationId=&effectiveDate=
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
  effectiveDate?: string | null;
  includeParents?: boolean;
}

export function useDimensionSearch(catalog: DimensionCatalog | null, args: OptionsArgs): DimensionSearchState {
  const { kind, locationId, selectedId, mode, noneOption, effectiveDate = null, includeParents = false } = args;
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [remoteHits, setRemoteHits] = useState<DimensionValueRecord[] | null>(null);
  const [extraResolved, setExtraResolved] = useState<DimensionValueRecord[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const searchSeqRef = useRef(0);
  const lookupSeqRef = useRef(0);
  const resolvedRef = useRef<Set<string>>(new Set());
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchQuery]);

  useEffect(() => {
    if (!catalog || !selectedId) {
      setExtraResolved((prev) => (prev.length ? [] : prev));
      return;
    }
    const inCatalog = catalog.allValues.some((v) => v.id === selectedId);
    const inRemote = (remoteHits ?? []).some((v) => v.id === selectedId);
    const inExtra = extraResolved.some((v) => v.id === selectedId);
    if (inCatalog) {
      if (inExtra) setExtraResolved((prev) => prev.filter((v) => v.id !== selectedId));
      return;
    }
    if (inRemote || inExtra || resolvedRef.current.has(selectedId)) return;
    resolvedRef.current.add(selectedId);
    let cancelled = false;
    const mySeq = ++lookupSeqRef.current;
    setLookupLoading(true);
    setLookupError(null);
    const url = `/api/ledger/dimensions?ids=${encodeURIComponent(selectedId)}&limit=1&postable=0`;
    void api<SearchResponse>(url).then((res) => {
      if (cancelled || mySeq !== lookupSeqRef.current) return;
      setLookupLoading(false);
      if (res.ok && res.data && Array.isArray(res.data.values)) {
        setExtraResolved((prev) => {
          const map = new Map(prev.map((v) => [v.id, v]));
          for (const v of res.data.values) map.set(v.id, v);
          return [...map.values()];
        });
      } else {
        setLookupError(res.status ? `http_${res.status}` : "network");
        resolvedRef.current.delete(selectedId);
      }
    });
    return () => { cancelled = true; };
  }, [catalog, selectedId, remoteHits, extraResolved, retryNonce]);

  useEffect(() => {
    if (!catalog) return;
    if (debouncedQuery.length < 2) {
      setRemoteHits(null);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    const params = new URLSearchParams({
      q: debouncedQuery,
      kind,
      postable: mode === "postable" ? "1" : "0",
      limit: includeParents ? "50" : "20",
    });
    if (mode === "postable" && locationId) params.set("locationId", locationId);
    if (mode === "postable" && effectiveDate) params.set("effectiveDate", effectiveDate);
    const url = `/api/ledger/dimensions?${params.toString()}`;
    let cancelled = false;
    const mySeq = ++searchSeqRef.current;
    setSearchLoading(true);
    setSearchError(null);
    void api<SearchResponse>(url).then((res) => {
      if (cancelled || mySeq !== searchSeqRef.current) return;
      setSearchLoading(false);
      if (res.ok && res.data && Array.isArray(res.data.values)) {
        setRemoteHits(res.data.values);
      } else {
        setRemoteHits(null);
        setSearchError(res.status ? `http_${res.status}` : "network");
      }
    });
    return () => { cancelled = true; };
  }, [catalog, debouncedQuery, kind, mode, locationId, effectiveDate, includeParents]);

  const retry = useCallback(() => {
    setRetryNonce((n) => n + 1);
    setSearchError(null);
    setLookupError(null);
    setSearchQuery((q) => q + " ");
    setTimeout(() => setSearchQuery((q) => q.trimEnd()), 0);
  }, []);

  const options = useMemo<SelectOption[]>(() => {
    if (!catalog) return noneOption ? [noneOption] : [];
    const baseList = mode === "postable" ? catalog.postableValues : catalog.allValues;
    const merged = new Map<string, DimensionValueRecord>();
    for (const v of baseList) if (v.kind === kind) merged.set(v.id, v);
    for (const v of extraResolved) if (v.kind === kind) merged.set(v.id, v);
    if (remoteHits) for (const v of remoteHits) if (v.kind === kind) merged.set(v.id, v);
    const values = [...merged.values()];
    const baseOpts =
      mode === "postable" && !includeParents
        ? dimensionOptionsFor(values, kind, locationId)
        : dimensionFilterOptionsFor(values, kind);
    return noneOption ? [noneOption, ...baseOpts] : baseOpts;
  }, [catalog, mode, kind, locationId, remoteHits, extraResolved, noneOption, includeParents]);

  const error = searchError ?? (debouncedQuery.length < 2 ? lookupError : null);
  const loading = searchLoading || lookupLoading;

  return { options, loading, error, retry, onQueryChange: setSearchQuery, truncated: false };
}

export function chunkSelectedIds(ids: readonly string[]): string[][] {
  const clean = ids.filter((id) => id && id.length > 0);
  const out: string[][] = [];
  for (let i = 0; i < clean.length; i += BATCH_IDS_LIMIT) out.push(clean.slice(i, i + BATCH_IDS_LIMIT));
  return out;
}
