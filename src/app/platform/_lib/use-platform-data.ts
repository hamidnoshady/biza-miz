"use client";

/**
 * Data-fetching hooks for the console — the reusable replacement for the
 * `useState/useEffect/loading/error/reload/busy` boilerplate every page used
 * to reimplement.
 *
 *   - usePlatformQuery: a cancellable GET with initial/refresh/error/empty
 *     states distinguished, plus `refetch`. A background refresh failure keeps
 *     the previously loaded data instead of blanking the page (section 33).
 *   - usePlatformMutation: a write with busy/error state and a typed result,
 *     wired to Sonner for success/failure toasts unless a caller opts out.
 *
 * Both speak the `PlatformResult` union from `platform-client.ts`, so a caller
 * always gets a discriminated success/error — never a raw fetch to interpret.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  platformFetch,
  type PlatformRequestOptions,
  type PlatformResult,
} from "@/lib/platform-client";
import { platformErrorText } from "@/lib/platform-errors";

export interface QueryState<T> {
  /** The last successfully loaded data, or null before the first success. */
  data: T | null;
  /** True only during the very first load (no data yet). */
  loading: boolean;
  /** True while re-fetching with data already on screen. */
  refreshing: boolean;
  /** A stable error code from the most recent failed load, else null. */
  error: string | null;
  /** Operator-facing Persian text for `error`, else null. */
  errorText: string | null;
  /** The HTTP status of the most recent failure (0 for network/abort). */
  errorStatus: number | null;
  /** Re-run the query, keeping current data visible until it resolves. */
  refetch: () => void;
}

export interface QueryOptions<T> {
  /** Skip fetching entirely (e.g. gated behind a capability or a selection). */
  enabled?: boolean;
  /** Extra domain-specific error codes for translation. */
  errorMessages?: Record<string, string>;
  /** Called after every successful load with the fresh data. */
  onSuccess?: (data: T) => void;
  /** Called with the error code after a failed load. */
  onError?: (code: string) => void;
}

/**
 * A cancellable GET. `deps` behaves like a dependency array: when any entry
 * changes the query re-runs and the previous request is aborted, so a fast
 * sequence of filter changes never lets a stale response overwrite a newer one.
 */
export function usePlatformQuery<T = unknown>(
  url: string | null,
  deps: readonly unknown[] = [],
  options: QueryOptions<T> = {},
): QueryState<T> {
  const { enabled = true, errorMessages, onSuccess, onError } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled && url !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const hasDataRef = useRef(false);
  // Keep the latest callbacks without forcing them into the dep array.
  const cbRef = useRef({ onSuccess, onError });
  cbRef.current = { onSuccess, onError };

  const run = useCallback(async () => {
    if (!url || !enabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (hasDataRef.current) setRefreshing(true);
    else setLoading(true);

    const result = await platformFetch<T>(url, { signal: controller.signal });
    if (controller.signal.aborted) return;

    if (result.ok) {
      hasDataRef.current = true;
      setData(result.data);
      setError(null);
      setErrorStatus(null);
      cbRef.current.onSuccess?.(result.data);
    } else if (!result.cancelled) {
      // A background refresh failure must not erase valid data already shown.
      setError(result.code);
      setErrorStatus(result.status);
      cbRef.current.onError?.(result.code);
    }
    setLoading(false);
    setRefreshing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, enabled, ...deps]);

  useEffect(() => {
    if (!url || !enabled) {
      setLoading(false);
      return;
    }
    void run();
    return () => abortRef.current?.abort();
  }, [run, url, enabled]);

  return {
    data,
    loading,
    refreshing,
    error,
    errorText: error ? platformErrorText(error, errorMessages) : null,
    errorStatus,
    refetch: run,
  };
}

export interface MutationState<TArgs, TData> {
  /** Fire the mutation; resolves to the normalised result. */
  mutate: (args: TArgs) => Promise<PlatformResult<TData>>;
  /** True while the mutation is in flight (blocks duplicate submits). */
  busy: boolean;
  /** Stable error code of the last failed mutation, else null. */
  error: string | null;
  /** Operator-facing text for `error`, else null. */
  errorText: string | null;
  /** Field-level validation errors from the last failure, if any. */
  fields: Record<string, string> | null;
  /** Clear the error/field state (e.g. when reopening a form). */
  reset: () => void;
}

export interface MutationOptions<TArgs, TData> {
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Build the request from the call args (url override, body, params). */
  request?: (args: TArgs) => { url?: string; options?: PlatformRequestOptions };
  /** Extra domain-specific error codes for translation. */
  errorMessages?: Record<string, string>;
  /** A Sonner success toast; omit or pass null to stay silent. */
  successToast?: string | ((data: TData, args: TArgs) => string) | null;
  /** Show a Sonner error toast on failure (default true). */
  errorToast?: boolean;
  onSuccess?: (data: TData, args: TArgs) => void;
  onError?: (code: string, args: TArgs) => void;
}

/**
 * A single write with busy/error/field state. Prevents duplicate submission by
 * ignoring calls while one is in flight, and does NOT reset caller form state
 * on error (section 27) — the caller decides what to keep.
 */
export function usePlatformMutation<TArgs = void, TData = unknown>(
  baseUrl: string,
  options: MutationOptions<TArgs, TData> = {},
): MutationState<TArgs, TData> {
  const {
    method = "POST",
    request,
    errorMessages,
    successToast,
    errorToast = true,
    onSuccess,
    onError,
  } = options;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string> | null>(null);
  const busyRef = useRef(false);
  // `mutate` is stable on `[baseUrl, method]` so callers don't re-render on every
  // keystroke; read the latest request/toast/callback options from a ref instead
  // of closing over a stale `request` (which broke provisioning with missing_fields).
  const optionsRef = useRef({
    request,
    errorMessages,
    successToast,
    errorToast,
    onSuccess,
    onError,
  });
  optionsRef.current = {
    request,
    errorMessages,
    successToast,
    errorToast,
    onSuccess,
    onError,
  };

  const reset = useCallback(() => {
    setError(null);
    setFields(null);
  }, []);

  const mutate = useCallback(
    async (args: TArgs): Promise<PlatformResult<TData>> => {
      if (busyRef.current) {
        return { ok: false, status: 0, code: "request_cancelled", cancelled: true };
      }
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setFields(null);

      const {
        request: buildRequest,
        errorMessages: errorMap,
        successToast: success,
        errorToast: showErrorToast,
        onSuccess: onOk,
        onError: onFail,
      } = optionsRef.current;

      const built = buildRequest?.(args) ?? {};
      const url = built.url ?? baseUrl;
      const result = await platformFetch<TData>(url, {
        method,
        ...(built.options ?? {}),
      });

      if (result.ok) {
        if (success) {
          const text = typeof success === "function" ? success(result.data, args) : success;
          toast.success(text);
        }
        onOk?.(result.data, args);
      } else if (!result.cancelled) {
        setError(result.code);
        setFields(result.fields ?? null);
        if (showErrorToast) toast.error(platformErrorText(result.code, errorMap));
        onFail?.(result.code, args);
      }

      busyRef.current = false;
      setBusy(false);
      return result;
    },
    [baseUrl, method],
  );

  return {
    mutate,
    busy,
    error,
    errorText: error ? platformErrorText(error, errorMessages) : null,
    fields,
    reset,
  };
}
