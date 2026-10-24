// @vitest-environment jsdom

/**
 * The capability contract (issue #833 follow-up): the section must not draw
 * live accounting controls until it AFFIRMATIVELY knows the member may use
 * them. `canManage === undefined` — permissions still loading, or unreadable —
 * renders read-only, exactly like `false`; the earlier `=== false` check drew
 * full mutation controls for the unknown state. The API stays authoritative
 * either way: this is about never offering a control that would 403 on click.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixedAssetsSection, type FixedAssetRow } from "./fixed-assets-section";

afterEach(cleanup);

const EMPTY_LIST = {
  fixedAssets: [],
  hasMore: false,
  kpis: {
    count: 0,
    totalCost: 0,
    totalAccumulatedDepreciation: 0,
    totalBookValue: 0,
    activeCount: 0,
    fullyDepreciatedCount: 0,
    disposedCount: 0,
  },
  reconciliation: {
    registerCost: "0",
    ledgerCost: "0",
    costDifference: "0",
    registerAccumulated: "0",
    ledgerAccumulated: "0",
    accumulatedDifference: "0",
    unlinkedCount: 0,
    unlinkedCost: "0",
    status: "reconciled",
  },
};

function stubRegisterFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/ledger/fixed-assets?")) {
        return { ok: true, status: 200, json: async () => EMPTY_LIST };
      }
      if (url.startsWith("/api/ledger/fixed-assets/filter-options")) {
        return { ok: true, status: 200, json: async () => ({ categories: [] }) };
      }
      if (url.startsWith("/api/locations/active")) {
        return { ok: true, status: 200, json: async () => ({ locations: [] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

const READ_ONLY_NOTICE = /دسترسی فقط‌خواندنی/;
const FORM_HEADING = /ثبت دارایی ثابت جدید/;

function renderSection(canManage?: boolean) {
  return render(
    <FixedAssetsSection busy={false} refreshKey={0} canManage={canManage} accounts={[]} />,
  );
}

describe("FixedAssetsSection — capability resolution", () => {
  it("unknown capability (undefined) is read-only: no mutation controls, the notice is shown", async () => {
    stubRegisterFetch();
    renderSection(undefined);

    // The register loaded (the empty state is drawn), and with it the
    // read-only notice — but never the register form.
    expect(await screen.findByText(READ_ONLY_NOTICE)).toBeTruthy();
    expect(screen.queryByText(FORM_HEADING)).toBeNull();
  });

  it("an explicit read-only capability (false) behaves the same", async () => {
    stubRegisterFetch();
    renderSection(false);

    expect(await screen.findByText(READ_ONLY_NOTICE)).toBeTruthy();
    expect(screen.queryByText(FORM_HEADING)).toBeNull();
  });

  it("an affirmed capability (true) draws the mutation controls and no notice", async () => {
    stubRegisterFetch();
    renderSection(true);

    expect(await screen.findByText(FORM_HEADING)).toBeTruthy();
    expect(screen.queryByText(READ_ONLY_NOTICE)).toBeNull();
  });
});

function assetRow(overrides: Partial<FixedAssetRow> = {}): FixedAssetRow {
  return {
    id: "fa-1",
    code: "FA-0001",
    name: "یخچال فروشگاهی",
    acquisitionDate: "2026-01-01",
    cost: 100_000_000,
    salvageValue: 0,
    usefulLifeMonths: 60,
    accumulatedDepreciation: 0,
    bookValue: 100_000_000,
    createdAt: "2026-01-01 10:00:00+00",
    status: "active",
    ...overrides,
  };
}

function listPayload(fixedAssets: FixedAssetRow[] = []) {
  return {
    fixedAssets,
    hasMore: false,
    kpis: {
      count: fixedAssets.length,
      totalCost: 0,
      totalAccumulatedDepreciation: 0,
      totalBookValue: 0,
      activeCount: fixedAssets.length,
      fullyDepreciatedCount: 0,
      disposedCount: 0,
    },
    reconciliation: {
      registerCost: "0",
      ledgerCost: "0",
      costDifference: "0",
      registerAccumulated: "0",
      ledgerAccumulated: "0",
      accumulatedDifference: "0",
      unlinkedCount: 0,
      unlinkedCost: "0",
      status: "reconciled",
    },
  };
}

/**
 * Issue #909 item 4 — `refreshKey` arrives as an external prop here (the
 * page's shared refresh button): a bump must refetch the same scope without
 * ever blanking the register (and its KPIs/reconciliation) already on
 * screen, and a refresh that itself fails must leave those rows alone.
 */
