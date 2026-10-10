// @vitest-environment jsdom
/**
 * Issue #829 — the parts of «دریافت و پرداخت» that are *wiring*, not rules.
 *
 * The register's contract (cursor pagination, the same filters on the list
 * and the export, the export cap, the posting-account tolerance) is proven
 * against a real database in `integration/receipts-payments-list`. What no
 * API test can prove is whether the screen actually speaks it: whether the
 * «فیلترهای بیشتر» panel puts its fields on the list URL, whether the
 * download button asks for the filtered export (not the visible page) and
 * repeats the server's truncation warning instead of swallowing it, whether
 * a failed option-list fetch degrades to disabled pickers with a retry
 * rather than a broken panel, and whether the drill-down links the party
 * and the posted journal entry. Each of those lives in JSX, so each is
 * tested here.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MoneyProvider } from "@/components/money/money-context";
import { jalaliToIsoDate, todayJalali } from "@/lib/jalali";
import { ReceiptsPaymentsSection } from "./receipts-payments-section";

vi.mock("next/link", () => ({
  // The drill-down asserts hrefs, not client-side navigation.
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "22222222-2222-4222-8222-222222222222";
const ENTRY_ID = "33333333-3333-4333-8333-333333333333";
const BRANCH_ID = "44444444-4444-4444-8444-444444444444";
const CASH_ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";

const ROW = {
  id: RECEIPT_ID,
  date: "2026-10-01",
  method: "cash",
  amount: 5000000,
  memo: "بابت فاکتور ۱۲",
  partyName: "علی رضایی",
  voucherNumber: 7,
  reversedAt: null,
  bankReference: null,
  cashAccount: { code: "1100", name: "صندوق" },
  locationName: null,
};

const DETAIL = {
  ...ROW,
  receiptDate: "2026-10-01",
  customerId: CUSTOMER_ID,
  customerName: "علی رضایی",
  locationName: "شعبهٔ مرکزی",
  createdByName: "حسابدار",
  createdAt: "2026-10-01T20:45:00.000Z",
  entryId: ENTRY_ID,
  reversedAt: null,
  reversalEntryId: null,
  reversalDate: null,
  reversedByName: null,
};

const DIRECTORY = { customers: [{ customerId: CUSTOMER_ID, customerName: "علی رضایی", customerPhone: null }] };
const SUPPLIERS = { suppliers: [{ supplierId: CUSTOMER_ID, supplierName: "تأمین چاپ", supplierPhone: null }] };
const FILTER_OPTIONS = { locations: [{ id: BRANCH_ID, name: "شعبهٔ مرکزی" }] };
const CHART = {
  accounts: [
    { id: CASH_ACCOUNT_ID, code: "1100", name: "صندوق", type: "asset", parent_code: null },
    { id: "66666666-6666-4666-8666-666666666666", code: "1200", name: "حساب‌های دریافتنی", type: "asset", parent_code: null },
  ],
};

/**
 * Answers the register's GETs. `breakOptions` fails the two pickers' sources
 * (branches + chart) while the list and directory stay healthy, so a test can
 * fail the panel alone; every call's URL is recorded on the mock.
 */
function serve(options: { breakOptions?: boolean; csvStatus?: number } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/api/ledger/ar/customers")) return json(DIRECTORY);
    if (url.includes("/api/ledger/ap/suppliers")) return json(SUPPLIERS);
    if (url.includes("/api/ledger/entries/filters") || url.includes("/api/ledger/accounts")) {
      return options.breakOptions ? json({ error: "server_error" }, 500) : json(url.includes("/filters") ? FILTER_OPTIONS : CHART);
    }
    if (url.includes("/api/ledger/ap/payments") && !/\/api\/ledger\/ap\/payments\//.test(url)) {
      return json({ payments: [], hasMore: false, nextCursor: null });
    }
    if (/\/api\/ledger\/a[pr]\/(receipts|payments)\//.test(url) && !url.includes("format=csv")) {
      return json({ receipt: DETAIL, payment: DETAIL });
    }
    if (url.includes("/api/ledger/ar/receipts")) {
      if (url.includes("format=csv")) {
        const status = options.csvStatus ?? 200;
        return status === 200
          ? new Response("col\nrow\n", { status, headers: { "Content-Type": "text/csv" } })
          : new Response(JSON.stringify({ error: "server_error" }), { status, headers: { "Content-Type": "application/json" } });
      }
      return json({ receipts: [ROW], hasMore: false, nextCursor: null });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderRegister() {
  return render(
    <MoneyProvider unit="rial">
      <ReceiptsPaymentsSection canManageReceivables canManagePayables canReverseReceipts canReversePayments />
    </MoneyProvider>,
  );
}

/** The list URLs fetched so far, newest last. */
function listUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => /\/api\/ledger\/a[pr]\/(receipts|payments)(\?|$)/.test(url) && !url.includes("format=csv"));
}

