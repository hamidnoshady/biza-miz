import { afterEach, describe, expect, it, vi } from "vitest";
import { api, SETUP_REQUEST_TIMEOUT_MS } from "./ui";
import { exportClientErrorLog } from "@/lib/error-report";

/**
 * Section 12 follow-up (see error-report.ts's module doc and
 * src/app/dashboard/api-error-logging.test.ts for the same coverage on the
 * dashboard's wrapper): the first-run setup wizard's shared `api()` fetch
 * wrapper also logs a server-side (5xx) failure into the same exportable
 * client-error ring buffer, with no change to the returned result.
 */

function fakeStorage(): Storage {
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

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl as typeof fetch));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("setup wizard api() error logging", () => {
  it("logs a 5xx server error without changing the returned result", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => new Response(JSON.stringify({ error: "server_error" }), { status: 500 }));
    const result = await api("/api/setup/bootstrap", { method: "POST" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(exportClientErrorLog(storage)).toContain("HTTP 500");
  });

  it("does not log an ordinary validation rejection (400)", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => new Response(JSON.stringify({ error: "missing_fields" }), { status: 400 }));
    await api("/api/setup/bootstrap", { method: "POST" });
    expect(exportClientErrorLog(storage)).toBe("");
  });

  it("does not log a normal 2xx success", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await api("/api/setup/state");
    expect(exportClientErrorLog(storage)).toBe("");
  });

  /**
   * Issue #808 §5: a rejected fetch (offline desktop, hybrid link down,
   * dropped connection) is a first-class failure, not an exception that
   * escapes a form handler. It is normalised to status 0 — the shape the
   * error-report layer already understands — and logged like a 5xx.
   */
  it("normalises a transport failure to status 0 instead of throwing", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    const result = await api<{ error?: string }>("/api/setup/progress", { method: "POST" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.data.error).toBe("network_error");
    expect(exportClientErrorLog(storage)).toContain("HTTP (no response)");
  });

  /**
   * Issue #808 §5, the "timeout" half: a request that is accepted by the
   * network stack and then never answered — the classic shape when a desktop
   * install's backend has died but the socket is still open, or a hybrid link
   * points at a host that stopped replying — must resolve as a failure after a
   * bounded wait. Otherwise `await api(...)` never returns and the form sits on
   * "busy" for ever, which is exactly the stuck form the audit reported.
   */
  it("aborts a request that never answers and reports it as a transport failure", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    // The mock only settles when the signal the wrapper passed is aborted —
    // i.e. the result below can only come from the wrapper's own timeout.
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.useFakeTimers();
    try {
      const pending = api<{ error?: string }>("/api/setup/state");
      await vi.advanceTimersByTimeAsync(SETUP_REQUEST_TIMEOUT_MS + 1);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.status).toBe(0);
      expect(result.data.error).toBe("network_error");
      expect(exportClientErrorLog(storage)).toContain("HTTP (no response)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout once a response arrives, so a slow-but-fine step is never aborted later", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.useFakeTimers();
    try {
      const result = await api("/api/setup/state");
      expect(result.ok).toBe(true);
      // The pending timeout is gone: advancing past it mocks nothing and logs
      // nothing, so the abort cannot fire against an already-finished call.
      await vi.advanceTimersByTimeAsync(SETUP_REQUEST_TIMEOUT_MS * 2);
      expect(exportClientErrorLog(storage)).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not log an ordinary validation rejection (400) even when Promise-shaped", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mockFetch(async () => new Response(JSON.stringify({ error: "missing_fields" }), { status: 400 }));
    const result = await api("/api/setup/business", { method: "POST" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(exportClientErrorLog(storage)).toBe("");
  });
});
