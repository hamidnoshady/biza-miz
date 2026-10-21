// @vitest-environment jsdom

/**
 * Issue #909 — `api()`'s two confirmed defects: a 200 whose body cannot
 * actually be read was treated as success, and there was no read deadline at
 * all, so a stalled connection left every caller's loading state spinning
 * forever with nothing to retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportClientErrorLog } from "@/lib/error-report";
import { routeTimingSummary } from "@/lib/route-instrumentation";
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

  /**
   * Issue #909 §13 — a mutation must not be cut off by `api()`'s own
   * deadline: aborting the client's connection does not stop the server
   * from finishing the write, so a slow-but-succeeding POST would otherwise
   * be reported to the user as a failure while it actually lands — the
   * exact ambiguous state that invites a dangerous duplicate retry of a
   * financial mutation.
   */
  it("never times out a mutation by default, even past the ordinary read deadline", async () => {
    let settle: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            settle = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
          }),
      ),
    );
    const pending = api("/api/x", { method: "POST", body: JSON.stringify({}) });
    // Well past the default 60s read deadline — a GET would have failed by now.
    await vi.advanceTimersByTimeAsync(120_000);
    settle();
    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it("does not time out a GET marked as a streaming call, even past the ordinary deadline", async () => {
    let settle: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            settle = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
          }),
      ),
    );
    const pending = api("/api/x", { stream: true });
    await vi.advanceTimersByTimeAsync(120_000);
    settle();
    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it("an explicit timeoutMs still applies to a mutation when the caller asks for one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    );
    const pending = api("/api/x", { method: "POST", timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect((result.data as { error?: string }).error).toBe("timeout");
  });

  it("fires onSlow once, at ~5s, independent of the 60s deadline — and not for a fast request", async () => {
    let settle: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            settle = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
          }),
      ),
    );
    const onSlow = vi.fn();
    const pending = api("/api/x", { onSlow });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(onSlow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSlow).toHaveBeenCalledTimes(1);
    settle();
    await pending;
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it("never fires onSlow for a request that settles before 5s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const onSlow = vi.fn();
    await api("/api/x", { onSlow });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onSlow).not.toHaveBeenCalled();
  });
});

describe("api() — 401/403 classification (issue #909)", () => {
  it("fills in 'unauthorized' for a 401 whose body carries no error code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 401 })));
    const result = await api("/api/x");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect((result.data as { error?: string }).error).toBe("unauthorized");
  });

  it("fills in 'forbidden' for a 403 with an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    const result = await api("/api/x");
    expect((result.data as { error?: string }).error).toBe("forbidden");
  });

  it("never overwrites a server's own, more specific 401/403 code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "session_expired" }), { status: 401 })),
    );
    const result = await api("/api/x");
    expect((result.data as { error?: string }).error).toBe("session_expired");
  });

  it("classifies even a malformed (non-JSON) 401 body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Unauthorized</html>", { status: 401 })));
    const result = await api("/api/x");
    expect((result.data as { error?: string }).error).toBe("unauthorized");
  });

  it("does not classify a 2xx or an unrelated 4xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 404 })));
    const result = await api("/api/x");
    expect((result.data as { error?: string }).error).toBeUndefined();
  });
});

describe("api() — redacted route-family timing instrumentation (issue #909)", () => {
  it("records a 'settled' sample keyed by route family, not the raw URL — on success", async () => {
    const storage = fakeLocalStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(JSON.stringify({ ok: true }))));
    await api("/api/ledger/expenses/42");

    const rows = routeTimingSummary(storage);
    const row = rows.find((r) => r.family === "/api/ledger/expenses/:id" && r.stage === "settled");
    expect(row).toBeDefined();
    expect(row?.outcomes).toEqual({ ok: 1 });
  });

  it("records outcome 'http_error' for a non-2xx response, and 'network_error' for a dropped connection", async () => {
    const storage = fakeLocalStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(JSON.stringify({ error: "server_error" }), { status: 500 })));
    await api("/api/ledger/reconciliation");
    expect(routeTimingSummary(storage).find((r) => r.family === "/api/ledger/reconciliation")?.outcomes).toEqual({
      http_error: 1,
    });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await api("/api/ledger/payroll/staff");
    expect(routeTimingSummary(storage).find((r) => r.family === "/api/ledger/payroll/staff")?.outcomes).toEqual({
      network_error: 1,
    });
  });

  it("records outcome 'aborted' for a caller-cancelled request, distinct from a real failure", async () => {
    const storage = fakeLocalStorage();
    vi.stubGlobal("localStorage", storage);
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((_, reject) => {
            controller.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    );
    const pending = api("/api/ledger/inventory", { signal: controller.signal });
    controller.abort();
    await pending;
    expect(routeTimingSummary(storage).find((r) => r.family === "/api/ledger/inventory")?.outcomes).toEqual({
      aborted: 1,
    });
  });

  it("records outcome 'timeout' when the read deadline fires", async () => {
    vi.useFakeTimers();
    try {
      const storage = fakeLocalStorage();
      vi.stubGlobal("localStorage", storage);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
            }),
        ),
      );
      const pending = api("/api/ledger/fixed-assets", { timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      expect(routeTimingSummary(storage).find((r) => r.family === "/api/ledger/fixed-assets")?.outcomes).toEqual({
        timeout: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a 'slow' sample at ~5s for a route family, independent of whether onSlow is given", async () => {
    vi.useFakeTimers();
    try {
      const storage = fakeLocalStorage();
      vi.stubGlobal("localStorage", storage);
      let settle: () => void = () => {};
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              settle = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
            }),
        ),
      );
      const pending = api("/api/ledger/receipts");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(routeTimingSummary(storage).find((r) => r.family === "/api/ledger/receipts" && r.stage === "slow")).toBeDefined();
      settle();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("never records a 'slow'/'settled' sample for a request that never happened to touch instrumentation's storage boundary — a quick, fast success has no 'slow' row", async () => {
    const storage = fakeLocalStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(JSON.stringify({ ok: true }))));
    await api("/api/ledger/chart-of-accounts");
    expect(routeTimingSummary(storage).find((r) => r.family === "/api/ledger/chart-of-accounts" && r.stage === "slow")).toBeUndefined();
  });
});
