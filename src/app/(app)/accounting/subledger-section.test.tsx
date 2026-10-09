// @vitest-environment jsdom

/**
 * The receivables screen's own contract — the parts issue #825 found that no
 * function call can prove, because they are about what the browser does with a
 * click and what it shows while a request is in flight.
 *
 * Each case is one of the audited defects, pinned:
 *
 *  - `ledger.view` alone must be enough to *read* everything, and the screen
 *    must not draw a live «دریافت وجه» button for a member the API would
 *    refuse. `canSettle` is the only thing that may show it, and the shared
 *    component never derives it — A/R's value is
 *    `finance.receivables_manage`.
 *  - The balance list is a window now: the search goes to the server
 *    (`?q=&limit=&offset=`, one page at a time), «نمایش موارد بیشتر» appends
 *    without blanking the table, and the reconciliation totals come from the
 *    server's summary rather than a second sum over the rows on screen.
 *  - A failed request must never render as «هیچ حساب دریافتنی بازی وجود
 *    ندارد» — that is a claim about the business, and nobody can make it from
 *    a dropped connection. Rows already on screen stay on screen.
 *  - A slow answer to an older search must not overwrite a newer one.
 *  - A statement line can be opened: the order link is built from the source
 *    record's own id (never parsed out of the Persian description), and the
 *    journal entry behind the line is fetched on demand.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { formatMoney } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";
import { RECEIVABLES_SIDE } from "./ar-section";
import { PAYABLES_SIDE } from "./ap-section";
import { SubledgerSection, SubledgerStatementPanel } from "./subledger-section";

afterEach(cleanup);

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function respond(payload: unknown, ok = true, status = 200): MockResponse {
  return { ok, status, json: async () => payload };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

const ALI = "11111111-1111-4111-8111-111111111111";
const SARA = "22222222-2222-4222-8222-222222222222";
const ENTRY = "33333333-3333-4333-8333-333333333333";

const ACTION = RECEIVABLES_SIDE.settle.actionLabel;
const SEARCH = RECEIVABLES_SIDE.searchLabel;
const RETRY = /تلاش دوباره/;

/** The server's whole-subledger totals — what may not move when the page does. */
function summary(overrides: Record<string, number> = {}) {
  return {
    receivableTotal: 800_000,
    advanceTotal: 0,
    netTotal: 800_000,
    controlBalance: 800_000,
    difference: 0,
    reconciles: true,
    ...overrides,
  };
}

function balancePage(
  rows: { id: string; name: string; balance: number }[],
  total = rows.length,
  overrides: Record<string, number> = {},
) {
  return {
    customers: rows.map((row) => ({
      customerId: row.id,
      customerName: row.name,
      customerPhone: null,
      balance: row.balance,
    })),
    total,
    nextOffset: rows.length < total ? rows.length : null,
    summary: summary(overrides),
  };
}

function statementPage() {
  return {
    lines: [
      {
        entryId: ENTRY,
        date: "2025-04-01",
        type: "invoice",
        description: "سفارش ۱۲۳",
        debit: 800_000,
        credit: 0,
        balance: 800_000,
        // The source record's own identifiers — the order id is what the link
        // is built from, not a number recovered from the sentence above.
        source: { type: "order", id: "order-1", label: null, orderId: "order-1", orderNumber: 123 },
      },
    ],
  };
}

function journalEntry() {
  return {
    entry: {
      id: ENTRY,
      entryDate: "2025-04-01",
      memo: "فروش نسیه",
      sourceType: "order",
      postedAt: "2025-04-01T10:00:00.000Z",
      createdByName: "زهرا",
      reversesEntryId: null,
      lines: [
        { id: "1", accountCode: "1200", accountName: "حساب‌های دریافتنی", debit: 800_000, credit: 0 },
        { id: "2", accountCode: "4300", accountName: "فروش", debit: 0, credit: 800_000 },
      ],
    },
  };
}

/** Routes the three endpoints by URL, the way the screen itself distinguishes them. */
function routeFetch(
  balances: (url: string) => MockResponse | Promise<MockResponse>,
  options: { statement?: MockResponse; entry?: MockResponse } = {},
) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/ledger/entries/")) return options.entry ?? respond({ error: "not_found" }, false, 404);
    if (url.startsWith("/api/ledger/ar/customers/")) return options.statement ?? respond(statementPage());
    return balances(url);
  });
}