describe("FixedAssetsSection — a same-scope refresh (issue #909 item 4)", () => {
  function stubOtherRoutes() {
    return {
      "/api/ledger/fixed-assets/filter-options": () => ({ ok: true, status: 200, json: async () => ({ categories: [] }) }),
      "/api/locations/active": () => ({ ok: true, status: 200, json: async () => ({ locations: [] }) }),
    };
  }

  it("keeps the register on screen while `refreshKey` refetches the same scope, never flashing a skeleton", async () => {
    let call = 0;
    const routes = stubOtherRoutes();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/ledger/fixed-assets?")) {
          call += 1;
          return { ok: true, status: 200, json: async () => listPayload([assetRow()]) };
        }
        for (const [prefix, handler] of Object.entries(routes)) {
          if (url.startsWith(prefix)) return handler();
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const view = render(<FixedAssetsSection busy={false} refreshKey={0} canManage accounts={[]} />);
    await screen.findAllByText("یخچال فروشگاهی");

    view.rerender(<FixedAssetsSection busy={false} refreshKey={1} canManage accounts={[]} />);
    // The row stays mounted through the refetch — no skeleton, no gap.
    expect(screen.getAllByText("یخچال فروشگاهی").length).toBeGreaterThan(0);
    await waitFor(() => expect(call).toBe(2));
    expect(screen.getAllByText("یخچال فروشگاهی").length).toBeGreaterThan(0);
  });

  it("keeps the stale register when a same-scope refresh itself fails, and still names the failure", async () => {
    let call = 0;
    const routes = stubOtherRoutes();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/ledger/fixed-assets?")) {
          call += 1;
          if (call === 1) return { ok: true, status: 200, json: async () => listPayload([assetRow()]) };
          return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
        }
        for (const [prefix, handler] of Object.entries(routes)) {
          if (url.startsWith(prefix)) return handler();
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const view = render(<FixedAssetsSection busy={false} refreshKey={0} canManage accounts={[]} />);
    await screen.findAllByText("یخچال فروشگاهی");

    view.rerender(<FixedAssetsSection busy={false} refreshKey={1} canManage accounts={[]} />);
    await screen.findByText("بارگذاری فهرست دارایی‌های ثابت ناموفق بود.");
    // Still there — a failed background refresh does not erase a good register.
    expect(screen.getAllByText("یخچال فروشگاهی").length).toBeGreaterThan(0);
  });

  it("names the very first load as slow after ~5s, and stops once it settles", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: unknown) => void;
      const deferred = new Promise((r) => {
        resolve = r;
      });
      const routes = stubOtherRoutes();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.startsWith("/api/ledger/fixed-assets?")) return deferred;
          for (const [prefix, handler] of Object.entries(routes)) {
            if (url.startsWith(prefix)) return handler();
          }
          throw new Error(`unexpected fetch ${url}`);
        }),
      );
      render(<FixedAssetsSection busy={false} refreshKey={0} canManage accounts={[]} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole("status", { name: "بارگذاری دارایی‌های ثابت کمی طول کشیده…" })).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByRole("status", { name: "بارگذاری دارایی‌های ثابت کمی طول کشیده…" })).toBeTruthy();

      resolve({ ok: true, status: 200, json: async () => listPayload([assetRow()]) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole("status", { name: "بارگذاری دارایی‌های ثابت کمی طول کشیده…" })).toBeNull();
      expect(screen.getAllByText("یخچال فروشگاهی").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
