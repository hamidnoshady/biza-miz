/**
 * Issue #909 — "Add redacted timing and error instrumentation by route
 * family and stage": `routeFamily()` must never leak an id/query string, and
 * `recordRouteStage`/`routeTimingSummary` must aggregate by family+stage
 * rather than growing an unbounded list of raw, potentially identifying URLs.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRouteTimingReport,
  recordRouteStage,
  resetRouteTimingMetrics,
  routeFamily,
  routeTimingSummary,
  statusBucket,
} from "./route-instrumentation";

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

afterEach(() => {
  resetRouteTimingMetrics();
});

describe("routeFamily — collapses an id-bearing URL to a redacted family", () => {
  it("collapses a numeric id segment", () => {
    expect(routeFamily("/api/ledger/expenses/4821")).toBe("/api/ledger/expenses/:id");
    expect(routeFamily("/api/ledger/expenses/9")).toBe("/api/ledger/expenses/:id");
  });

  it("collapses a UUID segment", () => {
    expect(routeFamily("/api/ledger/fixed-assets/9fcf1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(
      "/api/ledger/fixed-assets/:id",
    );
  });

  it("collapses a long opaque token (e.g. a cuid/nanoid) that mixes letters and digits", () => {
    expect(routeFamily("/api/ledger/receipts/ckv9n3x7g0001ab12cd34ef56")).toBe("/api/ledger/receipts/:id");
  });

  it("never collapses an ordinary route word, even a long one", () => {
    expect(routeFamily("/api/ledger/reconciliation")).toBe("/api/ledger/reconciliation");
    expect(routeFamily("/api/ledger/chart-of-accounts")).toBe("/api/ledger/chart-of-accounts");
  });

  it("drops the query string entirely, regardless of what it contains", () => {
    expect(routeFamily("/api/ledger/parties?search=فاطمه&email=foo@bar.com&token=abc123")).toBe(
      "/api/ledger/parties",
    );
  });

  it("two different ids on the same route resolve to the exact same family", () => {
    expect(routeFamily("/api/ledger/payroll/staff/111")).toBe(routeFamily("/api/ledger/payroll/staff/999"));
  });

  it("handles an absolute URL the same as a relative path", () => {
    expect(routeFamily("https://app.example.com/api/ledger/accounts/42?all=1")).toBe("/api/ledger/accounts/:id");
  });
});

describe("statusBucket — a coarse bucket, never the exact status", () => {
  it("buckets by hundreds, and 0 (no response) separately", () => {
    expect(statusBucket(200)).toBe("2xx");
    expect(statusBucket(201)).toBe("2xx");
    expect(statusBucket(404)).toBe("4xx");
    expect(statusBucket(500)).toBe("5xx");
    expect(statusBucket(0)).toBe("0");
  });
});

describe("recordRouteStage / routeTimingSummary — aggregated, not raw, and bounded", () => {
  it("aggregates repeated calls to the same family+stage into one row", () => {
    const storage = fakeLocalStorage();
    recordRouteStage({ method: "GET", url: "/api/ledger/expenses/1", stage: "settled", durationMs: 100, outcome: "ok", status: 200 }, storage);
    recordRouteStage({ method: "GET", url: "/api/ledger/expenses/2", stage: "settled", durationMs: 300, outcome: "ok", status: 200 }, storage);

    const rows = routeTimingSummary(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: "GET", family: "/api/ledger/expenses/:id", stage: "settled", count: 2, avgMs: 200, maxMs: 300 });
    expect(rows[0].outcomes).toEqual({ ok: 2 });
  });

  it("keeps slow and settled samples in separate rows for the same route", () => {
    const storage = fakeLocalStorage();
    recordRouteStage({ method: "GET", url: "/api/ledger/payroll/staff", stage: "slow", durationMs: 5_000 }, storage);
    recordRouteStage({ method: "GET", url: "/api/ledger/payroll/staff", stage: "settled", durationMs: 7_000, outcome: "ok", status: 200 }, storage);

    const rows = routeTimingSummary(storage);
    expect(rows.map((r) => r.stage).sort()).toEqual(["settled", "slow"]);
    const slowRow = rows.find((r) => r.stage === "slow");
    expect(slowRow?.outcomes).toEqual({});
  });

  it("tracks outcomes separately within one family+stage", () => {
    const storage = fakeLocalStorage();
    recordRouteStage({ method: "GET", url: "/api/ledger/reconciliation", stage: "settled", durationMs: 50, outcome: "ok", status: 200 }, storage);
    recordRouteStage({ method: "GET", url: "/api/ledger/reconciliation", stage: "settled", durationMs: 60_000, outcome: "timeout", status: 0 }, storage);

    const row = routeTimingSummary(storage).find((r) => r.family === "/api/ledger/reconciliation");
    expect(row?.outcomes).toEqual({ ok: 1, timeout: 1 });
  });

  it("never records the request/response body, Persian error text, or query string anywhere in the aggregate", () => {
    const storage = fakeLocalStorage();
    recordRouteStage(
      {
        method: "POST",
        url: "/api/ledger/receipts/42?token=super-secret-value&email=someone@example.com",
        stage: "settled",
        durationMs: 120,
        outcome: "http_error",
        status: 500,
      },
      storage,
    );
    const raw = storage.getItem("pos:routeTimingMetrics") ?? "";
    expect(raw).not.toContain("super-secret-value");
    expect(raw).not.toContain("someone@example.com");
    expect(raw).not.toContain("42");
    expect(raw).toContain("/api/ledger/receipts/:id");
  });

  it("a partial multi-region failure keeps each route family's own outcomes independent", () => {
    // Issue #909 item 5 behavioral test "partial multi-region failure": a
    // dashboard page with several independently-loaded regions (e.g. one
    // widget reading /api/ledger/expenses, another /api/ledger/receipts) can
    // have one region's read fail while the others succeed. Each family's
    // aggregate must reflect only its own calls — a failing region must
    // never be folded into, or suppress, a sibling region's recorded outcome.
    const storage = fakeLocalStorage();
    recordRouteStage({ method: "GET", url: "/api/ledger/expenses/7", stage: "settled", durationMs: 80, outcome: "ok", status: 200 }, storage);
    recordRouteStage({ method: "GET", url: "/api/ledger/receipts/9", stage: "settled", durationMs: 40, outcome: "http_error", status: 500 }, storage);
    recordRouteStage({ method: "GET", url: "/api/ledger/fixed-assets/3", stage: "settled", durationMs: 60, outcome: "ok", status: 200 }, storage);

    const rows = routeTimingSummary(storage);
    const expenses = rows.find((r) => r.family === "/api/ledger/expenses/:id");
    const receipts = rows.find((r) => r.family === "/api/ledger/receipts/:id");
    const fixedAssets = rows.find((r) => r.family === "/api/ledger/fixed-assets/:id");

    expect(expenses?.outcomes).toEqual({ ok: 1 });
    expect(receipts?.outcomes).toEqual({ http_error: 1 });
    expect(fixedAssets?.outcomes).toEqual({ ok: 1 });
    // The failing region's row exists on its own — it did not merge into,
    // overwrite, or remove either succeeding region's row.
    expect(rows).toHaveLength(3);
  });

  it("is a silent no-op with no storage available — never the reason a real request fails", () => {
    expect(() => recordRouteStage({ method: "GET", url: "/x", stage: "settled", durationMs: 10, outcome: "ok" }, undefined)).not.toThrow();
  });

  it("stops tracking new distinct keys past the cap, instead of growing unbounded", () => {
    const storage = fakeLocalStorage();
    for (let i = 0; i < 305; i += 1) {
      recordRouteStage({ method: "GET", url: `/api/one-off/${i}-unique-route-name`, stage: "settled", durationMs: 10, outcome: "ok", status: 200 }, storage);
    }
    // Every one of those urls has a *different* literal path segment (not an
    // id-shaped one), so each is genuinely its own family — the cap, not
    // redaction, is what bounds this.
    expect(routeTimingSummary(storage).length).toBeLessThanOrEqual(300);
  });
});

describe("buildRouteTimingReport — the exportable text, same shape as the error log", () => {
  it("is empty when nothing has been recorded", () => {
    expect(buildRouteTimingReport(fakeLocalStorage())).toBe("");
  });

  it("renders one readable line per family+stage, with counts and an outcome breakdown", () => {
    const storage = fakeLocalStorage();
    recordRouteStage({ method: "GET", url: "/api/ledger/expenses/1", stage: "settled", durationMs: 100, outcome: "ok", status: 200 }, storage);
    recordRouteStage({ method: "GET", url: "/api/ledger/expenses/2", stage: "settled", durationMs: 300, outcome: "network_error", status: 0 }, storage);

    const report = buildRouteTimingReport(storage);
    expect(report).toContain("GET /api/ledger/expenses/:id [settled]");
    expect(report).toContain("count=2");
    expect(report).toContain("avg=200ms");
    expect(report).toContain("ok=1");
    expect(report).toContain("network_error=1");
  });
});