describe("what a ledger.view-only member may press", () => {
  it("reads the balances, the totals and the statements — with no receive action in sight", async () => {
    routeFetch(() => respond(balancePage([{ id: ALI, name: "علی رضایی", balance: 800_000 }])));

    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle={false} />);

    expect(await screen.findAllByText("علی رضایی")).not.toHaveLength(0);
    // The reconciliation strip is readable, so an auditor can see the totals…
    expect(screen.getByText(RECEIVABLES_SIDE.summary.primaryLabel)).toBeTruthy();
    expect(screen.getByText(RECEIVABLES_SIDE.summary.reconciled)).toBeTruthy();
    // …and no write action is drawn anywhere: the API answers 403 to exactly
    // this member, and a button that can only fail is a trap.
    expect(screen.queryAllByRole("button", { name: ACTION })).toHaveLength(0);

    // Read-only is not read-nothing: the statement still opens.
    await userEvent.click(screen.getAllByRole("button", { name: "علی رضایی" })[0]);
    expect(await screen.findAllByText(/صورتحساب/)).not.toHaveLength(0);
    expect(await screen.findAllByText("سفارش ۱۲۳")).not.toHaveLength(0);
  });

  it("draws the receive action for a member who holds the write capability", async () => {
    routeFetch(() => respond(balancePage([{ id: ALI, name: "علی رضایی", balance: 800_000 }])));

    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle />);

    expect(await screen.findAllByRole("button", { name: ACTION })).not.toHaveLength(0);
    // Both layouts are drawn from the one fetch — table on desktop, cards on
    // phones — and neither is a second request.
    expect(screen.getAllByRole("button", { name: "علی رضایی" })).toHaveLength(2);
  });
});

describe("the search box asks the server, one page at a time", () => {
  it("sends a debounced windowed query and reports how much of the match is on screen", async () => {
    routeFetch((url) =>
      url.includes("q=Sara")
        ? respond(balancePage([{ id: SARA, name: "Sara", balance: 300_000 }], 1))
        : respond(balancePage([{ id: ALI, name: "Ali", balance: 800_000 }], 310)),
    );

    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle />);
    expect(await screen.findAllByText("Ali")).not.toHaveLength(0);

    // The first request is a page, never the whole book.
    const first = String(fetchMock.mock.calls[0][0]);
    expect(first).toContain("limit=25");
    expect(first).toContain("offset=0");
    expect(screen.getByText(/از/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: "Sara" } });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("q=Sara"))).toBe(true);
    });
    expect(await screen.findAllByText("Sara")).not.toHaveLength(0);
  });

  it("keeps the newest answer when an older search lands late", async () => {
    let releaseSlow: ((value: MockResponse) => void) | null = null;
    routeFetch((url) => {
      if (url.includes("q=Slow")) {
        return new Promise<MockResponse>((resolve) => {
          releaseSlow = resolve;
        });
      }
      if (url.includes("q=Fast")) return respond(balancePage([{ id: SARA, name: "Sara", balance: 1 }], 1));
      return respond(balancePage([{ id: ALI, name: "Ali", balance: 800_000 }], 3));
    });

    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle />);
    expect(await screen.findAllByText("Ali")).not.toHaveLength(0);

    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: "Slow" } });
    await waitFor(() => expect(releaseSlow).not.toBeNull());
    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: "Fast" } });
    await waitFor(() => expect(screen.queryAllByText("Sara").length).toBeGreaterThan(0));

    // The older search finally answers — with rows belonging to a question
    // nobody is asking any more. They must be dropped on the floor.
    releaseSlow!(respond(balancePage([{ id: ALI, name: "Ali", balance: 800_000 }], 1)));
    await waitFor(() => expect(screen.queryAllByText("Sara").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("Ali")).toHaveLength(0);
  });
});

