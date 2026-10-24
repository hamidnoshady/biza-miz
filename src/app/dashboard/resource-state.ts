"use client";

/**
 * The shared scoped-resource lifecycle (issue #909 §13 — "duplicated
 * request-state-lifecycle conventions across sections").
 *
 * Before this, every screen that reads a filtered report (trial balance, the
 * VAT report, the journal, the installment schedule, the ledger overview)
 * reinvented the same handful of states with its own `useState`/`useRef`
 * wiring and its own small, easy-to-get-wrong decisions: is this the first
 * load ever, or did the filters just change, or is this the *same* report
 * being re-fetched after someone posted an entry elsewhere? Each answer has a
 * different right UI (a full skeleton vs. a quiet "در حال به‌روزرسانی" label
 * over the figures already on screen vs. nothing changing at all), and three
 * sections independently got it right while two did not (issue #909 §13's
 * installments/overview defects). This hook is the one place that logic now
 * lives, built from the same six ideas the issue asks every section to share:
 *
 *   - **initial** — the very first load this hook instance has ever
 *     attempted. No data exists yet; there is nothing to keep on screen.
 *   - **changed-scope** — the requested scope (`scopeKey`) is not the one
 *     `data` currently answers, so the old figures are not a stale-but-valid
 *     answer to the new question — they are *wrong*, and must disappear
 *     immediately rather than linger as if they still applied. This also
 *     covers retrying a scope whose last attempt never succeeded.
 *   - **refreshing** — the scope has not changed; `data` already answers it.
 *     The previous figures stay on screen, labelled as refreshing, while the
 *     new ones load — the one behavior the installments/overview defects
 *     this issue fixes were missing, and trial balance/entries/VAT already
 *     had.
 *   - **ready** — the last load for the current scope succeeded.
 *   - **failed** — a load ended in error and there is no data for the
 *     current scope to fall back on (an initial or changed-scope failure).
 *   - **refresh-failed** — a *refresh* of an already-loaded scope failed.
 *     `data` is retained (the old, still-correct-for-this-scope figures)
 *     alongside the error, and a Retry re-runs the same scope — never a
 *     silent reversion to an empty/default state (the installments
 *     party-selector and plans-list defects this issue fixes).
 *
 * Plus the two mechanisms the issue names alongside those four states:
 *
 *   - **retry** — `retry()`, for a Retry button. Re-runs the loader for the
 *     *current* `scopeKey` regardless of whether anything changed.
 *   - **abort** — every load gets its own `AbortSignal`, aborted the moment a
 *     newer load starts (`scopeKey` changed, a `refreshSignal` bump, a
 *     `retry()`, or the component unmounting). A result for an aborted
 *     signal is dropped silently — matching `api()`'s own contract, a
 *     superseded request is the normal path, never a failure — so a slow
 *     response for an old scope can never paint over a newer one's data.
 *
 * **Scope key.** `scopeKey` must encode everything that changes what the
 * server returns for *this* resource — not just visible filters and dates,
 * but anything from the business/branch/permission context that the same
 * component could re-render under (switching businesses, a permission
 * change). A caller building it from `JSON.stringify({...})` over every
 * relevant field, the way trial balance already did before this hook
 * existed, is the recommended shape; see the section migrations for
 * examples. Two different scope keys are always treated as a *different*
 * question even if the bytes the server would return happen to coincide.
 *
 * **Identity context.** No current caller's own `scopeKey` actually includes
 * a business/branch/user id — most sections have none of those to hand
 * without new prop drilling, and the one context that can change *without*
 * remounting (the branch switcher's in-place `router.refresh()`, see
 * `resource-identity.ts`) is not a per-section concern. So this hook mixes
 * in `useResourceIdentityGeneration()` itself: the *effective* key used for
 * every initial/changed-scope/refreshing decision below is `scopeKey` plus
 * that generation, and `invalidateResourceIdentity()` (called after a branch
 * switch) bumps it for every mounted instance at once. A caller's own
 * `scopeKey` therefore still only needs to encode what *it* knows changed —
 * this hook's own built-in identity dimension covers the rest.
 *
 * This hook deliberately does not fetch anything itself — `load` is the
 * caller's own function (almost always a thin wrapper around one or more
 * `api()` calls), so each section keeps its own URL-building, its own
 * per-field validation before firing a request, and its own Persian error
 * copy via `describeError`. What moves here is only the state machine around
 * that function, not the function itself.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useResourceIdentityGeneration } from "./resource-identity";

export type ResourceStatus = "initial" | "changed-scope" | "refreshing" | "ready" | "failed" | "refresh-failed";

/** What a `load` function must resolve to — the shape `api()` already returns, narrowed to what this hook needs. */
export interface ResourceLoadOutcome<T> {
  ok: boolean;
  data: T;
  aborted: boolean;
  /** The server's error code, when `ok` is false — fed to `describeError`. */
  errorCode?: string;
}

