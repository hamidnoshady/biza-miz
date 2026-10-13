"use client";

/**
 * One GET whose URL is derived from the screen's current selection (a seller,
 * a page, a filter). A response is only ever shown for the URL that is on
 * screen now: changing the URL aborts the request in flight, and a response
 * that arrives late for an earlier URL is dropped, so A-then-B can never leave
 * A's data under B's heading.
 *
 * `null` means "nothing selected": no request, status `idle`.
 *
 * `describeError` must be a stable function (module-level), because it is an
 * effect dependency.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/app/dashboard/ui";

export type KeyedRequestStatus = "idle" | "loading" | "ready" | "error";

export interface KeyedRequest<T> {
  status: KeyedRequestStatus;
  data: T | null;
  error: string;
  retry: () => void;
}

interface Settled<T> {
  url: string;
  attempt: number;
  status: Exclude<KeyedRequestStatus, "idle">;
  data: T | null;
  error: string;
}

export function useKeyedRequest<T>(
  url: string | null,
  describeError: (code: string | undefined) => string,
): KeyedRequest<T> {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    api<T & { error?: string }>(url, { signal: controller.signal }).then(({ ok, data, aborted }) => {
      if (aborted || controller.signal.aborted) return;
      setSettled(
        ok
          ? { url, attempt, status: "ready", data, error: "" }
          : { url, attempt, status: "error", data: null, error: describeError(data.error) },
      );
    });
    return () => controller.abort();
  }, [url, attempt, describeError]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  // Anything settled for another URL or an earlier attempt is not this request's answer.
  const current = url !== null && settled !== null && settled.url === url && settled.attempt === attempt;
  if (url === null) return { status: "idle", data: null, error: "", retry };
  if (!current) return { status: "loading", data: null, error: "", retry };
  return { status: settled.status, data: settled.data, error: settled.error, retry };
}
