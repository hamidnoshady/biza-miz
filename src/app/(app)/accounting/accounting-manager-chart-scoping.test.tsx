// @vitest-environment jsdom

/**
 * Issue #909 §13 — "AccountingManager's chart-of-accounts prerequisite
 * waterfall blocking unrelated sections."
 *
 * Before this fix, `AccountingManager` answered a section that needs the
 * chart of accounts (`manual`, `expenses`, `fixed-assets`, `shareholders`,
 * `multicurrency`, `opening-balances`) with an early `return` for the whole
 * component while the chart was loading or had failed — which replaced the
 * sub-group chip row (the only way to reach a *sibling* section, several of
 * which do not need the chart at all) and the page's own error banner, not
 * just the one section's content. A person who landed on «ثبت سند دستی»
 * while the chart was still loading could not even see — let alone click —
 * «تراز آزمایشی» or «دفتر روزنامه» next to it in the same group, and had no
 * choice but to wait out a single section's own prerequisite.
 *
 * These tests mount the real component with a chart request that never
 * resolves (and, separately, one that fails) and assert the chrome around
 * the section — the sibling chips in its sub-group — stays rendered and
 * clickable throughout, exactly as it does for a section that needs nothing.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountingManager } from "./accounting-manager";

afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push }),
  useSearchParams: () => new URLSearchParams(),
}));

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("issue #909 §13: the chart-of-accounts gate is scoped to the section, not the page", () => {
  it("keeps the sub-group's sibling chips visible and clickable while the chart is still loading", async () => {
    // The chart request never resolves in this test — the manual-entry
    // section (which needs it) must stay on its own skeleton forever, but
    // that must not take the rest of the page down with it.
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/ledger/accounts") return new Promise<Response>(() => {});
      if (String(url).startsWith("/api/ledger/entries/drafts")) {
        return okJson({ drafts: [], total: 0, hasMore: false, limit: 20, offset: 0, activeLocation: null });
      }
      return okJson({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AccountingManager
        role="owner"
        section="manual"
        permissions={["ledger.view", "ledger.propose", "ledger.approve"]}
        currentUserId="user-owner"
      />,
    );

    // Siblings in the "ledger-books" sub-group that do NOT need the chart —
    // these must be visible and clickable even though "manual" (the current
    // section, which does need it) is stuck loading.
    const trialBalanceChip = (await screen.findByRole("button", { name: "تراز آزمایشی" })) as HTMLButtonElement;
    const entriesChip = screen.getByRole("button", { name: "دفتر روزنامه" }) as HTMLButtonElement;
    expect(trialBalanceChip.disabled).toBe(false);
    expect(entriesChip.disabled).toBe(false);

    trialBalanceChip.click();
    expect(push).toHaveBeenCalledWith(expect.stringContaining("trial-balance"));
  });

  it("keeps the chrome and offers Retry, scoped to the section, when the chart load fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/ledger/accounts") {
        return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
      }
      if (String(url).startsWith("/api/ledger/entries/drafts")) {
        return okJson({ drafts: [], total: 0, hasMore: false, limit: 20, offset: 0, activeLocation: null });
      }
      return okJson({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AccountingManager
        role="owner"
        section="manual"
        permissions={["ledger.view", "ledger.propose", "ledger.approve"]}
        currentUserId="user-owner"
      />,
    );

    await waitFor(() => expect(screen.queryByRole("button", { name: "تلاش دوباره" })).not.toBeNull());

    // The sibling chips — the way out of a section whose own prerequisite
    // failed — must still be there, not swallowed by a page-wide error.
    const trialBalanceChip = screen.getByRole("button", { name: "تراز آزمایشی" }) as HTMLButtonElement;
    const entriesChip = screen.getByRole("button", { name: "دفتر روزنامه" }) as HTMLButtonElement;
    expect(trialBalanceChip.disabled).toBe(false);
    expect(entriesChip.disabled).toBe(false);
  });

  it("does not gate a sibling section that does not need the chart at all", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/ledger/accounts") return new Promise<Response>(() => {});
      return okJson({ entries: [], total: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AccountingManager
        role="owner"
        section="trial-balance"
        permissions={["ledger.view"]}
        currentUserId="user-owner"
      />,
    );

    // "trial-balance" never asks for the chart at all, so nothing here
    // should ever be stuck behind the unrelated "manual"/"expenses" chart
    // prerequisite — not even transiently.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain("/api/ledger/accounts");
    expect(screen.queryByText("تلاش دوباره")).toBeNull();
  });
});
