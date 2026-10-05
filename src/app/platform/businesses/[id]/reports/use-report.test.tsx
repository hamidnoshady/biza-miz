/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useReport } from "./use-report";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("report request ownership", () => {
  it("aborts stale reads and never paints an old business/filter under a new selection", async () => {
    const pending: { resolve: (r: unknown) => void; signal: AbortSignal }[] = [];
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((resolve) => pending.push({ resolve, signal: options.signal }))));
    const hook = renderHook(({ url }) => useReport<{ total: number }>(url), { initialProps: { url: "/platform/a" } });
    hook.rerender({ url: "/platform/b" });
    expect(pending[0].signal.aborted).toBe(true);
    await act(async () => pending[1].resolve({ ok: true, json: async () => ({ total: 100 }) }));
    await waitFor(() => expect(hook.result.current.data?.total).toBe(100));
    await act(async () => pending[0].resolve({ ok: true, json: async () => ({ total: 10 }) }));
    expect(hook.result.current.data?.total).toBe(100);
  });
});
