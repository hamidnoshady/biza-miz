"use client";

/**
 * Issue #885 L05 — one credential request, with a bounded wait, guaranteed
 * cleanup and stale-response rejection.
 *
 * The bug this replaces: both sign-in forms set `busy` and then awaited a bare
 * `fetch` with no catch and no finally. A network rejection (the till's Wi-Fi
 * dropping, the local server restarting, a DNS failure) threw out of the
 * submit handler, the promise rejected unhandled, and `setBusy(false)` never
 * ran — so the button stayed disabled reading «در حال ورود…» until the page
 * was reloaded. On a shop floor that is not a cosmetic fault: it is a
 * permanently unusable login screen with no visible cause.
 *
 * Three guarantees, each of which a form used to get wrong:
 *
 *  1. **`busy` is always released**, on success, on HTTP error, on a thrown
 *     network error and on timeout, because the release is in a `finally`.
 *  2. **A request that cannot complete does not hang forever.** A slow or
 *     black-holed connection is aborted at `timeoutMs` and reported as a
 *     timeout rather than leaving the user guessing whether the click landed.
 *  3. **A late response cannot overwrite a newer one.** Every call takes a
 *     generation number; if a newer call has started by the time an older one
 *     resolves, the older result is returned as `stale` and the caller is
 *     expected to ignore it. This is what makes "cancel and go back" safe on
 *     the OTP step, where an in-flight verify used to be able to land after
 *     the member had already left.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Long enough for an SMS round trip on a bad connection, short enough to be a useful answer. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 20_000;

export type LoginRequestOutcome<T> =
  | {
      stale: true;
      /** A newer request superseded this one; the caller must ignore it. */
    }
  | {
      stale: false;
      ok: boolean;
      /** HTTP status, or 0 when the request never completed. */
      status: number;
      data: T;
      /**
       * Set only when the request did not complete at all — which is the case
       * the old forms mishandled. `timeout` means we gave up on it;
       * `unreachable` means the network refused it.
       */
      networkError?: "timeout" | "unreachable";
    };

export function useLoginRequest(timeoutMs: number = DEFAULT_LOGIN_TIMEOUT_MS) {
  const [busy, setBusy] = useState(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const release = useCallback(() => {
    if (mountedRef.current) setBusy(false);
  }, []);

  /**
   * Perform one credential request.
   *
   * The caller supplies the fetch, so the hook stays free of endpoint and
   * body knowledge and both doors can use it unchanged. The `signal` it is
   * handed is the abort handle for this call's timeout and cancellation.
   */
  const send = useCallback(
    async <T,>(
      doFetch: (signal: AbortSignal) => Promise<Response>,
    ): Promise<LoginRequestOutcome<T>> => {
      const id = ++generationRef.current;
      if (mountedRef.current) setBusy(true);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(controller.signal);
        // A non-JSON body (a proxy error page, an HTML 502) must not become an
        // unhandled rejection either.
        const data = (await res.json().catch(() => ({}))) as T;
        if (id !== generationRef.current) return { stale: true };
        return { stale: false, ok: res.ok, status: res.status, data };
      } catch (err) {
        if (id !== generationRef.current) return { stale: true };
        const timedOut =
          (err instanceof Error && err.name === "AbortError") ||
          controller.signal.aborted;
        return {
          stale: false,
          ok: false,
          status: 0,
          data: {} as T,
          networkError: timedOut ? "timeout" : "unreachable",
        };
      } finally {
        clearTimeout(timer);
        if (id === generationRef.current) release();
      }
    },
    [release, timeoutMs],
  );

  /**
   * Abandon whatever is in flight. The generation moves on, so the pending
   * call resolves into `{ stale: true }` and cannot touch state afterwards.
   */
  const cancel = useCallback(() => {
    generationRef.current += 1;
    release();
  }, [release]);

  return { busy, send, cancel };
}

/**
 * The Persian sentence for "the request never reached the server".
 *
 * Shared so the two doors cannot drift apart on the one message that matters
 * most on a flaky local network — and so neither of them reports a dropped
 * connection as a wrong password, which would send the user to re-type a
 * credential that was never the problem.
 */
export function networkErrorMessage(kind: "timeout" | "unreachable"): string {
  return kind === "timeout"
    ? "پاسخ سرور به موقع نرسید. اتصال شبکه را بررسی کنید و دوباره تلاش کنید."
    : "ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی کنید و دوباره تلاش کنید.";
}
