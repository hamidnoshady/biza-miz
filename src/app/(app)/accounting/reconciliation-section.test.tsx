// @vitest-environment jsdom

/**
 * «تطبیق بانکی و صندوق» — the two properties of this screen that a reader
 * cannot recover from if they are wrong (issue #830):
 *
 *  1. A member who can open the section but not manage a reconciliation must
 *     never be handed a control that answers 403. Every mutation behind this
 *     screen — start, tick, complete, discard — requires
 *     `finance.reconciliation_manage`, while the section itself opens on
 *     `ledger.view`; the screen used to draw all of them regardless.
 *  2. «انتخاب همه» is one batch request, not a request per line. The backend
 *     had the batch contract (`journalLineIds[]`, one transaction) while the
 *     screen still PATCHed one line at a time, so a month of card settlements
 *     was hundreds of round-trips and hundreds of chances to fail half-way.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconciliationSection } from "./reconciliation-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OPEN_RECONCILIATION = {
  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  accountCode: "cash",
  statementDate: "2026-09-30",
  statementBalance: 3_000,
  status: "in_progress",
  completedAt: null,
  completedByName: null,
  createdBy: "user-1",
  createdByName: "صاحب",
};

const DETAIL = {
  ...OPEN_RECONCILIATION,
  openingBalance: 0,
  clearedTotal: 0,
  computedBalance: 0,
  difference: 3_000,
  candidateCount: 2,
  clearedCount: 0,
  matchedCount: 2,
  limit: 200,
  hasMore: false,
  nextCursor: null,
  lines: [
    {
      journalLineId: "11",
      entryId: "11111111-1111-4111-8111-111111111111",
      entryDate: "2026-09-10",
      postedAt: "2026-09-10 08:00:00+00",
      memo: "فروش نقدی",
      sourceType: "order",
      sourceId: "22222222-2222-4222-8222-222222222222",
      reference: "1042",
      debit: 1_000,
      credit: 0,
      cleared: false,
    },
    {
      journalLineId: "12",
      entryId: "33333333-3333-4333-8333-333333333333",
      entryDate: "2026-09-11",
      postedAt: "2026-09-11 08:00:00+00",
      memo: "دریافت چک",
      sourceType: "cheque",
      sourceId: "44444444-4444-4444-8444-444444444444",
      reference: "چک ۵۵۶۶",
      debit: 2_000,
      credit: 0,
      cleared: false,
    },
  ],
};

/** The stub `run` accounting-manager hands its sections. */
const runner = vi.fn(async (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => {
  const { ok } = await fn();
  return ok;
});

function stubFetch(onPatch?: (body: unknown) => void) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/ledger/reconciliations?")) {
      return { ok: true, status: 200, json: async () => ({ reconciliations: [OPEN_RECONCILIATION] }) };
    }
    if (url.includes("/lines")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      onPatch?.(body);
      return { ok: true, status: 200, json: async () => ({ ok: true, changed: 2 }) };
    }
    if (url.includes("/api/ledger/reconciliations/")) {
      return { ok: true, status: 200, json: async () => DETAIL };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection(canManage?: boolean) {
  return render(
    <ReconciliationSection busy={false} run={runner} canManage={canManage} />,
  );
}

describe("ReconciliationSection — a read-only member", () => {
  it("sees the open reconciliation but not one control that would answer 403", async () => {
    stubFetch();
    renderSection(false);

    // The period itself is still readable — that is the point of ledger.view.
    await waitFor(() => expect(screen.getByText("تطبیق باز")).toBeTruthy());
    // Every line renders twice: once in the wide-screen table, once in the
    // phone's cards. Both layouts are in the DOM at once, CSS decides which is
    // seen — so "is it there" is a length, not a single node.
    expect(screen.getAllByText("فروش نقدی").length).toBeGreaterThan(0);
    expect(screen.getByText("مغایرت")).toBeTruthy();
    expect(
      screen.getByText("این بخش برای شما فقط خواندنی است؛ شروع، تطبیق اقلام و قفل کردن دوره به دسترسی «تطبیق بانکی» نیاز دارد."),
    ).toBeTruthy();

    // …and nothing actionable is drawn.
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(screen.queryByText("تکمیل و قفل کردن تطبیق")).toBeNull();
    expect(screen.queryByText("انصراف و حذف این تطبیق")).toBeNull();
    expect(screen.queryByText("شروع تطبیق جدید")).toBeNull();
    expect(screen.queryByText(/تطبیق همهٔ نمایان/)).toBeNull();
  });

  it("does draw those controls for a member who holds the capability", async () => {
    stubFetch();
    renderSection(true);

    await waitFor(() => expect(screen.getByText("تطبیق باز")).toBeTruthy());
    // Two lines × two layouts (table + cards).
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
    expect(screen.getByText("تکمیل و قفل کردن تطبیق")).toBeTruthy();
    expect(screen.getByText("انصراف و حذف این تطبیق")).toBeTruthy();
    expect(screen.getByText(/تطبیق همهٔ نمایان/)).toBeTruthy();
  });
});

describe("ReconciliationSection — «انتخاب همه»", () => {
  it("sends one batch request for everything on screen, not one request per line", async () => {
    const bodies: unknown[] = [];
    const fetchMock = stubFetch((body) => bodies.push(body));
    renderSection(true);

    await waitFor(() => expect(screen.getByText("تطبیق باز")).toBeTruthy());
    await userEvent.click(screen.getByText(/تطبیق همهٔ نمایان/));

    const patches = fetchMock.mock.calls.filter(([url]) => String(url).includes("/lines"));
    expect(patches).toHaveLength(1);
    expect(bodies[0]).toEqual({ journalLineIds: ["11", "12"], cleared: true });
  });

  it("moves «مغایرت» the instant the batch lands, without waiting for a re-read", async () => {
    stubFetch();
    renderSection(true);

    await waitFor(() => expect(screen.getByText("تطبیق باز")).toBeTruthy());
    await userEvent.click(screen.getByText(/تطبیق همهٔ نمایان/));

    // 1٬000 + 2٬000 ticked against a 3٬000 statement: the difference is gone,
    // and the screen said so from the tick rather than from a refetch.
    await waitFor(() => expect(screen.getByText("برابر است؛ آمادهٔ قفل کردن")).toBeTruthy());
  });

  it("unticks only what is ticked, in one request", async () => {
    const bodies: unknown[] = [];
    stubFetch((body) => bodies.push(body));
    renderSection(true);

    await waitFor(() => expect(screen.getByText("تطبیق باز")).toBeTruthy());
    await userEvent.click(screen.getByText(/تطبیق همهٔ نمایان/));
    await userEvent.click(screen.getByText(/لغو تطبیق نمایان‌ها/));

    expect(bodies).toEqual([
      { journalLineIds: ["11", "12"], cleared: true },
      { journalLineIds: ["11", "12"], cleared: false },
    ]);
  });
});

describe("ReconciliationSection — an account with no open period", () => {
  /** The start form, which is the control a read-only member must not be offered. */
  function stubEmptyHistory() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/ledger/reconciliations?")) {
          return { ok: true, status: 200, json: async () => ({ reconciliations: [] }) };
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  }

  it("offers «شروع تطبیق جدید» to a member who may manage", async () => {
    stubEmptyHistory();
    renderSection(true);
    // The heading and the button both read «شروع تطبیق جدید».
    await waitFor(() => expect(screen.getAllByText("شروع تطبیق جدید").length).toBe(2));
  });

  it("offers it to nobody else", async () => {
    stubEmptyHistory();
    renderSection(false);
    await waitFor(() =>
      expect(screen.getByText("تطبیق بازی برای این حساب در جریان نیست.")).toBeTruthy(),
    );
    expect(screen.queryByText("شروع تطبیق جدید")).toBeNull();
  });
});