export interface ResourceState<T> {
  status: ResourceStatus;
  /** The last successfully loaded value for the *current* `scopeKey`, or `null` while there is none to show. */
  data: T | null;
  /** Persian message for the most recent failure; `""` otherwise. Still set during `refresh-failed`, alongside retained `data`. */
  error: string;
  /** True while `status` is `initial`, `changed-scope` or `refreshing` — a request for the current scope is in flight. */
  loading: boolean;
  /**
   * True once the in-flight request has taken longer than ~5s (issue #909's
   * slow-read UX threshold) — see `load`'s `markSlow` argument. Reset to
   * `false` at the start of every new attempt, so it never survives into a
   * request that later turns out to be fast (a retry, a changed scope).
   */
  slow: boolean;
  /** Re-runs `load` for the current `scopeKey`, regardless of whether anything changed. For a Retry button. */
  retry: () => void;
  /**
   * Escape hatch for a caller that must update `data` outside the normal
   * load cycle — cursor pagination appending a page, an optimistic local
   * edit. Does not touch `status`/`error`; the caller remains responsible
   * for what those should say about a manually-set value.
   */
  setData: (updater: T | ((previous: T | null) => T)) => void;
}

export function useResourceState<T>(
  scopeKey: string,
  load: (signal: AbortSignal, markSlow: () => void) => Promise<ResourceLoadOutcome<T>>,
  options?: {
    describeError?: (code: string | undefined) => string;
    /**
     * Bump this (e.g. the parent's existing `refreshKey` after posting a
     * document) to force a same-scope refresh without the scope itself
     * changing. Leave undefined for a resource with no such external
     * refresh trigger.
     */
    refreshSignal?: number;
  },
): ResourceState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [status, setStatus] = useState<ResourceStatus>("initial");
  const [error, setError] = useState("");
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // See "Identity context" above — a branch switch (or anything else that
  // calls `invalidateResourceIdentity()`) must be treated exactly like the
  // caller's own `scopeKey` changing, for every section, with no per-section
  // wiring. `effectiveScopeKey` is what the state machine below actually
  // tracks; `scopeKey` itself is never read past this line.
  const identityGeneration = useResourceIdentityGeneration();
  const effectiveScopeKey = `${scopeKey}\u0000identity:${identityGeneration}`;

  // Mirrors `data`/the scope it answers synchronously, so the effect below
  // can make its "same scope, existing data" decision without racing
  // React's own batched state updates — the same reason `api()` keeps its
  // own `timedOut`/`isAborted()` locals instead of reading state.
  const dataRef = useRef<T | null>(null);
  const loadedScopeKeyRef = useRef<string | null>(null);
  const hasAttemptedRef = useRef(false);

  const setData = useCallback((updater: T | ((previous: T | null) => T)) => {
    const next = typeof updater === "function" ? (updater as (previous: T | null) => T)(dataRef.current) : updater;
    dataRef.current = next;
    setDataState(next);
  }, []);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  // `load` is almost always a fresh closure every render (it captures the
  // caller's current filters) — `refreshSignal`/`scopeKey`/`attempt` are the
  // dependencies that are actually meant to *trigger* a new request; `load`
  // itself is read through a ref so a re-render that only recreated the
  // closure (no actual input changed) does not refire it.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const holdingDataForThisScope = loadedScopeKeyRef.current === effectiveScopeKey && dataRef.current !== null;
    if (holdingDataForThisScope) {
      setStatus("refreshing");
    } else {
      setStatus(hasAttemptedRef.current ? "changed-scope" : "initial");
      dataRef.current = null;
      loadedScopeKeyRef.current = null;
      setDataState(null);
      setError("");
    }
    setSlow(false);
    hasAttemptedRef.current = true;

    const controller = new AbortController();
    let settled = false;
    loadRef.current(controller.signal, () => {
      if (!settled && !controller.signal.aborted) setSlow(true);
    }).then((result) => {
      settled = true;
      if (result.aborted || controller.signal.aborted) return;
      if (result.ok) {
        loadedScopeKeyRef.current = effectiveScopeKey;
        dataRef.current = result.data;
        setDataState(result.data);
        setStatus("ready");
        setError("");
        setSlow(false);
        return;
      }
      const message = options?.describeError ? options.describeError(result.errorCode) : "خطایی رخ داد؛ دوباره تلاش کنید.";
      setError(message);
      setSlow(false);
      // `dataRef.current` is already `null` on the changed-scope/initial
      // path (cleared above before this request even started), so this one
      // check correctly distinguishes both cases without re-deriving
      // "was this a same-scope refresh" separately.
      setStatus(dataRef.current !== null ? "refresh-failed" : "failed");
    });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is read through `loadRef`; see the comment above.
  }, [effectiveScopeKey, options?.refreshSignal, attempt]);

  return {
    status,
    data,
    error,
    loading: status === "initial" || status === "changed-scope" || status === "refreshing",
    slow,
    retry,
    setData,
  };
}
