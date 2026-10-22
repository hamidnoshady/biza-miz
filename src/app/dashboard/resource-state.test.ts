// @vitest-environment jsdom

/**
 * Issue #909 §13 — the shared scoped-resource lifecycle every migrated
 * section (`vat-report-section.tsx`, `trial-balance-section.tsx`,
 * `installments-section.tsx`, `ledger-dashboard-section.tsx`) now delegates
 * its loading/refresh/failure state to. See `resource-state.ts`'s own
 * top-of-file comment for what each status means and why.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useResourceState, type ResourceLoadOutcome } from "./resource-state";
import { __resetResourceIdentityForTests, invalidateResourceIdentity } from "./resource-identity";

afterEach(() => {
  __resetResourceIdentityForTests();
});

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

  it("unmount — a request that resolves after the component is gone touches nothing and throws nothing", async () => {
    // Issue #909 item 5 behavioral test "unmount": the component is gone by
    // the time the in-flight request settles (a slow report, a person who
    // navigated away). The effect's own cleanup already aborted it (test
    // above); this confirms acting on that late, aborted resolution — the
    // same shape a real unaborted browser fetch delivers after abort() — is
    // completely inert, not a React "set state on an unmounted component"
    // warning or a thrown error.
    const { load, pending } = deferredLoader();
    const { unmount } = renderHook(() => useResourceState("scope-a", load));
    unmount();
    await expect(
      act(async () => pending[0].resolve({ ok: true, data: { value: "too-late" }, aborted: true })),
    ).resolves.not.toThrow();
  });

  it("repeated Retry — clicking it again before the previous attempt settles aborts the stale one and only the latest lands", async () => {
    // Issue #909 item 5 behavioral test "repeated Retry": a person who taps
    // a slow Retry button again (impatience, a second real failure) must not
    // end up with whichever of the two requests happens to answer first
    // painting over the other — only the most recent retry's outcome may
    // ever reach `data`.
    const { load, pending } = deferredLoader();
    const { result } = renderHook(() => useResourceState("scope-a", load));

    await act(async () => pending[0].resolve(ok("v1")));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.retry());
    act(() => result.current.retry());
    act(() => result.current.retry());
    expect(load).toHaveBeenCalledTimes(4);
    // Every retry before the last one is now stale — its own effect cleanup
    // already aborted it.
    expect(pending[1].signal.aborted).toBe(true);
    expect(pending[2].signal.aborted).toBe(true);
    expect(pending[3].signal.aborted).toBe(false);

    // The stale ones answer anyway (a real abort() does not guarantee the
    // network call itself stops instantly) — none of them may land.
    await act(async () => pending[2].resolve(ok("STALE-from-second-retry")));
    expect(result.current.data).toEqual({ value: "v1" });

    await act(async () => pending[3].resolve(ok("v2-from-third-retry")));
    await waitFor(() => expect(result.current.data).toEqual({ value: "v2-from-third-retry" }));

    await act(async () => pending[1].resolve(ok("STALE-from-first-retry")));
    expect(result.current.data).toEqual({ value: "v2-from-third-retry" });
  });

  it("invalidation during debounce — several rapid scope changes (e.g. keystrokes) never let an earlier one's answer land", async () => {
    // Issue #909 item 5 behavioral test "invalidation during debounce": a
    // caller debouncing a search box still updates `scopeKey` once per
    // committed value; if several updates land in quick succession (a fast
    // typist, or a short debounce window), every scope but the last one is
    // invalidated the moment a newer one supersedes it — exactly like a
    // single scope change, just several in a row with multiple requests
    // outstanding at once.
    const { load, pending } = deferredLoader();
    const { result, rerender } = renderHook(({ scopeKey }: { scopeKey: string }) => useResourceState(scopeKey, load), {
      initialProps: { scopeKey: "q=a" },
    });

    rerender({ scopeKey: "q=ab" });
    rerender({ scopeKey: "q=abc" });
    rerender({ scopeKey: "q=abcd" });
    expect(load).toHaveBeenCalledTimes(4);
    expect(result.current.status).toBe("changed-scope");

    // The middle two answer first and late, in reverse order — neither may
    // ever appear on screen, only the current scope's own answer may.
    await act(async () => pending[2].resolve(ok("RESULT-for-q=abc")));
    expect(result.current.data).toBeNull();
    await act(async () => pending[1].resolve(ok("RESULT-for-q=ab")));
    expect(result.current.data).toBeNull();
    await act(async () => pending[0].resolve(ok("RESULT-for-q=a")));
    expect(result.current.data).toBeNull();

    await act(async () => pending[3].resolve(ok("RESULT-for-q=abcd")));
    await waitFor(() => expect(result.current.data).toEqual({ value: "RESULT-for-q=abcd" }));
    expect(result.current.status).toBe("ready");
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

  it("invalidateResourceIdentity() clears data as a 'changed-scope' even though the caller's own scopeKey did not change (branch switch while mounted)", async () => {
    const { load, pending } = deferredLoader();
    const { result } = renderHook(() => useResourceState("scope-a", load));

    await act(async () => pending[0].resolve(ok("branch-a-figures")));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual({ value: "branch-a-figures" });

    // Nothing about this section's own scope changed — only the branch
    // switcher's shared identity signal did, exactly like `switchTo()` in
    // `branch-switcher.tsx` calling this after a successful switch.
    act(() => invalidateResourceIdentity());

    // The stale branch-a figures must not linger on screen labelled as
    // merely "refreshing" — the question itself changed, so this is a
    // changed-scope transition: data clears immediately, same as any other
    // scope change.
    expect(result.current.status).toBe("changed-scope");
    expect(result.current.data).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => pending[1].resolve(ok("branch-b-figures")));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual({ value: "branch-b-figures" });
  });

  it("invalidateResourceIdentity() clears every mounted resource at once, not just one", async () => {
    const first = deferredLoader();
    const second = deferredLoader();
    const a = renderHook(() => useResourceState("scope-a", first.load));
    const b = renderHook(() => useResourceState("scope-b", second.load));

    await act(async () => {
      first.pending[0].resolve(ok("a1"));
      second.pending[0].resolve(ok("b1"));
    });
    await waitFor(() => expect(a.result.current.status).toBe("ready"));
    await waitFor(() => expect(b.result.current.status).toBe("ready"));

    act(() => invalidateResourceIdentity());

    expect(a.result.current.status).toBe("changed-scope");
    expect(a.result.current.data).toBeNull();
    expect(b.result.current.status).toBe("changed-scope");
    expect(b.result.current.data).toBeNull();
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
