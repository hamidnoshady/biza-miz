// @vitest-environment jsdom

/**
 * Issue #909 — `api()`'s two confirmed defects: a 200 whose body cannot
 * actually be read was treated as success, and there was no read deadline at
 * all, so a stalled connection left every caller's loading state spinning
 * forever with nothing to retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportClientErrorLog } from "@/lib/error-report";
import { api, errorMessage } from "./ui";

function fakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function textResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("api() — ordinary success and failure shapes (unchanged contract)", () => {
  it("parses a normal JSON 200 as ok:true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(JSON.stringify({ hello: "world" }))));
    const result = await api<{ hello: string }>("/api/x");
    expect(result).toEqual({ ok: true, status: 200, data: { hello: "world" }, aborted: false });
  });

  it("treats a genuinely empty body (e.g. a 204) as ok:true with {} — not malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const result = await api("/api/x", { method: "DELETE" });
    expect(result).toEqual({ ok: true, status: 204, data: {}, aborted: false });
  });

  it("reports a 4xx JSON error body as ok:false with the server's code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(JSON.stringify({ error: "missing_fields" }), { status: 400 })));
    const result = await api("/api/x", { method: "POST" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect((result.data as { error?: string }).error).toBe("missing_fields");
  });

  it("normalises a rejected fetch (dropped connection) to a network_error, never throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const result = await api("/api/x");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect((result.data as { error?: string }).error).toBe("network_error");
    expect(errorMessage((result.data as { error?: string }).error)).toContain("اینترنت");
  });

  it("reports a caller-driven cancellation as aborted:true, with no error message", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    );
    const pending = api("/api/x", { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result).toEqual({ ok: false, status: 0, data: {}, aborted: true });
  });

  it("logs a 5xx to the exportable error log (issue #824/#909 contract, unchanged)", async () => {
    const storage = fakeLocalStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(JSON.stringify({ error: "server_error" }), { status: 500 })));
    await api("/api/x");
    expect(exportClientErrorLog(storage)).toContain("HTTP 500");
  });
});

describe("api() — malformed-200 detection (issue #909)", () => {
  it("treats a non-empty, non-JSON 2xx body as a failure instead of silent ok:true", async () => {
    const storage = fakeLocalStorage();
    vi.stubGlobal("localStorage", storage);
    // A reverse proxy's HTML error page, served with a 200 it never should
    // have used, or a body truncated mid-stream after headers already said OK.
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("<html>not json</html>", { status: 200 })));
    const result = await api("/api/x");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.aborted).toBe(false);
    expect((result.data as { error?: string }).error).toBe("malformed_response");
    expect(errorMessage("malformed_response")).toContain("قابل خواندن نبود");
    // Forced into the technical log even though a bare 200 is not
    // `isNotableApiFailure` on its own — the caller already knows this one
    // matters.
    expect(exportClientErrorLog(storage)).toContain("malformed_response");
  });
});

describe("api() — read deadline (issue #909)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("gives up on a request that never answers, instead of hanging forever", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            // A real fetch() rejects with AbortError once its signal fires —
            // this stand-in does the same, the way the browser's own
            // implementation would when api()'s internal deadline aborts it.
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    );
    const pending = api("/api/x", { timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    // Not a deliberate cancellation — a Retry button should offer another try.
    expect(result.aborted).toBe(false);
    expect((result.data as { error?: string }).error).toBe("timeout");
  });

  it("still reports a caller's own cancellation as aborted, not as a timeout, when both are armed", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    );
    const pending = api("/api/x", { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();
    const result = await pending;
    expect(result).toEqual({ ok: false, status: 0, data: {}, aborted: true });
  });
});
