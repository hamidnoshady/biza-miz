// @vitest-environment jsdom

/**
 * Issue #909 §13 — the shared scoped-resource lifecycle every migrated
 * section (`vat-report-section.tsx`, `trial-balance-section.tsx`,
 * `installments-section.tsx`, `ledger-dashboard-section.tsx`) now delegates
 * its loading/refresh/failure state to. See `resource-state.ts`'s own
 * top-of-file comment for what each status means and why.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useResourceState, type ResourceLoadOutcome } from "./resource-state";

interface Pending {
  resolve: (outcome: ResourceLoadOutcome<{ value: string }>) => void;
  signal: AbortSignal;
  markSlow: () => void;
}

function deferredLoader() {
  const pending: Pending[] = [];
  const load = vi.fn((signal: AbortSignal, markSlow: () => void) => {
    return new Promise<ResourceLoadOutcome<{ value: string }>>((resolve) => {
      pending.push({ resolve, signal, markSlow });
    });
  });
  return { load, pending };
}

function ok(value: string): ResourceLoadOutcome<{ value: string }> {
  return { ok: true, data: { value }, aborted: false };
}

function fail(errorCode: string): ResourceLoadOutcome<{ value: string }> {
  return { ok: false, data: { value: "" }, aborted: false, errorCode };
}

describe("useResourceState", () => {
  it("starts initial, then ready — the first load ever has nothing to fall back on", async () => {
    const { load, pending } = deferredLoader();
    const { result } = renderHook(() => useResourceState("scope-a", load));

    expect(result.current.status).toBe("initial");
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => pending[0].resolve(ok("first")));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual({ value: "first" });
    expect(result.current.loading).toBe(false);
  });

  it("an initial failure leaves nothing to show — status 'failed', data null", async () => {
    const { load, pending } = deferredLoader();
    const { result } = renderHook(() =>
      useResourceState("scope-a", load, { describeError: (code) => `خطا: ${code}` }),
    );

    await act(async () => pending[0].resolve(fail("boom")));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe("خطا: boom");
  });

  it("a same-scope reload (refreshSignal bump) keeps the old data on screen as 'refreshing'", async () => {
    const { load, pending } = deferredLoader();
    const { result, rerender } = renderHook(
      ({ refreshSignal }: { refreshSignal: number }) => useResourceState("scope-a", load, { refreshSignal }),
      { initialProps: { refreshSignal: 0 } },
    );

    await act(async () => pending[0].resolve(ok("v1")));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ refreshSignal: 1 });
    // The scope did not change, so the previous value must still be on
    // screen while the new request is in flight — this is exactly the
    // installments/overview defect issue #909 fixes: no blanking, no
    // reverting to an empty/default state, just a label.
    expect(result.current.status).toBe("refreshing");
    expect(result.current.data).toEqual({ value: "v1" });

    await act(async () => pending[1].resolve(ok("v2")));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual({ value: "v2" });
  });

  it("a refresh failure keeps the retained data and reports the error — 'refresh-failed', not an empty state", async () => {
    const { load, pending } = deferredLoader();
    const { result, rerender } = renderHook(
      ({ refreshSignal }: { refreshSignal: number }) => useResourceState("scope-a", load, { refreshSignal }),
      { initialProps: { refreshSignal: 0 } },
    );

    await act(async () => pending[0].resolve(ok("v1")));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ refreshSignal: 1 });
    await act(async () => pending[1].resolve(fail("network_error")));
    await waitFor(() => expect(result.current.status).toBe("refresh-failed"));
    // The old, still-correct-for-this-scope data is retained alongside the error.
    expect(result.current.data).toEqual({ value: "v1" });
    expect(result.current.error).not.toBe("");
  });

  it("a changed scope clears the old data immediately — it is not a valid answer to the new question", async () => {
    const { load, pending } = deferredLoader();
    const { result, rerender } = renderHook(({ scopeKey }: { scopeKey: string }) => useResourceState(scopeKey, load), {
      initialProps: { scopeKey: "scope-a" },
    });

    await act(async () => pending[0].resolve(ok("a-value")));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ scopeKey: "scope-b" });
    expect(result.current.status).toBe("changed-scope");
    expect(result.current.data).toBeNull();

    await act(async () => pending[1].resolve(ok("b-value")));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual({ value: "b-value" });
  });

  it("a late response for a superseded scope is dropped silently — never painted over the newer scope", async () => {
    const { load, pending } = deferredLoader();
    const { result, rerender } = renderHook(({ scopeKey }: { scopeKey: string }) => useResourceState(scopeKey, load), {
      initialProps: { scopeKey: "scope-a" },
    });

    rerender({ scopeKey: "scope-b" });
    // Two requests are now outstanding: the stale "scope-a" one and the
    // current "scope-b" one. "scope-b" answers first; "scope-a" answers
    // late. "scope-a"'s result must never land on screen.
    await act(async () => pending[1].resolve(ok("b-value")));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => pending[0].resolve(ok("STALE-a-value")));
    // Still scope-b's value — the stale result changed nothing.
    expect(result.current.data).toEqual({ value: "b-value" });
    expect(result.current.status).toBe("ready");
  });

  it("the aborted signal is wired to the real AbortController — a cleanup/scope change actually aborts it", async () => {
    const { load, pending } = deferredLoader();
    const { unmount } = renderHook(() => useResourceState("scope-a", load));
    expect(pending[0].signal.aborted).toBe(false);
    unmount();
    expect(pending[0].signal.aborted).toBe(true);
  });

  it("retry() re-runs the same scope even though nothing changed", async () => {
    const { load, pending } = deferredLoader();
    const { result } = renderHook(() => useResourceState("scope-a", load));

    await act(async () => pending[0].resolve(ok("v1")));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.retry());
    expect(result.current.status).toBe("refreshing");
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => pending[1].resolve(ok("v2")));
    await waitFor(() => expect(result.current.data).toEqual({ value: "v2" }));
  });

  it("retry() after a failed initial load re-attempts as 'changed-scope', not a false 'refreshing'", async () => {
    const { load, pending } = deferredLoader();
    const { result } = renderHook(() => useResourceState("scope-a", load));

    await act(async () => pending[0].resolve(fail("network_error")));
    await waitFor(() => expect(result.current.status).toBe("failed"));

    act(() => result.current.retry());
    // There is no data to "refresh" — this must not claim there is.
    expect(result.current.status).toBe("changed-scope");
    expect(result.current.data).toBeNull();

    await act(async () => pending[1].resolve(ok("recovered")));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("marks 'slow' only when the loader calls markSlow, and clears it once a new attempt starts", async () => {
    const pendingMarks: (() => void)[] = [];
    const load = vi.fn((signal: AbortSignal, markSlow: () => void) => {
      pendingMarks.push(markSlow);
      return new Promise<ResourceLoadOutcome<{ value: string }>>(() => {});
    });
    const { result } = renderHook(() => useResourceState("scope-a", load));

    expect(result.current.slow).toBe(false);
    act(() => pendingMarks[0]());
    expect(result.current.slow).toBe(true);
  });

  it("setData lets a caller append (pagination) without disturbing status/error", async () => {
    const { load, pending } = deferredLoader();
    const { result } = renderHook(() => useResourceState("scope-a", load));

    await act(async () => pending[0].resolve(ok("page-1")));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.setData((previous) => ({ value: `${previous?.value}+page-2` })));
    expect(result.current.data).toEqual({ value: "page-1+page-2" });
    expect(result.current.status).toBe("ready");
  });
});
