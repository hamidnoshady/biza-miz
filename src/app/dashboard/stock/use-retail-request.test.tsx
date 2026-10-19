/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../ui";
import { useRetailRequest } from "./use-retail-request";

vi.mock("../ui", () => ({ api: vi.fn() }));
const response = (ok: boolean, status: number, data: object) => ({ ok, status, data, aborted: false });
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe("retail mutation identities (#915)", () => {
  it.each(["purchase", "supplier_return"] as const)("%s: lost response, remount and reconnect reuse the exact original snapshot", async operation => {
    vi.mocked(api).mockResolvedValueOnce(response(false, 0, { error: "network_error" }));
    const first = renderHook(() => useRetailRequest<{ quantity: string }>("business:member:branch", operation));
    await act(async () => { await first.result.current.submit({ quantity: "2" }); });
    const sent = JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string);
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    first.unmount();
    const retry = renderHook(() => useRetailRequest<{ quantity: string }>("business:member:branch", operation));
    expect(retry.result.current.pending?.payload).toEqual({ quantity: "2" });
    vi.mocked(api).mockResolvedValueOnce(response(true, 200, { ok: true }));
    await act(async () => { await retry.result.current.submit({ quantity: "999" }); });
    expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)).toEqual(sent);
    expect(retry.result.current.pending).toBeNull();
    expect(localStorage.length).toBe(0);
    retry.unmount();
  });

  it("guards same-tick repeat taps before React's disabled button updates", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise(r => { resolve = r; }) as never);
    const { result, unmount } = renderHook(() => useRetailRequest("scope", "purchase"));
    await act(async () => {
      const first = result.current.submit({ quantity: "2" });
      await result.current.submit({ quantity: "2" });
      expect(api).toHaveBeenCalledTimes(1);
      resolve(response(true, 200, { ok: true }));
      await first;
    });
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("does not consider truncated or malformed 200 JSON a resolved purchase", async () => {
    vi.mocked(api).mockResolvedValueOnce(response(true, 200, {}));
    const { result, unmount } = renderHook(() => useRetailRequest("scope", "purchase"));
    await act(async () => { await result.current.submit({ quantity: "2" }); });
    expect(result.current.pending).not.toBeNull();
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("allows correcting a resolved validation rejection, but retains conflict identity", async () => {
    vi.mocked(api).mockResolvedValueOnce(response(false, 400, { error: "invalid_quantity" }));
    const { result, unmount } = renderHook(() => useRetailRequest("scope", "purchase"));
    await act(async () => { await result.current.submit({ quantity: "0" }); });
    expect(result.current.pending).toBeNull();
    vi.mocked(api).mockResolvedValueOnce(response(false, 409, { error: "idempotency_conflict" }));
    await act(async () => { await result.current.submit({ quantity: "2" }); });
    expect(result.current.pending).not.toBeNull();
    const [a, b] = vi.mocked(api).mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    unmount();
  });

  it("never retries another business, member or branch's stored request", async () => {
    vi.mocked(api).mockResolvedValue(response(false, 0, {}));
    const first = renderHook(() => useRetailRequest("business:member:branchA", "purchase"));
    await act(async () => { await first.result.current.submit({ quantity: "2" }); });
    first.unmount();
    const other = renderHook(() => useRetailRequest("business:member:branchB", "purchase"));
    expect(other.result.current.pending).toBeNull();
    await act(async () => { await other.result.current.submit({ quantity: "3" }); });
    const [a, b] = vi.mocked(api).mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    other.unmount();
  });
});