describe("paging and failures", () => {
  it("appends the next page without blanking the rows already on screen", async () => {
    routeFetch((url) =>
      url.includes("offset=1")
        ? respond(balancePage([{ id: SARA, name: "Sara", balance: 300_000 }], 2))
        : respond(balancePage([{ id: ALI, name: "Ali", balance: 800_000 }], 2)),
    );

    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle />);
    expect(await screen.findAllByText("Ali")).not.toHaveLength(0);
    expect(screen.queryAllByText("Sara")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /نمایش موارد بیشتر/ }));

    expect(await screen.findAllByText("Sara")).not.toHaveLength(0);
    // Loading more is not reloading: the first page never left the table.
    expect(screen.queryAllByText("Ali").length).toBeGreaterThan(0);
  });

  it("says the load failed instead of claiming there are no open accounts", async () => {
    routeFetch(() => respond({ error: "network_error" }, false, 500));

    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle />);

    expect(await screen.findByText(RECEIVABLES_SIDE.loadBalancesFailed)).toBeTruthy();
    expect(screen.queryByText(RECEIVABLES_SIDE.emptyBalances)).toBeNull();
    expect(screen.getAllByRole("button", { name: RETRY }).length).toBeGreaterThan(0);
  });

  it("keeps the rows it has when a later request fails, and recovers on retry", async () => {
    let calls = 0;
    routeFetch(() => {
      calls += 1;
      if (calls === 1) return respond(balancePage([{ id: ALI, name: "Ali", balance: 800_000 }], 1));
      if (calls === 2) return respond({ error: "network_error" }, false, 500);
      return respond(balancePage([{ id: SARA, name: "Sara", balance: 300_000 }], 1));
    });

    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle />);
    expect(await screen.findAllByText("Ali")).not.toHaveLength(0);

    // A search whose connection drops: the failure is reported *above* the
    // rows, which stay — an answer that never arrived is not news that the
    // business has no customers.
    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: "Sara" } });
    expect(await screen.findByText(RECEIVABLES_SIDE.loadBalancesFailed)).toBeTruthy();
    expect(screen.queryAllByText("Ali").length).toBeGreaterThan(0);
    expect(screen.queryByText(RECEIVABLES_SIDE.emptyBalances)).toBeNull();

    await userEvent.click(screen.getAllByRole("button", { name: RETRY })[0]);
    expect(await screen.findAllByText("Sara")).not.toHaveLength(0);
  });

  it("shows a failed aging report as a failure, never as an empty book", async () => {
    routeFetch(
      () => respond(balancePage([{ id: ALI, name: "Ali", balance: 800_000 }])),
      { statement: respond({ error: "network_error" }, false, 500) },
    );

    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle />);
    expect(await screen.findAllByText("Ali")).not.toHaveLength(0);
    // The aging endpoint is the same mock's other branch; make it fail.
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/aging")
        ? respond({ error: "network_error" }, false, 500)
        : respond(balancePage([{ id: ALI, name: "Ali", balance: 800_000 }])),
    );

    await userEvent.click(screen.getByRole("button", { name: /نمای سنی بدهی‌ها/ }));

    expect(await screen.findByText(/بارگذاری نمای سنی بدهی‌ها ناموفق بود/)).toBeTruthy();
    expect(screen.queryByText(/هیچ بدهی بازی/)).toBeNull();
    expect(screen.getAllByRole("button", { name: RETRY }).length).toBeGreaterThan(0);
  });
});

