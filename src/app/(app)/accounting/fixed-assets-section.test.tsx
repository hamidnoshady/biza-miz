// @vitest-environment jsdom

/**
 * The capability contract (issue #833 follow-up): the section must not draw
 * live accounting controls until it AFFIRMATIVELY knows the member may use
 * them. `canManage === undefined` — permissions still loading, or unreadable —
 * renders read-only, exactly like `false`; the earlier `=== false` check drew
 * full mutation controls for the unknown state. The API stays authoritative
 * either way: this is about never offering a control that would 403 on click.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixedAssetsSection } from "./fixed-assets-section";

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