function disabled(button: HTMLElement | null): boolean {
  return (button as HTMLButtonElement | null)?.disabled ?? false;
}

/** Opens the panel and picks the customer; the option waits for the directory fetch. */
async function pickCustomer() {
  fireEvent.click(screen.getByRole("button", { name: "فیلترهای بیشتر" }));
  fireEvent.click(screen.getByRole("button", { name: "فیلتر مشتری" }));
  fireEvent.click(await screen.findByRole("option", { name: "علی رضایی" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Overlapping requests, answered in a controlled order. `serve()` answers
 * every fetch immediately, which can never reproduce a slow listing overlapped
 * by a fast filter change; here the *list* responses stay pending until the
 * test resolves them, while the ancillary endpoints (directory, branches,
 * chart) answer at once. Each test names which answer wins and which rows
 * must never appear.
 */
interface DeferredListCall {
  url: string;
  resolve: (body: unknown) => void;
}

function serveDeferred(): { listCalls: DeferredListCall[] } {
  const listCalls: DeferredListCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (/\/api\/ledger\/a[pr]\/(receipts|payments)(\?|$)/.test(url) && !url.includes("format=csv")) {
      return new Promise<Response>((resolve) => {
        listCalls.push({ url, resolve: (body) => resolve(json(body)) });
      });
    }
    if (url.includes("/api/ledger/ar/customers")) return Promise.resolve(json(DIRECTORY));
    if (url.includes("/api/ledger/ap/suppliers")) return Promise.resolve(json(SUPPLIERS));
    if (url.includes("/api/ledger/entries/filters")) return Promise.resolve(json(FILTER_OPTIONS));
    if (url.includes("/api/ledger/accounts")) return Promise.resolve(json(CHART));
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { listCalls };
}

let deferredRowSeq = 0;
function deferredRow(partyName: string, method: "cash" | "bank" = "bank") {
  deferredRowSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(deferredRowSeq).padStart(12, "0")}`,
    date: "2026-10-01",
    method,
    amount: 1000000,
    memo: null,
    partyName,
    voucherNumber: deferredRowSeq,
    reversedAt: null,
    bankReference: null,
    cashAccount: null,
    locationName: null,
  };
}

function listQuery(call: DeferredListCall): URLSearchParams {
  return new URL(call.url, "http://localhost").searchParams;
}

describe("capability gating", () => {
  it("hides every write and correction action from a ledger-only viewer", async () => {
    // No capability props at all: the contract fails closed, so an unwired
    // caller (or unreadable permissions) shows no action the API would 403.
    serve();
    render(
      <MoneyProvider unit="rial">
        <ReceiptsPaymentsSection />
      </MoneyProvider>,
    );
    await screen.findAllByText("علی رضایی");
    expect(screen.queryByRole("button", { name: "ثبت دریافت" })).toBeNull();

    // The payments stream hides its register and row-reversal actions too.
    fireEvent.click(screen.getByRole("button", { name: "پرداختی" }));
    await screen.findByText("هنوز سندی برای پرداخت ثبت نشده است.");
    expect(screen.queryByRole("button", { name: "ثبت پرداخت" })).toBeNull();
    expect(screen.queryByRole("button", { name: "برگشت پرداخت" })).toBeNull();
  });
});

describe("overlapping list requests", () => {
  it("refuses to page once the filters moved off the cursor's query", async () => {
    const { listCalls } = serveDeferred();
    renderRegister();
    await waitFor(() => expect(listCalls).toHaveLength(1));
    listCalls[0].resolve({ receipts: [deferredRow("حساب کهنه")], hasMore: true, nextCursor: "C1" });
    await screen.findAllByText("حساب کهنه");

    // The method chip lists immediately, but its answer is still in flight —
    // the cursor on screen belongs to the unfiltered query.
    fireEvent.click(screen.getByRole("button", { name: "نقدی" }));
    await waitFor(() => expect(listCalls).toHaveLength(2));
    expect(listQuery(listCalls[1]).get("method")).toBe("cash");
    expect(listQuery(listCalls[1]).get("cursor")).toBeNull();

    // Paging now would ask for the filtered query past the unfiltered
    // cursor — another dataset's rows appended to this one. The click must
    // not fire a request at all; the fresh listing resets the page instead.
    fireEvent.click(screen.getByRole("button", { name: "نمایش بیشتر" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(listCalls).toHaveLength(2);

    listCalls[1].resolve({ receipts: [deferredRow("حساب تازه", "cash")], hasMore: false, nextCursor: null });
    await screen.findAllByText("حساب تازه");
    expect(screen.queryAllByText("حساب کهنه")).toHaveLength(0);
  });

  it("appends the next page while the query is unchanged", async () => {
    const { listCalls } = serveDeferred();
    renderRegister();
    await waitFor(() => expect(listCalls).toHaveLength(1));
    listCalls[0].resolve({ receipts: [deferredRow("صفحه یک")], hasMore: true, nextCursor: "C1" });
    await screen.findAllByText("صفحه یک");

    fireEvent.click(screen.getByRole("button", { name: "نمایش بیشتر" }));
    await waitFor(() => expect(listCalls).toHaveLength(2));
    expect(listQuery(listCalls[1]).get("cursor")).toBe("C1");
    expect(screen.queryByRole("button", { name: "در حال بارگذاری…" })).not.toBeNull();

    listCalls[1].resolve({ receipts: [deferredRow("صفحه دو")], hasMore: false, nextCursor: null });
    await screen.findAllByText("صفحه دو");
    expect(screen.queryAllByText("صفحه یک").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "نمایش بیشتر" })).toBeNull();
  });

  it("never lets a superseded listing overwrite the newer answer", async () => {
    const { listCalls } = serveDeferred();
    renderRegister();
    await waitFor(() => expect(listCalls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "نقدی" }));
    await waitFor(() => expect(listCalls).toHaveLength(2));

    // The newer answer lands first, then the stale one — the screen keeps
    // the newer rows.
    listCalls[1].resolve({ receipts: [deferredRow("ردیف تازه", "cash")], hasMore: false, nextCursor: null });
    await screen.findAllByText("ردیف تازه");
    listCalls[0].resolve({ receipts: [deferredRow("ردیف کهنه")], hasMore: false, nextCursor: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryAllByText("ردیف تازه").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("ردیف کهنه")).toHaveLength(0);
  });

  it("drops a superseded «نمایش بیشتر» without appending and without wedging the button", async () => {
    const { listCalls } = serveDeferred();
    renderRegister();
    await waitFor(() => expect(listCalls).toHaveLength(1));
    listCalls[0].resolve({ receipts: [deferredRow("ردیف یک")], hasMore: true, nextCursor: "C1" });
    await screen.findAllByText("ردیف یک");

    fireEvent.click(screen.getByRole("button", { name: "نمایش بیشتر" }));
    await waitFor(() => expect(listCalls).toHaveLength(2));
    // A filter change supersedes the in-flight page…
    fireEvent.click(screen.getByRole("button", { name: "نقدی" }));
    await waitFor(() => expect(listCalls).toHaveLength(3));

    listCalls[2].resolve({ receipts: [deferredRow("ردیف دو", "cash")], hasMore: true, nextCursor: "C2" });
    await screen.findAllByText("ردیف دو");
    expect(screen.queryAllByText("ردیف یک")).toHaveLength(0);

    // …so when the stale page finally lands, its rows are discarded — and
    // the button is back to «نمایش بیشتر», not wedged on «در حال بارگذاری…».
    listCalls[1].resolve({ receipts: [deferredRow("ردیف بیگانه")], hasMore: false, nextCursor: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryAllByText("ردیف بیگانه")).toHaveLength(0);
    expect(screen.queryAllByText("ردیف دو").length).toBeGreaterThan(0);
    const more = screen.getByRole("button", { name: "نمایش بیشتر" });
    expect(disabled(more)).toBe(false);
  });
});

describe("the «فیلترهای بیشتر» panel", () => {
  it("puts the party, date and amount bounds on the list URL and counts them on the toggle", async () => {
    const fetchMock = serve();
    renderRegister();
    await screen.findAllByText("علی رضایی");

    await pickCustomer();

    // The date range: «امروز» pins an exact ISO day without navigating months.
    fireEvent.click(screen.getByRole("button", { name: "از تاریخ" }));
    const calendar = screen.getByRole("dialog", { name: "انتخاب تاریخ شمسی" });
    fireEvent.click(within(calendar).getByRole("button", { name: "امروز" }));
    const today = todayJalali();
    const todayIso = jalaliToIsoDate(today.jy, today.jm, today.jd);

    // The amount bound, typed in Rial (the provider's unit here).
    fireEvent.change(screen.getByLabelText("حداقل مبلغ"), { target: { value: "5000" } });

    await waitFor(() => {
      const latest = listUrls(fetchMock).at(-1) ?? "";
      expect(latest).toContain(`partyId=${CUSTOMER_ID}`);
      expect(latest).toContain(`dateFrom=${todayIso}`);
      expect(latest).toContain("minAmount=5000");
    });
    // Three fields set: the toggle carries the count in Persian digits.
    expect(screen.queryByRole("button", { name: /بستن فیلترهای بیشتر \(۳\)/ })).not.toBeNull();
  });

  it("clears every extra filter with one action", async () => {
    const fetchMock = serve();
    renderRegister();
    await screen.findAllByText("علی رضایی");

    await pickCustomer();
    await waitFor(() => {
      expect(listUrls(fetchMock).at(-1)).toContain(`partyId=${CUSTOMER_ID}`);
    });

    fireEvent.click(screen.getByRole("button", { name: "پاک کردن فیلترها" }));
    await waitFor(() => {
      expect(listUrls(fetchMock).at(-1)).not.toContain("partyId=");
    });
  });

  it("degrades to disabled pickers with a retry when the option lists fail", async () => {
    const fetchMock = serve({ breakOptions: true });
    renderRegister();
    await screen.findAllByText("علی رضایی");

    // The list itself loaded (the panel's failure must not break the screen) —
    // open it to see the degraded pickers and the retry banner.
    fireEvent.click(screen.getByRole("button", { name: "فیلترهای بیشتر" }));
    expect(disabled(screen.getByRole("button", { name: "فیلتر حساب" }))).toBe(true);
    expect(disabled(screen.getByRole("button", { name: "فیلتر شعبه" }))).toBe(true);
    expect(screen.queryByText(/فهرست شعب و حساب‌ها بارگذاری نشد/)).not.toBeNull();

    // The retry re-fetches healthy sources and revives the pickers.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/ledger/entries/filters")) return json(FILTER_OPTIONS);
      if (url.includes("/api/ledger/accounts")) return json(CHART);
      if (url.includes("/api/ledger/ar/receipts")) return json({ receipts: [ROW], hasMore: false, nextCursor: null });
      if (url.includes("/api/ledger/ar/customers")) return json(DIRECTORY);
      return json({});
    });
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await waitFor(() => {
      expect(disabled(screen.getByRole("button", { name: "فیلتر حساب" }))).toBe(false);
    });
  });

  it("resets the party filter when the stream switches, and asks the other directory", async () => {
    const fetchMock = serve();
    renderRegister();
    await screen.findAllByText("علی رضایی");

    await pickCustomer();
    await waitFor(() => {
      expect(listUrls(fetchMock).at(-1)).toContain(`partyId=${CUSTOMER_ID}`);
    });

    // A customer id is meaningless as a supplier filter: the switch drops it.
    fireEvent.click(screen.getByRole("button", { name: /پرداختی/ }));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes("/api/ledger/ap/suppliers?scope=directory"))).toBe(true);
    });
    await waitFor(() => {
      const latest = listUrls(fetchMock).at(-1) ?? "";
      expect(latest).toContain("/api/ledger/ap/payments");
      expect(latest).not.toContain("partyId=");
    });
  });
});

describe("the CSV export", () => {
  beforeEach(() => {
    // jsdom has no blob URLs and would navigate on an anchor click; the test
    // asserts the download was *triggered*, not the browser's file handling.
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("exports the filtered query, not the visible page", async () => {
    const fetchMock = serve();
    renderRegister();
    await screen.findAllByText("علی رضایی");

    await pickCustomer();
    await waitFor(() => {
      expect(listUrls(fetchMock).at(-1)).toContain(`partyId=${CUSTOMER_ID}`);
    });

    fireEvent.click(screen.getByRole("button", { name: "دانلود" }));
    await waitFor(() => {
      const csv = fetchMock.mock.calls.map((call) => String(call[0])).find((url) => url.includes("format=csv"));
      expect(csv).toContain(`partyId=${CUSTOMER_ID}`);
    });
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
  });

  it("shows a failed export as an error instead of downloading nothing", async () => {
    serve({ csvStatus: 500 });
    renderRegister();
    await screen.findAllByText("علی رضایی");

    fireEvent.click(screen.getByRole("button", { name: "دانلود" }));
    // A silently short file reconciled as complete is worse than no file —
    // the failure lands in the error box and no download is triggered.
    await waitFor(() => {
      expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    });
    expect(document.querySelector('[role="alert"]')?.textContent ?? "").not.toBe("");
  });
});

describe("the drill-down", () => {
  it("links the party directory and the posted journal entry", async () => {
    serve();
    renderRegister();
    const cells = await screen.findAllByText("علی رضایی");
    const desktopRow = cells.map((cell) => cell.closest("tr")).find(Boolean);
    expect(desktopRow).not.toBeUndefined();
    fireEvent.click(desktopRow!);

    // The party name links to the customer file; the entry links to the journal.
    const partyLink = await screen.findByRole("link", { name: "علی رضایی" });
    expect(partyLink.getAttribute("href")).toContain(`party=${CUSTOMER_ID}`);
    expect(partyLink.getAttribute("href")).toContain("view=customers");
    const entryLinks = await screen.findAllByRole("link", { name: "مشاهده در دفتر روزنامه" });
    expect(entryLinks).toHaveLength(1);
    expect(entryLinks[0].getAttribute("href")).toContain(`entryId=${ENTRY_ID}`);
    expect(entryLinks[0].getAttribute("href")).toContain("/accounting/entries");
    // …and the settlement account shows its code, not just its name.
    expect(screen.queryByText("۱۱۰۰ صندوق")).not.toBeNull();
  });

  it("shows the creation timestamp in business-local Shamsi, separate from the accounting date", async () => {
    serve();
    renderRegister();
    const cells = await screen.findAllByText("علی رضایی");
    const desktopRow = cells.map((cell) => cell.closest("tr")).find(Boolean);
    fireEvent.click(desktopRow!);
    await screen.findByText("جزئیات دریافت");
    // The voucher is dated Mehr 9, but it was recorded at 00:15 Tehran time on
    // Mehr 10 — the audit timestamp follows the creation instant, not the date.
    expect(screen.queryByText("۱۴۰۵/۰۷/۱۰ ۰۰:۱۵")).not.toBeNull();
    expect(screen.queryByText("زمان ثبت")).not.toBeNull();
  });

  it("opens from the mobile card with the keyboard", async () => {
    serve();
    renderRegister();
    const cards = await screen.findAllByRole("button", { name: /علی رضایی/ });
    fireEvent.keyDown(cards[0], { key: "Enter" });
    expect(await screen.findByText("جزئیات دریافت")).not.toBeNull();
  });
});
