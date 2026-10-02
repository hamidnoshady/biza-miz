"use client";

/**
 * One paginated workspace list: the rows loaded so far, the server's `page`
 * (filter-aware total, hasMore) and `summary` (aggregates over the WHOLE
 * filtered set, so a KPI never counts only the loaded page).
 *
 * A change of `url` (a filter) aborts the request in flight, so a slow
 * response to an old filter can never overwrite the new one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/dashboard/ui";
import { workspaceError } from "./workspace-ui";

export interface ListPage {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

interface State<T, S> {
  rows: T[] | null;
  page: ListPage | null;
  summary: S | null;
  error: string;
  loadingMore: boolean;
}

export function usePagedList<T, S = Record<string, number>>(url: string, key: string) {
  const [state, setState] = useState<State<T, S>>({
    rows: null, page: null, summary: null, error: "", loadingMore: false,
  });
  const controller = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    async (offset: number) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const sep = url.includes("?") ? "&" : "?";
      const { ok, data, aborted } = await api<Record<string, unknown>>(
        `${url}${offset ? `${sep}offset=${offset}` : ""}`,
        { signal: abort.signal },
      );
      if (aborted || abort.signal.aborted) return;
      if (!ok) {
        setState((prev) => ({
          ...prev,
          loadingMore: false,
          error: workspaceError(typeof data.error === "string" ? data.error : undefined),
        }));
        return;
      }
      const rows = (data[key] as T[] | undefined) ?? [];
      setState((prev) => ({
        rows: offset && prev.rows ? [...prev.rows, ...rows] : rows,
        page: (data.page as ListPage | undefined) ?? null,
        summary: (data.summary as S | undefined) ?? null,
        error: "",
        loadingMore: false,
      }));
    },
    [url, key],
  );

  const reload = useCallback(() => {
    void fetchPage(0);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    setState((prev) => ({ ...prev, loadingMore: true }));
    void fetchPage(state.rows?.length ?? 0);
  }, [fetchPage, state.rows?.length]);

  // A new filter starts from nothing: keeping the old rows on screen would
  // let «نمایش بیشتر» request the new filter at the old row count and append
  // a page of one filter onto rows of another.
  useEffect(() => {
    setState({ rows: null, page: null, summary: null, error: "", loadingMore: false });
    void fetchPage(0);
    return () => controller.current?.abort();
  }, [fetchPage]);

  return { ...state, reload, loadMore };
}