describe("statement drill-down", () => {
  it("opens the journal entry behind a row and links the order by its own id", async () => {
    routeFetch(() => respond(balancePage([{ id: ALI, name: "Ali", balance: 800_000 }])), {
      statement: respond(statementPage()),
      entry: respond(journalEntry()),
    });

    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Ali" }))[0]);

    expect(await screen.findAllByText("سفارش ۱۲۳")).not.toHaveLength(0);
    // A real destination, built from the source row's id.
    const orderLink = screen.getAllByRole("link", { name: RECEIVABLES_SIDE.statement.orderLinkLabel ?? "مشاهده" })[0];
    expect(orderLink.getAttribute("href")).toBe("/accounting/orders?order=order-1");
    // The customer's file in the one directory, keyed by the party id (the
    // header carries the unfiltered directory link, the panel the keyed one).
    const directoryHref = RECEIVABLES_SIDE.statement.directoryHrefFor(ALI, ALI);
    const directoryHrefs = screen
      .getAllByRole("link", { name: RECEIVABLES_SIDE.statement.directoryLabel })
      .map((link) => link.getAttribute("href"));
    expect(directoryHrefs).toContain(directoryHref);
    expect(directoryHrefs).toContain(RECEIVABLES_SIDE.directoryHref);

    await userEvent.click(screen.getAllByRole("button", { name: RECEIVABLES_SIDE.statement.entryLinkLabel })[0]);
    expect(await screen.findAllByText(/سند حسابداری/)).not.toHaveLength(0);
    expect(screen.getAllByText(/زهرا/).length).toBeGreaterThan(0);
    expect(await screen.findAllByText(/حساب‌های دریافتنی/)).not.toHaveLength(0);
    expect(await screen.findAllByText(/فروش/)).not.toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => url === `/api/ledger/entries/${ENTRY}`)).toBe(true);
  });

  it("says the statement failed rather than showing it as an empty account", async () => {
    routeFetch(() => respond(balancePage([{ id: ALI, name: "Ali", balance: 800_000 }])), {
      statement: respond({ error: "network_error" }, false, 500),
    });

    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Ali" }))[0]);

    expect(await screen.findByText(RECEIVABLES_SIDE.statement.failed)).toBeTruthy();
    expect(screen.queryByText(RECEIVABLES_SIDE.statement.empty)).toBeNull();
  });
});


describe("A/P contracts preserved by the shared screen", () => {
  it.each([0, 1])("reads flat statement metadata and opens the journal in layout %i", async (layout) => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("/api/ledger/entries/") ? respond(journalEntry()) : respond({
        lines: [{
          journalEntryId: ENTRY, journalLineId: "line-1",
          date: "2025-04-01", type: "adjustment", description: "Adjustment",
          debit: 0, credit: 500, balance: 500,
          sourceType: "manual", locationName: "Central",
          attributionStatus: "intentional_unknown",
        }],
      }),
    );
    render(<SubledgerStatementPanel side={PAYABLES_SIDE} id="unknown" name="Unknown"
      partyId={null} onClose={() => {}} />);

    expect(await screen.findAllByText("سند دستی")).toHaveLength(2);
    expect(screen.getAllByText(/Central/)).toHaveLength(2);
    expect(screen.getAllByText(PAYABLES_SIDE.statement.attributionNoteFor!("intentional_unknown")!)).toHaveLength(2);
    // Neither layout fabricates a party or purchase URL from description text.
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    await userEvent.click(screen.getAllByRole("button", { name: PAYABLES_SIDE.statement.entryLinkLabel })[layout]);
    expect(await screen.findAllByText(/سند حسابداری/)).not.toHaveLength(0);
    expect(screen.getAllByText(/زهرا/).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => url === `/api/ledger/entries/${ENTRY}`)).toBe(true);
  });

  it("keeps the payment key on retry, but changes it for an edited payment", async () => {
    const payments: { clientRequestId: string; memo?: string }[] = [];
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        payments.push(JSON.parse(String(init.body)));
        return respond({ error: "network_error" }, false, 500);
      }
      return respond({
        suppliers: [{ supplierId: ALI, supplierName: "Supplier", supplierPhone: null,
          supplierPartyId: SARA, locationName: "Central", balance: 800_000 }],
        total: 1, summary: { ...summary(), payableTotal: 800_000 },
      });
    });
    render(<SubledgerSection side={PAYABLES_SIDE} canSettle />);
    await userEvent.click((await screen.findAllByRole("button", { name: PAYABLES_SIDE.settle.actionLabel }))[0]);
    const dialog = within(screen.getByRole("dialog"));
    const submit = dialog.getByRole("button", { name: PAYABLES_SIDE.settle.submitLabel });
    await userEvent.click(submit);
    await waitFor(() => expect(payments).toHaveLength(1));
    await userEvent.click(submit);
    await waitFor(() => expect(payments).toHaveLength(2));
    expect(payments[0].clientRequestId).toBeTruthy();
    expect(payments[1].clientRequestId).toBe(payments[0].clientRequestId);
    await userEvent.type(dialog.getByLabelText("شرح (اختیاری)"), "Revised payment");
    await userEvent.click(submit);
    await waitFor(() => expect(payments).toHaveLength(3));
    expect(payments[2].memo).toBe("Revised payment");
    expect(payments[2].clientRequestId).not.toBe(payments[0].clientRequestId);
  });
});


