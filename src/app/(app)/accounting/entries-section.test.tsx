// @vitest-environment jsdom
/**
 * Issue #821 — the parts of «دفتر روزنامه» that are *wiring*, not rules.
 *
 * The rules themselves (who may reverse, what a filter URL means, how a count
 * is worded) are pure and tested in `journal-view.test.ts`. What cannot be
 * proven by calling a function is whether the screen actually asks them:
 * whether the reversal control is really absent for a member without
 * `ledger.approve`, whether a document's lines really stay out of the list
 * until the reader opens one, and whether a failed filter-list fetch really
 * produces a retry instead of a silent «همهٔ منابع». Each of those was the
 * defect, and each lives in JSX.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { EntriesSection } from "./entries-section";
import type { JournalEntryView } from "./journal-view";

const router = vi.hoisted(() => ({ replace: vi.fn() }));
const search = vi.hoisted(() => ({ value: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => search.value,
}));

const ENTRY: JournalEntryView = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entryDate: "2026-02-14",
  postedAt: "2026-02-14T09:30:00.000Z",
  memo: "اجارهٔ بهمن",
  sourceType: "manual",
  sourceId: null,
  locationId: null,
  locationName: "شعبهٔ مرکزی",
  projectId: null,
  projectName: null,
  createdBy: null,
  createdByName: "حسابدار",
  reversesEntryId: null,
  reversedByEntryId: null,
  reversedAt: null,
  reversedBy: null,
  reversedByName: null,
  // Past 2^53 rial: a float would render this as ...94 and the test would say so.
  totalDebit: "9007199254740993",
  lines: [
    {
      entryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      accountCode: "5100",
      accountName: "هزینهٔ اجاره",
      debit: "9007199254740993",
      credit: "0",
    },
    {
      entryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      accountCode: "1100",
      accountName: "صندوق",
      debit: "0",
      credit: "9007199254740993",
    },
  ],
};

const FILTER_OPTIONS = { sourceTypes: ["manual"], locations: [], creators: [], projects: [] };

function page(overrides: Record<string, unknown> = {}) {
  return { entries: [ENTRY], hasMore: false, nextCursor: null, totalCount: 1, ...overrides };
}

/** Answers the journal's two GETs; `filtersStatus` lets a test break the pickers alone. */
function serve(options: { page?: Record<string, unknown>; filtersStatus?: number } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/filters")) {
      const status = options.filtersStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? FILTER_OPTIONS : { error: "server_error" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(options.page ?? page()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderJournal(props: { canApprove?: boolean } = {}) {
  return render(
    <MoneyProvider unit="rial">
      <EntriesSection
        refreshKey={0}
        busy={false}
        accounts={[]}
        canApprove={props.canApprove}
        onRefresh={vi.fn()}
      />
    </MoneyProvider>,
  );
}

beforeEach(() => {
  search.value = new URLSearchParams();
  router.replace.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The journal draws the same documents twice — a table for a desk and a card
 * list for a phone, each hidden by a breakpoint class rather than unmounted —
 * so every query here is deliberately an `All` query.
 */
async function openFirstDocument(): Promise<void> {
  const expanders = await screen.findAllByRole("button", { name: "نمایش جزئیات سند" });
  fireEvent.click(expanders[0]);
}

describe("EntriesSection — the reversal control follows ledger.approve", () => {
  it("offers «برگشت سند» to a member who may approve", async () => {
    serve();
    renderJournal({ canApprove: true });
    await openFirstDocument();
    expect(await screen.findAllByRole("button", { name: "برگشت سند" })).not.toHaveLength(0);
  });

  it("withholds it from one who may not, and says why instead of going quiet", async () => {
    serve();
    renderJournal({ canApprove: false });
    await openFirstDocument();
    expect(await screen.findAllByText(/دسترسی «تأیید سند»/)).not.toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "برگشت سند" })).toHaveLength(0);
  });
});

describe("EntriesSection — a compact book that opens on demand", () => {
  it("lists the document without its lines until the reader opens it", async () => {
    serve();
    renderJournal({ canApprove: true });
    await screen.findAllByText("اجارهٔ بهمن");
    // The row is there; the line table behind it is not rendered yet.
    expect(screen.queryAllByText(/هزینهٔ اجاره/)).toHaveLength(0);

    await openFirstDocument();
    expect(await screen.findAllByText(/هزینهٔ اجاره/)).not.toHaveLength(0);
  });

  it("renders a BIGINT total exactly, where a float would round it", async () => {
    serve();
    const { container } = renderJournal();
    await screen.findAllByText("اجارهٔ بهمن");
    // ۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳ — the last digits are the point.
    expect(container.textContent).toContain("۹۹۳");
    expect(container.textContent).not.toContain("۹۹۴");
  });
});

describe("EntriesSection — failures stay visible", () => {
  it("offers a retry when the filter lists cannot be loaded", async () => {
    const fetchMock = serve({ filtersStatus: 500 });
    renderJournal();
    await screen.findByText(/فهرست منابع، شعب و ثبت‌کنندگان بارگذاری نشد/);

    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes("/filters")).length;
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/filters")).length,
      ).toBeGreaterThan(before),
    );
  });

  it("states how many of the total are shown rather than calling the loaded page the total", async () => {
    serve({ page: page({ hasMore: true, nextCursor: "c", totalCount: 1203 }) });
    renderJournal();
    expect(await screen.findAllByText("۱ از ۱٬۲۰۳ سند در دفتر نمایش داده شده")).not.toHaveLength(0);
  });
});

