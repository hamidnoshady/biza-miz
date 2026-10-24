import { describe, it, expect, vi, afterEach } from "vitest";
import { platformFetch, withParams } from "./platform-client";
import { exportClientErrorLog } from "./error-report";

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

describe("withParams", () => {
  it("appends params and drops nullish/blank values", () => {
    expect(withParams("/x", { a: 1, b: "", c: null, d: undefined, e: "y" })).toBe("/x?a=1&e=y");
  });

  it("returns the url unchanged with no params", () => {
    expect(withParams("/x")).toBe("/x");
  });

  it("respects an existing query string", () => {
    expect(withParams("/x?p=1", { q: 2 })).toBe("/x?p=1&q=2");
  });
});

describe("platformFetch", () => {
  it("returns a typed success envelope for 2xx JSON", async () => {
    mockFetch(() => new Response(JSON.stringify({ hello: "world" }), { status: 200 }));
    const res = await platformFetch<{ hello: string }>("/api/platform/x");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.hello).toBe("world");
  });

  it("treats 204 as success with no data", async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    const res = await platformFetch("/api/platform/x", { method: "DELETE" });
    expect(res.ok).toBe(true);
  });

  it("maps a body error code through the envelope", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "subdomain_taken" }), { status: 409 }));
    const res = await platformFetch("/api/platform/x", { method: "POST", body: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("subdomain_taken");
      expect(res.status).toBe(409);
    }
  });

  it("synthesizes a status code when the body has none", async () => {
    mockFetch(() => new Response(JSON.stringify({}), { status: 403 }));
    const res = await platformFetch("/api/platform/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("forbidden");
  });

  it("carries field validation errors", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "validation_error", fields: { name: "الزامی" } }), {
          status: 422,
        }),
    );
    const res = await platformFetch("/api/platform/x", { method: "POST", body: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fields?.name).toBe("الزامی");
  });

  it("keeps the rest of an error body (message/reference/steps) for diagnostics", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "storage_credentials_rejected",
            message: "سرویس ذخیره‌سازی ابری کلید دسترسی را نپذیرفت.",
            reference: "media-ref-7",
            steps: [{ id: "buffered_write", ok: false }],
          }),
          { status: 502 },
        ),
    );
    const res = await platformFetch("/api/platform/media/test", { method: "POST", body: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("storage_credentials_rejected");
      expect(res.body?.reference).toBe("media-ref-7");
      expect(res.body?.message).toContain("کلید دسترسی");
      expect(Array.isArray(res.body?.steps)).toBe(true);
    }
  });

  it("returns network_error when fetch throws", async () => {
    mockFetch(() => {
      throw new TypeError("boom");
    });
    const res = await platformFetch("/api/platform/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("network_error");
  });

  it("returns request_cancelled on abort", async () => {
    mockFetch(() => {
      throw new DOMException("aborted", "AbortError");
    });
    const res = await platformFetch("/api/platform/x");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("request_cancelled");
      expect(res.cancelled).toBe(true);
    }
  });

  it("returns parse_error for a 200 with invalid JSON", async () => {
    mockFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const res = await platformFetch("/api/platform/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("parse_error");
  });

  it("serializes a JSON body and sets the content-type", async () => {
    const spy = vi.fn((_url: string, _init?: RequestInit) => new Response(JSON.stringify({}), { status: 200 }));
    mockFetch(spy as unknown as typeof fetch);
    await platformFetch("/api/platform/x", { method: "POST", body: { a: 1 } });
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  // Section 12 follow-up (error-report.ts): a server-side (5xx) or transport
  // failure is logged into the same exportable client-error ring buffer a
  // render error uses — a browser-facing `window` is stubbed here since this
  // suite otherwise runs under vitest's node environment.
  describe("logs notable failures for the audit's Logs export (error-report.ts)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("records a 5xx server error", async () => {
      const storage = fakeStorage();
      vi.stubGlobal("window", { localStorage: storage });
      mockFetch(() => new Response(JSON.stringify({ error: "server_error" }), { status: 500 }));
      await platformFetch("/api/platform/x");
      expect(exportClientErrorLog(storage)).toContain("HTTP 500");
    });

    it("records a transport (network) failure", async () => {
      const storage = fakeStorage();
      vi.stubGlobal("window", { localStorage: storage });
      mockFetch(() => {
        throw new TypeError("boom");
      });
      await platformFetch("/api/platform/x");
      expect(exportClientErrorLog(storage)).toContain("(no response)");
    });

    it("does not record an ordinary 4xx rejection", async () => {
      const storage = fakeStorage();
      vi.stubGlobal("window", { localStorage: storage });
      mockFetch(() => new Response(JSON.stringify({ error: "subdomain_taken" }), { status: 409 }));
      await platformFetch("/api/platform/x", { method: "POST", body: {} });
      expect(exportClientErrorLog(storage)).toBe("");
    });

    it("does not record a caller-driven abort", async () => {
      const storage = fakeStorage();
      vi.stubGlobal("window", { localStorage: storage });
      mockFetch(() => {
        throw new DOMException("aborted", "AbortError");
      });
      await platformFetch("/api/platform/x");
      expect(exportClientErrorLog(storage)).toBe("");
    });
  });
});