describe("paging request ownership", () => {
  function deferred() {
    let resolve!: (response: MockResponse) => void;
    const promise = new Promise<MockResponse>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it.each(["search", "settlement refresh"])("releases superseded paging during %s without letting it finish the new page", async (replacement) => {
    const oldPage = deferred();
    const newList = deferred();
    const newPage = deferred();
    let listRequests = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(respond({}));
      listRequests += 1;
      if (listRequests === 1) return Promise.resolve(respond(balancePage([{ id: ALI, name: "Ali", balance: 100 }], 3)));
      if (listRequests === 2) return oldPage.promise;
      if (listRequests === 3) return newList.promise;
      return newPage.promise;
    });
    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle />);
    await screen.findAllByText("Ali");
    await userEvent.click(screen.getByRole("button", { name: "نمایش موارد بیشتر" }));
    expect(listRequests).toBe(2);
    if (replacement === "search") {
      fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: "New" } });
    } else {
      await userEvent.click(screen.getAllByRole("button", { name: ACTION })[0]);
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: RECEIVABLES_SIDE.settle.submitLabel }));
    }
    await waitFor(() => expect(listRequests).toBe(3));
    expect(screen.getAllByText("Ali")).toHaveLength(2);
    const blocked = screen.getByRole("button", { name: "نمایش موارد بیشتر" }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    await userEvent.click(blocked);
    expect(listRequests).toBe(3);

    await act(async () => newList.resolve(respond(balancePage([{ id: SARA, name: "New first", balance: 90 }], 3))));
    expect(screen.queryAllByText("Ali")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "نمایش موارد بیشتر" }));
    expect(listRequests).toBe(4);
    // An obsolete failure must not clear the new page's spinner or set its error.
    await act(async () => oldPage.resolve(respond({ error: "network_error" }, false, 500)));
    expect((screen.getByRole("button", { name: "در حال بارگذاری…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(RECEIVABLES_SIDE.loadBalancesFailed)).toBeNull();
    await act(async () => newPage.resolve(respond({ ...balancePage([{ id: ENTRY, name: "New next", balance: 80 }], 3), nextOffset: 2 })));
    expect(screen.getAllByText("New next")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "نمایش موارد بیشتر" }) as HTMLButtonElement).disabled).toBe(false);
    expect(String(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")[3][0])).toContain("offset=1");
  });

  it("advances by the server window even if live reordering repeats a row", async () => {
    routeFetch((url) => {
      if (url.includes("offset=2")) return respond({ ...balancePage([{ id: SARA, name: "Sara", balance: 80 }], 3), nextOffset: null });
      if (url.includes("offset=1")) return respond({ ...balancePage([{ id: ALI, name: "Ali", balance: 100 }], 3), nextOffset: 2 });
      return respond(balancePage([{ id: ALI, name: "Ali", balance: 100 }], 3));
    });
    render(<SubledgerSection side={RECEIVABLES_SIDE} canSettle={false} />);
    await screen.findAllByText("Ali");
    await userEvent.click(screen.getByRole("button", { name: "نمایش موارد بیشتر" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "نمایش موارد بیشتر" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "نمایش موارد بیشتر" }));
    await screen.findAllByText("Sara");
    expect(screen.queryByRole("button", { name: "نمایش موارد بیشتر" })).toBeNull();
  });
});


describe("subledger presentation contracts", () => {
  it.each(["rial", "toman"] as const)("uses %s and Jalali in both statement layouts; Escape dismisses the dialog", async (unit) => {
    routeFetch(() => respond(balancePage([{ id: ALI, name: "Ali", balance: 800_000 }])));
    render(<MoneyProvider unit={unit}><SubledgerSection side={RECEIVABLES_SIDE} canSettle={false} /></MoneyProvider>);
    expect(await screen.findAllByText(formatMoney(800_000, unit))).not.toHaveLength(0);
    await userEvent.click(screen.getAllByRole("button", { name: "Ali" })[0]);
    await screen.findAllByText("سفارش ۱۲۳");
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe(RECEIVABLES_SIDE.statement.headingId);
    expect(within(dialog).getAllByText(formatJalali("2025-04-01"), { exact: false })).toHaveLength(2);
    expect(within(dialog).queryByText("2025-04-01")).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