describe("EntriesSection — filters are the URL", () => {
  it("reads the filter it was linked with, and sends it to the API", async () => {
    search.value = new URLSearchParams("sourceType=manual&dateFrom=2026-01-01");
    const fetchMock = serve();
    renderJournal();
    await screen.findAllByText("اجارهٔ بهمن");
    const listCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/ledger/entries?"));
    expect(String(listCall?.[0])).toContain("sourceType=manual");
    expect(String(listCall?.[0])).toContain("dateFrom=2026-01-01");
  });

  it("writes a cleared filter back to the URL with replace, not push", async () => {
    search.value = new URLSearchParams("sourceType=manual");
    serve();
    renderJournal();
    fireEvent.click((await screen.findAllByRole("button", { name: "پاک کردن فیلترها" }))[0]);
    expect(router.replace).toHaveBeenCalledWith("/accounting/entries", { scroll: false });
  });
});

describe("EntriesSection — شرح فارسی اسناد سیستمی (issue #1060)", () => {
  it("reads historical system memos in Persian on desk and phone, in a direction-isolated node", async () => {
    const historical: JournalEntryView[] = [
      { ...ENTRY, id: "11111111-1111-4111-8111-111111111111", memo: "Order payment", sourceType: "order" },
      { ...ENTRY, id: "22222222-2222-4222-8222-222222222222", memo: "Cost of goods sold", sourceType: "order" },
    ];
    serve({ page: page({ entries: historical, totalCount: 2 }) });
    const { container } = renderJournal();

    // Twice each: the desktop table and the phone cards render side by side.
    expect(await screen.findAllByText("پرداخت سفارش")).toHaveLength(2);
    expect(await screen.findAllByText("بهای تمام‌شده کالای فروش‌رفته")).toHaveLength(2);
    expect(container.textContent).not.toContain("Order payment");
    expect(container.textContent).not.toContain("Cost of goods sold");
    // Mixed-direction user text must not reorder around the Persian chrome.
    expect(container.querySelector("bdi")?.textContent).toBe("پرداخت سفارش");
  });

  it("never translates a person's own manual memo, even when it spells a system string", async () => {
    serve({
      page: page({
        entries: [{ ...ENTRY, memo: "Order payment", sourceType: "manual" }],
        totalCount: 1,
      }),
    });
    renderJournal();
    expect(await screen.findAllByText("Order payment")).toHaveLength(2);
    expect(screen.queryAllByText("پرداخت سفارش")).toHaveLength(0);
  });
});
