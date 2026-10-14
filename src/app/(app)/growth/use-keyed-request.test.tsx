// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/dashboard/ui", () => ({ api: apiMock }));

import { useKeyedRequest } from "./use-keyed-request";

type Reply = { ok: boolean; status: number; data: Record<string, unknown>; aborted: boolean };

interface Pending {
  url: string;
  signal: AbortSignal | undefined;
  resolve: (reply: Reply) => void;
}

let pending: Pending[];

function ok(data: Record<string, unknown>): Reply {
  return { ok: true, status: 200, data, aborted: false };
}

function fail(error: string): Reply {
  return { ok: false, status: 500, data: { error }, aborted: false };
}

const describeError = (code: string | undefined) => `خطا: ${code ?? "نامشخص"}`;

beforeEach(() => {
  pending = [];
  apiMock.mockReset();
  apiMock.mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
    return new Promise<Reply>((resolve) => {
      pending.push({ url, signal: init?.signal, resolve });
    });
  });
});

afterEach(() => {
  cleanup();
});

function requestFor(url: string) {
  return pending.find((p) => p.url === url);
}

describe("useKeyedRequest", () => {
  it("is idle and makes no request when nothing is selected", () => {
    const { result } = renderHook(() => useKeyedRequest<{ x: number }>(null, describeError));
    expect(result.current.status).toBe("idle");
    expect(result.current.data).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("reports loading while the request is in flight, then the data", async () => {
    const { result } = renderHook(() => useKeyedRequest<{ x: number }>("/a", describeError));
    expect(result.current.status).toBe("loading");
    expect(result.current.data).toBeNull();

    await act(async () => requestFor("/a")!.resolve(ok({ x: 1 })));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual({ x: 1 });
    expect(result.current.error).toBe("");
  });

  it("A-then-B: a late response for the first seller never overwrites the second", async () => {
    const { result, rerender } = renderHook(({ url }: { url: string }) => useKeyedRequest<{ who: string }>(url, describeError), {
      initialProps: { url: "/statement?employeeId=A" },
    });
    rerender({ url: "/statement?employeeId=B" });

    // B answers first, then A's stale answer arrives.
    await act(async () => requestFor("/statement?employeeId=B")!.resolve(ok({ who: "B" })));
    await act(async () => requestFor("/statement?employeeId=A")!.resolve(ok({ who: "A" })));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual({ who: "B" });
  });

  it("aborts the superseded request when the selection changes", async () => {
    const { rerender } = renderHook(({ url }: { url: string }) => useKeyedRequest(url, describeError), {
      initialProps: { url: "/runs?offset=0" },
    });
    const first = requestFor("/runs?offset=0")!;
    expect(first.signal?.aborted).toBe(false);

    rerender({ url: "/runs?offset=50" });
    expect(first.signal?.aborted).toBe(true);
  });

  it("does not show a previous selection's data while the next one loads", async () => {
    const { result, rerender } = renderHook(({ url }: { url: string }) => useKeyedRequest<{ who: string }>(url, describeError), {
      initialProps: { url: "/statement?employeeId=A" },
    });
    await act(async () => requestFor("/statement?employeeId=A")!.resolve(ok({ who: "A" })));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ url: "/statement?employeeId=B" });
    expect(result.current.status).toBe("loading");
    expect(result.current.data).toBeNull();
  });

  it("returns to idle without a stale result when the selection is cleared", async () => {
    const { result, rerender } = renderHook(({ url }: { url: string | null }) => useKeyedRequest<{ who: string }>(url, describeError), {
      initialProps: { url: "/statement?employeeId=A" as string | null },
    });
    rerender({ url: null });
    expect(result.current.status).toBe("idle");
    expect(result.current.data).toBeNull();
    // A late answer for the cleared selection is dropped.
    await act(async () => requestFor("/statement?employeeId=A")!.resolve(ok({ who: "A" })));
    expect(result.current.status).toBe("idle");
    expect(result.current.data).toBeNull();
  });

  it("maps a server error to a message and retries with a fresh request", async () => {
    const { result } = renderHook(() => useKeyedRequest<{ x: number }>("/a", describeError));
    await act(async () => requestFor("/a")!.resolve(fail("db_down")));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("خطا: db_down");
    expect(result.current.data).toBeNull();

    act(() => result.current.retry());
    expect(result.current.status).toBe("loading");
    expect(pending.filter((p) => p.url === "/a")).toHaveLength(2);

    const retried = pending.filter((p) => p.url === "/a")[1];
    await act(async () => retried.resolve(ok({ x: 7 })));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual({ x: 7 });
    expect(result.current.error).toBe("");
  });

  it("ignores a response that was aborted rather than failing", async () => {
    const { result } = renderHook(() => useKeyedRequest<{ x: number }>("/a", describeError));
    await act(async () => requestFor("/a")!.resolve({ ok: false, status: 0, data: {}, aborted: true }));
    expect(result.current.status).toBe("loading");
    expect(result.current.error).toBe("");
  });
});
